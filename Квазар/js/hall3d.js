// 3D-вид с трибуны. Создаётся только по кнопке и полностью удаляется при выключении.
// Перед первым рядом поле 105 × 68 м (бровка у z = 1, центр поля на z = -33), напротив и за воротами трибуны с болельщиками.
const PITCH={L:105,W:68,near:1};PITCH.cz=PITCH.near-PITCH.W/2;
const Hall3D={r:null,sc:null,cam:null,eye:null,mats:{},ox:0,oy:0,
 on(box){if(!window.THREE)return false;const T=THREE;box.innerHTML="";this.r=new T.WebGLRenderer({antialias:true});box.append(this.r.domElement);
  this.cam=new T.PerspectiveCamera(62,4/3,.1,500);this.ro=new ResizeObserver(()=>{this.r.setSize(box.clientWidth,box.clientHeight,false);this.cam.aspect=box.clientWidth/box.clientHeight;this.cam.updateProjectionMatrix();this.draw()});this.ro.observe(box);
  let d=null;const cv=this.r.domElement,k=(v,m)=>Math.max(-m,Math.min(m,v));cv.onpointerdown=e=>d=[e.clientX,e.clientY];cv.onpointerup=()=>d=null;
  cv.onpointermove=e=>{if(!d)return;this.ox=k(this.ox-(e.clientX-d[0])*.12,60);this.oy=k(this.oy+(e.clientY-d[1])*.06,14);d=[e.clientX,e.clientY];this.draw()};return true},
 off(){if(!this.r)return;cancelAnimationFrame(this.tw);this.ro.disconnect();this.r.dispose();this.r.domElement.remove();this.r=this.sc=this.eye=null},
 pitchTex(){const run=5,k=12,cv=document.createElement("canvas");cv.width=(PITCH.L+run*2)*k;cv.height=(PITCH.W+run*2)*k;const g=cv.getContext("2d"),X=m=>(run+m)*k;
  g.fillStyle="#23703a";g.fillRect(0,0,cv.width,cv.height);for(let i=0;i<18;i++){g.fillStyle=i%2?"#2f8a45":"#2a7e3f";g.fillRect(X(i*PITCH.L/18),X(0),PITCH.L/18*k+1,PITCH.W*k)}
  g.strokeStyle="#f4f7f2";g.fillStyle="#f4f7f2";g.lineWidth=3;const mx=PITCH.L/2,my=PITCH.W/2,R=(x,y,w,h)=>g.strokeRect(X(x),X(y),w*k,h*k),A=(x,y,r,a=0,b=7)=>{g.beginPath();g.arc(X(x),X(y),r*k,a,b);g.stroke()};
  R(0,0,PITCH.L,PITCH.W);g.beginPath();g.moveTo(X(mx),X(0));g.lineTo(X(mx),X(PITCH.W));g.stroke();A(mx,my,9.15);
  [[0,1],[PITCH.L,-1]].forEach(([gx,s])=>{R(s>0?gx:gx-16.5,my-20.16,16.5,40.32);R(s>0?gx:gx-5.5,my-9.16,5.5,18.32);const a=Math.acos(5.5/9.15);s>0?A(11,my,9.15,-a,a):A(gx-11,my,9.15,Math.PI-a,Math.PI+a)});
  const t=new THREE.CanvasTexture(cv);t.anisotropy=8;return t},
 crowdTex(){const cv=document.createElement("canvas");cv.width=1024;cv.height=512;const g=cv.getContext("2d"),C=["#1fa35a","#1fa35a","#f4f4f0","#0f3d24","#e8ff3a","#2d3a33"];g.fillStyle="#141c18";g.fillRect(0,0,1024,512);
  for(let r=0;r<40;r++)for(let i=0;i<205;i++){if(Math.random()<.15)continue;g.fillStyle=C[Math.random()*C.length|0];g.beginPath();g.arc(i*5+2.5,r*12.8+6,4,0,7);g.fill()}
  const t=new THREE.CanvasTexture(cv);t.wrapS=THREE.RepeatWrapping;t.repeat.set(5,1);return t},
 boardTex(){const cv=document.createElement("canvas");cv.width=2048;cv.height=64;const g=cv.getContext("2d"),it=[["МАТЧВИД","#0b120e","#3ddc84"],["КУБОК РЕСПУБЛИКИ","#1fa35a","#fff"],["БИЛЕТ С ВИДОМ НА ПОЛЕ","#f4f4f0","#0b120e"],["МАТЧ ДНЯ","#0b120e","#e8ff3a"]];
  it.forEach(([s,b,f],i)=>{g.fillStyle=b;g.fillRect(i*512,0,512,64);g.fillStyle=f;g.font="bold 34px sans-serif";g.textAlign="center";g.textBaseline="middle";g.fillText(s,i*512+256,34)});
  const t=new THREE.CanvasTexture(cv);t.wrapS=THREE.RepeatWrapping;t.repeat.set(3,1);return t},
 build(c,taken,sel){const T=THREE,sc=this.sc=new T.Scene(),M=x=>new T.MeshLambertMaterial({color:x}),B=x=>new T.MeshBasicMaterial({color:x}),add=(g,m,x,y,z)=>{const o=new T.Mesh(g,m);o.position.set(x,y,z);sc.add(o);return o};
  sc.background=new T.Color(0x070d16);sc.fog=new T.Fog(0x070d16,150,320);sc.add(new T.HemisphereLight(0xc4d4ff,0x1d3a26,.9));const dl=new T.DirectionalLight(0xffffff,.7);dl.position.set(20,80,30);sc.add(dl);
  // земля, поле, ворота, борта
  add(new T.PlaneGeometry(320,320),M(0x18261d),0,-.35,PITCH.cz).rotation.x=-Math.PI/2;
  add(new T.PlaneGeometry(PITCH.L+10,PITCH.W+10),new T.MeshBasicMaterial({map:this.pitchTex()}),0,-.3,PITCH.cz).rotation.x=-Math.PI/2;
  const wht=B(0xffffff);[-1,1].forEach(s=>{const gx=s*PITCH.L/2;[-1,1].forEach(p=>add(new T.BoxGeometry(.15,2.44,.15),wht,gx,.9,PITCH.cz+p*3.66));add(new T.BoxGeometry(.15,.15,7.5),wht,gx,2.1,PITCH.cz);
   add(new T.BoxGeometry(2,2.44,7.3),new T.MeshBasicMaterial({color:0xffffff,wireframe:true,transparent:true,opacity:.25}),gx+s*1.05,.9,PITCH.cz)});
  const bm=new T.MeshBasicMaterial({map:this.boardTex()});add(new T.BoxGeometry(PITCH.L+6,.9,.12),bm,0,.15,PITCH.cz-PITCH.W/2-4);
  [-1,1].forEach(s=>{add(new T.BoxGeometry(PITCH.W,.9,.12),bm,s*(PITCH.L/2+5),.15,PITCH.cz).rotation.y=Math.PI/2});
  // игроки и мяч
  const F=[[-50,0],[-36,-24],[-38,-8],[-38,8],[-36,24],[-20,-22],[-22,-7],[-22,7],[-20,22],[-7,-6],[-7,6]],body=new T.BoxGeometry(.55,1.8,.35);
  F.forEach(([x,z],i)=>[[1,i?0x1fa35a:0xfacc15],[-1,i?0xf4f4f0:0x111827]].forEach(([s,col])=>add(body,M(col),s*x+Math.sin(i*2.1)*3,.6,PITCH.cz+s*z+Math.cos(i*1.3)*2)));
  add(new T.SphereGeometry(.25,12,10),wht,4,-.05,PITCH.cz+3);
  // трибуны напротив и за воротами
  const crowd=new T.MeshLambertMaterial({map:this.crowdTex(),emissive:0x223322}),lamp=B(0xfffbe8),roof=M(0x101a14);
  const stand=(w,x,z,ry,rise=24,depth=36)=>{const g=new T.Group(),len=Math.hypot(rise,depth),th=Math.atan2(rise,depth),p=new T.Mesh(new T.PlaneGeometry(w,len),crowd);
   p.rotation.x=-(Math.PI/2-th);p.position.set(0,rise/2,-depth/2);const rf=new T.Mesh(new T.BoxGeometry(w,.6,20),roof);rf.position.set(0,rise+7,-depth+4);
   const st=new T.Mesh(new T.BoxGeometry(w*.95,.4,.4),lamp);st.position.set(0,rise+6.6,-depth+14);g.add(p,rf,st);g.position.set(x,-.3,z);g.rotation.y=ry;sc.add(g)};
  stand(150,0,PITCH.cz-PITCH.W/2-7,0);stand(96,PITCH.L/2+9,PITCH.cz,-Math.PI/2,18,28);stand(96,-PITCH.L/2-9,PITCH.cz,Math.PI/2,18,28);
  [[-76,14],[76,14],[-76,PITCH.cz-46],[76,PITCH.cz-46]].forEach(([x,z])=>{add(new T.CylinderGeometry(.4,.7,46,8),M(0x2b3430),x,23,z);add(new T.BoxGeometry(9,4,.5),lamp,x,47,z).lookAt(0,0,PITCH.cz)});
  // своя трибуна: ступени тянутся влево и вправо, в соседних секторах болельщики
  const L=c.rows.length-1,cloth=[0x1fa35a,0xf4f4f0,0x0f3d24,0xe8ff3a,0x1fa35a,0x2d3a33],skin=[0xe0b896,0xc9a07c,0x8f6a4f,0xf0d2b6];this.mats={};
  const hs=s=>{let h=0;for(const ch of s)h=(h*31+ch.charCodeAt(0))>>>0;return h},conc=M(0x3f4641);
  let half=0;c.rows.forEach((n,r)=>{const[x]=seatPos(c,r,n-1);half=Math.max(half,x+1)});
  const fanGeo=new T.BoxGeometry(.5,.95,.35),fans=[];
  c.rows.forEach((n,r)=>{const[,y,z]=seatPos(c,r,0);const h=y+.3;add(new T.BoxGeometry(120,h,1.15),conc,0,h/2-.3,z+.2);
   for(let x=half+1;x<58;x+=.75)[-1,1].forEach(s=>{if(Math.random()<.8)fans.push([s*x,y+.75,z+.1])})});
  if(fans.length){const im=new T.InstancedMesh(fanGeo,new T.MeshLambertMaterial(),fans.length),m4=new T.Matrix4(),col=new T.Color();
   fans.forEach(([x,y,z],i)=>{m4.makeTranslation(x,y,z);im.setMatrixAt(i,m4);im.setColorAt(i,col.setHex(cloth[i*7%cloth.length]))});sc.add(im)}
  c.rows.forEach((n,r)=>{
   for(let i=0;i<n;i++){const id=r+"-"+i,[x,y,z]=seatPos(c,r,i),w=r==L?1.55:.78,base=r==L?0xd9dde0:0x1c8a4c,m=M(base);m.userData.base=base;this.mats[id]=m;
    const dark=M(0x1b221e);add(new T.BoxGeometry(r==L?w:.12,.3,r==L?.7:.3),dark,x,y+.2,z);add(new T.BoxGeometry(w-.06,.12,.55),m,x,y+.43,z-.02);
    const bk=add(new T.BoxGeometry(w-.06,r==L?.85:.5,.1),m,x,y+(r==L?.88:.7),z+.27);bk.rotation.x=-.12;
    if(r==L)[-1,1].forEach(s=>add(new T.BoxGeometry(.07,.34,.6),dark,x+s*(w/2-.02),y+.58,z));
    if(taken.has(id)){const q=hs(id),sk=M(skin[q%4]),cl=M(cloth[q%6]);
     add(new T.BoxGeometry(.5,.62,.3),cl,x,y+.95,z+.1);add(new T.SphereGeometry(.18,14,10),sk,x,y+1.5,z+.12);
     add(new T.SphereGeometry(.19,14,8,0,6.3,0,1.6),M(0x1c1f26),x,y+1.53,z+.14);
     [-1,1].forEach(s=>add(new T.BoxGeometry(.12,.12,.45),cl,x+s*.3,y+.78,z-.1))}}});
  // ложи наверху: стеклянный парапет
  const[,ly,lz]=seatPos(c,L,0);add(new T.BoxGeometry(120,1,.06),new T.MeshLambertMaterial({color:0x9fd8b8,transparent:true,opacity:.2}),0,ly+.5,lz-.6);
  this.paint(sel)},
 paint(sel){for(const id in this.mats)this.mats[id].color.setHex(sel.includes(id)?0xe8ff3a:this.mats[id].userData.base);this.draw()},
 draw(){if(!this.r||!this.sc)return;const e=this.eye||new THREE.Vector3(0,16,26);this.cam.position.copy(e);this.cam.lookAt(this.eye?e.x*.4+this.ox:0,this.eye?this.oy-.3:2,PITCH.cz*(this.eye?1:.35));this.r.render(this.sc,this.cam)},
 view(c,id){if(!this.r)return;this.ox=this.oy=0;const[r,i]=id.split("-").map(Number),[x,y,z]=seatPos(c,r,i),to=new THREE.Vector3(x,y+1.4,z),from=(this.eye||new THREE.Vector3(0,16,26)).clone(),t0=performance.now();
  cancelAnimationFrame(this.tw);const st=n=>{const k=Math.min(1,(n-t0)/500);this.eye=new THREE.Vector3().lerpVectors(from,to,k);this.draw();if(k<1)this.tw=requestAnimationFrame(st)};this.tw=requestAnimationFrame(st)}
};
