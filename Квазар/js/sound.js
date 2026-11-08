// Звук стадиона с пространственным позиционированием: гул трибун со всех сторон,
// фан-сектор за левыми воротами (там громче всего), волны скандирования и свисток судьи с поля.
const Sound={ctx:null,timer:null,
 start(){if(this.ctx)return;const c=this.ctx=new AudioContext(),out=this.out=c.createGain();out.gain.value=.6;out.connect(c.destination);
  const b=c.createBuffer(1,c.sampleRate*3,c.sampleRate),d=b.getChannelData(0);let p=0;for(let i=0;i<d.length;i++){p=p*.9+(Math.random()*2-1)*.3;d[i]=p}
  // [x, y, z, частота, громкость]: трибуна напротив, торцы, своя трибуна, фан-сектор
  [[0,10,-75,700,.3],[-60,8,-33,600,.22],[60,8,-33,600,.18],[0,4,12,800,.2],[-58,6,-20,900,.45]].forEach(([x,y,z,f,v],k)=>{const s=c.createBufferSource();s.buffer=b;s.loop=true;
   const bp=c.createBiquadFilter();bp.type="bandpass";bp.frequency.value=f;bp.Q.value=.7;const g=c.createGain(),l=c.createOscillator(),lg=c.createGain();
   l.frequency.value=.15+k*.05;lg.gain.value=v*.4;g.gain.value=v;l.connect(lg);lg.connect(g.gain);l.start();s.connect(bp);bp.connect(g);g.connect(this.pan(x,y,z));s.start(c.currentTime+k*.3)});
  this.timer=setInterval(()=>Math.random()<.35?this.whistle():this.chant(),2600)},
 pan(x,y,z){const p=this.ctx.createPanner();p.panningModel="HRTF";p.refDistance=8;p.rolloffFactor=.8;p.positionX.value=x;p.positionY.value=y;p.positionZ.value=z;p.connect(this.out);return p},
 chant(){const c=this.ctx;if(!c)return;const t=c.currentTime,dst=this.pan(-58,6,-20);
  [0,.45,.9].forEach(dt=>{const o=c.createOscillator(),g=c.createGain(),f=c.createBiquadFilter();o.type="sawtooth";o.frequency.value=180+Math.random()*30;f.type="lowpass";f.frequency.value=900;
   g.gain.setValueAtTime(0,t+dt);g.gain.linearRampToValueAtTime(.12,t+dt+.05);g.gain.exponentialRampToValueAtTime(.001,t+dt+.35);o.connect(f);f.connect(g);g.connect(dst);o.start(t+dt);o.stop(t+dt+.4)})},
 whistle(){const c=this.ctx;if(!c)return;const o=c.createOscillator(),m=c.createOscillator(),mg=c.createGain(),g=c.createGain(),t=c.currentTime,x=(Math.random()*2-1)*30;
  o.frequency.value=3100;m.frequency.value=38;mg.gain.value=120;m.connect(mg);mg.connect(o.frequency);
  g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(.12,t+.02);g.gain.setValueAtTime(.12,t+.35);g.gain.exponentialRampToValueAtTime(.001,t+.5);
  o.connect(g);g.connect(this.pan(x,1.5,-33));o.start(t);m.start(t);o.stop(t+.55);m.stop(t+.55)},
 listen(x,y,z){const l=this.ctx&&this.ctx.listener;if(!l)return;try{l.positionX.value=x;l.positionY.value=y;l.positionZ.value=z}catch(e){l.setPosition&&l.setPosition(x,y,z)}},
 stop(){clearInterval(this.timer);if(this.ctx)this.ctx.close();this.ctx=null}
};
