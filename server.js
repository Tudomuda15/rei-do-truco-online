const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const rooms = new Map();
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
function leave(socket) {
  const room=getRoom(socket); if(!room) return;
  room.players=room.players.filter(p=>p.id!==socket.id);
  socket.leave(room.code); socket.data.room=null;
  if (room.solo || !room.players.length) {
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
  const bot = room.players[room.turn];
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
  room.turn = (room.turn + 1) % 4;
  room.message = `${player.name} jogou ${card.r}${card.s}.`;
  sendHand(player);

  if (room.table.length === 4) {
    const winner = trickWinner(room.table);
    room.points[winner.seat % 2] += 1;
    room.round++;
    room.message = `Vaza vencida pela dupla ${winner.seat % 2 + 1}.`;
    room.table = [];
    room.turn = winner.seat;
    if (room.round > 3) {
      room.started = false;
      const nextStep = room.solo ? "Toque em Jogar outra mão para continuar." : "Crie nova partida para continuar.";
      room.message = `Fim da mão. Placar: dupla 1 ${room.points[0]} x ${room.points[1]} dupla 2. ${nextStep}`;
    } else {
      room.players.forEach(sendHand);
    }
  }

  broadcast(room);
  scheduleBotTurn(room);
}
io.on("connection", socket=>{
  socket.on("room:create", ({name,mode,solo}, cb)=>{
    leave(socket);
    let code;
    do {
      code = crypto.randomBytes(3).toString("hex").toUpperCase();
    } while (rooms.has(code));
    const room={code,mode:mode==="mineiro"?"mineiro":"paulista",solo:solo===true,players:[],started:false,round:1,points:[0,0],turn:0,table:[],message:"Aguardando 4 jogadores."};
    rooms.set(code,room); room.players.push({id:socket.id,name:String(name||"Jogador").slice(0,18),seat:0,ready:false});
    socket.join(code);socket.data.room=code; cb({ok:true,code});
    if (room.solo) {
      room.players.push({name: "Bot 1", seat: 1, bot: true}, {name: "Bot 2", seat: 2, bot: true}, {name: "Bot 3", seat: 3, bot: true});
      startGame(room);
    } else {
      broadcast(room);
    }
  });
  socket.on("room:join", ({code,name}, cb)=>{
    const requestedCode = String(code || "").toUpperCase();
    if (rooms.get(requestedCode)?.solo) return cb({ok:false,error:"Esta sala é exclusiva para treino solo."});
    leave(socket); const room=rooms.get(requestedCode);
    if(!room) return cb({ok:false,error:"Sala não encontrada."});
    if(room.started||room.players.length>=4) return cb({ok:false,error:"Sala cheia ou partida já iniciada."});
    const seat=room.players.length; room.players.push({id:socket.id,name:String(name||"Jogador").slice(0,18),seat,ready:false});
    socket.join(room.code);socket.data.room=room.code;cb({ok:true});broadcast(room);
  });
  socket.on("game:start", cb=>{
    const room=getRoom(socket); if(!room) return cb({ok:false,error:"Entre em uma sala primeiro."});
    if(room.players.length!==4) return cb({ok:false,error:"São necessários 4 jogadores."});
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
  socket.on("disconnect",()=>leave(socket));
});
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Rei do Truco Online running on http://localhost:${PORT}`));
