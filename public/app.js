const socket = io();
const $ = id => document.getElementById(id);
const positions = ["bottom-right", "bottom-left", "top-left", "top-right"];
const teamNames = ["Azul", "Vermelho"];
const raiseLabels = { 3: "Truco!", 4: "Truco!", 6: "Seis!", 9: "Nove!", 12: "Doze!" };
const suits = {"♠": "espadas", "♥": "copas", "♣": "paus", "♦": "ouros"};
let room = null;
let tables = [];
let counts = {};
let selectedTable = null;
let queuedTable = null;
let pendingQueue = false;
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const wholeMoney = new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL", minimumFractionDigits: 0, maximumFractionDigits: 0
});
const variantName = { paulista: "Truco Paulista", mineiro: "Truco Mineiro" };
const formatName = { solo: "Solo", arena: "Arena" };
const matchups = { solo: "1 contra 1", arena: "2 contra 2" };
const formatSelected = () => document.querySelector("input[name=format]:checked").value;
const price = cents => money.format(cents / 100);
const receipt = $("receipt");
const queueIcon = '<svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="8" cy="4" r="3"/><path d="M2 14v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1z"/></svg>';
const callKeys = ["truco", "seis", "nove", "doze", "correu"];
const soundClips = new Map();
let soundContext;
let soundOn = true;
let activeSound;
let soundQueue = Promise.resolve();
let soundVersion = 0;
let noticeTimer;

function unlockSound() {
  if (!soundOn) return;
  const AudioEngine = window.AudioContext || window.webkitAudioContext;
  if (!AudioEngine) return;
  if (!soundContext) {
    soundContext = new AudioEngine();
    for (const key of callKeys) {
      const clip = fetch("sons/" + key + ".mp3")
        .then(response => response.ok ? response.arrayBuffer() : null)
        .then(bytes => bytes && soundContext.decodeAudioData(bytes))
        .catch(() => null);
      soundClips.set(key, clip);
    }
  }
  if (soundContext.state !== "running") void soundContext.resume().catch(() => {});
}

function stopSounds() {
  soundVersion++;
  activeSound?.stop();
}

document.addEventListener("click", unlockSound, { capture: true });
$("sound-toggle").onclick = () => {
  soundOn = !soundOn;
  $("sound-toggle").setAttribute("aria-pressed", String(soundOn));
  $("sound-toggle").textContent = soundOn ? "Som ligado" : "Som desligado";
  if (soundOn) unlockSound();
  else stopSounds();
};

socket.on("game:call", ({ room: code, key }) => {
  const clip = soundClips.get(key);
  if (!soundOn || room?.code !== code || !clip) return;
  const version = soundVersion;
  soundQueue = soundQueue.then(async () => {
    const buffer = await clip;
    if (!buffer || version !== soundVersion || soundContext.state !== "running") return;
    const source = soundContext.createBufferSource();
    activeSound = source;
    source.buffer = buffer;
    source.connect(soundContext.destination);
    await new Promise(resolve => {
      source.onended = () => {
        if (activeSound === source) activeSound = null;
        source.disconnect();
        resolve();
      };
      source.start();
    });
  }).catch(() => {});
});

for (const button of $("table-chat").querySelectorAll("[data-chat]")) {
  button.onclick = () => {
    const error = $("chat-error");
    error.hidden = true;
    const menu = button.closest("details");
    const code = room?.code;
    socket.emit("game:table-message", { kind: button.dataset.chat, id: button.dataset.item }, result => {
      if (room?.code !== code) return;
      if (result.ok) menu.open = false;
      else {
        error.textContent = result.error;
        error.hidden = false;
      }
    });
  };
}

socket.on("game:table-message", ({ room: code, kind, text, seat, name }) => {
  if (!room || room.code !== code) return;
  const notice = $("chat-notice");
  const yours = room.players.some(player => player.you && player.seat === seat);
  notice.dataset.kind = kind;
  notice.textContent = (kind === "signal" ? "Só a dupla · " : "") + (yours ? "Você" : name) + " · " + text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4800);
});

function setStatus(message) {
  const status = $(room ? (room.actions?.accept ? "raise-error" : "game-error") : "status");
  status.textContent = message;
  status.hidden = !message;
}

function createRoom(solo) {
  setStatus("");
  socket.emit("room:create", {
    name: playerName(),
    mode: document.querySelector("input[name=mode]:checked").value,
    solo
  }, handleResult);
}

function playerName() {
  return $("name").value.trim() || "Jogador";
}

function handleResult(result) {
  if (!result.ok) setStatus(result.error);
}

