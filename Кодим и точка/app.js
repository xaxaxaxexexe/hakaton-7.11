const map = document.querySelector('#seatMap');
const taken = new Set(['1-4','1-5','2-2','2-3','3-8','3-9','4-6','4-7','5-3','5-4','6-10','6-11','7-1','7-2','8-13']);
let selected = HallModel.get('5-12');
let sessionContext = null;
const seatButtons = new Map();
for (let row = 1; row <= HallModel.config.rows; row++) {
  const line = document.createElement('div');
  line.className = 'seat-row';
  const label = document.createElement('span');
  label.className = 'row-label';
  label.textContent = row;
  line.append(label);
  HallModel.seats.filter(q => q.row === row).forEach(q => {
    const el = document.createElement('button');
    el.className = 'seat' + (taken.has(q.id) ? ' taken' : '');
    el.disabled = taken.has(q.id);
    el.setAttribute('aria-label', 'Ряд ' + q.row + ', место ' + q.seat + (el.disabled ? ', занято' : ''));
    el.addEventListener('click', () => selectSeat(q.id));
    seatButtons.set(q.id, el);
    line.append(el);
  });
  map.append(line);
}
function selectSeat(id) {
  if (taken.has(id)) return false;
  const q = HallModel.get(id);
  if (!q) return false;
  selected = q;
  for (const [key, button] of seatButtons) {
    button.classList.toggle('selected', key === id);
    button.setAttribute('aria-pressed', String(key === id));
  }
  const screenDistance = Math.hypot(q.z - HallModel.config.field.z, q.y - HallModel.config.field.y);
  const angle = Math.round(Math.atan2(Math.abs(q.x), screenDistance) * 180 / Math.PI);
  const score = Math.max(40, Math.round(98 - angle * 0.7 - Math.abs(q.row - 5) * 3));
  document.querySelector('#placeTitle').textContent = 'Ряд ' + q.row + ', место ' + q.seat;
  document.querySelector('#placeDescription').textContent = q.row <= 2 ? 'У кромки поля · игроки рядом' : q.row >= 7 ? 'Верх сектора · поле как схема' : 'Центр трибуны · поле почти целиком';
  document.querySelector('#qualityScore').textContent = score + '/100';
  document.querySelector('#qualityLabel').textContent = score > 88 ? 'Отличный' : score > 74 ? 'Хороший' : 'Под углом';
  document.querySelector('#distance').textContent = Math.hypot(q.x, screenDistance).toFixed(1).replace('.', ',') + ' м';
  document.querySelector('#angle').textContent = angle + '°';
  document.querySelector('#total').textContent = sessionPrice();
  document.querySelector('.recommendation p').textContent = 'Оценка обзора приблизительная. Выйдите на трибуну в 3D, осмотритесь и сравните места своими глазами.';
  return true;
}
function sessionPrice() {
  if (!sessionContext) return '—';
  const {minPrice, maxPrice} = sessionContext.session;
  return minPrice === maxPrice ? minPrice + ' ₽' : minPrice + '–' + maxPrice + ' ₽';
}
window.Stadium = { get selected() { return selected; }, taken, selectSeat,
  get context() { return sessionContext; }, priceLabel: sessionPrice,
  setContext(value) { sessionContext = value; selectSeat(selected.id); window.dispatchEvent(new Event('stadium-session-change')); } };
selectSeat(selected.id);
