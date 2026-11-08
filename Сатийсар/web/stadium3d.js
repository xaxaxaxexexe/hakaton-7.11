import * as THREE from './vendor/three.module.js';

const clamp = THREE.MathUtils.clamp;
const PITCH_X = 35;
const PITCH_Z = 22.5;
const ROW_DEPTH = 1.15;
const ROW_RISE = .62;
const SIDE_ROTATION = { south: 0, north: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 };
const HAIR_COLORS = ['#15130f', '#241a12', '#3a2a1c', '#0d0d0d', '#4a3a2c', '#6f6a62'];
const CROWD_COLORS = ['#e9ece6', '#c8d0c8', '#30343a', '#59616b', '#21a35a', '#7c8b7f', '#b7473d', '#35608f'];
// x runs goal to goal in the home half, z across the pitch.
const FORMATION = [[-.94, 0], [-.68, -.72], [-.72, -.26], [-.72, .26], [-.68, .72], [-.38, -.45], [-.42, 0], [-.38, .45], [-.1, -.68], [-.06, 0], [-.1, .68]];

const lerp = (a, b, t) => a + (b - a) * t;
const hash = (n) => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };

/* Loudness the fan hears: the home end carries, the top tier is quieter. Shared by the audio graph and the UI. */
export function crowdProfile(seat, seats, sectors, rows) {
  const fanCodes = new Set(sectors.filter((s) => s.is_fan).map((s) => s.code));
  const fan = seats.filter((s) => fanCodes.has(s.sector));
  const center = fan.reduce((sum, s) => ({ x: sum.x + s.x / fan.length, z: sum.z + s.z / fan.length }), { x: 0, z: 0 });
  const distance = Math.hypot(seat.x - center.x, seat.z - center.z);
  const fanLevel = 1 / (1 + (distance / 34) ** 2);
  const tier = 1 - .55 * (seat.row_number - 1) / Math.max(1, rows - 1);
  return { center, distance, fanLevel, tier, loudness: Math.round(100 * tier * (.42 + .58 * fanLevel)) };
}

function pitchTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 2048; canvas.height = 1316;
  const c = canvas.getContext('2d');
  const scale = canvas.width / (PITCH_X * 2);
  for (let i = 0; i < 16; i++) {
    c.fillStyle = i % 2 ? '#2c7d3f' : '#25703a';
    c.fillRect(i * canvas.width / 16, 0, canvas.width / 16 + 1, canvas.height);
  }
  c.strokeStyle = '#f2f6ef'; c.lineWidth = 7;
  const box = (x, w, h) => c.strokeRect(x, canvas.height / 2 - h / 2, w, h);
  c.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
  c.beginPath(); c.moveTo(canvas.width / 2, 0); c.lineTo(canvas.width / 2, canvas.height); c.stroke();
  c.beginPath(); c.arc(canvas.width / 2, canvas.height / 2, 6.1 * scale, 0, Math.PI * 2); c.stroke();
  const penaltyW = 11 * scale, penaltyH = 26.9 * scale, goalW = 3.67 * scale, goalH = 12.2 * scale;
  box(5, penaltyW, penaltyH); box(canvas.width - 5 - penaltyW, penaltyW, penaltyH);
  box(5, goalW, goalH); box(canvas.width - 5 - goalW, goalH > 0 ? goalW : 0, goalH);
  for (const [x, from, to] of [[7.3 * scale, -.93, .93], [canvas.width - 7.3 * scale, Math.PI - .93, Math.PI + .93]]) {
    c.beginPath(); c.arc(x, canvas.height / 2, 6.1 * scale, from, to); c.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function crowdTexture(colors) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const c = canvas.getContext('2d');
  c.fillStyle = '#10150f'; c.fillRect(0, 0, 512, 128);
  for (let y = 0; y < 128; y += 5) for (let x = 0; x < 512; x += 5) {
    const n = hash(x * 31 + y * 7);
    if (n < .1) continue;
    c.fillStyle = colors[Math.floor(hash(x + y * 13) * colors.length)];
    c.fillRect(x + (y % 10 ? 2 : 0), y, 3, 3);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function boardTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 48;
  const c = canvas.getContext('2d');
  c.fillStyle = '#0b1a11'; c.fillRect(0, 0, 1024, 48);
  c.fillStyle = '#39d27e'; c.font = '700 30px Arial, sans-serif'; c.textBaseline = 'middle';
  for (let x = 12; x < 1024; x += c.measureText(text).width + 60) c.fillText(text, x, 25);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class StadiumView {
  constructor(canvas, onSeatClick) {
    this.canvas = canvas;
    this.onSeatClick = onSeatClick;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, .08, 500);
    this.mode = 'seat';
    this.yaw = 0; this.pitch = 0;
    this.orbitYaw = 0; this.orbitPitch = .62; this.orbitRadius = 92;
    this.fov = 55;
    this.targets = { yaw: 0, pitch: 0, orbitYaw: 0, orbitPitch: .62, orbitRadius: 92, fov: 55 };
    this.world = null;
    this.stadiumKey = null;
    this.seat = null;
    this.selectedId = null;
    this.seats = [];
    this.pointer = null;
    this.raycaster = new THREE.Raycaster();
    this.pointerVector = new THREE.Vector2();
    this.visible = false;
    this.frame = null;
    this.lastFrame = 0;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (event) => this.pointerDown(event));
    canvas.addEventListener('pointermove', (event) => this.pointerMove(event));
    canvas.addEventListener('pointerup', (event) => this.pointerUp(event));
    canvas.addEventListener('pointercancel', () => { this.pointer = null; });
    canvas.addEventListener('wheel', (event) => this.wheel(event), { passive: false });
    this.resize();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(rect.width, rect.height, false);
    this.render();
  }

  setStadium(stadium, seats, match) {
    this.stadium = stadium;
    const key = `${stadium.id}:${match.id}`;
    if (key !== this.stadiumKey) {
      this.stadiumKey = key;
      this.build(stadium, seats, match);
    }
    this.syncSeats(seats);
    this.render();
  }

  build(stadium, seats, match) {
    if (this.world) {
      this.scene.remove(this.world);
      this.world.traverse((node) => {
        node.geometry?.dispose();
        for (const mat of [node.material].flat()) { mat?.map?.dispose(); mat?.dispose(); }
      });
    }
    this.world = new THREE.Group();
    this.scene.add(this.world);
    const daytime = !stadium.roof || Number(match.starts_at.slice(11, 13)) < 17;
    this.scene.background = new THREE.Color(daytime ? '#9cc9e6' : '#04080a');
    this.world.add(new THREE.HemisphereLight(daytime ? '#ffffff' : '#c9d8e6', daytime ? '#55704f' : '#22302a', daytime ? 2 : 1.5));
    const sun = new THREE.DirectionalLight('#ffffff', daytime ? 1.6 : 1.1);
    sun.position.set(30, 90, 40);
    this.world.add(sun);

    this.buildPitch(stadium);
    this.buildStands(stadium, seats, match, daytime);
    this.buildSeats(seats, stadium, match);
    this.buildPlayers(match);
    for (const roof of this.roofs) roof.visible = this.mode === 'seat';
    const marker = new THREE.Mesh(new THREE.ConeGeometry(.7, 1.6, 12), new THREE.MeshBasicMaterial({ color: '#39e07f' }));
    marker.rotation.x = Math.PI;
    marker.visible = false;
    this.marker = marker;
    this.world.add(marker);
  }

  buildPitch(stadium) {
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(PITCH_X * 2 + stadium.setback * 2 + 2, PITCH_Z * 2 + stadium.setback * 2 + 2), new THREE.MeshLambertMaterial({ color: '#1d5a31' }));
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -.02;
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(PITCH_X * 2, PITCH_Z * 2), new THREE.MeshLambertMaterial({ map: pitchTexture() }));
    pitch.rotation.x = -Math.PI / 2;
    this.world.add(apron, pitch);
    const post = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    for (const sign of [-1, 1]) {
      for (const z of [-2.45, 2.45]) {
        const upright = new THREE.Mesh(new THREE.CylinderGeometry(.07, .07, 1.65, 8), post);
        upright.position.set(sign * PITCH_X, .82, z);
        this.world.add(upright);
      }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(.07, .07, 4.9, 8), post);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(sign * PITCH_X, 1.65, 0);
      const net = new THREE.Mesh(new THREE.PlaneGeometry(4.9, 1.65), new THREE.MeshBasicMaterial({ color: '#dfe7e2', transparent: true, opacity: .16, side: THREE.DoubleSide }));
      net.rotation.y = Math.PI / 2;
      net.position.set(sign * (PITCH_X + 1), .82, 0);
      this.world.add(bar, net);
    }
  }

  /* Terraces share one stair profile, swept along each side so the corners close into a bowl. */
  buildStands(stadium, seats, match, daytime) {
    const rows = stadium.rows_count;
    const back = Math.max(...seats.map((s) => Math.max(Math.abs(s.x) - PITCH_X, Math.abs(s.z) - PITCH_Z))) + 1.1;
    const top = Math.max(...seats.map((s) => s.y)) + .4;
    const concrete = new THREE.MeshLambertMaterial({ color: daytime ? '#7d8782' : '#343c38' });
    const fascia = new THREE.MeshBasicMaterial({ color: '#0d1712' });
    const led = new THREE.MeshBasicMaterial({ color: '#7cf0ad' });
    const upperMaterial = new THREE.MeshLambertMaterial({
      map: crowdTexture([...CROWD_COLORS, match.home_color, match.home_color]),
      side: THREE.DoubleSide,
    });
    const boards = new THREE.MeshBasicMaterial({ map: boardTexture('ТРИБУНА  ·  БИЛЕТ С ВИДОМ НА ПОЛЕ') });
    const roofMaterial = new THREE.MeshLambertMaterial({ color: daytime ? '#c5ccc8' : '#0b100e', side: THREE.DoubleSide });
    const sectorHalf = stadium.seats_per_row * 1.1 / 2 + .5;
    const lamps = [];
    this.roofs = [];

    for (const [side, rotation] of Object.entries(SIDE_ROTATION)) {
      const longSide = side === 'south' || side === 'north';
      const near = (longSide ? PITCH_Z : PITCH_X) + stadium.setback;
      const halfLength = (longSide ? PITCH_X : PITCH_Z) + stadium.setback + back;
      const holder = new THREE.Group();
      holder.rotation.y = rotation;
      this.world.add(holder);

      for (let row = 1; row <= rows; row++) {
        const isBox = row === rows;
        const seat = seats.find((s) => s.row_number === row);
        const height = seat ? seat.y - .32 : 1;
        const depth = isBox ? back - stadium.setback - (row - 1) * ROW_DEPTH : ROW_DEPTH;
        const step = new THREE.Mesh(new THREE.BoxGeometry(halfLength * 2, height, depth + .02), concrete);
        step.position.set(0, height / 2, near + (row - 1) * ROW_DEPTH + depth / 2 - .6);
        holder.add(step);
      }

      const sold = stadium.sectors.filter((s) => s.side === side).map((s) => [s.offset_along - sectorHalf, s.offset_along + sectorHalf]).sort((a, b) => a[0] - b[0]);
      const gaps = [];
      let cursor = -halfLength;
      for (const [from, to] of sold) { if (from > cursor) gaps.push([cursor, from]); cursor = to; }
      if (cursor < halfLength) gaps.push([cursor, halfLength]);
      const rise = (rows - 2) * ROW_RISE, run = (rows - 2) * ROW_DEPTH;
      for (const [from, to] of gaps) {
        const bay = new THREE.Mesh(new THREE.PlaneGeometry(to - from, Math.hypot(rise, run)), upperMaterial.clone());
        bay.material.map = upperMaterial.map.clone();
        bay.material.map.repeat.set((to - from) / 34, .45);
        bay.material.map.needsUpdate = true;
        bay.position.set((from + to) / 2, 1.05 + rise / 2, near + run / 2 - .1);
        bay.rotation.order = 'YXZ';
        bay.rotation.set(-Math.atan2(run, rise), Math.PI, 0);
        holder.add(bay);
      }

      const board = new THREE.Mesh(new THREE.PlaneGeometry(halfLength * 2 - stadium.setback * 2, .75), boards.clone());
      board.material.map = boards.map.clone();
      board.material.map.repeat.x = longSide ? 2 : 1.4;
      board.material.map.needsUpdate = true;
      board.position.set(0, .4, near - 1.15);
      board.rotation.y = Math.PI;
      holder.add(board);

      // Decorative upper tier: it sets the scale of the bowl and is not sold.
      const baseZ = near + back - stadium.setback - .4;
      const lowerY = top + 1.6, upperZ = baseZ + 15, upperY = lowerY + 12;
      const band = new THREE.Mesh(new THREE.BoxGeometry(halfLength * 2, lowerY - top + .4, 1), fascia);
      band.position.set(0, top + (lowerY - top) / 2, baseZ);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(halfLength * 2, .12, .06), led);
      strip.position.set(0, top + (lowerY - top) * .7, baseZ - .53);
      holder.add(band, strip);
      const span = Math.hypot(upperZ - baseZ, upperY - lowerY);
      const tierLength = (halfLength + 15) * 2;
      const tier = new THREE.Mesh(new THREE.PlaneGeometry(tierLength, span), upperMaterial.clone());
      tier.material.map = upperMaterial.map.clone();
      tier.material.map.repeat.set(tierLength / 34, 1);
      tier.material.map.needsUpdate = true;
      tier.position.set(0, (lowerY + upperY) / 2, (baseZ + upperZ) / 2);
      tier.rotation.order = 'YXZ';
      tier.rotation.set(-Math.atan2(upperZ - baseZ, upperY - lowerY), Math.PI, 0);
      holder.add(tier);

      if (stadium.roof) {
        const roof = new THREE.Mesh(new THREE.PlaneGeometry(tierLength, 26), roofMaterial);
        roof.rotation.x = Math.PI / 2;
        roof.position.set(0, upperY + 2.5, upperZ - 11);
        holder.add(roof);
        this.roofs.push(roof);
        for (let i = -halfLength; i <= halfLength; i += 4.6) lamps.push({ holder, x: i, y: upperY + 2.2, z: upperZ - 23.5 });
      }
    }

    if (stadium.roof && lamps.length) {
      const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(.26, 8, 6), new THREE.MeshBasicMaterial({ color: '#fff9e3' }), lamps.length);
      const dummy = new THREE.Object3D();
      lamps.forEach((lamp, index) => {
        dummy.position.set(lamp.x, lamp.y, lamp.z);
        lamp.holder.updateMatrix();
        dummy.updateMatrix();
        bulbs.setMatrixAt(index, lamp.holder.matrix.clone().multiply(dummy.matrix));
      });
      this.world.add(bulbs);
      this.roofs.push(bulbs);
    } else if (!stadium.roof) {
      const mast = new THREE.MeshLambertMaterial({ color: '#6a726e' });
      const head = new THREE.MeshBasicMaterial({ color: '#fff9e3' });
      const reachX = PITCH_X + back + 22, reachZ = PITCH_Z + back + 22;
      for (const [x, z] of [[-reachX, -reachZ], [reachX, -reachZ], [-reachX, reachZ], [reachX, reachZ]]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(.35, .5, 40, 8), mast);
        pole.position.set(x, 20, z);
        const lights = new THREE.Mesh(new THREE.BoxGeometry(5, 3, .4), head);
        lights.position.set(x, 40, z);
        lights.lookAt(0, 0, 0);
        this.world.add(pole, lights);
      }
    }
  }

  buildSeats(seats, stadium, match) {
    const material = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    const makeGroup = (width, list) => {
      const cushion = new THREE.InstancedMesh(new THREE.BoxGeometry(width, .14, .62), material, list.length);
      const back = new THREE.InstancedMesh(new THREE.BoxGeometry(width, .6, .1), material, list.length);
      const dummy = new THREE.Object3D();
      const color = new THREE.Color();
      list.forEach((seat, index) => {
        dummy.rotation.set(0, -seat.yaw, 0);
        dummy.position.set(seat.x, seat.y, seat.z);
        dummy.updateMatrix();
        cushion.setMatrixAt(index, dummy.matrix);
        dummy.position.set(seat.x + Math.sin(seat.yaw) * -.3, seat.y + .3, seat.z + Math.cos(seat.yaw) * .3);
        dummy.updateMatrix();
        back.setMatrixAt(index, dummy.matrix);
        color.set(seat.kind === 'box' ? '#c9a24a' : this.seatColor(seat, stadium, match));
        cushion.setColorAt(index, color);
        back.setColorAt(index, color);
      });
      cushion.userData.seats = list;
      back.userData.seats = list;
      this.world.add(cushion, back);
      return [cushion, back];
    };
    const regular = seats.filter((s) => s.kind === 'regular');
    const boxes = seats.filter((s) => s.kind === 'box');
    this.seatMeshes = [...makeGroup(.9, regular), ...makeGroup(2.1, boxes)];

    const capacity = seats.length;
    this.crowdBodies = new THREE.InstancedMesh(new THREE.CylinderGeometry(.2, .3, .78, 8), new THREE.MeshLambertMaterial({ color: '#ffffff' }), capacity);
    this.crowdHeads = new THREE.InstancedMesh(new THREE.SphereGeometry(.17, 10, 8), new THREE.MeshLambertMaterial({ color: '#ffffff' }), capacity);
    this.world.add(this.crowdBodies, this.crowdHeads);
  }

  seatColor(seat, stadium, match) {
    const fan = stadium.sectors.find((s) => s.code === seat.sector)?.is_fan;
    return fan ? match.home_color : '#1f8a4e';
  }

  /* Purchased and held seats appear as people, so the crowd always matches the seat map. */
  syncSeats(seats) {
    this.seats = seats;
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    let count = 0;
    const fans = new Set(this.stadium.sectors.filter((s) => s.is_fan).map((s) => s.code));
    for (const seat of seats) {
      if (!seat.occupied) continue;
      dummy.rotation.set(0, -seat.yaw, 0);
      dummy.position.set(seat.x, seat.y + .46, seat.z);
      dummy.updateMatrix();
      this.crowdBodies.setMatrixAt(count, dummy.matrix);
      dummy.position.set(seat.x, seat.y + .96, seat.z);
      dummy.updateMatrix();
      this.crowdHeads.setMatrixAt(count, dummy.matrix);
      const shirt = fans.has(seat.sector) && hash(seat.id) < .8 ? this.homeColor() : CROWD_COLORS[Math.floor(hash(seat.id + .5) * CROWD_COLORS.length)];
      this.crowdBodies.setColorAt(count, color.set(shirt));
      this.crowdHeads.setColorAt(count, color.set(HAIR_COLORS[Math.floor(hash(seat.id + .25) * HAIR_COLORS.length)]));
      count++;
    }
    this.crowdBodies.count = count;
    this.crowdHeads.count = count;
    this.crowdBodies.instanceMatrix.needsUpdate = true;
    this.crowdHeads.instanceMatrix.needsUpdate = true;
    if (this.crowdBodies.instanceColor) this.crowdBodies.instanceColor.needsUpdate = true;
    if (this.crowdHeads.instanceColor) this.crowdHeads.instanceColor.needsUpdate = true;
  }

  homeColor() { return this.playerColors?.home || '#21a35a'; }

  buildPlayers(match) {
    this.playerColors = { home: match.home_color, away: match.away_color };
    const total = FORMATION.length * 2 + 1;
    const mk = (geometry, color) => {
      const mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial({ color }), total);
      this.world.add(mesh);
      return mesh;
    };
    this.playerParts = {
      legs: mk(new THREE.BoxGeometry(.3, .56, .2), '#101512'),
      torso: mk(new THREE.BoxGeometry(.44, .5, .26), '#ffffff'),
      head: mk(new THREE.SphereGeometry(.13, 10, 8), '#d8b49a'),
      shadow: mk(new THREE.CircleGeometry(.42, 12), '#0d2c18'),
    };
    this.playerParts.shadow.material.transparent = true;
    this.playerParts.shadow.material.opacity = .45;
    const color = new THREE.Color();
    this.players = [];
    for (let team = 0; team < 2; team++) {
      const sign = team ? -1 : 1;
      FORMATION.forEach(([x, z], index) => {
        const home = { x: x * sign * PITCH_X, z: z * sign * PITCH_Z };
        this.players.push({ home, x: home.x, z: home.z, phase: index * 1.7 + team * 3, team, goalkeeper: index === 0 });
        this.playerParts.torso.setColorAt(this.players.length - 1, color.set(team ? match.away_color : match.home_color));
      });
    }
    this.players.push({ home: { x: 0, z: 8 }, x: 0, z: 8, phase: 5, team: 2, goalkeeper: false });
    this.playerParts.torso.setColorAt(this.players.length - 1, color.set('#f3d21c'));
    this.playerParts.torso.instanceColor.needsUpdate = true;
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(.17, 12, 10), new THREE.MeshLambertMaterial({ color: '#ffffff' }));
    this.world.add(this.ball);
    this.ballState = { x: 0, z: 0, from: { x: 0, z: 0 }, to: this.players[9], start: 0, duration: 1.2, seed: 1 };
    this.simulatePlayers(0, 1);
  }

  simulatePlayers(time, delta) {
    const ball = this.ballState;
    const progress = clamp((time - ball.start) / ball.duration, 0, 1);
    ball.x = lerp(ball.from.x, ball.to.x, progress);
    ball.z = lerp(ball.from.z, ball.to.z, progress);
    if (progress >= 1) {
      ball.seed += 1;
      const outfield = this.players.filter((p) => !p.goalkeeper && p.team !== 2 && p !== ball.to);
      const next = outfield[Math.floor(hash(ball.seed) * outfield.length)];
      ball.from = { x: ball.x, z: ball.z };
      ball.to = next;
      ball.start = time;
      ball.duration = clamp(Math.hypot(next.x - ball.x, next.z - ball.z) / 14, .5, 2.2);
    }
    const dummy = new THREE.Object3D();
    this.players.forEach((player, index) => {
      const pull = player.goalkeeper ? .05 : player.team === 2 ? .7 : .3;
      const targetX = player.home.x + (ball.x - player.home.x) * pull + Math.sin(time * .5 + player.phase) * 1.4;
      const targetZ = player.home.z + (ball.z - player.home.z) * pull + Math.cos(time * .4 + player.phase) * 1.4;
      const blend = 1 - Math.exp(-delta * 1.1);
      const dx = (targetX - player.x) * blend, dz = (targetZ - player.z) * blend;
      player.x += dx; player.z += dz;
      const facing = Math.atan2(ball.x - player.x, ball.z - player.z);
      const place = (mesh, y) => {
        dummy.position.set(player.x, y, player.z);
        dummy.rotation.set(mesh === this.playerParts.shadow ? -Math.PI / 2 : 0, facing, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      };
      place(this.playerParts.shadow, .02);
      place(this.playerParts.legs, .28);
      place(this.playerParts.torso, .8);
      place(this.playerParts.head, 1.19);
    });
    for (const mesh of Object.values(this.playerParts)) mesh.instanceMatrix.needsUpdate = true;
    this.ball.position.set(ball.x, .17, ball.z);
  }

  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      if (this.audioEnabled) this.audioContext?.resume().catch(() => {});
      this.lastFrame = performance.now();
      this.frame = requestAnimationFrame((time) => this.tick(time));
    } else {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
      this.audioContext?.suspend().catch(() => {});
    }
  }

  tick(time) {
    this.frame = requestAnimationFrame((next) => this.tick(next));
    const delta = (time - this.lastFrame) / 1000;
    if (delta < 1 / 40) return;
    this.lastFrame = time;
    const step = Math.min(.1, delta);
    this.advanceCamera(step);
    if (this.world && !this.reducedMotion) this.simulatePlayers(time / 1000, step);
    this.render();
  }

  advanceCamera(elapsed) {
    const blend = 1 - Math.exp(-elapsed * 12);
    for (const key of Object.keys(this.targets)) this[key] += (this.targets[key] - this[key]) * blend;
    if (Math.abs(this.camera.fov - this.fov) > .001) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.updateCamera();
  }

  setSeat(seat, render = true) {
    if (!seat) return;
    this.selectedId = seat.id;
    this.seat = seat;
    if (this.marker) this.marker.position.set(seat.x, seat.y + 2.2, seat.z);
    this.resetLook(true);
    this.updateAudio();
    if (render) this.render();
  }

  setMode(mode) {
    this.mode = mode === 'overview' ? 'overview' : 'seat';
    if (this.marker) this.marker.visible = this.mode === 'overview';
    for (const roof of this.roofs || []) roof.visible = this.mode === 'seat';
    this.resetLook(true);
  }

  /* The default gaze is aimed at the pitch centre, so a corner seat starts turned toward play. */
  lookTargets() {
    const eye = this.eye();
    const dx = -eye.x, dz = -eye.z;
    const absolute = Math.atan2(dx, -dz);
    let yaw = absolute - this.seat.yaw;
    yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    return { yaw, pitch: Math.atan2(-eye.y + 1, Math.hypot(dx, dz)) };
  }

  eye() {
    const seat = this.seat;
    return { x: seat.x + Math.sin(seat.yaw) * .1, y: seat.y + 1.02, z: seat.z - Math.cos(seat.yaw) * .1 };
  }

  resetLook(instant = false) {
    const look = this.seat ? this.lookTargets() : { yaw: 0, pitch: 0 };
    Object.assign(this.targets, {
      yaw: look.yaw, pitch: look.pitch,
      orbitYaw: this.seat ? Math.atan2(this.seat.x, this.seat.z) : 0,
      orbitPitch: .62, orbitRadius: 92, fov: 55,
    });
    if (instant) {
      for (const key of Object.keys(this.targets)) this[key] = this.targets[key];
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
      this.updateCamera();
      this.render();
    }
  }

  updateCamera() {
    if (this.mode === 'overview') {
      const a = this.orbitPitch, r = this.orbitRadius;
      this.camera.position.set(Math.sin(this.orbitYaw) * Math.cos(a) * r, Math.sin(a) * r, Math.cos(this.orbitYaw) * Math.cos(a) * r);
      this.camera.lookAt(0, 2, 0);
    } else if (this.seat) {
      const eye = this.eye();
      this.camera.position.set(eye.x, eye.y, eye.z);
      const absolute = this.seat.yaw + this.yaw;
      this.camera.lookAt(eye.x + Math.sin(absolute) * Math.cos(this.pitch), eye.y + Math.sin(this.pitch), eye.z - Math.cos(absolute) * Math.cos(this.pitch));
    }
    this.updateAudioListener();
  }

  pointerDown(event) {
    this.pointer = { x: event.clientX, y: event.clientY, moved: false };
    this.canvas.setPointerCapture(event.pointerId);
  }
  pointerMove(event) {
    if (!this.pointer) return;
    const dx = event.clientX - this.pointer.x, dy = event.clientY - this.pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) this.pointer.moved = true;
    this.pointer.x = event.clientX; this.pointer.y = event.clientY;
    if (this.mode === 'overview') {
      this.targets.orbitYaw -= dx * .006;
      this.targets.orbitPitch = clamp(this.targets.orbitPitch + dy * .004, .18, 1.35);
    } else {
      this.targets.yaw = clamp(this.targets.yaw - dx * .005, -1.9, 1.9);
      this.targets.pitch = clamp(this.targets.pitch + dy * .004, -.95, .55);
    }
  }
  pointerUp(event) {
    if (!this.pointer) return;
    const moved = this.pointer.moved; this.pointer = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    if (moved || this.mode !== 'overview' || !this.seatMeshes) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointerVector.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height * 2 - 1));
    this.raycaster.setFromCamera(this.pointerVector, this.camera);
    const hit = this.raycaster.intersectObjects(this.seatMeshes, false)[0];
    const seat = hit?.object.userData.seats?.[hit.instanceId];
    if (seat) this.onSeatClick(seat.id);
  }
  wheel(event) {
    event.preventDefault();
    if (this.mode === 'overview') this.targets.orbitRadius = clamp(this.targets.orbitRadius + Math.sign(event.deltaY) * 6, 45, 150);
    else this.targets.fov = clamp(this.targets.fov + Math.sign(event.deltaY) * 3, 22, 75);
  }
  nudge(yaw, pitch) {
    if (this.mode === 'overview') {
      this.targets.orbitYaw += yaw;
      this.targets.orbitPitch = clamp(this.targets.orbitPitch + pitch, .18, 1.35);
    } else {
      this.targets.yaw = clamp(this.targets.yaw + yaw, -1.9, 1.9);
      this.targets.pitch = clamp(this.targets.pitch + pitch, -.95, .55);
    }
  }

  /* Crowd sound is synthesized: a stadium bed plus a chanting home end panned to its real position. */
  async enableAudio() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('Web Audio is unavailable');
    if (!this.audioContext) {
      const context = new Context();
      const noise = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
      const samples = noise.getChannelData(0);
      let last = 0;
      for (let i = 0; i < samples.length; i++) {
        last = (last + .03 * (Math.random() * 2 - 1)) / 1.03;
        samples[i] = last * 3.2;
      }
      const loop = (frequency, q) => {
        const source = context.createBufferSource();
        source.buffer = noise; source.loop = true;
        const filter = context.createBiquadFilter();
        filter.type = 'bandpass'; filter.frequency.value = frequency; filter.Q.value = q;
        source.connect(filter);
        source.start();
        return filter;
      };
      this.bedGain = context.createGain();
      loop(620, .5).connect(this.bedGain);
      this.bedGain.connect(context.destination);

      this.fanGain = context.createGain();
      const chant = context.createGain();
      chant.gain.value = .55;
      const pulse = context.createOscillator();
      pulse.frequency.value = 1.55;
      const depth = context.createGain();
      depth.gain.value = .45;
      pulse.connect(depth); depth.connect(chant.gain);
      pulse.start();
      this.fanPanner = context.createPanner();
      this.fanPanner.panningModel = 'HRTF';
      this.fanPanner.rolloffFactor = 0;
      loop(880, 1.4).connect(chant);
      chant.connect(this.fanGain);
      this.fanGain.connect(this.fanPanner);
      this.fanPanner.connect(context.destination);
      this.audioContext = context;
    }
    this.audioEnabled = true;
    this.updateAudio();
    await this.audioContext.resume();
  }

  disableAudio() {
    this.audioEnabled = false;
    this.audioContext?.suspend().catch(() => {});
  }

  updateAudio() {
    if (!this.audioContext || !this.seat || !this.stadium) return;
    const profile = crowdProfile(this.seat, this.seats, this.stadium.sectors, this.stadium.rows_count);
    const now = this.audioContext.currentTime;
    this.bedGain.gain.setTargetAtTime(.75 * profile.tier, now, .15);
    this.fanGain.gain.setTargetAtTime(2.4 * profile.tier * profile.fanLevel, now, .15);
    const panner = this.fanPanner;
    if (panner.positionX) {
      panner.positionX.value = profile.center.x; panner.positionY.value = 4; panner.positionZ.value = profile.center.z;
    } else panner.setPosition(profile.center.x, 4, profile.center.z);
    this.updateAudioListener();
  }

  updateAudioListener() {
    if (!this.audioContext || !this.seat) return;
    const context = this.audioContext, listener = context.listener;
    const eye = this.eye();
    const absolute = this.seat.yaw + this.yaw;
    const forward = [Math.sin(absolute), 0, -Math.cos(absolute)];
    if (listener.positionX) {
      for (const [param, value] of [[listener.positionX, eye.x], [listener.positionY, eye.y], [listener.positionZ, eye.z], [listener.forwardX, forward[0]], [listener.forwardY, 0], [listener.forwardZ, forward[2]]]) {
        param.setTargetAtTime(value, context.currentTime, .035);
      }
    } else {
      listener.setPosition(eye.x, eye.y, eye.z);
      listener.setOrientation(...forward, 0, 1, 0);
    }
  }

  render() {
    if (!this.canvas.parentElement.getBoundingClientRect().width || !this.world) return;
    this.renderer.render(this.scene, this.camera);
  }
}