function renderTables() {
  const format = formatSelected();
  $("format-status").textContent = matchups[format] + " · Valores simulados";
  for (const mode of Object.keys(variantName)) {
    const buttons = tables.filter(table => table.format === format && table.mode === mode).map(table => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tile";
      button.dataset.tableId = table.id;
      button.setAttribute("aria-haspopup", "dialog");
      const amount = (table.entry % 100 === 0 ? wholeMoney : money).format(table.entry / 100);
      button.innerHTML = '<strong>' + amount + '</strong><span class="queue-label">Fila</span>' +
        '<span class="fee">Taxa ' + price(table.fee) + '</span><span class="queue">' +
        queueIcon + '<span class="queue-count"></span></span>';
      button.onclick = () => openReceipt(table);
      return button;
    });
    $(mode + "-tables").replaceChildren(...buttons);
  }
  renderCounts();
}

function renderCounts() {
  for (const button of document.querySelectorAll(".tile[data-table-id]")) {
    button.querySelector(".queue-count").textContent = counts[button.dataset.tableId] || 0;
  }
  $("queue-status").hidden = !queuedTable;
  $("queue-cancel").disabled = pendingQueue;
  if (queuedTable) {
    const { id, mode, format, entry, size } = queuedTable;
    const joined = counts[id] || 1;
    $("queue-message").textContent = `${variantName[mode]} · ${formatName[format]} · ${price(entry)} · ${joined}/${size} na fila`;
  }
}

function openReceipt(table) {
  selectedTable = table;
  const { mode, format, entry, fee, size } = table;
  const prize = entry * size;
  $("receipt-title").textContent = variantName[mode] + " · " + formatName[format];
  $("entry").textContent = price(entry);
  $("fee").textContent = price(fee);
  $("charge").textContent = price(entry + fee);
  $("collected-label").textContent = "Total dos " + size + " jogadores";
  $("collected").textContent = price(prize + fee * size);
  $("fees").textContent = price(fee * size);
  $("prize-label").textContent = size === 2 ? "Prêmio do vencedor" : "Prêmio da dupla";
  $("prize").textContent = price(prize);
  $("per-winner-row").hidden = size === 2;
  $("per-winner").textContent = price(prize / 2);
  $("queue-join").disabled = !socket.connected || pendingQueue;
  $("queue-join").textContent = queuedTable && queuedTable.id !== table.id ? "Trocar de fila" : "Entrar na fila";
  receipt.showModal();
}

$("queue-join").onclick = () => {
  const table = selectedTable;
  receipt.close();
  if (!socket.connected || pendingQueue) return;
  setStatus("");
  pendingQueue = true;
  $("queue-cancel").disabled = true;
  socket.timeout(6000).emit("queue:join", { tableId: table.id, name: playerName() }, (error, result) => {
    pendingQueue = false;
    if (!error && result.ok && !room) queuedTable = table;
    renderCounts();
    if (error) return setStatus("A fila não respondeu. Tente de novo.");
    if (!result.ok) return handleResult(result);
    if (queuedTable) $("queue-status").scrollIntoView({ block: "nearest" });
  });
};
$("queue-cancel").onclick = () => {
  if (!socket.connected || pendingQueue) return;
  pendingQueue = true;
  renderCounts();
  socket.timeout(6000).emit("queue:leave", error => {
    pendingQueue = false;
    if (!error) queuedTable = null;
    renderCounts();
    if (error) setStatus("Não foi possível sair da fila. Tente de novo.");
  });
};
document.querySelector(".formats").addEventListener("change", renderTables);
for (const toggle of document.querySelectorAll(".variant-toggle")) {
  const list = $(toggle.getAttribute("aria-controls"));
  toggle.onclick = () => {
    const expanded = list.classList.toggle("is-expanded");
    toggle.setAttribute("aria-pressed", String(expanded));
    toggle.querySelector(".view-all").textContent = expanded ? "Ver em fileira" : "Ver todas";
  };
}
socket.on("tables:catalog", payload => {
  tables = payload.tables;
  counts = payload.counts;
  $("catalog-status").hidden = true;
  renderTables();
});
socket.on("tables:counts", updated => {
  counts = updated;
  renderCounts();
});

