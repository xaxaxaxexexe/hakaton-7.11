import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Строит сектор стадиона по данным из БД: места (pos_x/y/z) образуют трибуну,
// перед ней поле 105 × 68 м, напротив и за воротами — трибуны с болельщиками.
// Места смотрят на поле (в сторону -z).

const PITCH = { L: 105, W: 68, near: -4 };
PITCH.cz = PITCH.near - PITCH.W / 2;
const C = { seatBase: '#2a2f2c', concrete: '#3a403c', lime: '#e8ff3a' };
const FAN_COLORS = ['#1fa35a', '#1fa35a', '#f4f4f0', '#0f3d24', '#e8ff3a', '#2d3a33', '#f4f4f0', '#16803f'];

function tex(canvas, repeat = [1, 1]) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(...repeat);
  t.anisotropy = 8;
  return t;
}
function placed(geo, { x = 0, y = 0, z = 0, rx = 0, sx = 1 } = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (sx !== 1) g.scale(sx, 1, 1);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return g;
}

// ---------- текстуры ----------
function pitchCanvas() {
  const run = 6, L = PITCH.L + run * 2, W = PITCH.W + run * 2, k = 18;
  const c = document.createElement('canvas'); c.width = Math.round(L * k); c.height = Math.round(W * k);
  const x = c.getContext('2d');
  x.fillStyle = '#23703a'; x.fillRect(0, 0, c.width, c.height);
  const stripes = 18, sw = PITCH.L / stripes;
  for (let i = 0; i < stripes; i++) { x.fillStyle = i % 2 ? '#2f8a45' : '#2a7e3f'; x.fillRect((run + i * sw) * k, run * k, sw * k + 1, PITCH.W * k); }
  x.strokeStyle = '#f4f7f2'; x.lineWidth = 0.14 * k * 1.6; x.fillStyle = '#f4f7f2';
  const X = (m) => (run + m) * k, Y = (m) => (run + m) * k;
  const line = (x1, y1, x2, y2) => { x.beginPath(); x.moveTo(X(x1), Y(y1)); x.lineTo(X(x2), Y(y2)); x.stroke(); };
  const rect = (x1, y1, w, h) => x.strokeRect(X(x1), Y(y1), w * k, h * k);
  const arc = (cx, cy, r, a0, a1) => { x.beginPath(); x.arc(X(cx), Y(cy), r * k, a0, a1); x.stroke(); };
  const spot = (cx, cy) => { x.beginPath(); x.arc(X(cx), Y(cy), 0.25 * k, 0, Math.PI * 2); x.fill(); };
  const mx = PITCH.L / 2, my = PITCH.W / 2;
  rect(0, 0, PITCH.L, PITCH.W);
  line(mx, 0, mx, PITCH.W);
  arc(mx, my, 9.15, 0, Math.PI * 2); spot(mx, my);
  [0, 1].forEach((side) => {
    const s = side ? -1 : 1, gx = side ? PITCH.L : 0;
    rect(side ? gx - 16.5 : gx, my - 20.16, 16.5, 40.32);
    rect(side ? gx - 5.5 : gx, my - 9.16, 5.5, 18.32);
    spot(gx + s * 11, my);
    const a = Math.acos(5.5 / 9.15);
    if (side) arc(gx - 11, my, 9.15, Math.PI - a, Math.PI + a); else arc(11, my, 9.15, -a, a);
  });
  [[0, 0, 0, Math.PI / 2], [PITCH.L, 0, Math.PI / 2, Math.PI], [PITCH.L, PITCH.W, Math.PI, Math.PI * 1.5], [0, PITCH.W, Math.PI * 1.5, Math.PI * 2]]
    .forEach(([cx, cy, a0, a1]) => arc(cx, cy, 1, a0, a1));
  return c;
}
function crowdCanvas({ w = 1024, h = 512, rows = 40 } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#16201b'; x.fillRect(0, 0, w, h);
  const rh = h / rows;
  for (let r = 0; r < rows; r++) {
    x.fillStyle = r % 2 ? '#1b2721' : '#18231d'; x.fillRect(0, r * rh, w, rh);
    for (let i = 0; i < w / 5; i++) {
      if (Math.random() < 0.18) continue;
      x.fillStyle = FAN_COLORS[(Math.random() * FAN_COLORS.length) | 0];
      x.globalAlpha = 0.55 + Math.random() * 0.45;
      x.beginPath(); x.arc(i * 5 + 2.5 + Math.random(), r * rh + rh * 0.45, rh * 0.32, 0, Math.PI * 2); x.fill();
    }
  }
  x.globalAlpha = 1;
  return c;
}
function boardCanvas() {
  const c = document.createElement('canvas'); c.width = 2048; c.height = 64;
  const x = c.getContext('2d');
  const items = [['SPHERA ARENA', '#08140e', '#3ddc84'], ['БИЛЕТ С ВИДОМ НА ПОЛЕ', '#1fa35a', '#ffffff'], ['ГОРЦЫ', '#0b1f15', '#e8ff3a'], ['3D-ВИД С ЛЮБОГО МЕСТА', '#f4f4f0', '#0b1f15']];
  const w = c.width / items.length;
  items.forEach(([t, bg, fg], i) => {
    x.fillStyle = bg; x.fillRect(i * w, 0, w, 64);
    x.fillStyle = fg; x.font = '700 34px Unbounded, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(t, i * w + w / 2, 34);
  });
  return c;
}

