// Клиент: все данные берутся из БД через API (server.py) и туда же возвращаются.
const $=s=>document.querySelector(s),rub=n=>n.toLocaleString("ru-RU")+" ₽",HOUR=36e5,MAX=10;
let DATA,ME=null;
const S={id:null,sel:[],view:null,pay:"",agree:false,cin:null,next:"#/profile",flash:"",tk:new Set()};
const api=async(p,b)=>{const r=await fetch("/api/"+p,b===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}),j=await r.json().catch(()=>({}));
 if(!r.ok)throw Object.assign(new Error(j.error||"Ошибка сервера"),{data:j});return j};
const toast=(m,t="info")=>{const e=document.createElement("div");e.className="toast toast--"+t;e.textContent=m;$("#toasts").append(e);setTimeout(()=>e.classList.add("toast--out"),3200);setTimeout(()=>e.remove(),3700)};
const fmt=ts=>new Date(ts).toLocaleString("ru-RU",{day:"numeric",month:"long",hour:"2-digit",minute:"2-digit"});
const cinema=id=>DATA.cinemas.find(c=>c.id==id),film=id=>DATA.films.find(f=>f.id==id),ses=id=>DATA.sessions.find(s=>s.id==id),payName=id=>PAYS.find(p=>p.id==id).name;
const tier=(c,r)=>c.tiers.find(t=>r>=t[0]&&r<=t[1])[2],price=(s,r)=>Math.round(tier(cinema(s.cin),r)*(100-s.off)/100);
const seatName=(c,id)=>{const[r,i]=id.split("-").map(Number);return`Ряд ${r+1}, ${r==c.rows.length-1?"ложа":"место"} ${i+1}`};
const mono=t=>t.split(/[\s:-]+/).filter(w=>w.length>2).slice(0,2).map(w=>w[0]).join("");
const tags=s=>(film(s.film).marvel?'<span class="tag tag--marvel">Кубок</span> ':"")+(s.running?'<span class="tag tag--live">Идёт матч</span> ':"")+(s.off?`<span class="badge">−${s.off}%</span>`:"");
const fresh=async()=>{ME=(await api("me")).user;renderNav()};

function renderNav(){$("#user").innerHTML=ME?`<a class="btn btn--ghost" href="#/profile">${ME.name}</a><button class="btn btn--ghost" data-act="logout">Выйти</button>`:`<a class="btn btn--ghost" href="#/login">Войти</a><a class="btn btn--primary" href="#/register">Регистрация</a>`;
 document.querySelectorAll(".header__link").forEach(a=>a.classList.toggle("header__link--active",a.getAttribute("href")==(location.hash||"#/")))}
const ring=act=>{const n=DATA.cinemas.length,c=cinema(S.cin);return`<div class="ring"><div class="ring__core"><b>${c.name}</b><span>${DATA.sessions.filter(s=>s.cin==c.id).length} матчей</span></div>${DATA.cinemas.map((x,i)=>`<button class="ring__item ${x.id==S.cin?"ring__item--active":""}" style="--a:${i/n*360-90}deg" data-act="${act}" data-id="${x.id}"><span class="ring__label">${x.name}</span></button>`).join("")}</div>`};
const promoCard=s=>{const c=cinema(s.cin),f=film(s.film);return`<article class="promo"><span class="promo__badge">−${s.off}%</span><h3 class="promo__title">${f.title}</h3><p class="promo__meta">${c.name} · ${fmt(s.start)}</p><p class="promo__price">от ${rub(price(s,0))} <s>${rub(tier(c,0))}</s></p><a class="btn btn--primary" href="#/hall/${s.id}">Выбрать место</a></article>`};

