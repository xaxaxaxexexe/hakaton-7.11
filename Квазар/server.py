#!/usr/bin/env python3
"""Сервер МатчВид: статика + JSON API поверх SQLite (только стандартная библиотека). Запуск: python3 server.py"""
import sqlite3,json,os,random,hashlib,secrets,time,math,re,http.server,urllib.parse,http.cookies
ROOT=os.path.dirname(os.path.abspath(__file__));DB=os.path.join(ROOT,"matchvid.db");HOUR=3600000
PAYS=["mir","sbp","sber","ymoney","tpay"];MAX=10
def db():
    c=sqlite3.connect(DB,timeout=10,isolation_level=None);c.row_factory=sqlite3.Row;return c
SCHEMA="""
create table cinemas(id text primary key,name text,addr text,rows text);
create table tiers(cinema_id text,from_row int,to_row int,price int);
create table films(id text primary key,title text,marvel int default 0);
create table sessions(id integer primary key autoincrement,cinema_id text,film_id text,in_hours real,disc int,running int);
create table users(email text primary key,name text,salt text,hash text,notify int default 1,def3d int default 0,defpay text default '');
create table pay_methods(id integer primary key autoincrement,user text,system text,last4 text,exp text);
create table tickets(id text primary key,session_id int,user text,total int,pay text,start_ts int,status text,created int);
create table ticket_seats(session_id int,seat text,ticket_id text,unique(session_id,seat));
create table tokens(token text primary key,user text);"""
FILMS=["Горцы — Северный Ветер","Звезда Каспия — Беркут","Динамо-Сунжа — Метеор","Горцы — Нефтяник","Аргун — Сокол","Вайнах — Звезда Каспия","Беркут — Горцы","Метеор — Аргун","Нефтяник — Вайнах","Сокол — Динамо-Сунжа","Северный Ветер — Звезда Каспия","Горцы U-19 — Беркут U-19"]
CINEMAS=[("argun","Аргун Арена",[12]*9+[5],[(0,2,600),(3,8,1000),(9,9,3000)]),("grozny","Грозный Арена",[14]*9+[6],[(0,2,700),(3,8,1200),(9,9,3500)]),("gudermes","Гудермес Арена",[10,10]+[12]*5+[5],[(0,1,500),(2,6,900),(7,7,2500)])]
def seed(c):
    c.executescript(SCHEMA);c.execute("insert into films values('spider','Кубок республики: матч дня',1)")
    for i,t in enumerate(FILMS):c.execute("insert into films values(?,?,0)",("f%d"%i,t))
    for cid,name,rows,tiers in CINEMAS:
        c.execute("insert into cinemas values(?,?,?,?)",(cid,name,"Стадион МатчВид · "+name,json.dumps(rows)))
        for t in tiers:c.execute("insert into tiers values(?,?,?,?)",(cid,*t))
        chosen=random.sample(range(len(FILMS)),random.randint(4,6));run=chosen[0]
        slots=random.sample(range(2,70,3),len(chosen))
        plan=[("spider",5,0,0)]+[("f%d"%f,-.7 if f==run else slots[k],random.choice([0,0,15,25,30]),int(f==run)) for k,f in enumerate(chosen)]
        for fid,h,d,r in plan:
            sid=c.execute("insert into sessions(cinema_id,film_id,in_hours,disc,running) values(?,?,?,?,?)",(cid,fid,h,d,r)).lastrowid
            for r_,n in enumerate(rows):
                for i in range(n):
                    if random.random()<.28:c.execute("insert into ticket_seats values(?,?,'seed')",(sid,"%d-%d"%(r_,i)))
class E(Exception):
    def __init__(s,code,msg,**x):s.code,s.msg,s.x=code,msg,x
def hp(pw,salt):return hashlib.pbkdf2_hmac("sha256",pw.encode(),bytes.fromhex(salt),100000).hex()
def uj(c,e):
    u=c.execute("select * from users where email=?",(e,)).fetchone()
    if not u:return None
    return {"email":e,"name":u["name"],"set":{"notify":bool(u["notify"]),"def3d":bool(u["def3d"]),"defpay":u["defpay"]},
            "pays":[dict(r) for r in c.execute("select id,system,last4,exp from pay_methods where user=?",(e,))]}
