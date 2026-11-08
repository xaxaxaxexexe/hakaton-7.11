// Демо-акустика стадиона: гул двух трибун — левой и фан-сектора справа за воротами.
// Громкость, задержка и «глухота» зависят от расстояния до места: у фан-сектора громче, наверху тише.
export function playSeat(seat, screenW) {
  const ctx = new AudioContext(), len = ctx.sampleRate * 1.2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
  let p = 0; for (let i = 0; i < len; i++) { p = p * 0.9 + (Math.random() * 2 - 1) * 0.3; d[i] = p * Math.sin(Math.PI * i / len); }
  const lv = [], src = [[-40, 6, -30, 0.7], [45, 6, -20, 1.4]];
  src.forEach(([sx, sy, sz, loud], i) => {
    const dist = Math.hypot(seat.x - sx, seat.y + 1.15 - sy, seat.z - sz), gain = Math.min(1, loud * 12 / (1 + dist));
    const s = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter(), pan = ctx.createStereoPanner(), dl = ctx.createDelay(1);
    s.buffer = buf; g.gain.value = gain; f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.6; pan.pan.value = i ? 0.8 : -0.8; dl.delayTime.value = dist / 343;
    s.connect(f).connect(g).connect(dl).connect(pan).connect(ctx.destination); s.start(ctx.currentTime + i * 1.3); lv.push(Math.round(gain * 100));
  });
  setTimeout(() => ctx.close(), 3500);
  return `Демо-моделирование: левая трибуна ${lv[0]}%, фан-сектор ${lv[1]}%`;
}