function home(){$("#app").innerHTML=`<section class="hero"><div><h1 class="hero__title">Увидьте поле <span>до покупки</span> билета</h1>
 <p class="hero__text">Выберите место на трибуне и посмотрите на поле с него в 3D. Стадионы сети в Аргуне, Грозном и Гудермесе.</p>
 <div class="hero__actions"><a class="btn btn--primary" href="#/sessions">Выбрать матч</a><a class="btn" href="#/register">Создать аккаунт</a></div></div><img class="hero__img" src="img/hero.svg" alt="Стадион"></section>
 <section class="marvel"><div><span class="marvel__tag">Турнир</span><h2>Кубок республики: матч дня</h2><p class="muted">Сегодня на каждом стадионе сети матч дня Кубка республики. В 3D-виде баннеры турнира на рекламных бортах вокруг поля.</p>
 <button class="btn btn--primary" data-act="spider">Купить билет на матч дня</button></div><div class="marvel__poster">КУБОК<br>РЕСПУБЛИКИ<br><small>МАТЧ ДНЯ</small></div></section>
 <h2 class="section__title">Выберите стадион</h2>${ring("pick")}<div style="text-align:center"><a class="btn btn--primary" href="#/sessions">Показать матчи</a></div>
 <h2 class="section__title">Скидки на матчи</h2><div class="promos">${DATA.sessions.filter(s=>s.off).map(promoCard).join("")}</div>`}
function sessions(){const c=cinema(S.cin);$("#app").innerHTML=`<h2>Матчи</h2>${ring("cin")}${DATA.sessions.filter(s=>s.cin==c.id).sort((a,b)=>a.start-b.start).map(s=>`<div class="session"><div class="session__main"><div class="poster">${mono(film(s.film).title)}</div><span><b>${film(s.film).title}</b><br><small class="muted">${fmt(s.start)} · от ${rub(price(s,0))}</small><br>${tags(s)}</span></div><a class="btn btn--primary" href="#/hall/${s.id}">Выбрать места</a></div>`).join("")}`}

async function hall(id){const s=ses(+id);if(!s)return home();S.tk=new Set(await api("taken?s="+s.id));
 Object.assign(S,{id:s.id,sel:[],view:null,agree:false,pay:ME&&ME.pays[0]?ME.pays[0].system:""});const c=cinema(s.cin),f=film(s.film);
 $("#app").innerHTML=`<section class="hall"><div class="hall__head"><a class="btn btn--ghost" href="#/sessions">← Матчи</a><div><h2 class="hall__title">${f.title}</h2><p class="hall__meta">${c.name} · ${fmt(s.start)} ${tags(s)}</p></div></div>
 <div class="limit" id="limit"><b>Максимум ${MAX} мест в одном заказе</b><div class="limit__bar"><i id="lbar"></i></div><span id="lcnt"></span></div>
 <div class="hall__grid"><div><div class="view3d" id="view3d"><div class="view3d__placeholder">3D-вид выключен.<br>Нажмите «Включить 3D», чтобы увидеть поле с выбранного места.</div></div>
 <div class="hall__tools"><button class="btn btn--primary" data-act="3d" id="b3d">Включить 3D</button><button class="btn" data-act="sound" id="bsnd">Включить звук стадиона</button><span class="hall__hint" id="vi">Выберите место на схеме</span></div></div>
 <div><div class="panel"><div class="hall__screen"><span>поле</span></div><div id="map"></div><div class="legend"><span>▢ Свободно</span><span>■ Занято</span><span style="color:var(--ok)">■ Ваше место</span></div>
 <p class="hall__hint">${c.tiers.map(t=>`Ряды ${t[0]+1}${t[0]==t[1]?"":"–"+(t[1]+1)}${t[1]==c.rows.length-1?" (ложи)":""}: ${rub(Math.round(t[2]*(100-s.off)/100))}`).join(" · ")}</p></div><div class="panel" id="checkout"></div></div></div></section>`;drawMap();drawCart()}
function drawMap(){const s=ses(S.id),c=cinema(s.cin),L=c.rows.length-1;$("#map").innerHTML=c.rows.map((n,r)=>`<div class="map__row"><span class="map__num">${r+1}</span>${[...Array(n)].map((_,i)=>{const id=r+"-"+i,tk=S.tk.has(id);
 return`<button class="seat ${r==L?"seat--sofa":""} ${tk?"seat--taken":""} ${S.sel.includes(id)?"seat--selected":""} ${S.view==id?"seat--view":""}" data-act="seat" data-id="${id}" data-tip="${seatName(c,id)} · ${tk?"занято":rub(price(s,r))}" ${tk?"disabled":""} aria-label="${seatName(c,id)}"></button>`}).join("")}</div>`).join("")}
