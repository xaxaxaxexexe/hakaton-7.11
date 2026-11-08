'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),catalog=require('./catalog.js'),hall=require('./hall-model.js');
const ROOT=__dirname;
const occupied=new Set(['1-4','1-5','2-2','2-3','3-8','3-9','4-6','4-7','5-3','5-4','6-10','6-11','7-1','7-2','8-13']);
const snapshot=()=>JSON.parse(fs.readFileSync(path.join(ROOT,'schedule-data.js'),'utf8').replace(/^window\.ARENA_SNAPSHOT\s*=\s*/,'').replace(/;\s*$/,''));
const fail=(code,message)=>Object.assign(new Error(message),{statusCode:code});
function quote(input,schedule){
  if(!input||typeof input!=='object')throw fail(400,'Неверный заказ');
  const film=schedule.films.find(f=>f.sessions.some(s=>s.id===input.sessionId)),session=film?.sessions.find(s=>s.id===input.sessionId),seat=hall.get(input.seatId);
  if(!session)throw fail(400,'Матч не найден. Обновите расписание.');
  if(!seat||occupied.has(seat.id))throw fail(400,'Выберите свободное место в макете.');
  if(!Array.isArray(input.items)||input.items.length>catalog.length)throw fail(400,'Неверный состав заказа');
  const seen=new Set(),items=input.items.map(i=>{const p=catalog.find(p=>p.id===i.id);if(!p||seen.has(i.id)||!Number.isInteger(i.qty)||i.qty<1||i.qty>20)throw fail(400,'Неверное количество товара');seen.add(i.id);return{id:p.id,title:p.title,price:p.price,qty:i.qty,confirmed:p.confirmed};}).sort((a,b)=>a.id.localeCompare(b.id));
  const price=Math.round(session.minPrice*100);if(!Number.isSafeInteger(price)||price<=0)throw fail(400,'Цена матча недоступна');
  return{ticket:{title:film.title,hall:session.hall,time:session.time,date:session.date,row:seat.row,seat:seat.seat,price},items,total:price+items.reduce((n,p)=>n+p.price*p.qty,0),sessionId:session.id,seatId:seat.id};
}
function createApp(options={}){
  const env=options.env||process.env,mode=env.PAYMENT_MODE||'demo';
  if(!['demo','yookassa_test'].includes(mode))throw Error('Доступны только demo и yookassa_test. Реальные продажи ещё не подключены.');
  const shopId=env.YOOKASSA_SHOP_ID,secret=env.YOOKASSA_SECRET_KEY;
  if(mode==='yookassa_test'&&(!shopId||!secret?.startsWith('test_')))throw Error('Нужны shopId и тестовый ключ ЮKassa (test_).');
  const baseUrl=env.PUBLIC_BASE_URL||'http://127.0.0.1:4173';
  if(!/^https?:\/\//.test(baseUrl))throw Error('PUBLIC_BASE_URL должен быть полным адресом сайта');
  const dbPath=options.dbPath||env.DB_PATH||path.join(ROOT,'.data','orders.sqlite');if(dbPath!==':memory:')fs.mkdirSync(path.dirname(dbPath),{recursive:true});
  const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, digest TEXT, data TEXT)');
  db.exec('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)');
  const credentials=req=>{const token=/\barena_session=([a-f0-9]{64})\b/.exec(req.headers.cookie||'')?.[1];if(!token)return null;return db.prepare('SELECT users.id,users.email FROM sessions JOIN users ON users.id=sessions.user_id WHERE token_hash=? AND expires_at>?').get(crypto.createHash('sha256').update(token).digest('hex'),Date.now())||null;};
  const cookie=(token,maxAge)=>`arena_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${new URL(baseUrl).protocol==='https:'?'; Secure':''}`;
  let schedule=options.schedule||snapshot();const providerFetch=options.providerFetch||fetch;
  const get=id=>{const row=db.prepare('SELECT data FROM orders WHERE id=?').get(id);if(!row)throw fail(404,'Заказ не найден');return JSON.parse(row.data);};
  const save=o=>db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify(o),o.id);
  const publicOrder=o=>({id:o.id,mode:o.mode,status:o.status,ticket:o.ticket,items:o.items,total:o.total,confirmationUrl:o.status==='pending'?o.confirmationUrl:undefined});
  async function provider(endpoint,body,key){
    let r;try{r=await providerFetch('https://api.yookassa.ru/v3/payments'+endpoint,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(shopId+':'+secret).toString('base64'),'Content-Type':'application/json',...(key?{'Idempotence-Key':key}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});}catch{throw fail(502,'ЮKassa не отвечает. Попробуйте проверить заказ ещё раз.');}
    if(!r.ok)throw fail(502,'ЮKassa не приняла запрос. Проверьте настройки тестового магазина.');return r.json();
  }
  function acceptPayment(o,p){
    if(p.test!==true||p.amount?.currency!=='RUB'||p.amount?.value!==(o.total/100).toFixed(2)||p.metadata?.order_id!==o.id||!p.id||(o.paymentId&&o.paymentId!==p.id))throw fail(502,'Ответ платёжного сервиса не совпадает с заказом.');
    if(!['pending','waiting_for_capture','succeeded','canceled'].includes(p.status))throw fail(502,'Неизвестный статус платежа');
    if(p.status==='succeeded'&&p.paid!==true)throw fail(502,'Оплата не подтверждена');
    o.paymentId=p.id;o.status=p.status;
    if(p.confirmation?.confirmation_url){const u=new URL(p.confirmation.confirmation_url);if(u.protocol!=='https:'||!['yoomoney.ru','yookassa.ru'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d)))throw fail(502,'Неверный адрес страницы оплаты');o.confirmationUrl=u.href;}
    save(o);return o;
  }
  async function verify(o){if(o.mode==='yookassa_test'&&o.paymentId&&!['succeeded','canceled'].includes(o.status))return acceptPayment(o,await provider('/'+encodeURIComponent(o.paymentId)));return o;}
  async function readBody(req){let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>16384)throw fail(413,'Слишком большой запрос');chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{throw fail(400,'Неверный формат запроса');}}
  const staticNames=new Set(['index.html','styles.css','walk.css','arena.css','commerce.css','account.css','app.js','hall-model.js','hall-scene.js','lobby.js','stadium-audio.js','catalog.js','schedule-data.js','schedule.js','walk.js','commerce.js','account.js']);
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};
  const server=http.createServer(async(req,res)=>{
    const send=(status,value,extra={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...extra});res.end(JSON.stringify(value));};
    try{
      const url=new URL(req.url,'http://localhost'),route=url.pathname;
      if(req.method==='GET'&&route==='/api/config')return send(200,{mode,catalog});
      if(req.method==='POST'&&route!=='/api/yookassa/webhook'&&req.headers.origin){const local='http://'+req.headers.host;if(req.headers.origin!==local&&req.headers.origin!==new URL(baseUrl).origin)throw fail(403,'Недопустимый источник запроса');}
      if(req.method==='GET'&&route==='/api/me')return send(200,{user:credentials(req)});
      if(req.method==='POST'&&(route==='/api/register'||route==='/api/login')){
        const body=await readBody(req),email=String(body.email||'').trim().toLowerCase(),password=body.password;
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||typeof password!=='string'||password.length<10||password.length>128)throw fail(400,'Введите почту и пароль от 10 символов');
        let user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
        if(route==='/api/register'){
          if(user)throw fail(409,'Эта почта уже зарегистрирована');
          const salt=crypto.randomBytes(24).toString('hex'),passwordHash=crypto.scryptSync(password,salt,64).toString('hex');
          user={id:crypto.randomUUID(),email,salt,password_hash:passwordHash};db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(user.id,user.email,user.salt,user.password_hash);
        }else{
          const attempt=crypto.scryptSync(password,user?.salt||'invalid-salt',64),stored=Buffer.from(user?.password_hash||'00'.repeat(64),'hex');
          if(!user||!crypto.timingSafeEqual(attempt,stored))throw fail(401,'Неверная почта или пароль');
        }
        const token=crypto.randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(crypto.createHash('sha256').update(token).digest('hex'),user.id,Date.now()+30*86400000);
        return send(200,{user:{id:user.id,email:user.email}},{'Set-Cookie':cookie(token,30*86400)});
      }
      if(req.method==='POST'&&route==='/api/logout'){
        const token=/\barena_session=([a-f0-9]{64})\b/.exec(req.headers.cookie||'')?.[1];if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(token).digest('hex'));
        return send(200,{user:null},{'Set-Cookie':cookie('',0)});
      }
      if(req.method==='POST'&&route==='/api/orders'){
        const body=await readBody(req);if(typeof body.requestKey!=='string'||!/^[\da-f-]{36}$/.test(body.requestKey))throw fail(400,'Нужен ключ заказа');
        const fingerprint=crypto.createHash('sha256').update(JSON.stringify({sessionId:body.sessionId,seatId:body.seatId,items:body.items})).digest('hex');
        const existing=db.prepare('SELECT digest,data FROM orders WHERE request_key=?').get(body.requestKey);
        if(existing){if(existing.digest!==fingerprint)throw fail(409,'Состав заказа изменился. Создайте новый заказ.');return send(200,publicOrder(JSON.parse(existing.data)));}
        if(!schedule.films.some(f=>f.sessions.some(s=>s.id===body.sessionId)))throw fail(404,'Матч не найден. Обновите расписание.');
        const q=quote(body,schedule),o={...q,id:crypto.randomUUID(),mode,status:'created',createdAt:Date.now()};
        // Recheck after an asynchronous schedule refresh to keep request retries atomic.
        const raced=db.prepare('SELECT digest,data FROM orders WHERE request_key=?').get(body.requestKey);if(raced){if(raced.digest!==fingerprint)throw fail(409,'Состав заказа изменился');return send(200,publicOrder(JSON.parse(raced.data)));}
        db.prepare('INSERT INTO orders VALUES (?,?,?,?)').run(o.id,body.requestKey,fingerprint,JSON.stringify(o));return send(201,publicOrder(o));
      }
      const match=route.match(/^\/api\/orders\/([\da-f-]{36})(?:\/(payment|demo))?$/);
      if(match){let o=get(match[1]);
        if(req.method==='GET'&&!match[2])return send(200,publicOrder(await verify(o)));
        if(req.method==='POST'&&match[2]==='payment'){
          if(o.mode!==mode)throw fail(409,'Режим оплаты изменился. Создайте новый заказ.');
          if(o.mode==='demo')return send(200,publicOrder(o));
          if(o.paymentId)return send(200,publicOrder(await verify(o)));
          if(Date.now()-o.createdAt>23*3600000)throw fail(409,'Заказ устарел. Выберите матч заново.');
          const p=await provider('',{amount:{value:(o.total/100).toFixed(2),currency:'RUB'},capture:true,confirmation:{type:'redirect',return_url:new URL('/?order='+o.id,baseUrl).href},description:'Арена 3D · тестовый заказ '+o.id,metadata:{order_id:o.id}},o.id);
          return send(200,publicOrder(acceptPayment(o,p)));
        }
        if(req.method==='POST'&&match[2]==='demo'){
          if(o.mode!=='demo'||mode!=='demo')throw fail(403,'Демонстрационный ответ здесь недоступен');
          const body=await readBody(req);if(!['complete','cancel'].includes(body.action))throw fail(400,'Неизвестное действие');
          if(o.status==='created'){o.status=body.action==='complete'?'demo_completed':'canceled';save(o);}return send(200,publicOrder(o));
        }
        throw fail(405,'Метод не поддерживается');
      }
      if(req.method==='POST'&&route==='/api/yookassa/webhook'){
        if(mode!=='yookassa_test')return send(200,{received:true});
        const event=await readBody(req),paymentId=event.object?.id;if(typeof paymentId!=='string')throw fail(400,'Неверное уведомление');
        const record=db.prepare("SELECT data FROM orders WHERE json_extract(data,'$.paymentId')=?").get(paymentId);
        if(record)await verify(JSON.parse(record.data)); // Never trust payment status or totals in a webhook body.
        return send(200,{received:true});
      }
      if(!['GET','HEAD'].includes(req.method))throw fail(405,'Метод не поддерживается');
      const name=decodeURIComponent(route==='/'?'index.html':route.slice(1));
      if(!(staticNames.has(name)||/^(assets|vendor)\/[a-zA-Z0-9_.-]+$/.test(name))||name.includes('..'))throw fail(404,'Не найдено');
      const file=path.join(ROOT,name);let content;try{content=fs.readFileSync(file);}catch{throw fail(404,'Не найдено');}
      res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(req.method==='HEAD'?undefined:content);
    }catch(e){send(e.statusCode||500,{error:e.statusCode?e.message:'Не удалось обработать заказ. Попробуйте ещё раз.'});}
  });
  server.on('close',()=>db.close());return server;
}
if(require.main===module){const port=Number(process.env.PORT)||4173;createApp().listen(port,process.env.HOST||'127.0.0.1',()=>console.log('Арена 3D: http://127.0.0.1:'+port+' · '+(process.env.PAYMENT_MODE||'demo')));}
module.exports={createApp,quote};
