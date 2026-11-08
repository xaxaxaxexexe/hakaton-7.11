import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import gsap from 'gsap';
import { buildHall } from './hall.js';

// Одна сцена на всё приложение: страницы «Сектор» и «Матч» загружают в неё нужный сектор стадиона.
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const isTouch = window.matchMedia('(pointer: coarse)').matches;
gsap.ticker.lagSmoothing(0);
RectAreaLightUniformsLib.init();

const COL = {
  near: new THREE.Color('#25a862'), standard: new THREE.Color('#1c8a4c'), premium: new THREE.Color('#d9dde0'),
  vip: new THREE.Color('#d9dde0'), sofa: new THREE.Color('#0ea5e9'), accessible: new THREE.Color('#ffffff'),
  taken: new THREE.Color('#2a302d'), sel: new THREE.Color('#e8ff3a'), white: new THREE.Color('#ffffff'),
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const narrow = () => window.innerWidth < 860;

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouch ? 1.5 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#070d16');
  scene.fog = new THREE.Fog('#070d16', 140, 320);
  const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.05, 600);
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.5, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.07, enablePan: false, minPolarAngle: 0.35, maxPolarAngle: 1.38, minAzimuthAngle: -0.75, maxAzimuthAngle: 0.75, enabled: false });

  const st = {
    hall: null, data: null, seats: [], byId: new Map(), status: new Map(), selected: [], hover: -1,
    mode: 'idle', view: null, showPeople: true, running: false, phase: 0.1,
    look: { yaw: 0, pitch: 0, cy: 0, cp: 0 }, fx: { house: 1, filmOn: 1, beam: 0.55 },
    listeners: { pick: [], hover: [], frame: [] }, priceOf: () => null,
  };
  const lookTarget = new THREE.Vector3();
  let flight = null;
  let screenC = new THREE.Vector3();

  // ---------- загрузка зала ----------
  function load({ hall, seats, phase = 0.1, statuses = null }) {
    if (st.hall) { scene.remove(st.hall.root); st.hall.dispose(); }
    flight?.kill();
    st.data = hall;
    // VIP-ложи поднимаем на верхний ярус: оттуда поле видно как схему
    const lift = hall.category === 'vip' ? 14 : 0;
    st.seats = seats.map((s, i) => ({ ...s, y: Number(s.y) * 2.2 + lift, index: i })); // подъём рядов круче, как на трибуне
    st.byId = new Map(st.seats.map((s) => [s.id, s]));
    st.status = new Map(statuses || []);
    st.selected = []; st.hover = -1; st.view = null;
    st.hall = buildHall(hall, st.seats);
    scene.add(st.hall.root);
    screenC = new THREE.Vector3(st.hall.SCREEN.cx, st.hall.SCREEN.cy, st.hall.SCREEN.z);
    st.phase = phase;
    controls.maxDistance = st.hall.overview.pos.distanceTo(st.hall.overview.target) * 1.25;
    controls.minDistance = 6;
    paintAll(); placePeople(); placeMarkers();
    toOverview(true);
  }

  // ---------- состояния мест ----------
  const isTaken = (s) => { const v = st.status.get(s.id); return v === 'sold' || v === 'held' || v === 'blocked'; };
  const isSel = (s) => st.selected.includes(s.id);
  const tmp = new THREE.Color();
  function baseColor(s) {
    if (s.type === 'accessible') return COL.accessible;
    if (s.type === 'sofa') return COL.sofa;
    if (st.hall?.vip) return s.row <= 2 && st.data.hall_number !== 7 ? COL.near : COL.premium;
    if (s.type === 'premium') return COL.premium;
    return s.row <= 2 ? COL.near : COL.standard;
  }
  function paint(i) {
    const s = st.seats[i]; const slot = st.hall.slot[i];
    if (isSel(s)) tmp.copy(COL.sel);
    else if (isTaken(s)) tmp.copy(s.type === 'accessible' ? new THREE.Color('#555a70') : COL.taken);
    else tmp.copy(baseColor(s));
    if (i === st.hover) tmp.lerp(COL.white, isTaken(s) ? 0.12 : 0.3);
    slot.mesh.setColorAt(slot.k, tmp);
    slot.mesh.instanceColor.needsUpdate = true;
  }
  function paintAll() { st.seats.forEach((_, i) => paint(i)); }
  const mtx = new THREE.Matrix4();
  function placePeople() {
    const pm = st.hall.peopleMesh; let n = 0;
    if (st.showPeople) st.seats.forEach((s) => {
      if (!isTaken(s) || s.type === 'accessible' || (st.mode === 'seat' && st.view?.id === s.id)) return;
      mtx.makeTranslation(s.x, s.y, s.z); pm.setMatrixAt(n++, mtx);
    });
    pm.count = n; pm.instanceMatrix.needsUpdate = true;
  }
  function placeMarkers() {
    st.hall.markers.forEach((mk, k) => {
      const id = st.selected[k];
      if (!id || (st.mode === 'seat' && st.view?.id === id)) { mk.visible = false; return; }
      const s = st.byId.get(id);
      mk.visible = true; mk.userData.base = new THREE.Vector3(s.x, s.y + 1.85, s.z + 0.2); mk.userData.k = k;
    });
  }
  function setStatuses(entries) { st.status = new Map(entries); paintAll(); placePeople(); }
  function setSelected(ids) {
    const added = ids.filter((id) => !st.selected.includes(id));
    st.selected = [...ids];
    paintAll(); placeMarkers();
    added.forEach((id) => {
      const mk = st.hall.markers[st.selected.indexOf(id)];
      if (mk && !reduceMotion) { mk.scale.setScalar(0.01); gsap.to(mk.scale, { x: 1, y: 1, z: 1, duration: 0.7, ease: 'back.out(3)' }); }
    });
  }
  function setHover(i) {
    if (!st.hall || i === st.hover) return;
    const prev = st.hover; st.hover = i;
    if (prev >= 0) paint(prev);
    if (i >= 0) paint(i);
    canvas.style.cursor = i >= 0 && st.mode === 'overview' ? 'pointer' : st.mode === 'seat' ? 'grab' : 'default';
    st.listeners.hover.forEach((f) => f(i >= 0 ? st.seats[i] : null));
  }

  // ---------- указатель ----------
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  function pick(x, y) {
    if (!st.hall) return -1;
    const r = canvas.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(st.hall.pickMesh, false)[0];
    return hit ? hit.instanceId : -1;
  }
  let down = null; let last = { i: -1, t: 0 };
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, yaw: st.look.yaw, pitch: st.look.pitch };
    if (st.mode === 'seat') { canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (st.mode === 'seat' && down) {
      st.look.yaw = clamp(down.yaw - (e.clientX - down.x) * 0.0035, -1.25, 1.25);
      st.look.pitch = clamp(down.pitch + (e.clientY - down.y) * 0.003, -0.6, 0.6);
      return;
    }
    if (st.mode !== 'overview' || e.pointerType === 'touch') return;
    setHover(pick(e.clientX, e.clientY));
    st.pointer = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
    if (st.mode === 'seat') { canvas.style.cursor = 'grab'; return; }
    if (st.mode !== 'overview' || moved > 6) return;
    const i = pick(e.clientX, e.clientY);
    if (i < 0) return;
    const now = performance.now();
    const double = last.i === i && now - last.t < 380;
    last = double ? { i: -1, t: 0 } : { i, t: now };
    st.listeners.pick.forEach((f) => f(st.seats[i], { double, touch: e.pointerType === 'touch' }));
  });
  canvas.addEventListener('pointerleave', () => { if (st.mode === 'overview') setHover(-1); });

  // ---------- камера ----------
  const eyeOf = (s) => new THREE.Vector3(s.x, s.y + Number(s.eye || 1.1), s.z + (st.hall.vip ? 0.2 : 0.12));
  function seatFov() {
    const a = window.innerWidth / window.innerHeight;
    return clamp(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(34)) / a)), 58, 92);
  }
  function applyViewOffset() {
    const w = window.innerWidth, h = window.innerHeight;
    if (st.mode === 'seat' && narrow()) {
      const hud = document.getElementById('hud')?.offsetHeight || 0;
      camera.setViewOffset(w, h, 0, Math.round(hud * 0.42), w, h);
    } else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  function toOverview(instant = false) {
    const ov = st.hall.overview;
    flight?.kill();
    const finish = () => {
      st.mode = 'overview'; st.view = null;
      controls.target.copy(ov.target); controls.enabled = true; controls.update();
      placePeople(); placeMarkers();
    };
    if (instant || reduceMotion) {
      camera.position.copy(ov.pos); lookTarget.copy(ov.target); camera.lookAt(lookTarget);
      camera.fov = 48; applyViewOffset(); st.fx.house = 1; st.fx.beam = 0.55; finish(); return;
    }
    st.mode = 'fly';
    const from = camera.position.clone(); const mid = from.clone().lerp(ov.pos, 0.5); mid.y += 3;
    const curve = new THREE.QuadraticBezierCurve3(from, mid, ov.pos);
    const lf = lookTarget.clone(); const p = { t: 0 };
    flight = gsap.timeline({ onComplete: finish });
    flight.to(p, { t: 1, duration: 1.8, ease: 'power3.inOut', onUpdate: () => { camera.position.copy(curve.getPoint(p.t)); lookTarget.copy(lf).lerp(ov.target, p.t); camera.lookAt(lookTarget); } }, 0);
    flight.to(camera, { fov: 48, duration: 1.8, onUpdate: applyViewOffset }, 0);
    flight.to(st.fx, { house: 1, beam: 0.55, duration: 1.4 }, 0.2);
  }
  function enterSeat(s) {
    const first = st.mode !== 'seat';
    st.view = s; st.mode = 'seat'; controls.enabled = false;
    st.look.yaw = st.look.pitch = 0;
    setHover(-1); placePeople(); placeMarkers();
    const from = camera.position.clone(); const to = eyeOf(s); const lf = lookTarget.clone();
    const mid = from.clone().lerp(to, 0.5); mid.y = Math.max(from.y, to.y) + (first ? 2.5 : 0.4);
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    flight?.kill(); const p = { t: 0 };
    flight = gsap.timeline();
    flight.to(p, { t: 1, duration: reduceMotion ? 0.01 : first ? 2.1 : 0.85, ease: first ? 'power3.inOut' : 'power2.inOut',
      onUpdate: () => { camera.position.copy(curve.getPoint(p.t)); lookTarget.copy(lf).lerp(screenC, Math.min(1, p.t * 1.4)); camera.lookAt(lookTarget); } }, 0);
    flight.to(camera, { fov: seatFov(), duration: first ? 2.1 : 0.4, onUpdate: applyViewOffset }, 0);
    flight.to(st.fx, { house: 0.32, beam: 1, duration: 1.6 }, 0.3);
  }
  function neighbour(s, dir) {
    if (dir === 'left' || dir === 'right') {
      const row = st.seats.filter((o) => o.row === s.row).sort((a, b) => a.x - b.x);
      const i = row.findIndex((o) => o.id === s.id);
      return row[i + (dir === 'left' ? -1 : 1)];
    }
    const r = s.row + (dir === 'front' ? -1 : 1); let best = null;
    st.seats.forEach((o) => { if (o.row === r && (!best || Math.abs(o.x - s.x) < Math.abs(best.x - s.x))) best = o; });
    return best;
  }
  function metrics(s) {
    const e = eyeOf(s); const S = st.hall.SCREEN;
    const L = new THREE.Vector3(S.cx - S.w / 2, S.cy, S.z).sub(e).normalize();
    const R = new THREE.Vector3(S.cx + S.w / 2, S.cy, S.z).sub(e).normalize();
    const angle = THREE.MathUtils.radToDeg(Math.acos(L.dot(R)));
    const horiz = Math.hypot(screenC.x - e.x, screenC.z - e.z);
    return { eye: e, dist: screenC.distanceTo(e), angle, tilt: THREE.MathUtils.radToDeg(Math.atan2(screenC.y - e.y, horiz)) };
  }
  function highlightSpeaker(id, v) {
    st.hall?.speakers.forEach((sp) => { if (id === '*' || sp.id === id) gsap.to(sp.glowMat, { opacity: v ? 0.95 : 0, duration: v ? 0.08 : 0.5 }); });
  }

  // ---------- цикл ----------
  const clock = new THREE.Clock();
  const fwd = new THREE.Vector3();
  function frame() {
    if (!st.running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05); const t = clock.elapsedTime;
    const h = st.hall; if (!h) return;
    h.update(t);
    h.markers.forEach((mk) => {
      if (!mk.visible || !mk.userData.base) return;
      mk.position.copy(mk.userData.base); mk.position.y += Math.sin(t * 2 + mk.userData.k) * 0.08; mk.rotation.y = t * 1.4 + mk.userData.k;
    });
    if (st.mode === 'seat' && !flight?.isActive()) {
      const L = st.look; L.cy += (L.yaw - L.cy) * Math.min(1, dt * 8); L.cp += (L.pitch - L.cp) * Math.min(1, dt * 8);
      const eye = camera.position; const base = screenC.clone().sub(eye); const r = base.length();
      const yaw = Math.atan2(base.x, -base.z) + L.cy; const pitch = clamp(Math.asin(base.y / r) + L.cp, -1.2, 1.2);
      lookTarget.set(eye.x + Math.sin(yaw) * Math.cos(pitch) * r, eye.y + Math.sin(pitch) * r, eye.z - Math.cos(yaw) * Math.cos(pitch) * r);
      camera.lookAt(lookTarget);
    } else if (st.mode === 'overview') controls.update();
    camera.getWorldDirection(fwd);
    st.listeners.frame.forEach((f) => f({ pos: camera.position, forward: fwd, mode: st.mode }));
    composer.render(dt);
  }
  function resize() {
    const w = window.innerWidth, hgt = window.innerHeight;
    camera.aspect = w / hgt; camera.updateProjectionMatrix();
    renderer.setSize(w, hgt); composer.setSize(w, hgt); bloom.setSize(w, hgt);
    if (st.mode === 'seat') camera.fov = seatFov();
    applyViewOffset();
  }
  window.addEventListener('resize', resize);

  return {
    camera, state: st, load, setStatuses, setSelected, enterSeat, toOverview, neighbour, metrics, highlightSpeaker,
    eyeOf, isTaken, applyViewOffset,
    setShowPeople(v) { st.showPeople = v; placePeople(); },
    on(ev, f) { st.listeners[ev].push(f); return () => { st.listeners[ev] = st.listeners[ev].filter((x) => x !== f); }; },
    start() { if (st.running) return; st.running = true; canvas.hidden = false; resize(); clock.getDelta(); frame(); },
    stop() {
      st.running = false; canvas.hidden = true; flight?.kill(); controls.enabled = false;
      st.listeners = { pick: [], hover: [], frame: [] };
      if (st.hall) { scene.remove(st.hall.root); st.hall.dispose(); st.hall = null; }
    },
  };
}
