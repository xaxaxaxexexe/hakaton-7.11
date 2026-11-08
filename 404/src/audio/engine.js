// Звук: фоновая музыка сайта, «саундтрек» зала через колонки зала и проверка звука с места.
// Всё синтезируется Web Audio API, без внешних файлов. Колонки и параметры кресла берутся из БД:
// halls.speaker_layout, audio_reference_distance_m, audio_rolloff_factor, seats.audio_gain_db/occlusion/delay_ms.

const SPEED = 343; // м/с
const KEY = 'sphera-sound';
const NAMES = {
  L: 'Левый фронт', C: 'Центр', R: 'Правый фронт', LFE: 'Сабвуфер', SL: 'Левый боковой', SR: 'Правый боковой',
  SBL: 'Левый тыл', SBR: 'Правый тыл', TFL: 'Потолок, перед слева', TFR: 'Потолок, перед справа',
  TRL: 'Потолок, зад слева', TRR: 'Потолок, зад справа',
};
const ORDER = ['L', 'C', 'R', 'SR', 'SBR', 'SBL', 'SL', 'TFL', 'TFR', 'TRR', 'TRL', 'LFE'];
export const channelName = (c) => NAMES[c] || c;

let ctx = null, master, musicBus, sceneBus, uiBus, noiseBuf;
let wanted = (() => { try { return localStorage.getItem(KEY) === 'on'; } catch { return false; } })();
const subs = new Set();
const notify = () => subs.forEach((f) => f(isOn()));
export const isOn = () => !!ctx && ctx.state === 'running' && wanted;
export const onChange = (f) => { subs.add(f); return () => subs.delete(f); };

function init() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 3;
  master = ctx.createGain(); master.gain.value = 0.9;
  master.connect(comp).connect(ctx.destination);
  musicBus = ctx.createGain(); musicBus.gain.value = 0; musicBus.connect(master);
  sceneBus = ctx.createGain(); sceneBus.gain.value = 1; sceneBus.connect(master);
  uiBus = ctx.createGain(); uiBus.gain.value = 0.5; uiBus.connect(master);
  // розовый шум (фильтр Пола Келлета)
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
  }
}

export async function enable() {
  wanted = true; try { localStorage.setItem(KEY, 'on'); } catch {}
  init(); if (ctx.state !== 'running') await ctx.resume();
  music.start(); notify();
}
export function disable() {
  wanted = false; try { localStorage.setItem(KEY, 'off'); } catch {}
  if (ctx) { music.stop(); hall.stopSoundtrack(); ctx.suspend(); }
  notify();
}
export const wantsSound = () => wanted;
// браузер разрешает звук только после жеста пользователя
export function resumeOnGesture() {
  const go = () => { if (wanted) enable(); window.removeEventListener('pointerdown', go); window.removeEventListener('keydown', go); };
  window.addEventListener('pointerdown', go, { once: true }); window.addEventListener('keydown', go, { once: true });
}

const noiseSrc = () => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.loopStart = Math.random(); return s; };
const env = (g, t, a, hold, r, peak = 1) => {
  g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.setValueAtTime(peak, t + a + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + r);
};

// ---------- звуки интерфейса ----------
export function ui(name) {
  if (!isOn()) return;
  const t = ctx.currentTime;
  const tone = (f, at, dur, type = 'sine', vol = 0.22) => {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = type; o.frequency.value = f; o.connect(g).connect(uiBus);
    env(g, t + at, 0.005, 0.01, dur, vol); o.start(t + at); o.stop(t + at + dur + 0.05);
  };
  if (name === 'tap') tone(880, 0, 0.08);
  if (name === 'select') { tone(659, 0, 0.18, 'triangle'); tone(988, 0.06, 0.24, 'triangle'); }
  if (name === 'deselect') tone(440, 0, 0.14, 'triangle');
  if (name === 'error') { tone(196, 0, 0.18, 'square', 0.08); tone(174, 0.12, 0.22, 'square', 0.08); }
  if (name === 'success') [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.5, 'triangle', 0.18));
  if (name === 'fly') {
    const n = noiseSrc(); const f = ctx.createBiquadFilter(); const g = ctx.createGain();
    f.type = 'bandpass'; f.Q.value = 1.2; f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(2400, t + 0.9);
    f.frequency.exponentialRampToValueAtTime(500, t + 1.8);
    n.connect(f).connect(g).connect(uiBus); env(g, t, 0.6, 0.3, 0.9, 0.5); n.start(t); n.stop(t + 2);
  }
}

