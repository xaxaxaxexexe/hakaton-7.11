(() => {
'use strict';
const $=s=>document.querySelector(s),canvas=$('#walkCanvas'),modal=$('#walkMode'),model=HallModel;
const keys=new Set(),touchKeys=new Set(),moves=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);
let engine,active=false,paused=false,introOpen=false,introSeen=false,location='lobby',seated=null,nearby=null,position={x:0,z:5},yaw=Math.PI,pitch=0,drag,frame,last=0,lastMap=0,hud='',noticeTimer,mapPreference=null;
const hallNumber=()=>Number(Stadium.context?.session.hall.match(/\d+/)?.[0]||1),label=q=>'Ряд '+q.row+', место '+q.seat;
function notice(text){$('#walkNotice').textContent=text;$('#walkNotice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#walkNotice').hidden=true,4500);}
function screenTexture(){
 const c=document.createElement('canvas');c.width=2048;c.height=Math.round(c.width*model.config.screen.height/model.config.screen.width);const g=c.getContext('2d');
 const gradient=g.createLinearGradient(0,0,c.width,c.height);gradient.addColorStop(0,'#0d3a24');gradient.addColorStop(1,'#06140c');g.fillStyle=gradient;g.fillRect(0,0,c.width,c.height);
 g.fillStyle='#e8ff3a';g.fillRect(1870,0,178,c.height);g.fillRect(120,170,90,6);
 g.fillStyle='#c9f2d8';g.font='800 38px sans-serif';g.fillText('АРЕНА 3D / ТАБЛО · 0 : 0 · 1-й ТАЙМ',120,122);
 const title=Stadium.context?.film.title||'Добро пожаловать на стадион';let lines=[],size=108;
 do{g.font='bold '+size+'px sans-serif';lines=[''];for(const word of title.split(/\s+/)){const i=lines.length-1,next=lines[i]?lines[i]+' '+word:word;if(g.measureText(next).width>1630&&lines[i])lines.push(word);else lines[i]=next;}if(lines.length<=3)break;size-=6;}while(size>48);
 g.fillStyle='#fff';const lineHeight=size*1.2,start=410-(lines.length-1)*lineHeight/2;lines.forEach((line,i)=>g.fillText(line,120,start+i*lineHeight,1630));
 const session=Stadium.context?.session;g.fillStyle='#c9f2d8';g.font='38px sans-serif';g.fillText([session?.hall||'Сектор',session?.time,session?.date?.split('-').reverse().join('.')].filter(Boolean).join('   ·   '),120,735,1630);
 const t=new THREE.CanvasTexture(c);t.encoding=THREE.sRGBEncoding;t.anisotropy=engine?Math.min(4,engine.renderer.capabilities.getMaxAnisotropy()):1;return t;
}
function build(){
 const T=THREE,renderer=new T.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
 renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.7));renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
 const camera=new T.PerspectiveCamera(72,1,.04,420);camera.rotation.order='YXZ';
 engine={renderer,camera,...createStadiumSector(T,model,screenTexture),lobby:StadiumLobby.build(T),ray:new T.Raycaster(),colorKey:''};
 engine.screen.material.map.anisotropy=Math.min(4,renderer.capabilities.getMaxAnisotropy());
 engine.sound=StadiumAudio.create(T,camera,{hall:engine.scene,lobby:engine.lobby.scene},$('#walkSound'),notice);recolor();
}
function recolor(){
 const key=Stadium.selected.id+':'+(nearby?.id||'');if(!engine||engine.colorKey===key)return;
 model.seats.forEach((q,i)=>{const c=new THREE.Color(Stadium.taken.has(q.id)?'#2a302d':q.id===Stadium.selected.id?'#e8ff3a':q.id===nearby?.id?'#9adbb8':'#1c8a4c').convertSRGBToLinear();engine.backs.setColorAt(i,c);engine.bases.setColorAt(i,c);});
 engine.backs.instanceColor.needsUpdate=true;engine.bases.instanceColor.needsUpdate=true;engine.colorKey=key;
 const q=Stadium.selected;engine.marker.position.set(q.x,q.y+.013,q.z-.7);
}
function resize(){if(!engine)return;const r=modal.getBoundingClientRect();if(!r.width||!r.height)return;engine.renderer.setSize(r.width,r.height,false);engine.camera.aspect=r.width/r.height;engine.camera.fov=r.width<r.height?Math.min(108,THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(Math.PI/5)/engine.camera.aspect))):68;engine.camera.updateProjectionMatrix();setMapCollapsed(mapPreference??(r.height<650));}
function aim(x,z){yaw=Math.atan2(position.x-x,position.z-z);pitch=0;}
function faceScreen(){if(location==='lobby'){const d=StadiumLobby.doors.find(d=>d.hall===hallNumber());if(d.side==='end'&&position.z<23)aim(0,25);else aim(d.x,d.z);return;}const s=model.config.field;aim(0,s.z);pitch=Math.atan2(s.y-(seated?seated.y+1.17:model.floorAt(position.z)+1.68),Math.hypot(position.x,position.z-s.z));}
function syncSound(){engine?.sound.setState({active,paused,location});}
function setMapCollapsed(collapsed){$('#miniMapContent').hidden=collapsed;$('#toggleMiniMap').textContent=collapsed?'План':'Свернуть';$('#toggleMiniMap').setAttribute('aria-expanded',String(!collapsed));}
function showIntro(value){introOpen=value;$('#walkIntro').hidden=!value;for(const el of modal.children)if(el.id!=='walkIntro')el.inert=value;clearMovement();releaseMouse();if(value){clearTimeout(noticeTimer);$('#walkNotice').hidden=true;$('#startWalk').focus();}else canvas.focus();}
function clearMovement(){keys.clear();touchKeys.clear();drag=null;document.querySelectorAll('[data-walk]').forEach(b=>b.classList.remove('active'));}
function releaseMouse(){if(document.pointerLockElement===canvas)document.exitPointerLock();}
function updateHUD(){
 const key=location+':'+(seated?.id||'')+':'+(nearby?.id||nearby?.hall||nearby?.type||'')+':'+Stadium.selected.id;if(hud===key)return;hud=key;const lobby=location==='lobby';
 modal.dataset.location=location;
 modal.dataset.seated=String(!!seated);
 $('#walkPlace').textContent=lobby?'Подтрибунное · ваш сектор '+hallNumber():seated?label(seated):'Сектор '+hallNumber()+' · свободная прогулка';
 $('#walkState').textContent=seated?'Вы сидите':lobby?'Фуд-корт → сектор '+hallNumber():'Выберите место';
 $('#seatHint').textContent=lobby?(nearby?.type==='bar'?'Хот-доги и напитки — можно взять на трибуну':nearby?.type==='door'?'Вход в сектор '+nearby.hall:'Идите по коридору к сектору '+hallNumber()):seated?'Оцените вид на поле и начните оформление':nearby?.type==='exit'?'Вернуться в подтрибунное':nearby?label(nearby):'Подойдите к свободному месту';
 $('#interactSeat').disabled=!seated&&!nearby;
 $('#interactSeat').textContent=lobby?(nearby?.type==='bar'?'Открыть фуд-корт · E':'Выйти на трибуну · E'):seated?'Встать · E':nearby?.type==='exit'?'В коридор · E':'Сесть сюда · E';
 $('#walkChoice').textContent=lobby?'Сектор '+hallNumber()+' · '+(Stadium.context?.session.time||''):'Выбрано: '+label(Stadium.selected).toLowerCase();
 $('#walkBuy').textContent='Начать → к оплате';$('#walkBuy').disabled=!seated||lobby;
 $('#returnToSeat').textContent=lobby?'Показать направление':'К выбранному месту';$('#centerView').textContent=lobby?'К моему сектору':'К полю';$('#toLobby').hidden=lobby;$('#miniCaption').textContent=lobby?'Ваш сектор '+hallNumber():'Сектор '+hallNumber();$('#miniSelected').textContent=lobby?'Ваш сектор':'Место';
 $('#miniMap').setAttribute('aria-label',lobby?'План подтрибунного. Ваш сектор '+hallNumber():'План сектора '+hallNumber()+'. Выбрано: '+label(Stadium.selected));
}
function findNearby(){
 if(location==='lobby')return StadiumLobby.nearest(position);if(seated)return null;
 if(Math.hypot(position.x-6.7,position.z-18.9)<1.25)return{type:'exit'};
 let best=null,score=Infinity;
 for(const q of model.seats){if(Stadium.taken.has(q.id))continue;const d=Math.hypot(q.x-position.x,q.z-position.z);if(d<1.35){const facing=(-Math.sin(yaw)*(q.x-position.x)-Math.cos(yaw)*(q.z-position.z))/Math.max(d,.01),s=d-facing*.25;if(s<score){score=s;best=q;}}}return best;
}
function sit(q){if(location!=='hall'||!q||!q.id||Stadium.taken.has(q.id))return;seated=q;Stadium.selectSeat(q.id);position={x:q.x,z:q.z-.03};nearby=null;clearMovement();faceScreen();hud='';updateHUD();recolor();}
function stand(){if(!seated)return;position={x:seated.x,z:seated.z-.87};seated=null;nearby=findNearby();hud='';updateHUD();}
function enterHall(door){if(door.hall!==hallNumber())return notice('Ваш билет в сектор '+hallNumber()+'. Номер подсвечен на плане.');location='hall';seated=null;position={x:6.7,z:18};clearMovement();engine.camera.position.set(position.x,model.floorAt(position.z)+1.68,position.z);faceScreen();hud='';syncSound();notice('Сектор '+hallNumber()+'. Пройдите по проходу, выберите ряд и сядьте на свободное место.');}
function toLobby(){location='lobby';seated=null;const d=StadiumLobby.doors.find(d=>d.hall===hallNumber());position={x:d.side==='left'?-2.5:d.side==='right'?2.5:d.x,z:d.side==='end'?26.2:d.z};engine.camera.position.set(position.x,1.68,position.z);yaw=d.side==='left'?-Math.PI/2:d.side==='right'?Math.PI/2:0;pitch=0;clearMovement();hud='';syncSound();}
function interact(){if(paused||introOpen)return;if(location==='lobby'){if(nearby?.type==='bar')StadiumCommerce.openShop();else if(nearby?.type==='door')enterHall(nearby);}else if(nearby?.type==='exit')toLobby();else if(seated)stand();else sit(nearby);}
function open(options={}){
 if(active||!Stadium.context)return;$('#walkError').hidden=true;
 try{if(!window.THREE)throw Error('Не удалось загрузить 3D');if(!engine)build();}catch(e){$('#walkError').textContent='Не удалось открыть прогулку. '+e.message;$('#walkError').hidden=false;return;}
 active=true;paused=false;location='lobby';seated=null;position={x:0,z:5.2};yaw=-.85;pitch=-.04;modal.hidden=false;modal.inert=false;document.body.classList.add('walking');$('.app-shell').inert=true;
 engine.camera.position.set(position.x,1.68,position.z);engine.lobby.highlightHall(hallNumber());engine.sound.setHall(hallNumber());resize();clearMovement();hud='';nearby=findNearby();updateHUD();syncSound();canvas.focus();last=performance.now();frame=requestAnimationFrame(tick);
 try{introSeen=introSeen||localStorage.getItem('arena.tour-help')==='seen';}catch{}
 if(options.resume){enterHall({hall:hallNumber()});sit(Stadium.selected);}else if(!introSeen)showIntro(true);else notice('Ваш сектор '+hallNumber()+' выделен салатовым. Кнопка «Как гулять» напомнит управление.');
}
function close(){active=false;paused=false;showIntro(false);syncSound();clearMovement();releaseMouse();cancelAnimationFrame(frame);modal.hidden=true;modal.inert=false;document.body.classList.remove('walking');$('.app-shell').inert=false;clearTimeout(noticeTimer);$('#walkNotice').hidden=true;$('#walkBtn').focus();}
function pause(value){paused=value;syncSound();clearMovement();releaseMouse();modal.inert=value;if(!value&&active)canvas.focus();}
function drawMiniMap(){
 if($('#miniMapContent').hidden)return;
 const g=$('#miniMap').getContext('2d');g.setTransform(2,0,0,2,0,0);g.clearRect(0,0,180,210);let px,pz;
 if(location==='lobby'){
 px=x=>35+x*5.8;pz=z=>195-z*6.2;g.fillStyle='#22352a';g.fillRect(px(-4),pz(28),8*5.8,28*6.2);g.fillRect(px(4),pz(28),16*5.8,6*6.2);
 const target=StadiumLobby.doors.find(d=>d.hall===hallNumber());g.strokeStyle='#e8ff3a';g.lineWidth=1.4;g.setLineDash([3,3]);g.beginPath();g.moveTo(px(0),pz(5));g.lineTo(px(0),pz(target.side==='end'?25:target.z));if(target.side==='end')g.lineTo(px(target.x),pz(25));g.lineTo(px(target.x),pz(target.z));g.stroke();g.setLineDash([]);
 g.font='bold 13px sans-serif';g.textAlign='center';for(const d of StadiumLobby.doors){const chosen=d.hall===hallNumber();g.fillStyle=chosen?'#e8ff3a':'#5d7d6a';g.fillRect(px(d.x)-8,pz(d.z)-9,16,18);if(chosen){g.strokeStyle='#f4ffd0';g.lineWidth=1.5;g.strokeRect(px(d.x)-10,pz(d.z)-11,20,22);}g.fillStyle=chosen?'#101814':'#fff';g.fillText(d.hall,px(d.x),pz(d.z)+4);}
 g.fillStyle='#3ddc84';g.fillRect(px(1.5),pz(4.5),12,21);g.font='9px sans-serif';g.fillStyle='#e2eee6';g.fillText('ЕДА',77,177);g.fillText('ВХОД',35,208);
 }else{
 const s=model.config.screen;px=x=>90+x*6.4;pz=z=>30+(z-s.z)*6.4;g.fillStyle='#16241c';g.fillRect(13,26,154,159);g.strokeStyle='#4f7a62';g.lineWidth=1;g.strokeRect(13,26,154,159);
 g.fillStyle='#2f8a45';g.fillRect(px(-s.width/2),27,s.width*6.4,6);g.font='9px sans-serif';g.textAlign='center';g.fillText('ПОЛЕ',90,20);
 for(const q of model.seats){g.fillStyle=q.id===Stadium.selected.id?'#e8ff3a':Stadium.taken.has(q.id)?'#3a4a40':'#7fd1a0';g.fillRect(px(q.x)-2,pz(q.z)-2,4,4);}
 const q=Stadium.selected;g.strokeStyle='#eaffa0';g.lineWidth=1.5;g.beginPath();g.arc(px(q.x),pz(q.z),5,0,Math.PI*2);g.stroke();
 g.fillStyle='#b9d6c4';g.fillRect(87,176,6,4);g.font='9px sans-serif';g.fillText('ТВ-КАМЕРА',90,200);g.fillStyle='#8ee5d4';g.fillText('ВЫХОД',143,178);
 }
 const x=px(position.x),z=pz(position.z),dx=-Math.sin(yaw),dz=(location==='lobby'?1:-1)*Math.cos(yaw);g.fillStyle='#8ee5d42b';g.beginPath();g.moveTo(x,z);g.lineTo(x+dx*17-dz*8,z+dz*17+dx*8);g.lineTo(x+dx*17+dz*8,z+dz*17-dx*8);g.closePath();g.fill();g.strokeStyle='#8ee5d4';g.lineWidth=2;g.beginPath();g.moveTo(x,z);g.lineTo(x+dx*13,z+dz*13);g.stroke();g.fillStyle='#8ee5d4';g.beginPath();g.arc(x,z,3.5,0,Math.PI*2);g.fill();
}
function tick(now){
 if(!active)return;const dt=Math.min(Math.max((now-last)/1000,0),.05);last=now;
 if(!paused&&!introOpen){
 const f=Number(keys.has('KeyW')||keys.has('ArrowUp')||touchKeys.has('forward'))-Number(keys.has('KeyS')||keys.has('ArrowDown')||touchKeys.has('back')),s=Number(keys.has('KeyD')||keys.has('ArrowRight')||touchKeys.has('right'))-Number(keys.has('KeyA')||keys.has('ArrowLeft')||touchKeys.has('left'));
 if(f||s){if(seated)stand();const v=model.direction(yaw,f,s),speed=keys.has('ShiftLeft')||keys.has('ShiftRight')?4:2.8;position=(location==='lobby'?StadiumLobby:model).move(position,v.x*speed*dt,v.z*speed*dt);}
 const c=engine.camera,y=location==='lobby'?1.68:seated?seated.y+1.17:model.floorAt(position.z)+1.68;c.position.x=position.x;c.position.z=position.z;c.position.y+=(y-c.position.y)*(1-Math.exp(-12*dt));c.rotation.set(pitch,yaw,0,'YXZ');nearby=findNearby();updateHUD();recolor();if(now-lastMap>80){drawMiniMap();lastMap=now;}
 }engine.renderer.render(location==='lobby'?engine.lobby.scene:engine.scene,engine.camera);frame=requestAnimationFrame(tick);
}
function look(dx,dy){yaw-=dx*.0025;pitch=Math.max(-1.25,Math.min(1.25,pitch-dy*.0025));}
function selectPoint(x,y){if(location==='lobby'){if(nearby)interact();return;}const r=canvas.getBoundingClientRect(),locked=document.pointerLockElement===canvas;engine.ray.setFromCamera({x:locked?0:(x-r.left)/r.width*2-1,y:locked?0:-(y-r.top)/r.height*2+1},engine.camera);const hit=engine.ray.intersectObjects([engine.backs,engine.bases])[0];if(!hit)return;const q=model.seats[hit.instanceId];if(Stadium.taken.has(q.id))return notice('Это место уже занято. Выберите другое.');if(Math.hypot(position.x-q.x,position.z-q.z)>1.8)return notice('Подойдите к месту поближе.');sit(q);}
canvas.addEventListener('pointerdown',e=>{if(!active||paused||e.button!==0)return;canvas.focus();drag={id:e.pointerId,x:e.clientX,y:e.clientY,distance:0};if(document.pointerLockElement!==canvas)canvas.setPointerCapture(e.pointerId);});
canvas.addEventListener('pointermove',e=>{if(!active||paused)return;if(document.pointerLockElement===canvas)return look(e.movementX,e.movementY);if(!drag||drag.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.distance+=Math.hypot(dx,dy);look(dx,dy);drag.x=e.clientX;drag.y=e.clientY;});
canvas.addEventListener('pointerup',e=>{if(!drag||drag.id!==e.pointerId)return;const click=drag.distance<5;drag=null;if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);if(click)selectPoint(e.clientX,e.clientY);});
canvas.addEventListener('pointercancel',()=>drag=null);canvas.addEventListener('contextmenu',e=>e.preventDefault());
document.addEventListener('pointerlockchange',()=>{clearMovement();$('#mouseLook').textContent=document.pointerLockElement===canvas?'Мышь захвачена · Esc':'Управлять мышью';});
document.addEventListener('pointerlockerror',()=>notice('Осматривайтесь, удерживая левую кнопку мыши.'));
$('#mouseLook').addEventListener('click',async()=>{if(document.pointerLockElement===canvas)return releaseMouse();try{if(!canvas.requestPointerLock)throw Error();await canvas.requestPointerLock();}catch{notice('Осматривайтесь, удерживая левую кнопку мыши.');}});
window.addEventListener('keydown',e=>{if(!active||paused)return;if(introOpen){if(e.code==='Tab'){e.preventDefault();$('#startWalk').focus();}if(e.code==='Escape')showIntro(false);return;}if(e.target.closest('button')&&['Space','Enter'].includes(e.code))return;if(moves.has(e.code)||e.code==='Space')e.preventDefault();if(moves.has(e.code)||e.code.startsWith('Shift'))keys.add(e.code);if(e.code==='KeyE'&&!e.repeat)interact();if(e.code==='Space'&&!e.repeat)stand();if(e.code==='Tab'){const a=[...modal.querySelectorAll('button:not(:disabled),canvas[tabindex]')].filter(el=>el.getClientRects().length&&!el.closest('[inert]'));if(e.shiftKey&&document.activeElement===a[0]){e.preventDefault();a.at(-1).focus();}else if(!e.shiftKey&&document.activeElement===a.at(-1)){e.preventDefault();a[0].focus();}}});
window.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',clearMovement);document.addEventListener('visibilitychange',()=>{if(document.hidden){clearMovement();releaseMouse();}});window.addEventListener('resize',resize);
for(const b of document.querySelectorAll('[data-walk]')){b.addEventListener('pointerdown',e=>{if(paused)return;e.preventDefault();b.setPointerCapture(e.pointerId);touchKeys.add(b.dataset.walk);b.classList.add('active');});const stop=()=>{touchKeys.delete(b.dataset.walk);b.classList.remove('active');};b.addEventListener('pointerup',stop);b.addEventListener('pointercancel',stop);b.addEventListener('lostpointercapture',stop);}
$('#walkBtn').addEventListener('click',open);$('#closeWalk').addEventListener('click',close);$('#centerView').addEventListener('click',faceScreen);$('#interactSeat').addEventListener('click',interact);$('#toLobby').addEventListener('click',toLobby);
$('#returnToSeat').addEventListener('click',()=>location==='lobby'?faceScreen():sit(Stadium.selected));
$('#walkBuy').addEventListener('click',()=>{if(!seated||location!=='hall')return;close();StadiumCommerce.checkout();});
$('#walkBag').addEventListener('click',()=>StadiumCommerce.openShop());
$('#walkHelp').addEventListener('click',()=>showIntro(true));
$('#startWalk').addEventListener('click',()=>{introSeen=true;try{localStorage.setItem('arena.tour-help','seen');}catch{}showIntro(false);});
$('#toggleMiniMap').addEventListener('click',()=>{mapPreference=!$('#miniMapContent').hidden;setMapCollapsed(mapPreference);drawMiniMap();});
window.addEventListener('stadium-session-change',()=>{hud='';if(engine){engine.screen.material.map.dispose();engine.screen.material.map=screenTexture();engine.screen.material.needsUpdate=true;engine.lobby.highlightHall(hallNumber());engine.sound.setHall(hallNumber());}});
canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();close();$('#walkError').hidden=false;$('#walkError').textContent='3D прерван. Обновите страницу, чтобы продолжить.';});
window.StadiumTour={open,close,pause,get active(){return active;}};
})();
