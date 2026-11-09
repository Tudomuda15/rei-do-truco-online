const socket=io();let room=null,hand=[];
const $=id=>document.getElementById(id);
function setStatus(t){$("status").textContent=t;}
function name(){return $("name").value.trim()||"Jogador";}
$("create").onclick=()=>socket.emit("room:create",{name:name(),mode:$("mode").value},r=>{if(r.ok)setStatus("Sala criada: "+r.code);else setStatus(r.error);});
$("join").onclick=()=>socket.emit("room:join",{name:name(),code:$("code").value.trim().toUpperCase()},r=>{if(!r.ok)setStatus(r.error);});
$("start").onclick=()=>socket.emit("game:start",r=>{if(!r.ok)setStatus(r.error);});
$("leave").onclick=()=>location.reload();
socket.on("room:update",r=>{
 room=r;$("lobby").hidden=true;$("game").hidden=false;$("roomcode").textContent=r.code;$("modeLabel").textContent=r.mode==="paulista"?"Truco Paulista":"Truco Mineiro";
 $("players").innerHTML=r.players.map(p=>`<div class="player ${p.you?"you":""}">Lugar ${p.seat+1}: ${escapeHtml(p.name)}${p.you?" (você)":""}</div>`).join("");
 $("score").textContent=`Dupla 1: ${r.points[0]}  ×  ${r.points[1]} : Dupla 2`;
 $("message").textContent=r.message;$("played").innerHTML=r.table.map(t=>`<span class="card ${isRed(t.card.s)?"red":""}">${t.card.r}${t.card.s}<small> · ${t.seat+1}</small></span>`).join("");
 $("start").disabled=r.players.length!==4||r.started;$("start").textContent=r.started?"Partida em andamento":`Iniciar partida (${r.players.length}/4 jogadores)`;
});
socket.on("game:hand",cards=>{hand=cards;renderHand();});
function renderHand(){$("hand").innerHTML=hand.map(c=>`<button class="${isRed(c.s)?"red":""}" data-id="${c.id}">${c.r}${c.s}</button>`).join("");$("hand").querySelectorAll("button").forEach(b=>b.onclick=()=>socket.emit("game:play",{cardId:b.dataset.id},r=>{if(!r.ok)setStatus(r.error);}));}
function isRed(s){return s==="♦"||s==="♥";}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