// ---------- геометрии ----------
function chairGeo() {
  return mergeGeometries([
    placed(new RoundedBoxGeometry(0.46, 0.08, 0.42, 3, 0.03), { y: 0.43 }),
    placed(new RoundedBoxGeometry(0.46, 0.42, 0.06, 3, 0.03), { y: 0.68, z: 0.2, rx: 0.12 }),
  ]);
}
function vipGeo(sx) {
  return mergeGeometries([
    placed(new RoundedBoxGeometry(0.6, 0.16, 0.6, 3, 0.06), { y: 0.46, sx }),
    placed(new RoundedBoxGeometry(0.6, 0.72, 0.18, 3, 0.07), { y: 0.88, z: 0.36, rx: 0.14, sx }),
  ]);
}
function benchGeo() {
  return mergeGeometries([
    placed(new RoundedBoxGeometry(0.74, 0.12, 0.5, 3, 0.04), { y: 0.42 }),
    placed(new RoundedBoxGeometry(0.74, 0.46, 0.08, 3, 0.04), { y: 0.68, z: 0.24, rx: 0.12 }),
  ]);
}
function accessibleGeo() {
  return mergeGeometries([
    placed(new RoundedBoxGeometry(0.62, 0.04, 0.7, 2, 0.015), { y: 0.02 }),
    placed(new RoundedBoxGeometry(0.62, 0.5, 0.06, 2, 0.02), { y: 0.25, z: 0.36 }),
  ]);
}
function wheelchairTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#2f6fd6'; x.fillRect(0, 0, 128, 128);
  x.strokeStyle = '#fff'; x.fillStyle = '#fff'; x.lineWidth = 9; x.lineCap = 'round';
  x.beginPath(); x.arc(64, 26, 10, 0, Math.PI * 2); x.fill();
  x.beginPath(); x.moveTo(60, 42); x.lineTo(58, 74); x.lineTo(86, 74); x.lineTo(96, 100); x.stroke();
  x.beginPath(); x.arc(58, 86, 24, 0.9, 5.2); x.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const personGeo = (y0 = 0) => mergeGeometries([
  placed(new THREE.SphereGeometry(0.11, 12, 10), { y: y0 + 1.12, z: 0.12 }),
  placed(new RoundedBoxGeometry(0.42, 0.5, 0.24, 2, 0.1), { y: y0 + 0.74, z: 0.14, rx: 0.15 }),
]);

