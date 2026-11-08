import * as T from 'three';
// Система координат: x вправо, y вверх, z от поля вглубь трибуны (бровка у z = -2). Камера = координаты места + рост сидящего.
// Поле 105 × 68 м лежит ниже первого ряда; напротив и за воротами трибуны с болельщиками.
const EYE = 1.15, FIELD = { L: 105, W: 68, y: -1.6, near: -2 };
FIELD.cz = FIELD.near - FIELD.W / 2;
const hash = n => ((n * 2654435761) % 4294967296 >>> 7) % 100;

function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'));
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) { t.wrapS = T.RepeatWrapping; t.repeat.set(repeat, 1); }
  return t;
}
const pitchTexture = () => canvasTex(1380, 936, x => {
  const k = 12, run = 5, X = m => (run + m) * k, mx = FIELD.L / 2, my = FIELD.W / 2;
  x.fillStyle = '#23703a'; x.fillRect(0, 0, 1380, 936);
  for (let i = 0; i < 18; i++) { x.fillStyle = i % 2 ? '#2f8a45' : '#2a7e3f'; x.fillRect(X(i * FIELD.L / 18), X(0), FIELD.L / 18 * k + 1, FIELD.W * k); }
  x.strokeStyle = '#f4f7f2'; x.lineWidth = 3;
  const R = (a, b, w, h) => x.strokeRect(X(a), X(b), w * k, h * k), A = (a, b, r, s = 0, e = 7) => { x.beginPath(); x.arc(X(a), X(b), r * k, s, e); x.stroke(); };
  R(0, 0, FIELD.L, FIELD.W); x.beginPath(); x.moveTo(X(mx), X(0)); x.lineTo(X(mx), X(FIELD.W)); x.stroke(); A(mx, my, 9.15);
  for (const [gx, s] of [[0, 1], [FIELD.L, -1]]) {
    R(s > 0 ? gx : gx - 16.5, my - 20.16, 16.5, 40.32); R(s > 0 ? gx : gx - 5.5, my - 9.16, 5.5, 18.32);
    const a = Math.acos(5.5 / 9.15); if (s > 0) A(11, my, 9.15, -a, a); else A(gx - 11, my, 9.15, Math.PI - a, Math.PI + a);
  }
});
const crowdTexture = () => canvasTex(1024, 512, x => {
  const C = ['#1fa35a', '#1fa35a', '#f4f4f0', '#0f3d24', '#e8ff3a', '#2d3a33']; x.fillStyle = '#141c18'; x.fillRect(0, 0, 1024, 512);
  for (let r = 0; r < 40; r++) for (let i = 0; i < 205; i++) { if (Math.random() < .15) continue; x.fillStyle = C[Math.random() * C.length | 0]; x.beginPath(); x.arc(i * 5 + 2.5, r * 12.8 + 6, 4, 0, 7); x.fill(); }
}, 5);
const boardTexture = () => canvasTex(2048, 64, x => {
  [['БИЛЕТ С ВИДОМ НА ПОЛЕ', '#0b120e', '#3ddc84'], ['D4C ARENA', '#1fa35a', '#fff'], ['ПРЕМЬЕР-ЛИГА', '#f4f4f0', '#0b120e'], ['ГОРЦЫ', '#0b120e', '#e8ff3a']]
    .forEach(([s, b, f], i) => { x.fillStyle = b; x.fillRect(i * 512, 0, 512, 64); x.fillStyle = f; x.font = 'bold 34px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(s, i * 512 + 256, 34); });
}, 3);

export function createView(host, hall, seats) {
  const r = new T.WebGLRenderer({ antialias: true }); // бросит исключение, если WebGL недоступен
  host.appendChild(r.domElement); r.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new T.Scene(); scene.background = new T.Color(0x070d16); scene.fog = new T.Fog(0x070d16, 150, 320);
  const cam = new T.PerspectiveCamera(65, 1, 0.1, 450), LAST = Math.max(...seats.map(s => s.z)) + 1;
  const M = c => new T.MeshLambertMaterial({ color: c }), B = c => new T.MeshBasicMaterial({ color: c });
  const box = (w, h, d, m, x, y, z) => { const o = new T.Mesh(new T.BoxGeometry(w, h, d), m); o.position.set(x, y, z); scene.add(o); return o; };
  scene.add(new T.HemisphereLight(0xc4d4ff, 0x1d3a26, 1.6)); const dl = new T.DirectionalLight(0xfffaf0, 1.4); dl.position.set(20, 80, 30); scene.add(dl);
  // поле, ворота, борта
  box(320, 0.05, 320, M(0x18261d), 0, FIELD.y - 0.05, FIELD.cz);
  const pitch = new T.Mesh(new T.PlaneGeometry(FIELD.L + 10, FIELD.W + 10), new T.MeshBasicMaterial({ map: pitchTexture() }));
  pitch.rotation.x = -Math.PI / 2; pitch.position.set(0, FIELD.y, FIELD.cz); scene.add(pitch);
  const wht = B(0xffffff);
  [-1, 1].forEach(s => { const gx = s * FIELD.L / 2; [-1, 1].forEach(p => box(0.15, 2.44, 0.15, wht, gx, FIELD.y + 1.22, FIELD.cz + p * 3.66)); box(0.15, 0.15, 7.5, wht, gx, FIELD.y + 2.44, FIELD.cz);
    const net = box(2, 2.44, 7.3, new T.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.25 }), gx + s * 1.05, FIELD.y + 1.22, FIELD.cz); net.geometry = new T.BoxGeometry(2, 2.44, 7.3, 4, 6, 14); });
  const bm = new T.MeshBasicMaterial({ map: boardTexture() });
  box(FIELD.L + 6, 0.9, 0.12, bm, 0, FIELD.y + 0.45, FIELD.cz - FIELD.W / 2 - 4);
  [-1, 1].forEach(s => box(0.12, 0.9, FIELD.W, bm, s * (FIELD.L / 2 + 5), FIELD.y + 0.45, FIELD.cz));
  // игроки и мяч
  const F = [[-50, 0], [-36, -24], [-38, -8], [-38, 8], [-36, 24], [-20, -22], [-22, -7], [-22, 7], [-20, 22], [-7, -6], [-7, 6]];
  F.forEach(([x, z], i) => [[1, i ? 0x1fa35a : 0xfacc15], [-1, i ? 0xf4f4f0 : 0x111827]].forEach(([s, c]) => box(0.55, 1.8, 0.35, M(c), s * x + Math.sin(i * 2.1) * 3, FIELD.y + 0.9, FIELD.cz + s * z + Math.cos(i * 1.3) * 2)));
  const ball = new T.Mesh(new T.SphereGeometry(0.25, 12, 10), wht); ball.position.set(4, FIELD.y + 0.25, FIELD.cz + 3); scene.add(ball);
  // трибуны напротив и за воротами, прожекторы
  const crowd = new T.MeshLambertMaterial({ map: crowdTexture(), emissive: 0x223322 }), lamp = B(0xfffbe8), roof = M(0x101a14);
  const stand = (w, x, z, ry, rise = 26, depth = 38) => {
    const g = new T.Group(), len = Math.hypot(rise, depth), th = Math.atan2(rise, depth);
    const p = new T.Mesh(new T.PlaneGeometry(w, len), crowd); p.rotation.x = -(Math.PI / 2 - th); p.position.set(0, rise / 2, -depth / 2);
    const rf = new T.Mesh(new T.BoxGeometry(w, 0.6, 20), roof); rf.position.set(0, rise + 7, -depth + 4);
    const st = new T.Mesh(new T.BoxGeometry(w * 0.95, 0.4, 0.4), lamp); st.position.set(0, rise + 6.6, -depth + 14);
    g.add(p, rf, st); g.position.set(x, FIELD.y, z); g.rotation.y = ry; scene.add(g);
  };
  stand(150, 0, FIELD.cz - FIELD.W / 2 - 8, 0); stand(96, FIELD.L / 2 + 9, FIELD.cz, -Math.PI / 2, 20, 30); stand(96, -FIELD.L / 2 - 9, FIELD.cz, Math.PI / 2, 20, 30);
  [[-78, 10], [78, 10], [-78, FIELD.cz - 46], [78, FIELD.cz - 46]].forEach(([x, z]) => {
    box(0.8, 48, 0.8, M(0x2b3430), x, FIELD.y + 24, z); box(9, 4, 0.5, lamp, x, FIELD.y + 49, z).lookAt(0, FIELD.y, FIELD.cz);
  });
  // своя трибуна: бетонные ступени тянутся в соседние сектора, там болельщики
  const conc = M(0x40463f);
  box(160, -FIELD.y, 0.4, M(0x141c18), 0, FIELD.y / 2, FIELD.near + 1.6);
  box(160, 0.2, 3.8, conc, 0, 0.1 - 0.2, 1.7 - 0.2);
  box(160, 1, 0.06, new T.MeshLambertMaterial({ color: 0x9fd8b8, transparent: true, opacity: 0.22 }), 0, 0.5, FIELD.near + 1.85);
  const rows = {}; seats.forEach(s => (rows[s.row_num] ||= []).push(s));
  const half = Math.max(...seats.map(s => Math.abs(s.x))) + 1.2, fanG = new T.BoxGeometry(0.5, 0.95, 0.35), fanC = [0x1fa35a, 0xf4f4f0, 0x0f3d24, 0xe8ff3a, 0x1fa35a, 0x2d3a33], fans = [];
  Object.values(rows).forEach(a => {
    const y = a[0].y, z = Math.min(...a.map(s => s.z)), sofa = a[0].seat_type === 'sofa';
    box(160, y + 0.2, 1.2, conc, 0, (y + 0.2) / 2 - 0.2, z + 0.1);
    if (sofa) box(160, 1, 0.06, new T.MeshLambertMaterial({ color: 0x9fd8b8, transparent: true, opacity: 0.25 }), 0, y + 0.5, z - 0.55);
    else for (let x = half; x < 60; x += 0.8) [-1, 1].forEach(s => { if (hash(Math.round(x * 10) * 7 + a[0].row_num * 131 + (s + 1) * 999) < 80) fans.push([s * x, y + 0.75, z + 0.1]); });
  });
  box(160, 3, 0.3, M(0x141c18), 0, Math.max(...seats.map(s => s.y)) + 1.2, LAST + 0.6);
  if (fans.length) {
    const im = new T.InstancedMesh(fanG, new T.MeshLambertMaterial(), fans.length), d = new T.Object3D(), col = new T.Color();
    fans.forEach(([x, y, z], i) => { d.position.set(x, y, z); d.updateMatrix(); im.setMatrixAt(i, d.matrix); im.setColorAt(i, col.setHex(fanC[i % fanC.length])); }); scene.add(im);
  }
  // места сектора: пластиковые сиденья, в ложах — мягкие кресла
  seats.forEach(s => {
    const sofa = s.seat_type === 'sofa', w = sofa ? 1.75 : 0.56, m = M(sofa ? 0xd9dde0 : 0x1c8a4c);
    box(w, sofa ? 0.35 : 0.12, sofa ? 0.55 : 0.45, m, s.x, s.y + (sofa ? 0.3 : 0.42), s.z); box(w, sofa ? 0.7 : 0.45, 0.08, m, s.x, s.y + (sofa ? 0.65 : 0.68), s.z + 0.25);
    if (!sofa) box(0.08, 0.38, 0.3, M(0x3a403c), s.x, s.y + 0.19, s.z);
  });
  const crowdG = new T.Group(); scene.add(crowdG); const headG = new T.SphereGeometry(0.13, 12, 10), bodyG = new T.BoxGeometry(0.42, 0.5, 0.22);
  let base = { yaw: 0, pitch: 0 }, off = { yaw: 0, pitch: 0 };
  const apply = () => cam.rotation.set(base.pitch + off.pitch, base.yaw + off.yaw, 0);
  // Болельщики — визуальный эффект, не связанный со статусом продажи; на месте пользователя никого нет
  function setSeat(seat) {
    crowdG.clear();
    seats.forEach(s => { if (s.id === seat.id || (s.seat_type === 'sofa' && hash(s.id) > 35) || !(s.taken || hash(s.id) < 40)) return;
      const c = M(fanC[s.id % fanC.length]), h = new T.Mesh(headG, M(0x2a2420)), b = new T.Mesh(bodyG, c); h.position.set(s.x, s.y + 1.2, s.z); b.position.set(s.x, s.y + 0.85, s.z + 0.05); crowdG.add(h, b); });
    cam.position.set(seat.x, seat.y + EYE, seat.z); cam.rotation.order = 'YXZ'; cam.lookAt(seat.x * 0.4, FIELD.y, FIELD.cz);
    base = { yaw: cam.rotation.y, pitch: cam.rotation.x }; off = { yaw: 0, pitch: 0 }; apply();
  }
  const el = r.domElement; let drag = null;
  el.onpointerdown = e => { drag = e; el.setPointerCapture(e.pointerId); };
  el.onpointerup = () => drag = null;
  el.onpointermove = e => { if (!drag) return; off.yaw = Math.max(-1.1, Math.min(1.1, off.yaw + (e.clientX - drag.clientX) * 0.004)); off.pitch = Math.max(-0.5, Math.min(0.5, off.pitch + (e.clientY - drag.clientY) * 0.004)); drag = e; apply(); };
  const ro = new ResizeObserver(() => { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; r.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); }); ro.observe(host);
  let raf; const loop = () => { raf = requestAnimationFrame(loop); r.render(scene, cam); }; loop();
  return { setSeat, dispose() { cancelAnimationFrame(raf); ro.disconnect(); scene.traverse(o => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose?.(); }); r.dispose(); el.remove(); } };
}
