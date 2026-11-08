const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const hall=require('./hall-model.js'),T=require('./vendor/three.min.js');
const {synthesize}=require('./stadium-audio.js');
const {createApp}=require('./server.cjs');

test('enlarged screen and its frame fit inside the hall, clear of the first row',()=>{
  const {screen,room}=hall.config;
  assert.equal(screen.width/12.4,1.8);
  assert(Math.abs(screen.height/5.17-1.8)<1e-12);
  assert(screen.width+.32<room.width-.4);
  assert(screen.y-screen.height/2-.16>1);
  assert(screen.y+screen.height/2+.16<room.height-.1);
  assert(screen.z-.21>room.front+.1);
  assert(hall.get('1-1').z-screen.z>9);
  const context={window:{},document:{createElement:()=>({getContext:()=>({fillRect(){},fillText(){}})})}};
  vm.runInNewContext(fs.readFileSync('hall-scene.js','utf8'),context);
  const scene=context.window.createStadiumSector(T,hall,()=>new T.Texture());
  scene.scene.updateMatrixWorld(true);
  const bounds=new T.Box3().setFromObject(scene.screen);
  assert(Math.abs(bounds.getSize(new T.Vector3()).x-screen.width)<.00001);
  assert.equal(scene.screen.material.toneMapped,false);
  const direction=new T.Vector3(0,screen.y,screen.z).sub(new T.Vector3(0,3,18)).normalize();
  const hits=new T.Raycaster(new T.Vector3(0,3,18),direction).intersectObjects(scene.scene.children);
  assert.equal(hits[0].object,scene.screen,'screen centre must be visible from the back');
  assert(scene.projector.position.z>hall.get('8-1').z+2);
  assert(scene.projector.position.y>hall.get('8-1').y+2);
});

test('expanded floor permits walking along both new walls without escaping the room',()=>{
  for(const x of [-11,11]){
    const p=hall.move({x,z:2},0,16);
    assert(Math.abs(p.z-18)<.001);
    assert(hall.canStand(p.x,p.z));
  }
  const p=hall.move({x:0,z:2},100,-100);
  assert(hall.canStand(p.x,p.z));
  assert(p.z>hall.config.screen.z+.5);
  assert(p.x<hall.config.room.width/2-.2);
});

test('all six synthesized sound buffers are quiet, finite, non-silent and seamless',()=>{
  for(const kind of ['lobby','bar','entrance','hall','projector','ventilation']){
    const data=synthesize(kind);let peak=0,power=0;
    for(const value of data){assert(Number.isFinite(value));peak=Math.max(peak,Math.abs(value));power+=value*value;}
    const rms=Math.sqrt(power/data.length);
    assert(peak<.4,kind+' peak');assert(rms>.01&&rms<.08,kind+' RMS');
    assert.equal(Math.abs(data[0]),0);assert.equal(Math.abs(data.at(-1)),0);
    assert.equal(data.length,144000);
  }
});

test('audio remains optional and does not create an AudioContext before a trusted gesture',()=>{
  const listeners={},button={textContent:'',setAttribute(){},addEventListener(type,fn){listeners[type]=fn;}};
  let constructed=0;
  const root={document:{hidden:false,addEventListener(){}},addEventListener(){},localStorage:{getItem(){throw Error('storage blocked');}}};
  vm.runInNewContext(fs.readFileSync('stadium-audio.js','utf8'),{window:root,clearTimeout,setTimeout});
  const T={AudioListener:class{constructor(){constructed++;throw Error('unsupported');}}};
  let audio=root.StadiumAudio.create(T,{}, {},button);
  audio.setState({active:true,paused:false,location:'lobby'});
  assert.equal(button.disabled,true);assert.equal(button.textContent,'Звук выключен');
  root.AudioContext=function(){};
  audio=root.StadiumAudio.create(T,{}, {},button);
  audio.setState({active:true,paused:false,location:'hall'});
  assert.equal(button.disabled,false);assert.equal(constructed,0);
  listeners.click({isTrusted:false});assert.equal(constructed,0);
});

test('server serves local audio code and match cards without exposing private files',async t=>{
  const app=createApp({dbPath:':memory:',env:{PAYMENT_MODE:'demo'}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>app.close(resolve)));
  const base='http://127.0.0.1:'+app.address().port;
  for(const file of ['/stadium-audio.js','/assets/match-m1.svg'])assert.equal((await fetch(base+file)).status,200,file);
  for(const file of ['/presentation.test.cjs','/assets/../server.cjs','/.data/orders.sqlite'])assert.equal((await fetch(base+file)).status,404,file);
});