$("solo").onclick = () => createRoom(true);
$("create").onclick = () => createRoom(false);
$("join-form").onsubmit = event => {
  event.preventDefault();
  setStatus("");
  socket.emit("room:join", {
    name: playerName(),
    code: $("code").value.trim().toUpperCase()
  }, handleResult);
};
$("start").onclick = () => {
  setStatus("");
  socket.emit("game:start", handleResult);
};
$("leave").onclick = () => {
  socket.emit("room:leave", () => resetRoom());
};
for (const [id, action] of [["run-hand", "run"], ["refuse-truco", "run"], ["accept-truco", "accept"],
  ["ask-truco", "raise"], ["counter-truco", "raise"]]) {
  $(id).onclick = () => {
    if (!room) return;
    setStatus("");
    socket.emit("game:hand-action", { action, offer: room.raise?.value ?? null }, handleResult);
  };
}

function renderRaisePanel(actions) {
  const panel = $("raise-panel");
  const opening = panel.hidden;
  panel.hidden = !actions.accept;
  if (panel.hidden) return;

  const { team, seat, value } = room.raise;
  const caller = room.players.find(player => player.seat === seat);
  $("raise-name").textContent = caller?.name ?? teamNames[team];
  $("raise-name").dataset.team = team;
  $("raise-call").textContent = raiseLabels[value];
  $("raise-vira").hidden = !room.vira;
  $("raise-vira").replaceChildren(...(room.vira ? [makeCard(room.vira)] : []));
  $("raise-cards-label").textContent = room.table.length ? "Cartas na mesa" : "Nenhuma carta jogada nesta vaza";
  $("raise-cards").hidden = room.table.length === 0;
  $("raise-cards").replaceChildren(...room.table.map(({ card }) => makeCard(card)));
  $("counter-truco").hidden = !actions.raiseTo;
  $("counter-truco").textContent = raiseLabels[actions.raiseTo] ?? "";
  if (opening) {
    setStatus("");
    panel.focus();
  }
}

socket.on("room:update", updatedRoom => {
  const entering = !room;
  room = updatedRoom;
  queuedTable = null;
  renderCounts();
  if (receipt.open) receipt.close();
  const you = room.players.find(player => player.you);
  const current = room.players.find(player => player.seat === room.turn);
  const actions = room.actions ?? {};
  $("lobby").hidden = true;
  $("game").hidden = false;
  $("table-chat").hidden = !room.chat?.table;
  $("signal-menu").hidden = !room.chat?.signal;
  $("message-menu").hidden = !room.chat?.table;
  if (entering) window.scrollTo(0, 0);
  $("roomcode").textContent = room.match ? formatName[room.match.format] + " · " + price(room.match.entry)
    : room.solo ? "Treino solo" : room.code;
  $("room-prefix").hidden = room.solo || Boolean(room.match);
  $("modeLabel").textContent = variantName[room.mode];

  $("vira-slot").hidden = !room.vira;
  $("vira-card").replaceChildren(...(room.vira ? [makeCard(room.vira)] : []));
  const manilha = $("table-manilha");
  manilha.hidden = !room.manilhaRank && room.mode !== "mineiro";
  manilha.textContent = room.mode === "mineiro" ? "Manilhas fixas" : `Manilha ${room.manilhaRank ?? ""}`;

  renderPlayers(you);
  for (let team = 0; team < 2; team++) {
    $("team-" + team).textContent = room.size === 2
      ? (you?.team === team ? "Você" : "Adversário")
      : (you?.team === team ? "Sua dupla" : "Outra dupla");
    $("points-" + team).textContent = room.points[team];
  }
  $("round").textContent = room.started ? `Vaza ${room.round}/3` : room.handOver ? "Fim da mão" : "Aguardando";
  $("hand-value").textContent = room.handValue ?? (room.mode === "mineiro" ? 2 : 1);
  Array.from($("round-dots").children).forEach((dot, index) => {
    const result = room.results?.[index];
    const current = result === undefined && room.started && index + 1 === room.round;
    const description = result === "tie" ? "Empate" : teamNames[result] ?? (current ? "Em jogo" : "Aguardando");
    dot.dataset.result = result ?? "";
    dot.classList.toggle("current", current);
    dot.setAttribute("aria-label", `Vaza ${index + 1}: ${description}`);
  });
  $("message").textContent = room.message;
  $("played").hidden = Boolean(actions.accept);
  $("played").replaceChildren(...room.table.map(({seat, card}) => {
    const item = document.createElement("div");
    item.className = "played-card";
    const name = document.createElement("span");
    name.className = "played-name";
    const player = room.players.find(candidate => candidate.seat === seat);
    name.textContent = player?.you ? "Você" : player?.name || `Lugar ${seat + 1}`;
    const face = makeCard(card);
    if (room.highlightedSeats?.includes(seat)) {
      const tied = room.results.at(-1) === "tie";
      item.dataset.result = tied ? "tie" : seat % 2;
      face.setAttribute("aria-label", face.getAttribute("aria-label") + (tied ? ", empatou" : ", venceu a vaza"));
    }
    item.append(face, name);
    return item;
  }));

  $("start").hidden = room.started || room.nextHand;
  $("start").disabled = room.players.length !== room.size;
  $("start").textContent = room.matchWinner != null ? "Jogar nova partida" : room.handOver ? "Jogar outra mão"
    : `Iniciar partida (${room.players.length}/${room.size} jogadores)`;
  $("hand-actions").hidden = !room.started || Boolean(room.raise);
  $("run-hand").disabled = !actions.run;
  $("ask-truco").disabled = !actions.raiseTo;
  $("ask-truco").textContent = raiseLabels[actions.raiseTo] ?? "Truco!";
  $("turn-status").hidden = !room.started || room.showingTrick || actions.accept || (!room.raise && !current);
  $("turn-status").textContent = room.raise ? "Aguardando a resposta."
    : current?.you ? "Sua vez de jogar" : current ? `Vez de ${current.name}` : "";
  renderHand();
  renderRaisePanel(actions);
});