function drawCart(msg=""){const s=ses(S.id),c=cinema(s.cin),n=S.sel.length,total=S.sel.reduce((a,id)=>a+price(s,+id.split("-")[0]),0);
 $("#lbar").style.width=n/MAX*100+"%";$("#lcnt").textContent=`${n} / ${MAX}`;$("#limit").classList.toggle("limit--full",n>=MAX);
 $("#checkout").innerHTML=`<h3 class="profile__title">Ваш заказ</h3>${S.sel.map(id=>`<div class="cart__line"><span>${seatName(c,id)}</span><span>${rub(price(s,+id.split("-")[0]))}</span></div>`).join("")||'<p class="muted">Выберите места на схеме</p>'}<div class="cart__total">Итого: ${rub(total)}</div>`+(ME?
 `<h3 class="profile__title">Способ оплаты</h3>${PAYS.map(p=>{const sv=ME.pays.find(x=>x.system==p.id);return`<label class="pay ${S.pay==p.id?"pay--active":""}"><input type="radio" name="pay" value="${p.id}" ${S.pay==p.id?"checked":""}><img class="pay__logo" src="img/pay-${p.id}.svg" alt=""><span>${p.name}${sv?` · •••• ${sv.last4}`:""}</span></label>`}).join("")}
 <label class="check"><input type="checkbox" id="agree" ${S.agree?"checked":""}><span>Принимаю <a href="#/terms" target="_blank">пользовательское соглашение</a> и условия возврата</span></label><div class="cart__error">${msg}</div>
 <button class="btn btn--primary" style="width:100%" data-act="buy" id="buy" ${n?"":"disabled"}>Оплатить ${n?rub(total):""}</button>`
 :`<p class="muted">Чтобы купить билет, <a href="#/login" data-act="needauth">войдите</a> или <a href="#/register" data-act="needauth">зарегистрируйтесь</a>.</p>`)}
function setView(id){const c=cinema(ses(S.id).cin);S.view=id;$("#vi").textContent=id?`Вид с места: ${seatName(c,id)}`:"Выберите место на схеме";
 if(id){const[r,i]=id.split("-").map(Number),p=seatPos(c,r,i);Sound.listen(p[0],p[1]+1.4,p[2]);if(Hall3D.r)Hall3D.view(c,id)}}
async function buy(){const s=ses(S.id);if(!S.sel.length)return;if(!S.pay)return drawCart("Выберите способ оплаты");if(!S.agree)return drawCart("Примите пользовательское соглашение");
 $("#buy").disabled=true;$("#buy").textContent="Обработка платежа…";
 try{await new Promise(r=>setTimeout(r,700));await api("buy",{session:s.id,seats:S.sel,pay:S.pay});S.flash="Оплата прошла успешно. Места закреплены за вами и заблокированы для других покупателей.";location.hash="#/profile"}
 catch(e){if(e.data&&e.data.taken){S.tk=new Set(e.data.taken);S.sel=S.sel.filter(i=>!S.tk.has(i));drawMap();if(Hall3D.r)Hall3D.build(cinema(s.cin),S.tk,S.sel)}toast(e.message,"error");drawCart(e.message)}}

const authForm=k=>`<section class="auth"><form class="auth__form" data-form="${k}"><h2>${k=="login"?"Вход":"Регистрация"}</h2>${k=="register"?'<label class="field">Имя<input class="field__input" name="name" required minlength="2"></label>':""}
 <label class="field">Email<input class="field__input" name="email" type="email" required></label><label class="field">Пароль (от 6 символов)<input class="field__input" name="pass" type="password" required minlength="6"></label>
 ${k=="register"?'<label class="check"><input type="checkbox" name="agree" required><span>Принимаю <a href="#/terms" target="_blank">пользовательское соглашение</a></span></label>':""}
 <p class="auth__error" id="err"></p><button class="btn btn--primary" style="width:100%">${k=="login"?"Войти":"Создать аккаунт"}</button><p class="auth__alt">${k=="login"?'Нет аккаунта? <a href="#/register">Регистрация</a>':'Уже есть аккаунт? <a href="#/login">Войти</a>'}</p></form></section>`;
