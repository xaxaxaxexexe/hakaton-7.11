(() => {
  const $ = s => document.querySelector(s);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const saved = window.ARENA_SNAPSHOT;
  let data = saved || {dates:[],films:[],fetchedAt:null};
  let date = data.dates[0] || '';
  let page = location.hash === '#seances' ? 'seances' : 'afisha';
  let filter = 'all', query = '', hall = '', busy = false, sourceStatus = 'snapshot';
  const localPosters = new Map((saved?.films || []).map(f => [f.id, f.localPoster]));
  function poster(film) { return localPosters.get(film.id) || film.poster; }
  function readableDate(d) { return new Date(d + 'T12:00:00+03:00').toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow',day:'numeric',month:'long',weekday:'short'}); }
  function sourceTime(value) { return value ? new Date(value).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : ''; }
  function releaseUrl() { return '#seats'; }
  function price(s) { return s.minPrice === s.maxPrice ? s.minPrice + ' ₽' : s.minPrice + '–' + s.maxPrice + ' ₽'; }
  function matches(film) { return film.title.toLocaleLowerCase('ru').includes(query) && (filter === 'all' || film.badges.includes(filter)); }
  function sessions(film) { return film.sessions.filter(s => s.date === date && (!hall || s.hall === hall)); }
  function sessionButton(film, s) {
    return '<button class="showtime" data-session="' + esc(s.id) + '" aria-label="' + esc(film.title + ', ' + s.time + ', ' + s.hall + ', от ' + s.minPrice + ' рублей') + '"><b>' + esc(s.time) + '</b><span>' + esc(s.formats) + ' <em>от ' + s.minPrice + ' ₽</em></span><small>' + esc(s.hall) + '</small></button>';
  }
  function updateStatus() {
    $('#refreshSchedule').disabled = busy;
    $('#refreshSchedule').textContent = busy ? 'Обновляем…' : '↻ Обновить';
    $('#scheduleStatus').textContent = 'Расписание матчей стадиона · обновлено ' + sourceTime(data.fetchedAt);
  }
  function render() {
    document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
    document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
    $('#scheduleTitle').textContent = page === 'seances' ? 'Расписание' : 'Матчи';
    const currentDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    $('#scheduleDates').innerHTML = data.dates.map(d => '<button class="' + (d === date ? 'active' : '') + '" data-date="' + esc(d) + '">' + (d === currentDate ? 'Сегодня' : esc(readableDate(d))) + '<small>' + esc(d === currentDate ? readableDate(d) : '') + '</small></button>').join('');
    const halls = [...new Set(data.films.flatMap(f => f.sessions.filter(s => s.date === date).map(s => s.hall)))].sort((a,b)=>a.localeCompare(b,'ru',{numeric:true}));
    $('#hallFilter').innerHTML = '<option value="">Все сектора</option>' + halls.map(h => '<option' + (h === hall ? ' selected' : '') + '>' + esc(h) + '</option>').join('');
    const films = data.films.filter(f => matches(f) && sessions(f).length);
    const count = films.reduce((n,f)=>n+sessions(f).length,0);
    $('#scheduleCount').textContent = (date ? readableDate(date) + ' · ' : '') + 'Матчей: ' + films.length + ' · Секторов в продаже: ' + count;
    $('#movieList').classList.toggle('chronological', page === 'seances');
    if (page === 'seances') {
      $('#movieList').innerHTML = films.flatMap(f => sessions(f).map(s=>({f,s}))).sort((a,b)=>a.s.startsAt.localeCompare(b.s.startsAt)).map(({f,s}) =>
        '<article class="session-row"><div class="session-clock">' + esc(s.time) + '</div><img src="' + esc(poster(f)) + '" alt="" loading="lazy"><div class="session-film"><h2>' + esc(f.title) + '</h2><p>' + esc(f.genres.join(' · ')) + '</p></div><div class="session-facts"><b>' + esc(s.hall) + '</b><span>' + esc(s.formats) + ' · ' + price(s) + '</span></div><button class="session-open" data-session="' + esc(s.id) + '">Выбрать место</button></article>'
      ).join('');
    } else {
      $('#movieList').innerHTML = films.map(f =>
        '<article class="film-card"><img class="film-poster" src="' + esc(poster(f)) + '" alt="Матч: ' + esc(f.title) + '" loading="lazy"><div class="film-content"><div class="film-badges">' + f.badges.map(b=>'<span>' + (b === 'premiere' ? 'Главный матч' : 'Семейный') + '</span>').join('') + '</div><h2>' + esc(f.title) + '</h2><p class="film-genres">' + esc(f.genres.join(' · ')) + '</p><div class="showtimes">' + sessions(f).map(s=>sessionButton(f,s)).join('') + '</div></div></article>'
      ).join('');
    }
    $('#scheduleEmpty').hidden = count > 0;
    updateStatus();
  }
  function showSchedule(next = page) {
    page = next; $('#hallView').hidden = true; $('#scheduleView').hidden = false;
    history.replaceState(null, '', '#' + page);
    render();
  }
  function openSession(id) {
    const film = data.films.find(f => f.sessions.some(s => s.id === id));
    const s = film?.sessions.find(s => s.id === id);
    if (!s) return;
    $('#selectedPoster').src = poster(film); $('#selectedPoster').alt = 'Матч: ' + film.title;
    $('#selectedTitle').textContent = film.title; $('#selectedDate').textContent = readableDate(s.date);
    $('#selectedMeta').textContent = [...film.genres, s.formats].filter(Boolean).join(' · ');
    $('#selectedTime').textContent = s.time; $('#selectedHall').textContent = s.hall + ' · ' + price(s);
    $('#officialBooking').href = releaseUrl(film, s.date);
    $('#officialBooking').textContent = 'Купить билет';
    $('#walkCinema').textContent = 'Арена 3D / ' + s.hall + ' / вид с трибуны';
    Stadium.setContext({film, session:s});
    setTimeout(() => window.StadiumTour?.open(), 0);
    $('#scheduleView').hidden = true; $('#hallView').hidden = false;
    window.scrollTo({top:0});
    $('#backSchedule').focus({preventScroll:true});
  }
  async function refresh() {
    if (busy) return;
    busy = true; updateStatus();
    try {
      // Расписание матчей хранится в schedule-data.js.
      sourceStatus = 'snapshot';
      if (!data.dates.includes(date)) date = data.dates[0] || '';
      if (!data.films.some(f => f.sessions.some(s => s.hall === hall))) hall = '';
    } catch (e) { sourceStatus = 'failed'; }
    finally { busy = false; render(); }
  }
  $('#movieList').addEventListener('click', e => { const b=e.target.closest('[data-session]'); if(b)openSession(b.dataset.session); });
  $('#scheduleDates').addEventListener('click', e => { const b=e.target.closest('[data-date]'); if(b){date=b.dataset.date;hall='';render();} });
  document.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click',()=>{showSchedule(b.dataset.page);window.scrollTo({top:0});}));
  $('.arena-logo').addEventListener('click', e => {e.preventDefault();showSchedule('afisha');window.scrollTo({top:0});});
  document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click',()=>{filter=b.dataset.filter;render();}));
  $('#filmSearch').addEventListener('input', e=>{query=e.target.value.trim().toLocaleLowerCase('ru');render();});
  $('#hallFilter').addEventListener('change',e=>{hall=e.target.value;render();});
  $('#refreshSchedule').addEventListener('click',refresh);
  $('#officialBooking').addEventListener('click',e=>{e.preventDefault();$('#walkBtn').click();});
  $('#resetFilters').addEventListener('click',()=>{filter='all';query='';hall='';$('#filmSearch').value='';render();});
  $('#backSchedule').addEventListener('click',()=>showSchedule());
  showSchedule(); refresh();
})();
