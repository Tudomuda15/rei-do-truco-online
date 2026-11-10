const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const rooms = new Map();
const waiting = new Map();
const prices = [[25, 3], [100, 7], [200, 14], [500, 35], [1000, 70],
  [2500, 175], [5000, 350], [10000, 700], [20000, 1200], [50000, 2500]];
const tables = ["solo", "arena"].flatMap(format => ["paulista", "mineiro"].flatMap(mode =>
  prices.map(([entry, fee]) => ({ id: `${format}:${mode}:${entry}`, format, mode, entry, fee,
    size: format === "solo" ? 2 : 4 }))));
const tableById = new Map(tables.map(table => [table.id, table]));
const SUITS = ["♦","♠","♥","♣"];
const RANKS = ["4","5","6","7","Q","J","K","A","2","3"];
const VALUE = Object.fromEntries(RANKS.map((r,i)=>[r,i]));
const MINEIRO_MANILHAS = ["7♦", "A♠", "7♥", "4♣"];
const HAND_VALUES = { paulista: [1, 3, 6, 9, 12], mineiro: [2, 4, 6, 10, 12] };
const TEAM_NAMES = ["Azul", "Vermelho"];
const TRICK_REVEAL_MS = 2000;
function deck() {
  return SUITS.flatMap(s => RANKS.map(r => ({ r, s, id: r + s })));
}
function cardStrength(room, card) {
  const manilha = room.mode === "mineiro"
    ? MINEIRO_MANILHAS.indexOf(card.id)
    : card.r === room.manilhaRank ? SUITS.indexOf(card.s) : -1;
  return manilha >= 0 ? RANKS.length + manilha : VALUE[card.r];
}
function shuffled(a) { for(let i=a.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function roomView(room) {
  return {code:room.code, mode:room.mode, solo:room.solo,
    players:room.players.map(player => ({ name: player.name, seat: player.seat, team: player.seat % 2,
      ready: !!player.ready, cardCount: player.hand?.length ?? 0 })),
    size:room.size, match:room.match,
    vira:room.vira, manilhaRank:room.manilhaRank,
    started:room.started, round:room.round, points:room.points, turn:room.turn,
    results:room.results, showingTrick: Boolean(room.revealTimer), highlightedSeats:room.highlightedSeats,
    handValue:room.handValue, handOver:room.handOver, matchWinner:room.matchWinner, raise:room.raise,
    table:room.table.map(t=>({seat:t.seat, card:t.card})), message:room.message};
}
function broadcast(room) {
  const view = roomView(room);
  for (const player of room.players) {
    if (player.bot) continue;
    io.to(player.id).emit("room:update", {
      ...view,
      players: view.players.map(seat => ({ ...seat, you: seat.seat === player.seat })),
      hand: player.hand ?? [],
      actions: handActions(room, player)
    });
  }
}
function sendHand(player) {
  if (!player.bot) io.to(player.id).emit("game:hand", player.hand);
}
function getRoom(socket) { const code=socket.data.room; return code && rooms.get(code); }
function playerName(name) {
  return (typeof name === "string" ? name.trim().slice(0, 18) : "") || "Jogador";
}
function createRoom(mode, { solo = false, size = 4, match = null } = {}) {
  let code;
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  const room = { code, mode, solo, size, match, players: [], started: false,
    round: 1, points: [0, 0], turn: 0, table: [], vira: null, manilhaRank: null,
    results: [], highlightedSeats: [], handLead: -1, handOver: false, matchWinner: null,
    handValue: HAND_VALUES[mode][0], raise: null, lastRaiseTeam: null,
    message: "Aguardando 4 jogadores." };
  rooms.set(code, room);
  return room;
}
function seatPlayer(room, socket, name) {
  const seat = Array.from({ length: room.size }, (_, index) => index)
    .find(index => !room.players.some(player => player.seat === index));
  room.players.push({ id: socket.id, name: playerName(name), seat, ready: false });
  socket.join(room.code);
  socket.data.room = room.code;
}
function queueCounts() {
  return Object.fromEntries([...waiting].map(([id, queue]) => [id, queue.size]));
}
function cancelQueue(socket) {
  const id = socket.data.queue;
  if (!id) return false;
  socket.data.queue = null;
  const queue = waiting.get(id);
  queue.delete(socket.id);
  if (queue.size === 0) waiting.delete(id);
  return true;
}
function leave(socket) {
  const room=getRoom(socket); if(!room) return;
  room.players=room.players.filter(p=>p.id!==socket.id);
  socket.leave(room.code); socket.data.room=null;
  if (room.match) {
    clearGameTimers(room);
    rooms.delete(room.code);
    for (const player of room.players) {
      const remaining = io.sockets.sockets.get(player.id);
      if (!remaining) continue;
      remaining.data.room = null;
      remaining.leave(room.code);
      remaining.emit("room:closed", "Um jogador saiu. Escolha outra mesa para jogar.");
    }
  } else if (room.solo || !room.players.length) {
    clearGameTimers(room);
    rooms.delete(room.code);
  } else {
    if (room.started) {
      clearGameTimers(room);
      Object.assign(room, { started: false, round: 1, table: [], results: [], highlightedSeats: [],
        vira: null, manilhaRank: null, raise: null, message: "Um jogador saiu. Aguardando outro para continuar." });
      room.players.forEach(player => { player.hand = []; sendHand(player); });
    }
    broadcast(room);
  }
}

function clearGameTimers(room) {
  clearTimeout(room.botTimer);
  clearTimeout(room.revealTimer);
  room.botTimer = undefined;
  room.revealTimer = undefined;
}

function startGame(room) {
  if (room.matchWinner !== null) {
    room.points = [0, 0];
    room.matchWinner = null;
    room.handLead = -1;
  }
  room.started = true;
  room.round = 1;
  room.handLead = (room.handLead + 1) % room.size;
  room.turn = room.handLead;
  room.table = [];
  room.results = [];
  room.highlightedSeats = [];
  room.handOver = false;
  room.handValue = HAND_VALUES[room.mode][0];
  room.raise = null;
  room.lastRaiseTeam = null;
  const cards = shuffled(deck());
  room.vira = room.mode === "paulista" ? cards[room.players.length * 3] : null;
  room.manilhaRank = room.vira ? RANKS[(VALUE[room.vira.r] + 1) % RANKS.length] : null;
  room.players.forEach((player, index) => {
    player.hand = cards.slice(index * 3, index * 3 + 3);
    sendHand(player);
  });
  room.message = "Partida iniciada! Cada jogador recebe 3 cartas.";
  broadcast(room);
  scheduleBotTurn(room);
}

function trickLeaders(room) {
  const strongest = Math.max(...room.table.map(entry => cardStrength(room, entry.card)));
  return room.table.filter(entry => cardStrength(room, entry.card) === strongest);
}

function handWinner(results) {
  if (results.length < 2) return null;
  const [first, second, third] = results;
  if (first === second) {
    if (first !== "tie") return first;
    return third === "tie" ? null : (third ?? null);
  }
  if (first === "tie") return second;
  if (second === "tie") return first;
  return third === "tie" ? first : (third ?? null);
}

function handActions(room, player) {
  const team = player.seat % 2;
  const available = room.started && !room.revealTimer;
  const respond = available && Boolean(room.raise) && room.raise.team !== team;
  const play = available && !room.raise && room.turn === player.seat;
  const values = HAND_VALUES[room.mode];
  const nextValue = values[values.indexOf(room.raise?.value ?? room.handValue) + 1];
  return { play, accept: respond, run: respond || play,
    raiseTo: respond || (play && room.lastRaiseTeam !== team) ? (nextValue ?? null) : null };
}

function finishHand(room, team, reason) {
  clearGameTimers(room);
  room.started = false;
  room.handOver = true;
  room.raise = null;
  room.table = [];
  room.highlightedSeats = [];
  if (team !== null) {
    room.points[team] = Math.min(12, room.points[team] + room.handValue);
    if (room.points[team] === 12) room.matchWinner = team;
  }
  const ending = room.matchWinner === null ? "" : ` ${TEAM_NAMES[room.matchWinner]} venceu a partida!`;
  room.message = reason + ending;
  broadcast(room);
}

function acceptRaise(room) {
  room.handValue = room.raise.value;
  room.lastRaiseTeam = room.raise.team;
  room.raise = null;
  room.message = `Pedido aceito. A mão vale ${room.handValue} tentos.`;
  broadcast(room);
  scheduleBotTurn(room);
}

function scheduleBotTurn(room) {
  if (!room.solo || !room.started || room.revealTimer || room.botTimer) return;
  if (room.raise) {
    room.botTimer = setTimeout(() => {
      room.botTimer = undefined;
      acceptRaise(room);
    }, 650);
    return;
  }
  const bot = room.players.find(player => player.seat === room.turn);
  if (!bot?.bot) return;

  room.botTimer = setTimeout(() => {
    room.botTimer = undefined;
    const ordered = [...bot.hand].sort((a, b) => cardStrength(room, a) - cardStrength(room, b));
    const leading = trickLeaders(room)[0];
    const winningCard = leading && leading.seat % 2 !== bot.seat % 2
      ? ordered.find(card => cardStrength(room, card) > cardStrength(room, leading.card))
      : null;
    playCard(room, bot, winningCard || ordered[0]);
  }, 650);
}

function playCard(room, player, card) {
  player.hand = player.hand.filter(candidate => candidate.id !== card.id);
  room.table.push({seat: player.seat, card});
  room.turn = (room.turn + 1) % room.size;
  room.message = `${player.name} jogou ${card.r}${card.s}.`;
  sendHand(player);

  if (room.table.length === room.size) {
    const leaders = trickLeaders(room);
    const team = leaders[0].seat % 2;
    const tied = leaders.some(entry => entry.seat % 2 !== team);
    const nextSeat = tied ? room.table[0].seat : leaders[0].seat;
    room.results.push(tied ? "tie" : team);
    room.highlightedSeats = leaders.map(entry => entry.seat);
    room.message = tied ? "Vaza empatada." : `${TEAM_NAMES[team]} venceu a vaza.`;
    room.revealTimer = setTimeout(() => {
      room.revealTimer = undefined;
      const winner = handWinner(room.results);
      if (winner !== null || room.results.length === 3) {
        const message = winner === null ? "Mão empatada." : `${TEAM_NAMES[winner]} venceu a mão.`;
        finishHand(room, winner, message);
        return;
      }
      room.table = [];
      room.highlightedSeats = [];
      room.round++;
      room.turn = nextSeat;
      broadcast(room);
      scheduleBotTurn(room);
    }, TRICK_REVEAL_MS);
  }

  broadcast(room);
  scheduleBotTurn(room);
}
io.on("connection", socket=>{
  socket.emit("tables:catalog", { tables, counts: queueCounts() });
  socket.on("queue:join", (request, cb) => {
    if (typeof cb !== "function") return;
    const table = tableById.get(request?.tableId);
    if (!table) return cb({ ok: false, error: "Mesa não encontrada." });
    if (getRoom(socket)) return cb({ ok: false, error: "Saia da sala antes de entrar na fila." });
    if (socket.data.queue === table.id) return cb({ ok: true });
    cancelQueue(socket);
    if (!waiting.has(table.id)) waiting.set(table.id, new Map());
    const queue = waiting.get(table.id);
    queue.set(socket.id, { socket, name: playerName(request.name) });
    socket.data.queue = table.id;
    cb({ ok: true });
    if (queue.size === table.size) {
      const room = createRoom(table.mode, { size: table.size, match: table });
      for (const player of queue.values()) {
        player.socket.data.queue = null;
        seatPlayer(room, player.socket, player.name);
      }
      waiting.delete(table.id);
      startGame(room);
    }
    io.emit("tables:counts", queueCounts());
  });
  socket.on("queue:leave", cb => {
    if (cancelQueue(socket)) io.emit("tables:counts", queueCounts());
    if (typeof cb === "function") cb({ ok: true });
  });
  socket.on("room:leave", cb => {
    leave(socket);
    if (typeof cb === "function") cb({ ok: true });
  });
  socket.on("room:create", ({name,mode,solo}, cb)=>{
    if (cancelQueue(socket)) io.emit("tables:counts", queueCounts());
    leave(socket);
    const room = createRoom(mode === "mineiro" ? "mineiro" : "paulista", { solo: solo === true });
    seatPlayer(room, socket, name);
    cb({ok:true,code:room.code});
    if (room.solo) {
      room.players.push({name: "Bot 1", seat: 1, bot: true}, {name: "Bot 2", seat: 2, bot: true}, {name: "Bot 3", seat: 3, bot: true});
      startGame(room);
    } else {
      broadcast(room);
    }
  });
  socket.on("room:join", ({code,name}, cb)=>{
    const requestedCode = String(code || "").toUpperCase();
    const room=rooms.get(requestedCode);
    if(!room) return cb({ok:false,error:"Sala não encontrada."});
    if (room.solo || room.match) return cb({ok:false,error:"Esta sala não aceita entrada por código."});
    if (getRoom(socket) === room) return cb({ok:true});
    if(room.started||room.players.length>=room.size) return cb({ok:false,error:"Sala cheia ou partida já iniciada."});
    if (cancelQueue(socket)) io.emit("tables:counts", queueCounts());
    leave(socket);
    seatPlayer(room, socket, name);
    cb({ok:true});broadcast(room);
  });
  socket.on("game:start", cb=>{
    const room=getRoom(socket); if(!room) return cb({ok:false,error:"Entre em uma sala primeiro."});
    if(room.players.length!==room.size) return cb({ok:false,error:`São necessários ${room.size} jogadores.`});
    if(room.started) return cb({ok:true});
    startGame(room);cb({ok:true});
  });
  socket.on("game:play", (request, cb)=>{
    if (typeof cb !== "function") return;
    const room=getRoom(socket); if(!room||!room.started) return cb({ok:false,error:"Partida não iniciada."});
    const p=room.players.find(p=>p.id===socket.id);
    if(!p||!handActions(room,p).play) return cb({ok:false,error:"Aguarde a sua vez de jogar."});
    const card=p.hand.find(c=>c.id===request?.cardId);if(!card) return cb({ok:false,error:"Carta inválida."});
    playCard(room,p,card);cb({ok:true});
  });
  socket.on("game:hand-action", (request, cb) => {
    if (typeof cb !== "function") return;
    const room = getRoom(socket);
    const player = room?.players.find(candidate => candidate.id === socket.id);
    if (!player) return cb({ ok: false, error: "Entre em uma partida primeiro." });
    if (request?.offer !== (room.raise?.value ?? null)) return cb({ ok: false, error: "A proposta mudou. Confira os tentos." });
    const actions = handActions(room, player);
    const team = player.seat % 2;
    const action = request?.action;
    if (action === "raise" && actions.raiseTo) {
      if (room.raise) room.handValue = room.raise.value;
      room.raise = { team, value: actions.raiseTo };
      room.message = `${TEAM_NAMES[team]} pediu ${actions.raiseTo} tentos.`;
      broadcast(room);
      scheduleBotTurn(room);
    } else if (action === "accept" && actions.accept) {
      acceptRaise(room);
    } else if (action === "run" && actions.run) {
      finishHand(room, 1 - team, `${TEAM_NAMES[team]} correu. ${TEAM_NAMES[1 - team]} venceu a mão.`);
    } else {
      return cb({ ok: false, error: "Esta opção não está disponível agora." });
    }
    cb({ ok: true });
  });
  socket.on("disconnect",()=>{
    if (cancelQueue(socket)) io.emit("tables:counts", queueCounts());
    leave(socket);
  });
});
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Rei do Truco Online running on http://localhost:${PORT}`));
