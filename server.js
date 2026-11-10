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
function deck(mode) {
  let d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({r,s,id:r+s});
  if (mode === "mineiro") {
    // Fixed manilhas: 4♣, 7♥, A♠, 7♦ in descending order.
    const fixed = ["4♣","7♥","A♠","7♦"];
    d.sort((a,b)=> (fixed.includes(b.id)?100+fixed.indexOf(b.id):VALUE[b.r]) -
                   (fixed.includes(a.id)?100+fixed.indexOf(a.id):VALUE[a.r]));
  }
  return d;
}
function shuffled(a) { for(let i=a.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function roomView(room, socketId) {
  return {code:room.code, mode:room.mode, solo:room.solo, players:room.players.map(p=>({name:p.name, seat:p.seat, team:p.seat%2, ready:!!p.ready, you:p.id===socketId})),
    size:room.size, match:room.match,
    started:room.started, round:room.round, points:room.points, turn:room.turn,
    table:room.table.map(t=>({seat:t.seat, card:t.card})), message:room.message};
}
function broadcast(room) {
  for (const player of room.players) {
    if (!player.bot) io.to(player.id).emit("room:update", roomView(room, player.id));
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
    round: 1, points: [0, 0], turn: 0, table: [], message: "Aguardando 4 jogadores." };
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
    rooms.delete(room.code);
    for (const player of room.players) {
      const remaining = io.sockets.sockets.get(player.id);
      if (!remaining) continue;
      remaining.data.room = null;
      remaining.leave(room.code);
      remaining.emit("room:closed", "Um jogador saiu. Escolha outra mesa para jogar.");
    }
  } else if (room.solo || !room.players.length) {
    clearTimeout(room.botTimer);
    rooms.delete(room.code);
  } else {
    broadcast(room);
  }
}

function startGame(room) {
  room.started = true;
  room.round = 1;
  room.points = [0, 0];
  room.turn = 0;
  room.table = [];
  const cards = shuffled(deck(room.mode));
  room.players.forEach((player, index) => {
    player.hand = cards.slice(index * 3, index * 3 + 3);
    sendHand(player);
  });
  room.message = "Partida iniciada! Cada jogador recebe 3 cartas.";
  broadcast(room);
}

function trickWinner(table) {
  // Preserve the prototype's simplified ranking in both room types.
  return table.reduce((best, entry) => VALUE[entry.card.r] > VALUE[best.card.r] ? entry : best);
}

function scheduleBotTurn(room) {
  if (!room.solo || !room.started) return;
  const bot = room.players.find(player => player.seat === room.turn);
  if (!bot.bot) return;

  room.botTimer = setTimeout(() => {
    room.botTimer = undefined;
    const ordered = [...bot.hand].sort((a, b) => VALUE[a.r] - VALUE[b.r]);
    const leading = room.table.length ? trickWinner(room.table) : null;
    const winningCard = leading && leading.seat % 2 !== bot.seat % 2
      ? ordered.find(card => VALUE[card.r] > VALUE[leading.card.r])
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
    const winner = trickWinner(room.table);
    const winnerName = room.size === 2 ? room.players.find(candidate => candidate.seat === winner.seat).name
      : `Dupla ${winner.seat % 2 + 1}`;
    room.points[winner.seat % 2] += 1;
    room.round++;
    room.message = `Vaza vencida por ${winnerName}.`;
    room.table = [];
    room.turn = winner.seat;
    if (room.round > 3) {
      room.started = false;
      room.message = `Fim da mão. Placar: ${room.points[0]} x ${room.points[1]}. Toque em Jogar outra mão para continuar.`;
    } else {
      room.players.forEach(sendHand);
    }
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
  socket.on("game:play", ({cardId}, cb)=>{
    const room=getRoom(socket); if(!room||!room.started) return cb({ok:false,error:"Partida não iniciada."});
    const p=room.players.find(p=>p.id===socket.id);
    if(!p||p.seat!==room.turn) return cb({ok:false,error:"Não é sua vez."});
    const card=p.hand.find(c=>c.id===cardId);if(!card) return cb({ok:false,error:"Carta inválida."});
    playCard(room,p,card);cb({ok:true});
  });
  socket.on("disconnect",()=>{
    if (cancelQueue(socket)) io.emit("tables:counts", queueCounts());
    leave(socket);
  });
});
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Rei do Truco Online running on http://localhost:${PORT}`));