async function profile(){if(!ME){S.next="#/profile";return location.hash="#/login"}const tk=await api("tickets"),flash=S.flash;S.flash="";const u=ME;
 $("#app").innerHTML=`<h2>Личный кабинет</h2>${flash?`<div class="notice">${flash}</div>`:""}<div class="profile">
 <section class="panel"><h3 class="profile__title">Профиль</h3><form data-form="profile"><label class="field">Имя<input class="field__input" name="name" value="${u.name}" required></label><p class="muted">${u.email}</p><button class="btn">Сохранить</button></form></section>
 <section class="panel"><h3 class="profile__title">Настройки</h3><label class="check"><input type="checkbox" data-set="notify" ${u.set.notify?"checked":""}><span>Напоминать о матче (демо)</span></label>
 <label class="check"><input type="checkbox" data-set="def3d" ${u.set.def3d?"checked":""}><span>Сразу включать 3D при выборе места</span></label>
 <label class="field">Способ оплаты по умолчанию<select class="field__input" data-set="defpay"><option value="">— не выбран —</option>${PAYS.map(p=>`<option value="${p.id}" ${u.set.defpay==p.id?"selected":""}>${p.name}</option>`).join("")}</select></label></section>
 <section class="panel profile__wide"><h3 class="profile__title">Способы оплаты</h3>${u.pays.map(p=>`<div class="bankcard"><img class="method__logo" src="img/pay-${p.system}.svg" alt=""><div><div class="bankcard__num">•••• •••• •••• ${p.last4}</div><div class="bankcard__meta">${payName(p.system)}${p.exp?" · до "+p.exp:""}</div></div><button class="btn btn--danger" data-act="rmpay" data-id="${p.id}">Удалить</button></div>`).join("")||'<p class="muted">Ничего не привязано</p>'}
 <form data-form="addpay"><label class="field">Способ<select class="field__input" name="system">${PAYS.map(p=>`<option value="${p.id}">${p.name}</option>`).join("")}</select></label><label class="field">Номер карты / телефона / кошелька (хранится только окончание)<input class="field__input" name="num" required minlength="4"></label><p class="auth__error" id="err"></p><button class="btn btn--primary">Привязать</button></form></section>
 <section class="panel profile__wide"><h3 class="profile__title">Мои билеты</h3>${tk.map(t=>{const s=ses(t.ses),c=cinema(s.cin),can=t.status=="active"&&t.ts-Date.now()>=HOUR;
  return`<div class="ticket ${t.status=="refunded"?"ticket--refunded":""}"><div><div class="ticket__film">${film(s.film).title}</div><div class="ticket__meta">${c.name} · ${fmt(t.ts)}<br>${t.seats.map(i=>seatName(c,i)).join("; ")}</div><small>№ ${t.id} · ${payName(t.pay)}</small></div>
  <div class="ticket__side"><b>${rub(t.total)}</b><div class="ticket__status">${t.status=="refunded"?"Возвращён":t.ts<Date.now()?"Матч начался":"Действует"}</div>${t.status=="active"?`<button class="btn btn--danger" data-act="refund" data-id="${t.id}" ${can?"":"disabled title='Возврат возможен не позднее чем за час до начала'"}>Вернуть</button>`:""}</div></div>`}).join("")||'<p class="muted">Билетов пока нет. <a href="#/sessions">Выбрать матч</a></p>'}</section></div>`}
function terms(){$("#app").innerHTML=`<article class="terms"><h2>Пользовательское соглашение</h2><p class="muted">Учебный проект: текст демонстрационный и не является юридической офертой.</p>
 <h3>1. Общие положения</h3><p>Сервис позволяет выбрать стадион и матч, посмотреть вид на поле в 3D и приобрести билет. Регистрируясь, вы принимаете эти условия.</p>
 <h3>2. Оплата</h3><p>Принимаются «Мир», СБП, SberPay, ЮMoney, T-Pay. Цена зависит от места и скидки на матч и рассчитывается на сервере. В демо-версии реальные списания не выполняются, хранится только окончание номера карты.</p>
 <h3>3. Места</h3><p>В одном заказе — не более 10 мест. Купленные места блокируются для повторной покупки вами и другими пользователями.</p>
 <h3>4. Возврат билета</h3><p>Билет можно вернуть в личном кабинете не позднее чем за 1 час до начала матча. Сумма возвращается тем же способом оплаты, места снова становятся свободными.</p>
 <h3>5. Турнир</h3><p>Стадионы, клубы и турнир вымышлены и используются только для демонстрации сервиса.</p>
 <h3>6. Персональные данные</h3><p>Хранятся имя, email, хеш пароля и история заказов — только для работы сервиса.</p></article>`}