export function buildHall(hall, seats) {
  const root = new THREE.Group();
  const disposables = [];
  const keep = (o) => { disposables.push(o); return o; };
  const vip = hall.category === 'vip';
  const W = Number(hall.room_width_m) || 16;
  const halfW = W / 2;
  const backZ = Math.max(...seats.map((s) => s.z)) + 1;
  const frontZ = PITCH.near;
  const SCREEN = { w: PITCH.L, h: 0, cx: 0, cy: 0, z: PITCH.cz };
  const anim = [];

  // ---------- ряды трибуны ----------
  const rows = [];
  const byRow = new Map();
  seats.forEach((s) => { if (!byRow.has(s.row)) byRow.set(s.row, []); byRow.get(s.row).push(s); });
  [...byRow.keys()].sort((a, b) => a - b).forEach((r) => {
    const list = byRow.get(r);
    rows.push({ row: r, y: Math.min(...list.map((s) => s.y)), z: list.reduce((a, s) => a + s.z, 0) / list.length, seats: list });
  });
  const pitch = rows.length > 1 ? rows[1].z - rows[0].z : 1.2;
  const topY = rows.length ? rows[rows.length - 1].y : 0;

  // ---------- земля и поле ----------
  const ground = new THREE.Mesh(keep(new THREE.PlaneGeometry(320, 320)), keep(new THREE.MeshStandardMaterial({ color: '#1a2a21', roughness: 1 })));
  ground.rotation.x = -Math.PI / 2; ground.position.set(0, -0.05, PITCH.cz);
  root.add(ground);
  const pitchTex = keep(tex(pitchCanvas()));
  pitchTex.wrapS = pitchTex.wrapT = THREE.ClampToEdgeWrapping; pitchTex.anisotropy = 16;
  const field = new THREE.Mesh(keep(new THREE.PlaneGeometry(PITCH.L + 12, PITCH.W + 12)),
    keep(new THREE.MeshStandardMaterial({ map: pitchTex, roughness: 0.9, emissive: '#ffffff', emissiveMap: pitchTex, emissiveIntensity: 0.28 })));
  field.rotation.x = -Math.PI / 2; field.position.set(0, 0.01, PITCH.cz);
  root.add(field);

  // ворота
  const postMat = keep(new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.5 }));
  const netMat = keep(new THREE.MeshBasicMaterial({ color: '#ffffff', wireframe: true, transparent: true, opacity: 0.25 }));
  [-1, 1].forEach((s) => {
    const gx = s * PITCH.L / 2;
    [-1, 1].forEach((p) => {
      const post = new THREE.Mesh(keep(new THREE.BoxGeometry(0.12, 2.44, 0.12)), postMat);
      post.position.set(gx, 1.22, PITCH.cz + p * 3.66); root.add(post);
    });
    const bar = new THREE.Mesh(keep(new THREE.BoxGeometry(0.12, 0.12, 7.44)), postMat);
    bar.position.set(gx, 2.44, PITCH.cz); root.add(bar);
    const net = new THREE.Mesh(keep(new THREE.BoxGeometry(2, 2.44, 7.32, 4, 6, 14)), netMat);
    net.position.set(gx + s * 1.05, 1.22, PITCH.cz); root.add(net);
  });

  // рекламные борта
  const boardTex = keep(tex(boardCanvas(), [3, 1]));
  const boardMat = keep(new THREE.MeshStandardMaterial({ map: boardTex, emissive: '#ffffff', emissiveMap: boardTex, emissiveIntensity: 0.9 }));
  const darkMat = keep(new THREE.MeshStandardMaterial({ color: '#0d1511', roughness: 0.8 }));
  const board = (len, x, z, ry) => {
    const b = new THREE.Mesh(keep(new THREE.BoxGeometry(len, 0.9, 0.12)), [darkMat, darkMat, darkMat, darkMat, boardMat, darkMat]);
    b.position.set(x, 0.45, z); b.rotation.y = ry; root.add(b);
  };
  board(PITCH.L + 6, 0, PITCH.cz - PITCH.W / 2 - 4, 0);
  board(PITCH.W, -PITCH.L / 2 - 5, PITCH.cz, Math.PI / 2);
  board(PITCH.W, PITCH.L / 2 + 5, PITCH.cz, -Math.PI / 2);

  // ---------- игроки и мяч ----------
  const playerGeo = keep(mergeGeometries([
    placed(new THREE.BoxGeometry(0.34, 0.86, 0.2), { y: 0.43 }),
    placed(new RoundedBoxGeometry(0.5, 0.66, 0.28, 2, 0.08), { y: 1.2 }),
    placed(new THREE.SphereGeometry(0.14, 12, 10), { y: 1.7 }),
  ]));
  const formation = [[-50, 0], [-36, -24], [-38, -8], [-38, 8], [-36, 24], [-20, -22], [-22, -7], [-22, 7], [-20, 22], [-7, -6], [-7, 6]];
  const players = [];
  formation.forEach(([x, z], i) => { players.push({ bx: x, bz: z, team: 0, gk: i === 0 }); players.push({ bx: -x, bz: -z, team: 1, gk: i === 0 }); });
  const playerMesh = new THREE.InstancedMesh(playerGeo, keep(new THREE.MeshStandardMaterial({ roughness: 0.6 })), players.length);
  players.forEach((p, i) => playerMesh.setColorAt(i, new THREE.Color(p.gk ? (p.team ? '#111827' : '#facc15') : p.team ? '#f4f4f0' : '#1fa35a')));
  const shadowMesh = new THREE.InstancedMesh(keep(new THREE.CircleGeometry(0.55, 16).rotateX(-Math.PI / 2)), keep(new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.35, depthWrite: false })), players.length);
  const ball = new THREE.Mesh(keep(new THREE.SphereGeometry(0.22, 16, 12)), keep(new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.6 })));
  root.add(playerMesh, shadowMesh, ball);
  const pm = new THREE.Matrix4(); const q = new THREE.Quaternion(); const one = new THREE.Vector3(1, 1, 1); const pv = new THREE.Vector3();
  anim.push((t) => {
    const bx = Math.sin(t * 0.21) * 34 + Math.sin(t * 0.53) * 6;
    const bz = Math.sin(t * 0.33) * 20;
    ball.position.set(bx, 0.22 + Math.abs(Math.sin(t * 2.4)) * 0.4, PITCH.cz + bz);
    players.forEach((p, i) => {
      const pull = p.gk ? 0.04 : 0.28;
      const x = p.bx + (bx - p.bx) * pull + Math.sin(t * 0.4 + i * 1.7) * 2.2;
      const z = p.bz + (bz - p.bz) * pull + Math.cos(t * 0.35 + i * 2.3) * 2;
      const dx = bx - x, dz = bz - z;
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(dx, dz));
      pm.compose(pv.set(x, 0, PITCH.cz + z), q, one); playerMesh.setMatrixAt(i, pm);
      pm.makeTranslation(x, 0.02, PITCH.cz + z); shadowMesh.setMatrixAt(i, pm);
    });
    playerMesh.instanceMatrix.needsUpdate = true; shadowMesh.instanceMatrix.needsUpdate = true;
  });

  // ---------- трибуны напротив и за воротами ----------
  const crowdTex = keep(tex(crowdCanvas(), [6, 1]));
  const crowdMat = keep(new THREE.MeshStandardMaterial({ map: crowdTex, roughness: 0.9, emissive: '#ffffff', emissiveMap: crowdTex, emissiveIntensity: 0.18 }));
  const roofMat = keep(new THREE.MeshStandardMaterial({ color: '#111a15', roughness: 0.7, side: THREE.DoubleSide }));
  const stripMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color('#fffbe8').multiplyScalar(3) }));
  function stand(width, x, z, ry, { depth = 38, rise = 26 } = {}) {
    const g = new THREE.Group();
    const len = Math.hypot(depth, rise); const th = Math.atan2(rise, depth);
    const slope = new THREE.Mesh(keep(new THREE.PlaneGeometry(width, len)), crowdMat);
    slope.rotation.x = -(Math.PI / 2 - th);
    slope.position.set(0, 1.2 + rise / 2, -depth / 2);
    const wall = new THREE.Mesh(keep(new THREE.BoxGeometry(width, 1.2, 0.4)), darkMat);
    wall.position.set(0, 0.6, 0);
    const roof = new THREE.Mesh(keep(new THREE.BoxGeometry(width, 0.6, 22)), roofMat);
    roof.position.set(0, rise + 7, -depth + 4);
    const strip = new THREE.Mesh(keep(new THREE.BoxGeometry(width * 0.96, 0.35, 0.35)), stripMat);
    strip.position.set(0, rise + 6.6, -depth + 4 + 11);
    g.add(slope, wall, roof, strip);
    g.position.set(x, 0, z); g.rotation.y = ry;
    root.add(g);
  }
  stand(150, 0, PITCH.cz - PITCH.W / 2 - 7, 0);
  stand(96, PITCH.L / 2 + 9, PITCH.cz, -Math.PI / 2, { rise: 20, depth: 30 });
  stand(96, -PITCH.L / 2 - 9, PITCH.cz, Math.PI / 2, { rise: 20, depth: 30 });

  // мачты прожекторов
  const mastMat = keep(new THREE.MeshStandardMaterial({ color: '#2b3430', metalness: 0.6, roughness: 0.4 }));
  const lampMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color('#fffaf0').multiplyScalar(4) }));
  [[-78, 14], [78, 14], [-78, PITCH.cz - 46], [78, PITCH.cz - 46]].forEach(([x, z]) => {
    const mast = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.4, 0.7, 48, 10)), mastMat);
    mast.position.set(x, 24, z); root.add(mast);
    const head = new THREE.Mesh(keep(new THREE.BoxGeometry(9, 4, 0.5)), lampMat);
    head.position.set(x, 49, z); head.lookAt(0, 0, PITCH.cz); root.add(head);
  });

  // ---------- своя трибуна: бетонные ступени, продолжение рядов влево и вправо ----------
  const concreteMat = keep(new THREE.MeshStandardMaterial({ color: C.concrete, roughness: 0.95 }));
  const stepTopMat = keep(new THREE.MeshStandardMaterial({ color: '#4a514c', roughness: 0.9 }));
  const nosingMat = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(C.lime).multiplyScalar(1.4) }));
  const EXT = 62;
  rows.forEach((r, i) => {
    const z0 = i === 0 ? r.z - pitch / 2 : (rows[i - 1].z + r.z) / 2;
    const z1 = i === rows.length - 1 ? backZ : (rows[i + 1].z + r.z) / 2;
    const h = r.y + 0.3;
    const box = new THREE.Mesh(keep(new THREE.BoxGeometry(EXT * 2, h, z1 - z0)), [concreteMat, concreteMat, stepTopMat, concreteMat, concreteMat, concreteMat]);
    box.position.set(0, r.y - h / 2, (z0 + z1) / 2);
    root.add(box);
    if (i > 0 && r.y > rows[i - 1].y) {
      [-1, 1].forEach((s) => {
        const strip = new THREE.Mesh(keep(new THREE.BoxGeometry(0.9, 0.025, 0.03)), nosingMat);
        strip.position.set(s * (halfW + 0.45), r.y - 0.06, z0 - 0.005);
        root.add(strip);
      });
    }
  });
  // передний парапет
  if (rows.length) {
    const z0 = rows[0].z - pitch / 2;
    const glass = new THREE.Mesh(keep(new THREE.BoxGeometry(EXT * 2, 1, 0.06)), keep(new THREE.MeshStandardMaterial({ color: '#9fd8b8', transparent: true, opacity: 0.18, roughness: 0.1 })));
    glass.position.set(0, rows[0].y + 0.5, z0 - 0.05);
    root.add(glass);
    if (rows[0].y > 1) {
      const front = new THREE.Mesh(keep(new THREE.PlaneGeometry(EXT * 2, rows[0].y + 0.3)), crowdMat.clone());
      front.material.map = null; front.material.emissiveMap = null; front.material.color.set('#16201b'); front.material.emissiveIntensity = 0; keep(front.material);
      front.position.set(0, rows[0].y / 2 - 0.15, z0 - 0.01);
      root.add(front);
    }
  }
  // болельщики в соседних секторах
  const fanSlots = [];
  rows.forEach((r) => {
    for (let x = halfW + 1.4; x < EXT - 0.5; x += 0.56) {
      [-1, 1].forEach((s) => { if (Math.random() < 0.82) fanSlots.push([s * x, r.y, r.z]); });
    }
  });
  const fanGeo = keep(personGeo());
  const fanMesh = new THREE.InstancedMesh(fanGeo, keep(new THREE.MeshStandardMaterial({ roughness: 0.7 })), Math.max(1, fanSlots.length));
  const fm = new THREE.Matrix4(); const fc = new THREE.Color();
  fanSlots.forEach(([x, y, z], i) => { fm.makeTranslation(x, y, z); fanMesh.setMatrixAt(i, fm); fanMesh.setColorAt(i, fc.set(FAN_COLORS[(Math.random() * FAN_COLORS.length) | 0])); });
  fanMesh.count = fanSlots.length;
  root.add(fanMesh);
  // задний парапет своей трибуны
  const backWall = new THREE.Mesh(keep(new THREE.BoxGeometry(EXT * 2, topY + 1.6, 0.4)), darkMat);
  backWall.position.set(0, (topY + 1.6) / 2 - 0.3, backZ + 0.2);
  root.add(backWall);

  // ---------- звук: данные колонок остаются для аудио, сами колонки не рисуем ----------
  const speakers = (hall.speaker_layout || []).map((sp) => ({
    ...sp, pos: new THREE.Vector3(Number(sp.x), Number(sp.y), Number(sp.z)),
    glowMat: keep(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 })),
  }));

  // ---------- места ----------
  const pickGeo = keep(new THREE.BoxGeometry(1, 1.15, 0.8));
  pickGeo.translate(0, 0.58, 0.05);
  const pickMesh = new THREE.InstancedMesh(pickGeo, keep(new THREE.MeshBasicMaterial({ visible: false })), seats.length);
  const seatW = rows.length ? Math.min(...rows.map((r) => {
    const xs = r.seats.map((s) => s.x).sort((a, b) => a - b);
    let m = 9; for (let i = 1; i < xs.length; i++) m = Math.min(m, xs[i] - xs[i - 1]);
    return m;
  })) : 0.6;
  const seatMat = keep(new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.05 }));
  const typeGeo = {
    premium: vip ? keep(vipGeo(Math.min(1.5, Math.max(0.9, seatW / 0.74)))) : keep(chairGeo()),
    standard: keep(chairGeo()),
    sofa: keep(benchGeo()),
    accessible: keep(accessibleGeo()),
  };
  const groups = {};
  seats.forEach((s, i) => { (groups[s.type] ||= []).push(i); });
  const seatMeshes = {};
  const slot = new Array(seats.length);
  const m = new THREE.Matrix4();
  Object.entries(groups).forEach(([type, idx]) => {
    const mat = type === 'accessible' ? keep(new THREE.MeshStandardMaterial({ map: keep(wheelchairTexture()), roughness: 0.6 })) : seatMat;
    const mesh = new THREE.InstancedMesh(typeGeo[type] || typeGeo.standard, mat, idx.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(idx.length * 3).fill(1), 3);
    idx.forEach((si, k) => {
      const s = seats[si];
      m.makeTranslation(s.x, s.y, s.z);
      mesh.setMatrixAt(k, m);
      slot[si] = { mesh, k };
    });
    root.add(mesh);
    seatMeshes[type] = mesh;
  });
  seats.forEach((s, i) => {
    m.makeScale(Math.max(0.5, seatW * 0.95), 1, 1).setPosition(s.x, s.y, s.z);
    pickMesh.setMatrixAt(i, m);
  });
  root.add(pickMesh);

  // стойки кресел
  const chairIdx = seats.map((s, i) => i).filter((i) => seats[i].type === 'premium' || seats[i].type === 'standard');
  const baseMesh = new THREE.InstancedMesh(keep(new THREE.BoxGeometry(vip ? 0.5 : 0.08, vip ? 0.36 : 0.38, vip ? 0.6 : 0.3)), keep(new THREE.MeshStandardMaterial({ color: C.seatBase, roughness: 0.6 })), Math.max(1, chairIdx.length));
  chairIdx.forEach((i, k) => { const s = seats[i]; m.makeTranslation(s.x, s.y + 0.19, s.z + 0.04); baseMesh.setMatrixAt(k, m); });
  baseMesh.count = chairIdx.length;
  root.add(baseMesh);

  // ---------- болельщики на занятых местах ----------
  const peopleMesh = new THREE.InstancedMesh(keep(personGeo(vip ? 0.06 : 0)), keep(new THREE.MeshStandardMaterial({ roughness: 0.7 })), seats.length);
  for (let i = 0; i < seats.length; i++) peopleMesh.setColorAt(i, fc.set(FAN_COLORS[(i * 7) % FAN_COLORS.length]));
  peopleMesh.count = 0;
  root.add(peopleMesh);

  // ---------- маркеры выбранных мест ----------
  const markerGeo = keep(new THREE.OctahedronGeometry(0.16, 0));
  markerGeo.scale(1, 1.5, 0.35);
  const markerMat = keep(new THREE.MeshStandardMaterial({ color: C.lime, emissive: C.lime, emissiveIntensity: 1.4, metalness: 0.3, roughness: 0.3 }));
  const markers = Array.from({ length: 8 }, () => { const mk = new THREE.Mesh(markerGeo, markerMat); mk.visible = false; root.add(mk); return mk; });

  // ---------- свет ----------
  const hemi = new THREE.HemisphereLight('#c4d4ff', '#1d3a26', 1.1);
  const top = new THREE.DirectionalLight('#fffaf0', 2.2);
  top.position.set(25, 90, PITCH.cz + 40);
  top.target.position.set(0, 0, PITCH.cz);
  const fill = new THREE.DirectionalLight('#dfe8ff', 0.7);
  fill.position.set(-30, 50, PITCH.cz - 80);
  fill.target.position.set(0, 0, (rows[0]?.z || 0) + 6);
  root.add(hemi, top, top.target, fill, fill.target);

  // точка обзора: над трибуной, видно и места, и поле
  const midRow = rows.length ? rows[Math.floor(rows.length / 2)] : { y: 0, z: 6 };
  const overview = {
    pos: new THREE.Vector3(0, topY + Math.max(13, backZ * 0.7), backZ + Math.max(6, backZ * 0.3)),
    target: new THREE.Vector3(0, midRow.y, midRow.z - 4),
  };

  return {
    root, SCREEN, room: { W, H: topY + 6, backZ, frontZ }, rows, overview,
    seatMeshes, slot, pickMesh, peopleMesh, markers, speakers, hemi, top, vip,
    update(t) { anim.forEach((f) => f(t)); },
    dispose() {
      disposables.forEach((d) => d.dispose?.());
      Object.values(seatMeshes).forEach((x) => x.dispose());
      [pickMesh, peopleMesh, baseMesh, fanMesh, playerMesh, shadowMesh].forEach((x) => x.dispose());
    },
  };
}
