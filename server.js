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
  return {code:room.code, mode:room.mode, players:room.players.map(p=>({name:p.name, seat:p.seat, team:p.seat%2, ready:!!p.ready, you:p.id===socketId})),
    started:room.started, round:room.round, points:room.points, turn:room.turn,
    table:room.table.map(t=>({seat:t.seat, card:t.card})), message:room.message};
}
function broadcast(room) { room.players.forEach(p=>io.to(p.id).emit("room:update",roomView(room,p.id))); }
function getRoom(socket) { const code=socket.data.room; return code && rooms.get(code); }
function leave(socket) {
  const room=getRoom(socket); if(!room) return;
  room.players=room.players.filter(p=>p.id!==socket.id);
  socket.leave(room.code); socket.data.room=null;
  if(!room.players.length) rooms.delete(room.code); else broadcast(room);
}
io.on("connection", socket=>{
  socket.on("room:create", ({name,mode}, cb)=>{
    leave(socket);
    const code=crypto.randomBytes(3).toString("hex").toUpperCase();
    const room={code,mode:mode==="mineiro"?"mineiro":"paulista",players:[],started:false,round:1,points:[0,0],turn:0,table:[],message:"Aguardando 4 jogadores."};
    rooms.set(code,room); room.players.push({id:socket.id,name:String(name||"Jogador").slice(0,18),seat:0,ready:false});
    socket.join(code);socket.data.room=code; cb({ok:true,code});broadcast(room);
  });
  socket.on("room:join", ({code,name}, cb)=>{
    leave(socket); const room=rooms.get(String(code||"").toUpperCase());
    if(!room) return cb({ok:false,error:"Sala não encontrada."});
    if(room.started||room.players.length>=4) return cb({ok:false,error:"Sala cheia ou partida já iniciada."});
    const seat=room.players.length; room.players.push({id:socket.id,name:String(name||"Jogador").slice(0,18),seat,ready:false});
    socket.join(room.code);socket.data.room=room.code;cb({ok:true});broadcast(room);
  });
  socket.on("game:start", cb=>{
    const room=getRoom(socket); if(!room) return cb({ok:false,error:"Entre em uma sala primeiro."});
    if(room.players.length!==4) return cb({ok:false,error:"São necessários 4 jogadores."});
    if(room.started) return cb({ok:true});
    room.started=true;room.round=1;room.points=[0,0];room.turn=0;room.table=[];
    const cards=shuffled(deck(room.mode));
    room.players.forEach((p,i)=>{p.hand=cards.slice(i*3,i*3+3);});
    room.message="Partida iniciada! Cada jogador recebe 3 cartas.";
    room.players.forEach(p=>io.to(p.id).emit("game:hand",p.hand));
    broadcast(room);cb({ok:true});
  });
  socket.on("game:play", ({cardId}, cb)=>{
    const room=getRoom(socket); if(!room||!room.started) return cb({ok:false,error:"Partida não iniciada."});
    const p=room.players.find(p=>p.id===socket.id);
    if(!p||p.seat!==room.turn) return cb({ok:false,error:"Não é sua vez."});
    const card=p.hand.find(c=>c.id===cardId);if(!card) return cb({ok:false,error:"Carta inválida."});
    p.hand=p.hand.filter(c=>c.id!==cardId);room.table.push({seat:p.seat,card});
    room.turn=(room.turn+1)%4;
    room.message=`${p.name} jogou ${card.r}${card.s}.`;
    p.hand && io.to(p.id).emit("game:hand",p.hand);
    if(room.table.length===4){
      // MVP trick winner: rank ordering. Paulista uses next card rank as manilha; simplified pending full scoring.
      let winner=room.table.reduce((best,entry)=>VALUE[entry.card.r]>VALUE[best.card.r]?entry:best,room.table[0]);
      room.points[winner.seat%2]+=1;room.round++;
      room.message=`Vaza vencida pela dupla ${winner.seat%2+1}.`;
      room.table=[];room.turn=winner.seat;
      if(room.round>3){room.started=false;room.message=`Fim da mão. Placar: dupla 1 ${room.points[0]} x ${room.points[1]} dupla 2. Crie nova partida para continuar.`;}
      else room.players.forEach(pl=>io.to(pl.id).emit("game:hand",pl.hand));
    }
    broadcast(room);cb({ok:true});
  });
  socket.on("disconnect",()=>leave(socket));
});
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Rei do Truco Online running on http://localhost:${PORT}`));