const A={
 pick:e=>{S.cin=e.dataset.id;home()},cin:e=>{S.cin=e.dataset.id;sessions()},needauth:()=>{S.next=location.hash},
 spider:()=>{const s=DATA.sessions.find(x=>x.cin==S.cin&&film(x.film).marvel);location.hash="#/hall/"+s.id},
 logout:async()=>{await api("logout",{});ME=null;renderNav();location.hash="#/";route()},
 seat:e=>{const id=e.dataset.id,k=S.sel.indexOf(id);if(k<0){if(S.sel.length>=MAX)return toast(`Максимум ${MAX} мест в одном заказе`,"error");S.sel.push(id);setView(id);if(ME&&ME.set.def3d&&!Hall3D.r)A["3d"]()}else{S.sel.splice(k,1);setView(S.sel.at(-1)||null)}
  drawMap();drawCart();if(Hall3D.sc)Hall3D.paint(S.sel)},
 "3d":()=>{const c=cinema(ses(S.id).cin),b=$("#b3d");if(Hall3D.r){Hall3D.off();$("#view3d").innerHTML='<div class="view3d__placeholder">3D-вид выключен.</div>';b.textContent="Включить 3D";return}
  if(!Hall3D.on($("#view3d")))return toast("Не удалось загрузить 3D-библиотеку","error");Hall3D.build(c,S.tk,S.sel);b.textContent="Выключить 3D";if(S.view)Hall3D.view(c,S.view)},
 sound:()=>{const b=$("#bsnd");if(Sound.ctx){Sound.stop();b.textContent="Включить звук стадиона";return}Sound.start();b.textContent="Выключить звук стадиона";setView(S.view);toast("Звук стадиона включён: у фан-сектора громче, на верхних рядах тише")},
 buy,refund:async e=>{if(!confirm("Вернуть билет? Места снова станут свободными."))return;try{await api("refund",{id:e.dataset.id});S.flash="Билет возвращён, места свободны.";profile()}catch(x){toast(x.message,"error")}},
 rmpay:async e=>{ME=(await api("pay/delete",{id:+e.dataset.id})).user;profile()}
};
document.addEventListener("click",e=>{const b=e.target.closest("[data-act]");if(b&&A[b.dataset.act])A[b.dataset.act](b)});
document.addEventListener("change",async e=>{const t=e.target;if(t.name=="pay"){S.pay=t.value;drawCart()}else if(t.id=="agree"){S.agree=t.checked;drawCart()}
 else if(t.dataset.set){ME.set[t.dataset.set]=t.type=="checkbox"?t.checked:t.value;ME=(await api("settings",ME.set)).user;toast("Настройки сохранены")}});
document.addEventListener("submit",async e=>{const f=e.target.dataset.form;if(!f)return;e.preventDefault();const d=Object.fromEntries(new FormData(e.target)),err=m=>{const x=$("#err");x?x.textContent=m:toast(m,"error")};
 try{if(f=="register"||f=="login"){ME=(await api(f,d)).user;renderNav();const n=S.next;S.next="#/profile";location.hash=n;route()}
  else if(f=="profile"){ME=(await api("profile",d)).user;renderNav();toast("Профиль сохранён")}
  else if(f=="addpay"){ME=(await api("pay/add",d)).user;profile();toast("Способ оплаты привязан")}}catch(x){err(x.message)}});
const tip=$("#tip");document.addEventListener("mouseover",e=>{const t=e.target.closest("[data-tip]");tip.hidden=!t;if(t)tip.textContent=t.dataset.tip});
document.addEventListener("mousemove",e=>{if(!tip.hidden){tip.style.left=e.clientX+12+"px";tip.style.top=e.clientY+14+"px"}});

async function route(){const[p,a]=location.hash.slice(2).split("/");Hall3D.off();Sound.stop();window.scrollTo(0,0);
 const R={"":home,sessions,hall:()=>hall(a),login:()=>$("#app").innerHTML=authForm("login"),register:()=>$("#app").innerHTML=authForm("register"),profile,terms};
 try{await(R[p]||home)()}catch(e){toast(e.message,"error")}renderNav()}
(async()=>{try{DATA=await api("bootstrap");S.cin=DATA.cinemas[0].id;await fresh()}catch(e){$("#app").innerHTML='<p class="notice" style="color:var(--danger)">Сервер недоступен. Запустите <code>python3 server.py</code> и откройте http://localhost:8000</p>';return}
 addEventListener("hashchange",route);route()})();
