// Схема сектора сверху: координаты берутся из тех же x/z, что использует 3D-сцена
const P = 30, HX = 11.5, ZO = 2;
const sx = x => (x + HX) * P, sz = z => (z - ZO) * P + 44;
export function renderMap(el, seats, selId, screenW, onPick) {
  const zmax = Math.max(...seats.map(s => s.z)), H = sz(zmax) + 30;
  const rows = {}; seats.forEach(s => { (rows[s.row_num] ||= []).push(s); });
  const labels = Object.entries(rows).map(([r, a]) => { const m = a.reduce((p, s) => s.x < p.x ? s : p); return `<text class="rl" x="${sx(m.x) - (m.seat_type === 'sofa' ? 44 : 24)}" y="${sz(m.z) + 4}">${r}</text>`; }).join('');
  const rects = seats.map(s => {
    const w = (s.seat_type === 'sofa' ? 1.75 : 0.7) * P, h = (s.seat_type === 'sofa' ? 0.85 : 0.62) * P;
    const st = s.id === selId ? 'sel' : s.taken ? 'taken' : 'free', t = `${s.label}, ${s.price} ₽${s.taken ? ', занято' : ''}`;
    return `<rect class="seat ${st}" data-id="${s.id}" x="${sx(s.x) - w / 2}" y="${sz(s.z) - h / 2}" width="${w}" height="${h}" rx="5" role="button" aria-label="${t}" ${s.taken ? 'aria-disabled="true"' : 'tabindex="0"'}><title>${t}</title></rect>`;
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${HX * 2 * P} ${H}"><rect x="${sx(-HX + 0.6)}" y="6" width="${(HX * 2 - 1.2) * P}" height="30" rx="4" fill="#2a7e3f" stroke="#ffffff99" stroke-width="2"/><path d="M${sx(0)} 6v30" stroke="#ffffff99" stroke-width="2"/><circle cx="${sx(0)}" cy="21" r="9" fill="none" stroke="#ffffff99" stroke-width="2"/><text class="rl" x="${sx(0) + 16}" y="26" fill="#fff">Поле</text>${labels}${rects}</svg>`;
  const pick = e => { const g = e.target.closest('[data-id]'); if (g && !g.classList.contains('taken')) onPick(+g.dataset.id); };
  el.onclick = pick; el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); } };
}