def cookie(c,e):
    t=secrets.token_hex(16);c.execute("insert into tokens values(?,?)",(t,e));return "sid=%s; Path=/; HttpOnly; SameSite=Lax"%t
def price(c,sid,row):
    s=c.execute("select * from sessions where id=?",(sid,)).fetchone()
    if not s:raise E(404,"Матч не найден")
    p=c.execute("select price from tiers where cinema_id=? and ?>=from_row and ?<=to_row",(s["cinema_id"],row,row)).fetchone()["price"]
    return int(p*(100-s["disc"])/100+.5)
def handle(c,m,p,q,b,me):
    now=time.time()*1000;base=math.ceil(now/HOUR)*HOUR;need=lambda:me or (_ for _ in ()).throw(E(401,"Войдите в аккаунт"))
    if p=="bootstrap":
        return {"cinemas":[{"id":r["id"],"name":r["name"],"addr":r["addr"],"rows":json.loads(r["rows"]),"tiers":[list(t) for t in c.execute("select from_row,to_row,price from tiers where cinema_id=? order by from_row",(r["id"],))]} for r in c.execute("select * from cinemas")],
          "films":[dict(r) for r in c.execute("select * from films")],
          "sessions":[{"id":r["id"],"cin":r["cinema_id"],"film":r["film_id"],"start":int(base+r["in_hours"]*HOUR),"off":r["disc"],"running":r["running"]} for r in c.execute("select * from sessions")]}
    if p=="taken":return [r["seat"] for r in c.execute("select seat from ticket_seats where session_id=?",(q["s"][0],))]
    if p=="me":return {"user":uj(c,me) if me else None}
    if p in("register","login"):
        e=str(b.get("email","")).strip().lower()
        if p=="register":
            if not re.match(r"^\S+@\S+\.\S+$",e) or len(b.get("pass",""))<6 or len(str(b.get("name","")).strip())<2:raise E(400,"Проверьте имя, email и пароль (от 6 символов)")
            if c.execute("select 1 from users where email=?",(e,)).fetchone():raise E(409,"Этот email уже зарегистрирован")
            salt=secrets.token_hex(8);sysm=random.choice(PAYS)
            c.execute("insert into users(email,name,salt,hash,defpay) values(?,?,?,?,?)",(e,b["name"].strip(),salt,hp(b["pass"],salt),sysm))
            c.execute("insert into pay_methods(user,system,last4,exp) values(?,?,?,?)",(e,sysm,"%04d"%random.randint(0,9999),"%02d/%d"%(random.randint(1,12),random.randint(27,31))))
        else:
            u=c.execute("select * from users where email=?",(e,)).fetchone()
            if not u or u["hash"]!=hp(b.get("pass",""),u["salt"]):raise E(401,"Неверный email или пароль")
        return {"user":uj(c,e),"_cookie":cookie(c,e)}
    if p=="logout":c.execute("delete from tokens where user=?",(me,));return {"ok":1}
    need()
    if p=="profile":c.execute("update users set name=? where email=?",(str(b.get("name","")).strip()[:60] or "Гость",me))
    elif p=="settings":c.execute("update users set notify=?,def3d=?,defpay=? where email=?",(int(bool(b.get("notify"))),int(bool(b.get("def3d"))),b.get("defpay") if b.get("defpay") in PAYS+[""] else "",me))
    elif p=="pay/add":
        d=re.sub(r"\D","",str(b.get("num","")))
        if b.get("system") not in PAYS or len(d)<4:raise E(400,"Укажите способ и номер (минимум 4 цифры)")
        c.execute("insert into pay_methods(user,system,last4,exp) values(?,?,?,'')",(me,b["system"],d[-4:]))
    elif p=="pay/delete":c.execute("delete from pay_methods where id=? and user=?",(b.get("id"),me))
    elif p=="tickets":
        return [{"id":t["id"],"ses":t["session_id"],"total":t["total"],"pay":t["pay"],"ts":t["start_ts"],"status":t["status"],"seats":[r["seat"] for r in c.execute("select seat from ticket_seats where ticket_id=?",(t["id"],))],
                 "seats_text":t["id"]} for t in c.execute("select * from tickets where user=? order by created desc",(me,))]
    elif p=="buy":
        seats=b.get("seats",[]);sid=b.get("session")
        if not(isinstance(seats,list) and 1<=len(seats)<=MAX and len(set(seats))==len(seats)):raise E(400,"Можно выбрать от 1 до %d мест"%MAX)
        if b.get("pay") not in PAYS:raise E(400,"Выберите способ оплаты")
        s=c.execute("select s.*,ci.rows from sessions s join cinemas ci on ci.id=s.cinema_id where s.id=?",(sid,)).fetchone()
        if not s:raise E(404,"Матч не найден")
        rows=json.loads(s["rows"]);tot=0
        for x in seats:
            if not re.match(r"^\d+-\d+$",str(x)):raise E(400,"Неверное место")
            r,i=map(int,x.split("-"))
            if r>=len(rows) or i>=rows[r]:raise E(400,"Такого места нет")
            tot+=price(c,sid,r)
        tid="T"+secrets.token_hex(3).upper();start=int(base+s["in_hours"]*HOUR)
        c.execute("begin immediate")
        try:
            c.execute("insert into tickets values(?,?,?,?,?,?,?,?)",(tid,sid,me,tot,b["pay"],start,"active",int(now)))
            for x in seats:c.execute("insert into ticket_seats values(?,?,?)",(sid,x,tid))
            c.execute("commit")
        except sqlite3.IntegrityError:
            c.execute("rollback");raise E(409,"Часть мест уже куплена",taken=[r["seat"] for r in c.execute("select seat from ticket_seats where session_id=?",(sid,))])
        return {"id":tid,"total":tot}
    elif p=="refund":
        t=c.execute("select * from tickets where id=? and user=?",(b.get("id"),me)).fetchone()
        if not t or t["status"]!="active":raise E(404,"Билет не найден")
        if t["start_ts"]-now<HOUR:raise E(400,"Возврат невозможен: до матча меньше часа")
        c.execute("update tickets set status='refunded' where id=?",(t["id"],));c.execute("delete from ticket_seats where ticket_id=?",(t["id"],))
    else:raise E(404,"Нет такого метода")
    return {"user":uj(c,me)}
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s,*a,**k):super().__init__(*a,directory=ROOT,**k)
    def reply(s,code,obj):
        ck=obj.pop("_cookie",None) if isinstance(obj,dict) else None;d=json.dumps(obj,ensure_ascii=False).encode()
        s.send_response(code);s.send_header("Content-Type","application/json; charset=utf-8");s.send_header("Content-Length",str(len(d)))
        if ck:s.send_header("Set-Cookie",ck)
        s.end_headers();s.wfile.write(d)
    def api(s,m,path,q,b):
        c=db()
        try:
            t=http.cookies.SimpleCookie(s.headers.get("Cookie","")).get("sid");me=None
            if t:
                r=c.execute("select user from tokens where token=?",(t.value,)).fetchone();me=r and r["user"]
            s.reply(200,handle(c,m,path,q,b,me))
        except E as e:s.reply(e.code,{"error":e.msg,**e.x})
        finally:c.close()
    def do_GET(s):
        u=urllib.parse.urlparse(s.path)
        if u.path.startswith("/api/"):return s.api("GET",u.path[5:],urllib.parse.parse_qs(u.query),{})
        if u.path.endswith((".db",".py")):return s.reply(404,{"error":"not found"})
        super().do_GET()
    def do_POST(s):
        n=int(s.headers.get("Content-Length",0));s.api("POST",urllib.parse.urlparse(s.path).path[5:],{},json.loads(s.rfile.read(n) or b"{}"))
    def log_message(s,*a):pass
if __name__=="__main__":
    if not os.path.exists(DB):
        c=db();seed(c);c.close()
    port=int(os.environ.get("PORT",8000));print("МатчВид: http://localhost:%d"%port)
    http.server.ThreadingHTTPServer(("",port),H).serve_forever()