// ---------- генеративная музыка ----------
// Медленные аккорды и щипковая мелодия в ладу ре минор; источник подаётся либо в стерео (лобби),
// либо в колонки зала (тогда звук зависит от места).
const CHORDS = [[50, 57, 62, 65], [46, 53, 58, 62], [48, 55, 60, 64], [45, 52, 57, 60]];
const MELODY = [62, 65, 67, 69, 72, 74, 77];
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const music = {
  timer: null, step: 0, outs: null, nextChord: 0, nextNote: 0,
  start() {
    if (this.timer || !ctx) return;
    if (!this.outs) {
      const front = ctx.createGain(); const surround = ctx.createGain(); const lfe = ctx.createGain(); const left = ctx.createStereoPanner(); const right = ctx.createStereoPanner();
      left.pan.value = -0.6; right.pan.value = 0.6;
      this.outs = { front, surround, lfe, left, right };
      this.route('lobby');
    }
    musicBus.gain.setTargetAtTime(0.55, ctx.currentTime, 0.8);
    this.nextChord = this.nextNote = ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.tick(), 120);
  },
  stop() { clearInterval(this.timer); this.timer = null; if (ctx) musicBus.gain.setTargetAtTime(0, ctx.currentTime, 0.3); },
  route(mode, speakers) {
    const o = this.outs; if (!o) return;
    [o.front, o.surround, o.lfe, o.left, o.right].forEach((n) => n.disconnect());
    if (mode === 'lobby' || !speakers) {
      o.front.connect(musicBus); o.left.connect(musicBus); o.right.connect(musicBus);
      o.surround.connect(musicBus); o.lfe.connect(musicBus);
    } else {
      const pick = (...ids) => ids.map((id) => speakers[id]).filter(Boolean);
      pick('C').forEach((s) => o.front.connect(s.input));
      pick('L').forEach((s) => o.left.connect(s.input));
      pick('R').forEach((s) => o.right.connect(s.input));
      pick('SL', 'SR', 'SBL', 'SBR', 'TRL', 'TRR').forEach((s) => o.surround.connect(s.input));
      pick('LFE').forEach((s) => o.lfe.connect(s.input));
    }
  },
  tick() {
    const t = ctx.currentTime;
    while (this.nextChord < t + 0.4) { this.chord(this.nextChord, CHORDS[this.step % CHORDS.length]); this.step++; this.nextChord += 8; }
    while (this.nextNote < t + 0.4) {
      if (Math.random() < 0.7) this.pluck(this.nextNote, MELODY[Math.floor(Math.random() * MELODY.length)]);
      this.nextNote += [0.5, 0.75, 1, 1.5][Math.floor(Math.random() * 4)];
    }
  },
  chord(t, notes) {
    const o = this.outs; const g = ctx.createGain(); const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 0.5;
    g.connect(f); f.connect(o.front); f.connect(o.left); f.connect(o.right);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 2.5); g.gain.exponentialRampToValueAtTime(0.0001, t + 9);
    notes.forEach((m) => [-6, 6].forEach((det) => {
      const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = mtof(m); osc.detune.value = det;
      osc.connect(g); osc.start(t); osc.stop(t + 9.2);
    }));
    // бас в сабвуфер и ветер в тылы
    const b = ctx.createOscillator(); const bg = ctx.createGain(); b.frequency.value = mtof(notes[0] - 12);
    b.connect(bg).connect(o.lfe); env(bg, t, 1.5, 4, 2.5, 0.12); b.start(t); b.stop(t + 8.2);
    const n = noiseSrc(); const nf = ctx.createBiquadFilter(); const ng = ctx.createGain();
    nf.type = 'bandpass'; nf.Q.value = 0.7; nf.frequency.setValueAtTime(400, t); nf.frequency.linearRampToValueAtTime(1200, t + 4); nf.frequency.linearRampToValueAtTime(500, t + 8);
    n.connect(nf).connect(ng).connect(o.surround); env(ng, t, 3, 2, 3, 0.05); n.start(t); n.stop(t + 8.5);
  },
  pluck(t, m) {
    const o = this.outs; const osc = ctx.createOscillator(); const g = ctx.createGain(); const f = ctx.createBiquadFilter();
    osc.type = 'triangle'; osc.frequency.value = mtof(m);
    f.type = 'lowpass'; f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(600, t + 0.8);
    osc.connect(f).connect(g).connect(Math.random() < 0.5 ? o.left : o.right);
    env(g, t, 0.004, 0.02, 1.4, 0.07); osc.start(t); osc.stop(t + 1.6);
  },
};

