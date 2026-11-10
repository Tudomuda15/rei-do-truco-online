const socket = io();
const $ = id => document.getElementById(id);
const positions = ["bottom", "left", "top", "right"];
const suits = {"♠": "espadas", "♥": "copas", "♣": "paus", "♦": "ouros"};
let room = null;
let hand = [];

function setStatus(message) {
  const status = $(room ? "game-error" : "status");
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
$("leave").onclick = () => location.reload();

socket.on("room:update", updatedRoom => {
  const entering = !room;
  room = updatedRoom;
  const you = room.players.find(player => player.you);
  const current = room.players.find(player => player.seat === room.turn);
  $("lobby").hidden = true;
  $("game").hidden = false;
  if (entering) window.scrollTo(0, 0);
  $("roomcode").textContent = room.solo ? "Treino solo" : room.code;
  $("room-prefix").hidden = room.solo;
  $("modeLabel").textContent = room.mode === "paulista" ? "Truco Paulista" : "Truco Mineiro";

  renderPlayers(you);
  for (let team = 0; team < 2; team++) {
    $("team-" + team).textContent = you?.team === team ? "Sua dupla" : "Outra dupla";
    $("points-" + team).textContent = room.points[team];
  }
  $("round").textContent = room.started ? `Vaza ${room.round}/3` : room.round > 3 ? "Fim da mão" : "Aguardando";
  $("message").textContent = room.message;
  $("played").replaceChildren(...room.table.map(({seat, card}) => {
    const item = document.createElement("div");
    item.className = "played-card";
    const name = document.createElement("span");
    name.className = "played-name";
    const player = room.players.find(candidate => candidate.seat === seat);
    name.textContent = player?.you ? "Você" : player?.name || `Lugar ${seat + 1}`;
    item.append(makeCard(card), name);
    return item;
  }));

  $("start").hidden = room.started;
  $("start").disabled = room.players.length !== 4;
  $("start").textContent = room.solo ? "Jogar outra mão" : `Iniciar partida (${room.players.length}/4 jogadores)`;
  $("turn-status").hidden = !room.started || !current;
  $("turn-status").textContent = current?.you ? "Sua vez de jogar" : current ? `Vez de ${current.name}` : "";
  renderHand();
});

socket.on("game:hand", cards => {
  hand = cards;
  renderHand();
});

socket.on("disconnect", () => {
  if (!room) return;
  room = null;
  hand = [];
  renderHand();
  $("game").hidden = true;
  $("lobby").hidden = false;
  setStatus("A conexão caiu. Assim que voltar, entre em uma mesa para jogar.");
});

function renderPlayers(you) {
  $("players").replaceChildren(...positions.map((position, offset) => {
    const seat = ((you?.seat ?? 0) + offset) % 4;
    const player = room.players.find(candidate => candidate.seat === seat);
    const item = document.createElement("div");
    item.className = `player player-${position}`;
    item.classList.toggle("active", room.started && room.turn === seat);
    item.classList.toggle("empty", !player);

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
    element.type = "button";
    element.disabled = !room?.started || !room.players.some(player => player.you && player.seat === room.turn);
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
  $("hand").replaceChildren(...hand.map(card => makeCard(card, true)));
  $("hand").hidden = hand.length === 0;
}
