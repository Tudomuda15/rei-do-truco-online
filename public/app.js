const socket=io();let room=null,hand=[];
const $=id=>document.getElementById(id);
function setStatus(t){$("status").textContent=t;}
function name(){return $("name").value.trim()||"Jogador";}
const soloButton = $("solo");
const roomPrefix = $("room-prefix");
const turnStatus = $("turn-status");
if (soloButton) {
  soloButton.onclick = () => socket.emit("room:create", {name: name(), mode: $("mode").value, solo: true}, result => {
    if (!result.ok) setStatus(result.error);
  });
}
$("create").onclick=()=>socket.emit("room:create",{name:name(),mode:$("mode").value},r=>{if(r.ok)setStatus("Sala criada: "+r.code);else setStatus(r.error);});
$("join").onclick=()=>socket.emit("room:join",{name:name(),code:$("code").value.trim().toUpperCase()},r=>{if(!r.ok)setStatus(r.error);});
$("start").onclick=()=>socket.emit("game:start",r=>{if(!r.ok)setStatus(r.error);});
$("leave").onclick=()=>location.reload();
socket.on("room:update",r=>{
 room=r;$("lobby").hidden=true;$("game").hidden=false;$("roomcode").textContent=r.solo?"Treino solo":r.code;$("modeLabel").textContent=r.mode==="paulista"?"Truco Paulista":"Truco Mineiro";
 if (roomPrefix) roomPrefix.hidden = r.solo;
 $("players").innerHTML=r.players.map(p=>`<div class="player ${p.you?"you":""}">Lugar ${p.seat+1}: ${escapeHtml(p.name)}${p.you?" (você)":""}</div>`).join("");
 $("score").textContent=`Dupla 1: ${r.points[0]}  ×  ${r.points[1]} : Dupla 2`;
 $("message").textContent=r.message;$("played").innerHTML=r.table.map(t=>`<span class="card ${isRed(t.card.s)?"red":""}">${t.card.r}${t.card.s}<small> · ${t.seat+1}</small></span>`).join("");
 $("start").disabled=r.players.length!==4||r.started;$("start").textContent=r.started?"Partida em andamento":`Iniciar partida (${r.players.length}/4 jogadores)`;
 $("start").hidden = r.solo && r.started;
 if (turnStatus) turnStatus.hidden = !r.solo || !r.started;
 if (r.solo) {
   if (!r.started) $("start").textContent = "Jogar outra mão";
   if (r.started && turnStatus) {
     const current = r.players.find(player => player.seat === r.turn);
     turnStatus.textContent = current.you ? "Sua vez. Escolha uma carta." : `${current.name} vai jogar.`;
   }
   renderHand();
 }
});
socket.on("game:hand",cards=>{hand=cards;renderHand();});
socket.on("disconnect", () => {
  if (!room?.solo) return;
  room = null;
  hand = [];
  renderHand();
  $("game").hidden = true;
  $("lobby").hidden = false;
  setStatus("A conexão caiu. Toque em Jogar sozinho para começar outra mão.");
});
function renderHand() {
  const disabled = room?.solo && (!room.started || !room.players.some(player => player.you && player.seat === room.turn));
  $("hand").innerHTML = hand.map(card => `<button class="${isRed(card.s) ? "red" : ""}" data-id="${card.id}"${disabled ? " disabled" : ""}>${card.r}${card.s}</button>`).join("");
  $("hand").querySelectorAll("button").forEach(button => {
    button.onclick = () => socket.emit("game:play", {cardId: button.dataset.id}, result => {
      if (!result.ok) setStatus(result.error);
    });
  });
}
function isRed(s){return s==="♦"||s==="♥";}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