// ---------- акустика зала ----------
// Боковые каналы на трибуне — линейки колонок вдоль сектора: для слушателя звучит ближайший участок линейки.
export function speakerPos(sp, hallData, eye) {
  if ((sp.channel === 'SL' || sp.channel === 'SR') && eye) {
    const D = Number(hallData.room_depth_m) || 18;
    return { x: sp.x, y: sp.y, z: Math.min(D * 0.9, Math.max(D * 0.3, eye.z)) };
  }
  return { x: sp.x, y: sp.y, z: sp.z };
}
// Модель затухания совпадает с PannerNode 'inverse': g = ref / (ref + rolloff * (max(d, ref) - ref)).
function measure(hallData, eye, seat) {
  const ref = Number(hallData.audio_reference_distance_m) || 4;
  const roll = Number(hallData.audio_rolloff_factor) || 1;
  const gainDb = Number(seat?.gain) || 0; const extra = Number(seat?.delay) || 0;
  const rows = (hallData.speaker_layout || []).map((sp) => {
    const p = speakerPos(sp, hallData, eye);
    const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
    const g = ref / (ref + roll * (Math.max(d, ref) - ref));
    return { id: sp.id, channel: sp.channel, name: channelName(sp.channel), dist: d, delay: (d / SPEED) * 1000 + extra, level: 20 * Math.log10(g) + gainDb };
  });
  const main = rows.filter((r) => r.channel !== 'LFE');
  const get = (c) => rows.find((r) => r.channel === c);
  const avg = (a) => a.reduce((x, r) => x + r.level, 0) / Math.max(1, a.length);
  const front = main.filter((r) => ['L', 'C', 'R'].includes(r.channel));
  const surr = main.filter((r) => !['L', 'C', 'R'].includes(r.channel));
  return {
    rows,
    balance: (get('L')?.level ?? 0) - (get('R')?.level ?? 0),
    spread: Math.max(...main.map((r) => r.delay)) - Math.min(...main.map((r) => r.delay)),
    frontSurr: avg(front) - avg(surr),
  };
}
// Оценка места относительно эталонного кресла зала (центр, примерно две трети глубины).
export function analyze(hallData, seat, eye, refEye) {
  const occ = Number(seat?.occ) || 0;
  const m = measure(hallData, eye, seat);
  const r = refEye ? measure(hallData, refEye, null) : { spread: m.spread, frontSurr: m.frontSurr };
  const dSpread = Math.max(0, m.spread - r.spread - 5);
  const dFS = Math.abs(m.frontSurr - r.frontSurr);
  let score = 100 - Math.max(0, Math.abs(m.balance) - 0.5) * 8 - dSpread * 1.0 - Math.max(0, dFS - 2) * 3 - occ * 60;
  score = Math.max(20, Math.min(100, Math.round(score)));
  let verdict;
  if (Math.abs(m.balance) > 1.2) verdict = `Ближе к ${m.balance > 0 ? 'левой' : 'правой'} части трибуны: ${m.balance > 0 ? 'слева' : 'справа'} шум громче на ${Math.abs(m.balance).toFixed(1)} дБ.`;
  else if (m.frontSurr - r.frontSurr > 3) verdict = 'Поле слышно лучше трибун: удары по мячу и крики игроков почти рядом.';
  else if (r.frontSurr - m.frontSurr > 3) verdict = 'Вы в гуще болельщиков: кричалки и барабаны вокруг звучат громче, чем у поля.';
  else if (dSpread > 8) verdict = `Звук дальних колонок отстаёт на ${Math.round(m.spread)} мс, объём чуть размыт.`;
  else verdict = 'Сбалансированное место: шум трибун и звуки поля слышны поровну.';
  if (occ > 0.05) verdict += ` Верхние частоты немного приглушены (${Math.round(occ * 100)}%).`;
  return { ...m, score, verdict, occ, gainDb: Number(seat?.gain) || 0 };
}