function resetRoom(message = "") {
  room = null;
  stopSounds();
  clearTimeout(noticeTimer);
  $("chat-notice").hidden = true;
  $("chat-error").hidden = true;
  $("signal-menu").open = false;
  $("message-menu").open = false;
  $("raise-panel").hidden = true;
  renderHand();
  $("game").hidden = true;
  $("lobby").hidden = false;
  setStatus(message);
}
socket.on("room:closed", resetRoom);
socket.on("disconnect", () => {
  pendingQueue = false;
  queuedTable = null;
  counts = {};
  renderCounts();
  $("queue-join").disabled = true;
  $("catalog-status").textContent = "Reconectando às mesas…";
  $("catalog-status").hidden = false;
  if (room) resetRoom("A conexão caiu. Assim que voltar, entre em uma mesa para jogar.");
});

function renderPlayers(you) {
  const layout = room.size === 2 ? ["bottom-right", "top-left"] : positions;
  $("players").replaceChildren(...layout.map((position, offset) => {
    const seat = ((you?.seat ?? 0) + offset) % room.size;
    const player = room.players.find(candidate => candidate.seat === seat);
    const item = document.createElement("div");
    item.className = `player player-${position}`;
    item.classList.toggle("active", room.started && !room.showingTrick && !room.raise && room.turn === seat);
    item.classList.toggle("empty", !player);
    if (player) item.dataset.team = player.team;

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = player ? Array.from(player.name.trim())[0]?.toUpperCase() || "♠" : "+";

    const details = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = player?.name || "Lugar livre";
    const role = document.createElement("small");
    role.textContent = player?.you ? "Você" : !player ? "Aguardando" : offset === 2 ? "Sua dupla" : "Adversário";
    details.append(name, role);
    item.append(avatar, details);
    if (player && !player.you && player.cardCount > 0) {
      const backs = document.createElement("span");
      backs.className = "player-cards";
      backs.setAttribute("role", "img");
      backs.setAttribute("aria-label", `${player.cardCount} ${player.cardCount === 1 ? "carta fechada" : "cartas fechadas"}`);
      for (let index = 0; index < player.cardCount; index++) {
        const back = document.createElement("span");
        back.setAttribute("aria-hidden", "true");
        backs.append(back);
      }
      item.append(backs);
    }
    return item;
  }));
}

function makeCard(card, interactive = false) {
  const element = document.createElement(interactive ? "button" : "span");
  element.className = "card";
  element.classList.toggle("red", card.s === "♥" || card.s === "♦");
  element.innerHTML = `<span class="card-corner" aria-hidden="true"></span><span class="card-suit" aria-hidden="true"></span>`;
  element.firstChild.textContent = `${card.r}\n${card.s}`;
  element.lastChild.textContent = card.s;
  element.setAttribute("aria-label", `${card.r} de ${suits[card.s]}`);
  if (interactive) {
    if (card.manilha) {
      element.classList.add("manilha");
      element.setAttribute("aria-label", element.getAttribute("aria-label") + ", manilha");
    }
    element.type = "button";
    element.disabled = !room.actions?.play;
    element.onclick = () => {
      setStatus("");
      socket.emit("game:play", {cardId: card.id}, handleResult);
    };
  } else {
    element.setAttribute("role", "img");
  }
  return element;
}

function renderHand() {
  const hand = room?.hand ?? [];
  $("hand").replaceChildren(...hand.map(card => makeCard(card, true)));
  $("hand").hidden = hand.length === 0;
}
