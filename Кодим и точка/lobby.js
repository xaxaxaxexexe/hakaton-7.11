(function(root) {
  // The hand-drawn plan: 4/1 on one wall, 2/3/5 opposite, 6/7 after the turn.
  const doors = [
    {hall:4,x:-3.92,z:7,side:'left'}, {hall:1,x:-3.92,z:13,side:'left'},
    {hall:2,x:3.92,z:7,side:'right'}, {hall:3,x:3.92,z:13,side:'right'},
    {hall:5,x:3.92,z:19,side:'right'}, {hall:6,x:9,z:27.92,side:'end'},
    {hall:7,x:16,z:27.92,side:'end'},
  ];
  function valid(x,z) {
    const inside=(x> -3.75&&x<3.75&&z>0.25&&z<27.75)||(x> -3.75&&x<19.75&&z>22.25&&z<27.75);
    return inside && !(x>1.4&&x<3.8&&z>0.8&&z<4.7);
  }
  function move(p,dx,dz) {
    let {x,z}=p; const n=Math.max(1,Math.ceil(Math.hypot(dx,dz)/.06));
    for(let i=0;i<n;i++){if(valid(x+dx/n,z))x+=dx/n;if(valid(x,z+dz/n))z+=dz/n;}
    return {x,z};
  }
  function nearest(p) {
    if(Math.hypot(p.x-1.4,p.z-3.2)<2.5)return {type:'bar',title:'Кассы и фуд-корт'};
    const door=doors.find(d=>Math.hypot(d.x-p.x,d.z-p.z)<2.1);
    return door?{type:'door',...door}:null;
  }
  function build(T) {
    const scene=new T.Scene();scene.background=new T.Color('#0d1611');scene.fog=new T.Fog('#0d1611',25,50);
    const material=(color,roughness=.8)=>{const m=new T.MeshStandardMaterial({color,roughness});m.color.convertSRGBToLinear();return m;};
    const floor=material('#5a505c'),wall=material('#314138'),purple=material('#0d4a2c'),black=material('#171e1a'),counter=material('#63776c'),gold=material('#ad8b57');
    const light=new T.MeshBasicMaterial({color:'#f0fbe6'}),orange=new T.MeshBasicMaterial({color:'#16a34a'});
    const box=new T.BoxGeometry(1,1,1);
    function block(x,y,z,w,h,d,m){const o=new T.Mesh(box,m);o.position.set(x,y,z);o.scale.set(w,h,d);scene.add(o);return o;}
    function sign(text,x,y,z,width=2,angle=0,color='#ffffff',bg='#132f20') {
      const c=document.createElement('canvas');c.width=1024;c.height=256;const g=c.getContext('2d');
      g.fillStyle=bg;g.fillRect(0,0,1024,256);g.fillStyle=color;g.font='bold 88px sans-serif';g.textAlign='center';g.fillText(text,512,160,970);
      const t=new T.CanvasTexture(c);t.encoding=T.sRGBEncoding;
      const mesh=new T.Mesh(new T.PlaneGeometry(width,width/4),new T.MeshBasicMaterial({map:t}));mesh.position.set(x,y,z);mesh.rotation.y=angle;scene.add(mesh);return mesh;
    }
    scene.add(new T.HemisphereLight('#d9ffeb','#425a4d',1));
    const sun=new T.PointLight('#e0f5c0',1.4,18);sun.position.set(0,3.4,4);scene.add(sun);
    const turnLight=new T.PointLight('#a5ffcf',1.5,22);turnLight.position.set(2,3.6,23);scene.add(turnLight);
    block(0,-.12,14,8,.24,28,floor);block(12,-.12,25,16,.24,6,floor);
    block(0,4.5,14,8,.2,28,black);block(12,4.5,25,16,.2,6,black);
    block(-4,2.2,14,.16,4.4,28,wall);block(4,2.2,11,.16,4.4,22,wall);
    block(8,2.2,28,24,4.4,.16,wall);block(12,2.2,22,16,4.4,.16,wall);
    block(20,2.2,25,.16,4.4,6,wall);block(0,2.2,0,8,4.4,.16,wall);
    for(let z=3;z<28;z+=4){block(0,4.35,z,5,.03,.06,light);block(-3.88,.2,z,.02,.035,3.8,orange);}
    for(let x=6;x<20;x+=4)block(x,4.35,25,.06,.03,4,light);
    const hallSigns=[];
    for(const d of doors) {
      const side=d.side==='left'?1:d.side==='right'?-1:0;
      const mesh=block(d.x,1.35,d.z,side?.12:1.65,2.7,side?1.65:.12,black);
      const label=sign('СЕКТОР '+d.hall,d.x+side*.1,3.1,d.z+(side?0:-.1),2,side?side*Math.PI/2:Math.PI);
      label.material.toneMapped=false;
      const frameMaterial=new T.MeshBasicMaterial({color:'#3f6b52'});
      const frame=block(d.x+side*.05,1.35,d.z+(side?0:-.05),side?.12:1.9,2.95,side?1.9:.12,frameMaterial);
      // The door sits in front of its coloured frame when seen from the corridor.
      mesh.position.x+=side*.09;mesh.position.z+=side?0:-.09;
      hallSigns.push({hall:d.hall,label,frame});
      block(d.x+side*.08,.07,d.z+(side?0:-.1),side?.06:1.65,.04,side?1.65:.06,orange);
      mesh.userData.hall=d.hall;
    }
    block(2.7,.55,2.8,2.1,1.1,3.2,counter);block(2.7,1.13,2.8,2.25,.12,3.3,black);
    sign('ФУД-КОРТ',2.7,2.7,1.1,2.3,Math.PI,'#e6f7d0','#0d4a2c');
    sign('КАССЫ',2.7,1.95,4.45,2.3,0);
    sign('ХОТ-ДОГИ · НАПИТКИ',2.7,.65,4.48,2.1,0,'#fff','#0d4a2c');
    // Popcorn buckets and bottles visible on the counter.
    const red=material('#d82b24'),yellow=material('#ddf6a2');
    for(let i=0;i<3;i++){
      const h=.28+i*.12; const cup=new T.Mesh(new T.CylinderGeometry(.14+i*.035,.11+i*.025,h,24),i===1?purple:red);cup.position.set(2.1+i*.55,1.21+h/2,3.8);scene.add(cup);
      for(let j=0;j<9;j++){const p=new T.Mesh(new T.SphereGeometry(.055,7,5),yellow);p.position.set(cup.position.x+Math.cos(j*2.4)*.1,1.21+h+.015,3.8+Math.sin(j*2.4)*.1);scene.add(p);}
    }
    for(let i=0;i<3;i++){const bottle=new T.Mesh(new T.CylinderGeometry(.07,.09,.4,16),[gold,black,purple][i]);bottle.position.set(2+i*.35,1.4,2);scene.add(bottle);}
    block(6,1.3,22.12,2.5,2.6,.15,black);sign('ГАРДЕРОБ',6,3,22.25,2.6);
    for(let i=0;i<5;i++)block(5+i*.5,2,22.3,.05,.5,.2,gold);
    sign('СЕКТОРА 6–7  →',0,3.2,21.9,3.4,Math.PI);
    sign('АРЕНА 3D',0,3.1,.15,4);
    function highlightHall(hall){for(const s of hallSigns){const selected=s.hall===hall;s.frame.material.color.set(selected?'#c8f03a':'#3f6b52');s.label.material.color.set(selected?'#eaffa0':'#ffffff');}}
    return {scene,doors,highlightHall};
  }
  const value={doors,move,valid,nearest,build};
  if(typeof module!=='undefined')module.exports=value;else root.StadiumLobby=value;
})(typeof window==='undefined'?globalThis:window);