// Колонки зала как отдельные источники: задержка распространения + HRTF-панорамирование.
export const hall = {
  speakers: null, chain: null, data: null, seat: null, checking: false, abort: null, soundtrack: false,
  setup(hallData, seat) {
    if (!ctx) return;
    this.teardown();
    this.data = hallData; this.seat = seat;
    const ref = Number(hallData.audio_reference_distance_m) || 4; const roll = Number(hallData.audio_rolloff_factor) || 1;
    // цепочка кресла: доп. задержка, приглушение верхов, усиление
    const seatIn = ctx.createGain(); const dl = ctx.createDelay(1); const lp = ctx.createBiquadFilter(); const sg = ctx.createGain();
    lp.type = 'lowpass';
    seatIn.connect(dl).connect(lp).connect(sg).connect(sceneBus);
    this.chain = { seatIn, dl, lp, sg };
    this.speakers = {};
    (hallData.speaker_layout || []).forEach((sp) => {
      const input = ctx.createGain(); const delay = ctx.createDelay(1);
      const pan = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: ref, rolloffFactor: roll,
        positionX: sp.x, positionY: sp.y, positionZ: sp.z });
      input.connect(delay).connect(pan).connect(seatIn);
      this.speakers[sp.channel] = { ...sp, input, delay, pan };
    });
    this.applySeat(seat);
  },
  applySeat(seat) {
    if (!this.chain) return;
    this.seat = seat; const t = ctx.currentTime;
    const occ = Number(seat?.occ) || 0;
    this.chain.dl.delayTime.setTargetAtTime((Number(seat?.delay) || 0) / 1000, t, 0.05);
    this.chain.lp.frequency.setTargetAtTime(20000 * Math.pow(1 - occ, 2) + 1200 * occ, t, 0.05);
    this.chain.sg.gain.setTargetAtTime(Math.pow(10, (Number(seat?.gain) || 0) / 20), t, 0.05);
  },
  setListener(pos, forward) {
    if (!ctx || !this.speakers) return;
    const L = ctx.listener; const t = ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(pos.x, t, 0.03); L.positionY.setTargetAtTime(pos.y, t, 0.03); L.positionZ.setTargetAtTime(pos.z, t, 0.03);
      L.forwardX.setTargetAtTime(forward.x, t, 0.03); L.forwardY.setTargetAtTime(forward.y, t, 0.03); L.forwardZ.setTargetAtTime(forward.z, t, 0.03);
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else { L.setPosition(pos.x, pos.y, pos.z); L.setOrientation(forward.x, forward.y, forward.z, 0, 1, 0); }
    // задержка распространения от каждой колонки (или ближайшего участка линейки) до слушателя
    Object.values(this.speakers).forEach((s) => {
      const p = speakerPos(s, this.data, pos);
      if (s.channel === 'SL' || s.channel === 'SR') s.pan.positionZ.setTargetAtTime(p.z, t, 0.05);
      const d = Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z);
      s.delay.delayTime.setTargetAtTime(Math.min(0.9, d / SPEED), t, 0.05);
    });
  },
  startSoundtrack() {
    if (!isOn() || !this.speakers) return;
    this.soundtrack = true; music.route('hall', this.speakers);
  },
  stopSoundtrack() { this.soundtrack = false; music.route('lobby'); },
  // последовательно «прозванивает» колонки, затем делает облёт звуком вокруг слушателя
  async soundCheck(onStep) {
    if (!this.speakers) return;
    if (!isOn()) await enable();
    this.cancel();
    this.checking = true; let stopped = false;
    this.abort = () => { stopped = true; };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    musicBus.gain.setTargetAtTime(0.08, ctx.currentTime, 0.2);
    const list = ORDER.map((c) => this.speakers[c]).filter(Boolean);
    for (const sp of list) {
      if (stopped) break;
      onStep?.({ type: 'speaker', id: sp.id, channel: sp.channel, name: channelName(sp.channel) });
      const t = ctx.currentTime + 0.02; const g = ctx.createGain(); g.connect(sp.input);
      if (sp.channel === 'LFE') {
        const o = ctx.createOscillator(); o.frequency.setValueAtTime(40, t); o.frequency.linearRampToValueAtTime(80, t + 1.1);
        const n = noiseSrc(); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 90;
        o.connect(g); n.connect(f).connect(g); env(g, t, 0.05, 1.0, 0.25, 0.9);
        o.start(t); n.start(t); o.stop(t + 1.4); n.stop(t + 1.4);
      } else {
        const n = noiseSrc(); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1000; f.Q.value = 0.35;
        n.connect(f).connect(g); env(g, t, 0.03, 0.9, 0.15, 0.55); n.start(t); n.stop(t + 1.2);
      }
      await wait(1350);
      onStep?.({ type: 'speaker-off', id: sp.id });
    }
    if (!stopped) {
      // облёт: источник движется по кругу вокруг слушателя через фантомное панорамирование между колонками
      onStep?.({ type: 'flyover', name: 'Облёт стадиона' });
      const ring = list.filter((s) => s.channel !== 'LFE' && !s.channel.startsWith('T'));
      const n = noiseSrc(); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
      const gains = ring.map((s) => { const g = ctx.createGain(); g.gain.value = 0; f.connect(g).connect(s.input); return g; });
      n.connect(f); const t0 = ctx.currentTime; const dur = 4.5;
      for (let i = 0; i <= 90; i++) {
        const tt = t0 + (dur * i) / 90; const p = (i / 90) * ring.length;
        f.frequency.setValueAtTime(600 + 1800 * Math.sin(Math.PI * i / 90), tt);
        gains.forEach((g, k) => {
          let dist = Math.abs(p - k); dist = Math.min(dist, ring.length - dist);
          g.gain.setValueAtTime(Math.max(0, 1 - dist) * 0.5, tt);
        });
      }
      n.start(t0); n.stop(t0 + dur + 0.1);
      const step = (dur * 1000) / ring.length;
      for (let k = 0; k < ring.length && !stopped; k++) { onStep?.({ type: 'speaker', id: ring[k].id, channel: ring[k].channel, name: 'Облёт: ' + channelName(ring[k].channel), sweep: true }); await wait(step); onStep?.({ type: 'speaker-off', id: ring[k].id }); }
    }
    musicBus.gain.setTargetAtTime(0.55, ctx.currentTime, 0.6);
    this.checking = false;
    onStep?.({ type: 'done', stopped });
  },
  cancel() { this.abort?.(); this.abort = null; },
  teardown() {
    this.cancel();
    if (this.speakers) Object.values(this.speakers).forEach((s) => { s.input.disconnect(); s.pan.disconnect(); });
    if (this.chain) this.chain.sg.disconnect();
    this.speakers = null; this.chain = null;
    music.route('lobby');
  },
};
