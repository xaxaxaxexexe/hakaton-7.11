/* Original, local synthesis. No recordings, downloads, microphones or network requests. */
(function(root) {
  'use strict';
  const preferenceKey='arena.sound';

  function synthesize(kind, sampleRate=24000, seconds=6) {
    const samples=new Float32Array(sampleRate*seconds);
    let seed=1579,low=0,soft=0;
    for(let i=0;i<samples.length;i++){
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      const noise=seed/2147483648-1,t=i/sampleRate;
      low+=.035*(noise-low);soft+=.22*(noise-soft);
      const wave=f=>Math.sin(2*Math.PI*f*t);
      let value;
      switch(kind){
        case 'lobby': value=low*(.45+.15*wave(.5))+.018*(wave(180)+wave(270))*(.6+.4*wave(1/3));break;
        case 'bar': value=soft*.12+low*.45+.025*wave(720)*Math.pow(Math.max(0,wave(1.5)),24);break;
        case 'entrance': value=low*.4+.025*(wave(110)+wave(165))*(.7+.3*wave(.5));break;
        case 'hall': value=low*.24+.018*(wave(65)+wave(98))*(.8+.2*wave(1/3));break;
        case 'projector': value=soft*(.16+.14*Math.pow(Math.max(0,wave(24)),6))+.035*wave(96)+.018*wave(144);break;
        default: value=low*.5+.028*wave(60)+.012*wave(120);
      }
      // A short zero-crossing envelope avoids clicks at the loop seam.
      samples[i]=value*Math.min(1,i/(sampleRate*.025),(samples.length-1-i)/(sampleRate*.025));
    }
    return samples;
  }

  function create(T,camera,scenes,button,onStatus=()=>{}) {
    let enabled=true;
    try{enabled=root.localStorage.getItem(preferenceKey)!=='off';}catch{}
    let supported=!!(root.AudioContext||root.webkitAudioContext),listener,context;
    let active=false,paused=false,zone='lobby',unlocked=false,resuming=false,suspendTimer;
    const sources=[];
    const wanted=()=>supported&&enabled&&active&&!paused&&!root.document.hidden;
    function updateButton(){
      const audible=wanted()&&context?.state==='running'&&sources.some(s=>s.audio.isPlaying);
      button.textContent=audible?'Звук включён':'Звук выключен';
      button.setAttribute('aria-pressed',String(!!audible));
      button.disabled=!supported;
      button.title=!supported?'Браузер не поддерживает пространственный звук':audible?'Отключить звуки стадиона':'Включить тихий пространственный звук';
    }
    function build(){
      listener=new T.AudioListener();context=listener.context;
      listener.gain.gain.value=0;camera.add(listener);
      const limiter=context.createDynamicsCompressor();
      limiter.threshold.value=-18;limiter.knee.value=12;limiter.ratio.value=4;
      limiter.attack.value=.01;limiter.release.value=.25;listener.setFilter(limiter);
      const buffers=new Map();
      const add=(name,kind,area,position,volume,distance)=>{
        if(!buffers.has(kind)){
          const data=synthesize(kind),buffer=context.createBuffer(1,data.length,24000);
          buffer.getChannelData(0).set(data);buffers.set(kind,buffer);
        }
        const audio=new T.PositionalAudio(listener);audio.name=name;
        audio.setBuffer(buffers.get(kind));audio.setLoop(true);audio.setVolume(0);
        audio.setDistanceModel('inverse');audio.setRefDistance(distance);audio.setRolloffFactor(1.4);audio.setMaxDistance(40);
        audio.position.set(...position);scenes[area].add(audio);
        sources.push({audio,area,volume});return audio;
      };
      add('lobby-ambience','lobby','lobby',[-1,2,4],.42,3);
      add('stadium-bar','bar','lobby',[2.1,1.4,3.2],.45,1.6);
      add('hall-entrance','entrance','lobby',[0,1.8,7],.3,1.5);
      add('lobby-ventilation','ventilation','lobby',[1,3.5,23],.24,4);
      add('hall-ambience','hall','hall',[0,2.8,8],.28,5);
      const p=root.HallModel.config.projector;
      add('projector','projector','hall',[p.x,p.y,p.z],.6,2.2);
      add('hall-ventilation','ventilation','hall',[-9,4.5,13],.23,4);
      setHall(currentHall);
      context.addEventListener('statechange',updateButton);
    }
    function mix(){
      if(!listener)return;
      listener.gain.gain.setTargetAtTime(wanted()?.32:0,context.currentTime,.055);
      for(const s of sources)s.audio.gain.gain.setTargetAtTime(wanted()&&s.area===zone?s.volume:0,context.currentTime,.1);
    }
    function sync(){
      clearTimeout(suspendTimer);
      if(!context){updateButton();return;}
      mix();
      if(wanted()&&unlocked){
        if(!resuming){
          resuming=true;
          // resume() is called synchronously from a gesture on first activation.
          context.resume().then(()=>{
            if(wanted())for(const s of sources)if(!s.audio.isPlaying)s.audio.play();
            mix();
          }).catch(()=>onStatus('Нажмите «Звук выключен», чтобы повторить включение звука.'))
            .finally(()=>{resuming=false;updateButton();});
        }
      }else{
        suspendTimer=setTimeout(()=>{if(!wanted())context.suspend().catch(()=>{});},220);
      }
      updateButton();
    }
    function gesture(event){
      if(!event?.isTrusted||!wanted())return;
      try{if(!context)build();unlocked=true;sync();}
      catch{
        supported=false;
        if(listener){listener.gain.gain.value=0;camera.remove(listener);}
        for(const s of sources){if(s.audio.isPlaying)s.audio.stop();s.audio.parent?.remove(s.audio);s.audio.gain.disconnect();}
        context?.suspend().catch(()=>{});
        updateButton();onStatus('Звук недоступен в этом браузере. Прогулка продолжит работать.');
      }
    }
    let currentHall=1;
    function setHall(hall){
      currentHall=hall;
      const door=root.StadiumLobby.doors.find(d=>d.hall===hall);
      const source=sources.find(s=>s.audio.name==='hall-entrance');
      if(door&&source)source.audio.position.set(door.x,1.8,door.z);
    }
    button.addEventListener('click',event=>{
      if(!supported)return;
      enabled=!(enabled&&unlocked&&context?.state==='running');
      try{root.localStorage.setItem(preferenceKey,enabled?'on':'off');}catch{}
      if(enabled)gesture(event);else sync();
    });
    const unlock=event=>{if(!event.target.closest?.('#walkSound')&&(event.type!=='keydown'||!event.repeat))gesture(event);};
    root.document.addEventListener('pointerdown',unlock,{capture:true});
    root.document.addEventListener('keydown',unlock,{capture:true});
    root.document.addEventListener('visibilitychange',sync);
    root.addEventListener('pagehide',()=>{active=false;sync();});
    updateButton();
    return {
      setState(next){active=next.active;paused=next.paused;zone=next.location;sync();},
      setHall,
    };
  }
  const value={create,synthesize};
  if(typeof module!=='undefined')module.exports=value;else root.StadiumAudio=value;
})(typeof window==='undefined'?globalThis:window);
