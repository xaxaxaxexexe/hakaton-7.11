/* Stadium sector: instanced stand seats, the pitch below row 1, opposite stands, floodlights and a scoreboard. */
window.createStadiumSector = function(T, model, screenTexture) {
  const scene = new T.Scene(); scene.background = new T.Color('#070d16');
  const material = (color, roughness=.75, metalness=0) => {
    const m = new T.MeshStandardMaterial({color, roughness, metalness});m.color.convertSRGBToLinear();return m;
  };
  const basic = (color) => new T.MeshBasicMaterial({color});
  const concrete=material('#454b47',.95),dark=material('#141c18'),plastic=material('#ffffff',.42),
    metal=material('#59605c',.3,.7),lime=basic('#e8ff3a'),white=basic('#f4f7f2'),lamp=basic('#fffbe8');
  const box=new T.BoxGeometry(1,1,1);
  const {room,screen:screenSize,projector:projectorPosition,field}=model.config;
  const block=(x,y,z,w,h,d,m)=>{const o=new T.Mesh(box,m);o.position.set(x,y,z);o.scale.set(w,h,d);scene.add(o);return o;};
  scene.add(new T.HemisphereLight('#c4d4ff','#1d3a26',.9));
  const sun=new T.DirectionalLight('#fffaf0',.9);sun.position.set(20,80,-20);scene.add(sun);
  // Canvas textures: pitch markings, crowd and advertising boards.
  const canvasTexture=(w,h,draw,repeat)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');draw(g,w,h);const t=new T.CanvasTexture(c);t.encoding=T.sRGBEncoding;if(repeat){t.wrapS=T.RepeatWrapping;t.repeat.set(repeat,1);}return t;};
  const pitchTexture=canvasTexture(1380,936,(g)=>{const k=12,run=5,X=m=>(run+m)*k;
    g.fillStyle='#23703a';g.fillRect(0,0,1380,936);for(let i=0;i<18;i++){g.fillStyle=i%2?'#2f8a45':'#2a7e3f';g.fillRect(X(i*field.length/18),X(0),field.length/18*k+1,field.width*k);}
    if(!g.strokeRect)return;g.strokeStyle='#f4f7f2';g.lineWidth=3;const mx=field.length/2,my=field.width/2,R=(x,y,w,h)=>g.strokeRect(X(x),X(y),w*k,h*k),A=(x,y,r,a=0,b=7)=>{g.beginPath();g.arc(X(x),X(y),r*k,a,b);g.stroke();};
    R(0,0,field.length,field.width);g.beginPath();g.moveTo(X(mx),X(0));g.lineTo(X(mx),X(field.width));g.stroke();A(mx,my,9.15);
    for(const [gx,s] of [[0,1],[field.length,-1]]){R(s>0?gx:gx-16.5,my-20.16,16.5,40.32);R(s>0?gx:gx-5.5,my-9.16,5.5,18.32);const a=Math.acos(5.5/9.15);if(s>0)A(11,my,9.15,-a,a);else A(gx-11,my,9.15,Math.PI-a,Math.PI+a);}});
  const crowdTexture=canvasTexture(1024,512,(g)=>{const C=['#1fa35a','#1fa35a','#f4f4f0','#0f3d24','#e8ff3a','#2d3a33'];g.fillStyle='#141c18';g.fillRect(0,0,1024,512);
    if(!g.arc)return;for(let r=0;r<40;r++)for(let i=0;i<205;i++){if(Math.random()<.15)continue;g.fillStyle=C[Math.random()*C.length|0];g.beginPath();g.arc(i*5+2.5,r*12.8+6,4,0,7);g.fill();}},5);
  const boardTexture=canvasTexture(2048,64,(g)=>{[['АРЕНА 3D','#0b120e','#3ddc84'],['БИЛЕТ С ВИДОМ НА ПОЛЕ','#1fa35a','#ffffff'],['ПРЕМЬЕР-ЛИГА','#f4f4f0','#0b120e'],['ГОРЦЫ','#0b120e','#e8ff3a']].forEach(([s,b,f],i)=>{g.fillStyle=b;g.fillRect(i*512,0,512,64);g.fillStyle=f;g.font='bold 34px sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillText(s,i*512+256,34);});},3);
  // Pitch, goals and boards. The pitch sits below the stand; the long side faces the sector.
  const pitch=new T.Mesh(new T.PlaneGeometry(field.length+10,field.width+10),new T.MeshBasicMaterial({map:pitchTexture}));
  pitch.rotation.x=-Math.PI/2;pitch.position.set(0,field.y,field.z);scene.add(pitch);
  block(0,field.y-.05,field.z+10,320,.05,320,dark);
  for(const s of [-1,1]){const gx=s*field.length/2;for(const p of [-1,1])block(gx,field.y+1.22,field.z+p*3.66,.15,2.44,.15,white);block(gx,field.y+2.44,field.z,.15,.15,7.5,white);
    const net=new T.Mesh(new T.BoxGeometry(2,2.44,7.3,4,6,14),new T.MeshBasicMaterial({color:'#ffffff',wireframe:true,transparent:true,opacity:.25}));net.position.set(gx+s*1.05,field.y+1.22,field.z);scene.add(net);}
  const boardMat=new T.MeshBasicMaterial({map:boardTexture});
  block(0,field.y+.45,field.z-field.width/2-4,field.length+6,.9,.12,boardMat);
  for(const s of [-1,1])block(s*(field.length/2+5),field.y+.45,field.z,.12,.9,field.width,boardMat);
  // Players and ball, a frozen moment of the match.
  const formation=[[-50,0],[-36,-24],[-38,-8],[-38,8],[-36,24],[-20,-22],[-22,-7],[-22,7],[-20,22],[-7,-6],[-7,6]];
  formation.forEach(([x,z],i)=>{for(const [s,c] of [[1,i?'#1fa35a':'#facc15'],[-1,i?'#f4f4f0':'#111827']])block(s*x+Math.sin(i*2.1)*3,field.y+.9,field.z+s*z+Math.cos(i*1.3)*2,.55,1.8,.35,material(c,.6));});
  const ball=new T.Mesh(new T.SphereGeometry(.25,12,10),white);ball.position.set(4,field.y+.25,field.z+3);scene.add(ball);
  // Opposite and end stands with crowd, roof and light strips.
  const crowd=new T.MeshStandardMaterial({map:crowdTexture,roughness:.9,emissive:'#223322'});
  const stand=(w,x,z,ry,rise=26,depth=38)=>{const g=new T.Group(),len=Math.hypot(rise,depth),th=Math.atan2(rise,depth);
    const slope=new T.Mesh(new T.PlaneGeometry(w,len),crowd);slope.rotation.x=-(Math.PI/2-th);slope.position.set(0,rise/2,-depth/2);
    const roof=new T.Mesh(box,dark);roof.scale.set(w,.6,20);roof.position.set(0,rise+7,-depth+4);
    const strip=new T.Mesh(box,lamp);strip.scale.set(w*.95,.4,.4);strip.position.set(0,rise+6.6,-depth+14);
    g.add(slope,roof,strip);g.position.set(x,field.y,z);g.rotation.y=ry;scene.add(g);};
  stand(150,0,field.z-field.width/2-8,0);stand(96,field.length/2+9,field.z,-Math.PI/2,20,30);stand(96,-field.length/2-9,field.z,Math.PI/2,20,30);
  for(const [x,z] of [[-78,8],[78,8],[-78,field.z-46],[78,field.z-46]]){const mast=new T.Mesh(new T.CylinderGeometry(.4,.7,48,8),metal);mast.position.set(x,field.y+24,z);scene.add(mast);
    const head=new T.Mesh(box,lamp);head.scale.set(9,4,.5);head.position.set(x,field.y+49,z);head.lookAt(0,field.y,field.z);scene.add(head);}
  // Own stand: front wall above the pitch, concrete steps continuing into the neighbouring sectors.
  const depth=room.back-room.front,centerZ=(room.back+room.front)/2;
  block(0,-.14,centerZ,room.width,.28,depth,concrete);
  block(0,(field.y-.28)/2,room.front-.1,160,-field.y,.4,dark);
  block(0,.5,room.front+.15,160,1,.06,new T.MeshStandardMaterial({color:'#9fd8b8',transparent:true,opacity:.22}));
  for(let row=2;row<=8;row++){
    const start=3.97+(row-1)*model.config.rowGap,end=row===8?19.8:start+model.config.rowGap,y=(row-1)*model.config.rise;
    block(0,y/2,(start+end)/2,room.width-.2,y,end-start,concrete);
    for(const s of [-1,1])block(s*(room.width/2+30),y/2,(start+end)/2,60,y,end-start,concrete);
    for(const x of [-6.75,6.75])block(x,y+.012,start+.018,1.85,.025,.045,lime);
  }
  {const end=3.97+model.config.rowGap;for(const s of [-1,1])block(s*(room.width/2+30),-.14,(room.front+end)/2,60,.28,end-room.front,concrete);}
  // Fans in the neighbouring sectors.
  const fanColors=['#1fa35a','#f4f4f0','#0f3d24','#e8ff3a','#1fa35a','#2d3a33'],fans=[];
  for(let row=1;row<=8;row++){const z=5+(row-1)*model.config.rowGap,y=(row-1)*model.config.rise;
    for(let x=room.width/2+1;x<58;x+=.8)for(const s of [-1,1])if(Math.random()<.8)fans.push([s*x,y+.75,z+.1]);}
  const fanMesh=new T.InstancedMesh(new T.BoxGeometry(.5,.95,.35),new T.MeshStandardMaterial({roughness:.7}),fans.length),fanDummy=new T.Object3D(),fanColor=new T.Color();
  fans.forEach((p,i)=>{fanDummy.position.set(...p);fanDummy.updateMatrix();fanMesh.setMatrixAt(i,fanDummy.matrix);fanMesh.setColorAt(i,fanColor.set(fanColors[i%fanColors.length]));});scene.add(fanMesh);
  // Back wall with the exit to the concourse.
  block(0,room.height/4,room.back,room.width,room.height/2,.2,dark);
  for(const side of [-1,1])for(const x of [2.6,4,5.4])block(side*x,.48,3.3,.045,.96,.045,metal);
  for(const side of [-1,1]){block(side*4,.96,3.3,2.85,.045,.045,metal);block(side*4,.48,3.3,2.85,.03,.03,metal);}
  // Scoreboard above the opposite stand shows the selected match.
  const screen=new T.Mesh(new T.PlaneGeometry(screenSize.width,screenSize.height),new T.MeshBasicMaterial({map:screenTexture(),toneMapped:false}));
  const sy=3+(18-(-95))*(screenSize.y-3)/(18-screenSize.z);screen.position.set(0,sy,-95);scene.add(screen);
  block(0,sy,-95.2,screenSize.width+.8,screenSize.height+.8,.3,dark);
  // TV camera platform at the back of the sector.
  const projector=block(projectorPosition.x,projectorPosition.y,projectorPosition.z,1.3,.65,.8,metal);
  block(0,5.65,19.25,.16,.25,.2,dark);
  const lens=new T.Mesh(new T.CylinderGeometry(.13,.17,.16,24),dark);lens.rotation.x=Math.PI/2;lens.position.set(0,5.2,18.65);scene.add(lens);
  block(6.7,2.45,19.6,1.45,2.4,.16,dark);
  const c=document.createElement('canvas');c.width=512;c.height=128;const g=c.getContext('2d');g.fillStyle='#0d4a2c';g.fillRect(0,0,512,128);g.fillStyle='white';g.font='bold 62px sans-serif';g.textAlign='center';g.fillText('К ВЫХОДУ',256,86);
  const t=new T.CanvasTexture(c);t.encoding=T.sRGBEncoding;const exit=new T.Mesh(new T.PlaneGeometry(1.6,.4),new T.MeshBasicMaterial({map:t}));exit.position.set(6.7,3.95,19.48);exit.rotation.y=Math.PI;scene.add(exit);
  // Stadium seats: moulded plastic shell with a short back.
  const dummy=new T.Object3D();
  function instances(geometry,mat,items){const mesh=new T.InstancedMesh(geometry,mat,items.length);items.forEach((v,i)=>{dummy.position.set(...v.p);dummy.scale.set(...(v.s||[1,1,1]));dummy.rotation.set(v.rx||0,v.ry||0,0);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix);});scene.add(mesh);return mesh;}
  function rounded(w,h,d,r){const s=new T.Shape(),x=-w/2,y=-h/2;
    s.moveTo(x+r,y);s.lineTo(x+w-r,y);s.quadraticCurveTo(x+w,y,x+w,y+r);s.lineTo(x+w,y+h-r);s.quadraticCurveTo(x+w,y+h,x+w-r,y+h);s.lineTo(x+r,y+h);s.quadraticCurveTo(x,y+h,x,y+h-r);s.lineTo(x,y+r);s.quadraticCurveTo(x,y,x+r,y);
    const geo=new T.ExtrudeGeometry(s,{depth:d,bevelEnabled:true,bevelSize:.02,bevelThickness:.025,bevelSegments:2,steps:1,curveSegments:5});geo.translate(0,0,-d/2);return geo;
  }
  const backs=instances(rounded(.5,.5,.06,.08),plastic,model.seats.map(q=>({p:[q.x,q.y+.72,q.z+.2],rx:-.15})));
  const bases=instances(rounded(.5,.46,.08,.08),plastic,model.seats.map(q=>({p:[q.x,q.y+.43,q.z-.02],rx:-Math.PI/2})));
  instances(box,metal,model.seats.map(q=>({p:[q.x,q.y+.2,q.z+.05],s:[.08,.4,.3]})));
  const marker=new T.Mesh(new T.RingGeometry(.27,.30,32),new T.MeshBasicMaterial({color:'#e8ff3a',side:T.DoubleSide}));marker.rotation.x=-Math.PI/2;scene.add(marker);
  return {scene,screen,backs,bases,marker,projector};
};
