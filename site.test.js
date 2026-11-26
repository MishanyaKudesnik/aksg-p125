/* Проверки боевой версии: роли, сохранение, конфликты, полевые пакеты.
   Запуск: node --test   (нужен PostgreSQL и DATABASE_URL в .env.local) */
const {test,before,after}=require('node:test');
const assert=require('node:assert');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');

const PORT=31990,BASE='http://127.0.0.1:'+PORT;
const DBNAME='aksg_test_'+Date.now().toString(36);
let srv,base;

function env(){
  const f=path.join(__dirname,'.env.local');
  const out={};
  if(fs.existsSync(f))for(const l of fs.readFileSync(f,'utf8').split('\n')){
    const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(m)out[m[1]]=m[2].replace(/^["']|["']$/g,'');
  }
  return out;
}
const run=(cmd,args)=>new Promise(ok=>{const p=spawn(cmd,args,{stdio:'ignore'});p.on('exit',c=>ok(c))});

const jar={};
function cookieOf(name){return jar[name]||''}
async function call(p,who,opts={}){
  const headers={'content-type':'application/json',...(opts.headers||{})};
  if(who&&jar[who])headers.cookie='aksg='+jar[who];
  const r=await fetch(BASE+p,{...opts,headers,redirect:'manual'});
  const sc=r.headers.get('set-cookie');
  if(sc&&who){const m=sc.match(/aksg=([^;]*)/);if(m)jar[who]=m[1]}
  let body=null;try{body=await r.json()}catch(e){}
  return{status:r.status,body};
}

before(async()=>{
  const e=env();
  base=(e.DATABASE_URL||process.env.DATABASE_URL||'').replace(/\/[^/]*$/,'/'+DBNAME);
  assert.ok(base,'нужен DATABASE_URL в .env.local');
  await run('createdb',[DBNAME]);
  srv=spawn(process.execPath,[path.join(__dirname,'dev-server.js')],
    {env:{...process.env,PORT:String(PORT),DATABASE_URL:base},stdio:'ignore'});
  for(let i=0;i<80;i++){
    const r=await call('/api/auth').catch(()=>null);
    if(r&&r.status===200)return;
    await new Promise(r=>setTimeout(r,150));
  }
  throw new Error('сервер не поднялся');
});
after(async()=>{
  if(srv)srv.kill();
  await new Promise(r=>setTimeout(r,400));
  await run('dropdb',['--force',DBNAME]);
});

test('пустая система предлагает создать первого администратора',async()=>{
  const r=await call('/api/auth');
  assert.equal(r.body.firstRun,true);
  assert.equal(r.body.user,null);
  assert.ok(r.body.roles.inspector&&r.body.roles.manager&&r.body.roles.admin,'три роли описаны');
});

test('первый зарегистрированный становится администратором, второй без кода — нет',async()=>{
  const a=await call('/api/auth','admin',{method:'POST',
    body:JSON.stringify({action:'register',login:'glavniy',name:'Админ',pass:'parol12345'})});
  assert.equal(a.status,200);
  assert.equal(a.body.user.role,'admin');
  const b=await call('/api/auth','x',{method:'POST',
    body:JSON.stringify({action:'register',login:'chuzhoy',pass:'parol12345'})});
  assert.equal(b.status,400,'без кода приглашения регистрация закрыта');
});

test('пароль короче восьми знаков и кривой логин не принимаются',async()=>{
  const a=await call('/api/auth','x',{method:'POST',
    body:JSON.stringify({action:'register',login:'korotkiy',pass:'123'})});
  assert.equal(a.status,400);
  const b=await call('/api/auth','x',{method:'POST',
    body:JSON.stringify({action:'register',login:'плохой логин',pass:'parol12345'})});
  assert.equal(b.status,400);
});

test('администратор выдаёт коды, по ним появляются инспектор и руководитель',async()=>{
  const i=await call('/api/admin','admin',{method:'POST',body:JSON.stringify({action:'invite',role:'inspector'})});
  const m=await call('/api/admin','admin',{method:'POST',body:JSON.stringify({action:'invite',role:'manager'})});
  assert.equal(i.status,200);assert.ok(i.body.code);
  const r1=await call('/api/auth','insp',{method:'POST',
    body:JSON.stringify({action:'register',login:'inspektor',name:'Инспектор Петров',pass:'parol12345',code:i.body.code})});
  assert.equal(r1.body.user.role,'inspector');
  const r2=await call('/api/auth','boss',{method:'POST',
    body:JSON.stringify({action:'register',login:'nachalnik',name:'Руководитель',pass:'parol12345',code:m.body.code})});
  assert.equal(r2.body.user.role,'manager');
  const again=await call('/api/auth','x',{method:'POST',
    body:JSON.stringify({action:'register',login:'eshchyo',pass:'parol12345',code:i.body.code})});
  assert.equal(again.status,400,'код на одно применение второй раз не работает');
});

test('инспектор правит график, руководитель только смотрит',async()=>{
  const s=await call('/api/state','insp');
  assert.equal(s.status,200);
  assert.ok(s.body.works.length,'демо-график загрузился');
  s.body.works[0].progress=55;
  const put=await call('/api/state','insp',{method:'PUT',body:JSON.stringify(s.body)});
  assert.equal(put.status,200);
  const after=await call('/api/state','boss');
  assert.equal(after.status,200,'руководитель читает');
  assert.equal(after.body.works[0].progress,55,'видит правку инспектора');
  const denied=await call('/api/state','boss',{method:'PUT',body:JSON.stringify(after.body)});
  assert.equal(denied.status,403,'записывать руководителю нельзя');
  const adminOnly=await call('/api/admin','insp');
  assert.equal(adminOnly.status,403,'инспектор не видит раздел людей');
});

test('без входа данные не отдаются',async()=>{
  assert.equal((await call('/api/state')).status,401);
  assert.equal((await call('/api/history')).status,401);
  assert.equal((await call('/api/admin')).status,401);
});

test('устаревшая версия не затирает чужую правку',async()=>{
  const s=await call('/api/state','insp');
  const copy=JSON.parse(JSON.stringify(s.body));
  copy.works[1].progress=11;
  assert.equal((await call('/api/state','insp',{method:'PUT',body:JSON.stringify(copy)})).status,200);
  const stale=JSON.parse(JSON.stringify(s.body));
  stale.works[1].progress=99;
  const r=await call('/api/state','insp',{method:'PUT',body:JSON.stringify(stale)});
  assert.equal(r.status,409);
  assert.ok(r.body.state&&r.body.state.works,'сервер вернул свежую версию для разбора');
});

test('полевой пакет применяется, повторная загрузка не дублирует',async()=>{
  const s=(await call('/api/state','insp')).body;
  const w=s.works[2];
  const batch={format:'aksg-batch',version:1,id:'B-test-1',author:'Инспектор Петров',device:'планшет',
    collectedAt:new Date().toISOString(),
    works:[{...w,progress:91,updatedAt:new Date().toISOString()}],
    evidence:[{id:'E-field-1',work:w.id,type:'Фото',ref:'cam-12 поле',date:'2026-11-20',note:''}]};
  const r=await call('/api/sync','insp',{method:'POST',body:JSON.stringify(batch)});
  assert.equal(r.status,200);
  assert.equal(r.body.report.applied.length,1);
  const after=(await call('/api/state','insp')).body;
  assert.equal(after.works.find(x=>x.id===w.id).progress,91);
  assert.ok(after.evidence.some(e=>e.id==='E-field-1'),'подтверждение из поля на месте');
  const again=await call('/api/sync','insp',{method:'POST',body:JSON.stringify(batch)});
  assert.equal(again.body.already,true,'повтор того же пакета не применяется дважды');
});

test('пакет со старой правкой не затирает более свежую на сервере',async()=>{
  const s=(await call('/api/state','insp')).body;
  const w=s.works[3];
  const old=new Date(Date.now()-3*864e5).toISOString();
  s.works[3].progress=70;
  await call('/api/state','insp',{method:'PUT',body:JSON.stringify(s)});
  const batch={format:'aksg-batch',version:1,id:'B-test-old',author:'поле',
    works:[{...w,progress:5,updatedAt:old}],evidence:[]};
  const r=await call('/api/sync','insp',{method:'POST',body:JSON.stringify(batch)});
  assert.equal(r.body.report.skipped.length,1,'старая правка пропущена');
  const after=(await call('/api/state','insp')).body;
  assert.equal(after.works.find(x=>x.id===w.id).progress,70,'на сервере осталась свежая цифра');
});

test('чужой файл вместо пакета отклоняется',async()=>{
  const r=await call('/api/sync','insp',{method:'POST',body:JSON.stringify({hello:'world'})});
  assert.equal(r.status,400);
  assert.match(r.body.error,/пакет/i);
});

test('хронология показывает, кто и когда менял факт',async()=>{
  const h=await call('/api/history','boss');
  assert.equal(h.status,200);
  assert.ok(h.body.history.length,'записи есть');
  assert.ok(h.body.history.some(r=>r.actor==='inspektor'),'видно инспектора');
  assert.ok(h.body.batches.length,'полевые пакеты перечислены');
});

test('администратор меняет роль, закрывает доступ и сбрасывает пароль',async()=>{
  assert.equal((await call('/api/admin','admin',{method:'POST',
    body:JSON.stringify({action:'role',login:'nachalnik',role:'inspector'})})).status,200);
  const u=(await call('/api/admin','admin')).body.users.find(x=>x.login==='nachalnik');
  assert.equal(u.role,'inspector');
  assert.equal((await call('/api/admin','admin',{method:'POST',
    body:JSON.stringify({action:'role',login:'glavniy',role:'inspector'})})).status,400,'себя разжаловать нельзя');
  assert.equal((await call('/api/admin','admin',{method:'POST',
    body:JSON.stringify({action:'active',login:'nachalnik',active:false})})).status,200);
  assert.equal((await call('/api/state','boss')).status,401,'отключённый пользователь теряет доступ');
  assert.equal((await call('/api/admin','admin',{method:'POST',
    body:JSON.stringify({action:'password',login:'inspektor',pass:'short'})})).status,400);
});

test('выход закрывает сессию',async()=>{
  assert.equal((await call('/api/auth','insp',{method:'POST',body:JSON.stringify({action:'logout'})})).status,200);
  assert.equal((await call('/api/state','insp')).status,401);
});

/* ---------------- вложения ---------------- */
test('инспектор заходит снова после выхода',async()=>{
  const r=await call('/api/auth','insp',{method:'POST',
    body:JSON.stringify({action:'login',login:'inspektor',pass:'parol12345'})});
  assert.equal(r.status,200);
  assert.equal(r.body.user.role,'inspector');
});

const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('инспектор прикладывает фото: файл ложится в базу и отдаётся обратно',async()=>{
  const r=await call('/api/file','insp',{method:'POST',
    body:JSON.stringify({name:'снимок.png',mime:'image/png',work:'W1',data:PNG})});
  assert.equal(r.status,200,'файл принят');
  assert.ok(r.body.id,'вернулся идентификатор');
  assert.ok(r.body.size>0);
  const get=await fetch(BASE+'/api/file?id='+encodeURIComponent(r.body.id),
    {headers:{cookie:'aksg='+jar.insp}});
  assert.equal(get.status,200);
  assert.match(get.headers.get('content-type'),/image\/png/);
  assert.equal((await get.arrayBuffer()).byteLength,r.body.size,'файл вернулся целым');
  /* привязываем к подтверждению и проверяем, что сведения о файле видны в графике */
  const s=(await call('/api/state','insp')).body;
  s.evidence.push({id:'E-file-1',work:'W1',type:'Фото',ref:'Фото ПК 0-120',date:'2026-11-20',note:'',
    fileId:r.body.id,fileName:'снимок.png',fileSize:r.body.size,fileMime:'image/png'});
  assert.equal((await call('/api/state','insp',{method:'PUT',body:JSON.stringify(s)})).status,200);
  const after=(await call('/api/state','insp')).body;
  const ev=after.evidence.find(e=>e.id==='E-file-1');
  assert.equal(ev.fileId,r.body.id);
  assert.equal(ev.fileName,'снимок.png','имя файла подтянулось из базы');
});

test('чужие и слишком большие файлы не принимаются',async()=>{
  assert.equal((await call('/api/file','insp',{method:'POST',
    body:JSON.stringify({name:'вирус.exe',mime:'application/x-msdownload',data:PNG})})).status,400);
  const big=Buffer.alloc(3.6*1024*1024,7).toString('base64');
  assert.equal((await call('/api/file','insp',{method:'POST',
    body:JSON.stringify({name:'большой.jpg',mime:'image/jpeg',data:big})})).status,413);
  assert.equal((await call('/api/file','insp',{method:'POST',
    body:JSON.stringify({name:'пусто.png',mime:'image/png',data:''})})).status,400);
});

test('тяжёлый снимок не принимается: уменьшать надо на устройстве',async()=>{
  const heavy=Buffer.alloc(1.5*1024*1024,3).toString('base64');
  const r=await call('/api/file','insp',{method:'POST',
    body:JSON.stringify({name:'снимок.jpg',mime:'image/jpeg',data:heavy})});
  assert.equal(r.status,413,'фото больше 1,2 МБ отклонено');
  assert.match(r.body.error,/Сфотографировать|уменьша/i,'сказано, что делать');
  /* а документ такого же веса — обычное дело, его принимаем */
  assert.equal((await call('/api/file','insp',{method:'POST',
    body:JSON.stringify({name:'акт.pdf',mime:'application/pdf',data:heavy})})).status,200);
});

test('занятое место видно всем, кто вошёл',async()=>{
  const r=await call('/api/file?usage=1','insp');
  assert.equal(r.status,200);
  assert.ok(r.body.quota>0,'квота задана');
  assert.ok(r.body.bytes>0,'файлы уже есть');
  assert.equal(r.body.free,r.body.quota-r.body.bytes);
  assert.ok(r.body.pct>=0&&r.body.pct<=100);
  assert.equal((await fetch(BASE+'/api/file?usage=1')).status,401,'без входа нельзя');
});

test('руководитель файлы смотрит, но не загружает',async()=>{
  await call('/api/admin','admin',{method:'POST',
    body:JSON.stringify({action:'active',login:'nachalnik',active:true})});
  await call('/api/admin','admin',{method:'POST',
    body:JSON.stringify({action:'role',login:'nachalnik',role:'manager'})});
  const m=await call('/api/auth','boss2',{method:'POST',
    body:JSON.stringify({action:'login',login:'nachalnik',pass:'parol12345'})});
  assert.equal(m.status,200);
  assert.equal((await call('/api/file','boss2',{method:'POST',
    body:JSON.stringify({name:'х.png',mime:'image/png',data:PNG})})).status,403);
  const s=(await call('/api/state','boss2')).body;
  const ev=s.evidence.find(e=>e.fileId);
  const get=await fetch(BASE+'/api/file?id='+encodeURIComponent(ev.fileId),{headers:{cookie:'aksg='+jar.boss2}});
  assert.equal(get.status,200,'смотреть можно');
  assert.equal((await fetch(BASE+'/api/file?id='+encodeURIComponent(ev.fileId))).status,401,'без входа нельзя');
});

test('полевой пакет приносит фотографии вместе с правками',async()=>{
  const s=(await call('/api/state','insp')).body;
  const w=s.works[4];
  const batch={format:'aksg-batch',version:1,id:'B-files-1',author:'Инспектор Петров',device:'планшет',
    collectedAt:new Date().toISOString(),
    files:[{id:'F-field-1',name:'поле.png',mime:'image/png',work:w.id,data:PNG}],
    works:[{...w,progress:25,updatedAt:new Date().toISOString()}],
    evidence:[{id:'E-field-2',work:w.id,type:'Фото',ref:'снято без связи',date:'2026-11-20',
      note:'',fileId:'F-field-1'}]};
  const r=await call('/api/sync','insp',{method:'POST',body:JSON.stringify(batch)});
  assert.equal(r.status,200);
  assert.equal(r.body.report.files,1,'файл из пакета сохранён');
  const after=(await call('/api/state','insp')).body;
  const ev=after.evidence.find(e=>e.id==='E-field-2');
  assert.equal(ev.fileId,'F-field-1');
  assert.equal(ev.fileName,'поле.png');
  const get=await fetch(BASE+'/api/file?id=F-field-1',{headers:{cookie:'aksg='+jar.insp}});
  assert.equal(get.status,200,'фотография из поля открывается');
});

/* ---------------- оборудование ---------------- */
let devKey=null;

test('администратор заводит устройство и получает ключ',async()=>{
  const r=await call('/api/admin','admin',{method:'POST',
    body:JSON.stringify({action:'device',name:'Камера ПК 40-95',note:'тестовая'})});
  assert.equal(r.status,200);
  assert.ok(r.body.key&&r.body.key.length>=32,'ключ выдан');
  devKey=r.body.key;
  const list=(await call('/api/admin','admin')).body.devices;
  assert.ok(list.some(d=>d.name==='Камера ПК 40-95'&&d.active),'устройство в списке');
  assert.equal((await call('/api/admin','insp',{method:'POST',
    body:JSON.stringify({action:'device',name:'своё'})})).status,403,'инспектор устройства не заводит');
});

let reviewId=null,reviewWork=null;

test('сводка камеры сама факт не меняет — она ждёт проверки',async()=>{
  const before=(await call('/api/state','insp')).body;
  const w=before.works[2];reviewWork=w.id;
  const was=w.progress;
  const r=await fetch(BASE+'/api/sensor',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+devKey},
    body:JSON.stringify({work:w.id,progress:66,ref:'cam-07 20.11 09:40',note:'ПК 40-95'})});
  const d=await r.json();
  assert.equal(r.status,200);
  assert.equal(d.accepted,1);
  assert.equal(d.results[0].status,'review','сводка ушла на проверку');
  assert.match(d.message,/ждёт проверки/);
  const after=(await call('/api/state','insp')).body;
  assert.equal(after.works.find(x=>x.id===w.id).progress,was,'факт не изменился сам');
  assert.ok(after.pending.some(p=>p.work===w.id&&p.progress===66),'сводка видна в очереди');
  const rev=(await call('/api/review','insp')).body.reports.find(x=>x.work===w.id&&x.status==='review');
  assert.ok(rev,'сводка в списке на проверку');
  assert.equal(rev.device,'Камера ПК 40-95');
  reviewId=rev.id;
});

test('повторная такая же сводка очередь не засоряет',async()=>{
  const r=await fetch(BASE+'/api/sensor',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+devKey},
    body:JSON.stringify({work:reviewWork,progress:66,ref:'cam-07 ещё раз'})});
  const d=await r.json();
  assert.ok(d.results[0].repeated,'помечена как повтор');
  const pend=(await call('/api/state','insp')).body.pending.filter(p=>p.work===reviewWork);
  assert.equal(pend.length,1,'в очереди по-прежнему одна сводка');
});

test('руководитель решение по сводке принимать не может',async()=>{
  const r=await call('/api/review','boss2',{method:'POST',
    body:JSON.stringify({id:reviewId,decision:'accept'})});
  assert.equal(r.status,403);
});

test('инспектор принимает сводку: факт, хронология и подтверждение появляются',async()=>{
  const r=await call('/api/review','insp',{method:'POST',
    body:JSON.stringify({id:reviewId,decision:'accept'})});
  assert.equal(r.status,200);
  const after=(await call('/api/state','insp')).body;
  const w=after.works.find(x=>x.id===reviewWork);
  assert.equal(w.progress,66,'факт принят');
  assert.equal(w.source,'camera');
  assert.ok(!after.pending.some(p=>p.id===reviewId),'из очереди ушла');
  assert.ok(after.evidence.some(e=>e.ref==='cam-07 20.11 09:40'),'подтверждение создано');
  const h=(await call('/api/history','insp')).body.history;
  assert.ok(h.some(x=>x.work===reviewWork&&/принято от/.test(x.note||'')),'в хронологии видно, кто принял и от кого');
  assert.equal((await call('/api/review','insp',{method:'POST',
    body:JSON.stringify({id:reviewId,decision:'accept'})})).status,409,'дважды принять нельзя');
});

test('отклонение сводки требует причины и факт не трогает',async()=>{
  const s=(await call('/api/state','insp')).body;
  const w=s.works[7];const was=w.progress;
  await fetch(BASE+'/api/sensor',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+devKey},
    body:JSON.stringify({work:w.id,progress:99,ref:'cam-09 подозрительно'})});
  const id=(await call('/api/state','insp')).body.pending.find(p=>p.work===w.id).id;
  assert.equal((await call('/api/review','insp',{method:'POST',
    body:JSON.stringify({id,decision:'reject'})})).status,400,'без причины нельзя');
  const r=await call('/api/review','insp',{method:'POST',
    body:JSON.stringify({id,decision:'reject',reason:'камера смотрит на соседний участок'})});
  assert.equal(r.status,200);
  const after=(await call('/api/state','insp')).body;
  assert.equal(after.works.find(x=>x.id===w.id).progress,was,'факт не изменился');
  assert.ok(!after.pending.some(p=>p.id===id));
  const rec=(await call('/api/review','insp')).body.reports.find(x=>x.id===id);
  assert.equal(rec.status,'rejected');
  assert.match(rec.reason,/соседний участок/);
});

test('оборудование шлёт пачку записей и получает разбор по каждой',async()=>{
  const s=(await call('/api/state','insp')).body;
  const r=await fetch(BASE+'/api/sensor',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+devKey},
    body:JSON.stringify({reports:[
      {work:s.works[5].id,progress:71},
      {work:'НЕТ-ТАКОЙ',progress:50},
      {work:s.works[6].id,progress:'ерунда'}]})});
  const d=await r.json();
  assert.equal(r.status,200);
  assert.equal(d.accepted,1,'принята только верная запись');
  assert.equal(d.results[1].error,'работа не найдена');
  assert.match(d.results[2].error,/числом/);
});

test('чужой ключ, отключённое устройство и человеческий вход к датчикам не пускаются',async()=>{
  assert.equal((await fetch(BASE+'/api/sensor',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer 0000'},
    body:JSON.stringify({work:'W1',progress:5})})).status,401);
  assert.equal((await fetch(BASE+'/api/sensor',{method:'POST',
    headers:{'content-type':'application/json',cookie:'aksg='+jar.admin},
    body:JSON.stringify({work:'W1',progress:5})})).status,401,'сессия человека — не ключ устройства');
  const dev=(await call('/api/admin','admin')).body.devices.find(d=>d.name==='Камера ПК 40-95');
  await call('/api/admin','admin',{method:'POST',
    body:JSON.stringify({action:'device-active',id:dev.id,active:false})});
  assert.equal((await fetch(BASE+'/api/sensor',{method:'POST',
    headers:{'content-type':'application/json',authorization:'Bearer '+devKey},
    body:JSON.stringify({work:'W1',progress:5})})).status,401,'отключённое устройство молчит');
});


/* ---------------- меры защиты, обещанные эксперту ИБ ---------------- */
const {Client}=require('pg');

test('у вложения считается SHA-256 и он отдаётся при выдаче',async()=>{
  const r=await call('/api/file','insp',{method:'POST',
    body:JSON.stringify({name:'акт.png',mime:'image/png',work:'W1',data:PNG})});
  assert.equal(r.status,200);
  assert.match(r.body.sha256,/^[0-9a-f]{64}$/,'хеш посчитан');
  const crypto=require('node:crypto');
  const want=crypto.createHash('sha256').update(Buffer.from(PNG,'base64')).digest('hex');
  assert.equal(r.body.sha256,want,'хеш совпадает с содержимым');
  const get=await fetch(BASE+'/api/file?id='+encodeURIComponent(r.body.id),
    {headers:{cookie:'aksg='+jar.insp}});
  assert.equal(get.headers.get('x-content-sha256'),want,'хеш отдаётся в заголовке');
  const s=(await call('/api/state','insp')).body;
  s.evidence.push({id:'E-sha-1',work:'W1',type:'Акт',ref:'акт с хешем',date:'2026-11-20',note:'',
    fileId:r.body.id,fileName:'акт.png',fileSize:r.body.size,fileMime:'image/png'});
  await call('/api/state','insp',{method:'PUT',body:JSON.stringify(s)});
  const ev=(await call('/api/state','insp')).body.evidence.find(e=>e.id==='E-sha-1');
  assert.equal(ev.fileSha,want,'хеш виден в подтверждении');
});

test('подменённый в базе файл не выдаётся',async()=>{
  const up=await call('/api/file','insp',{method:'POST',
    body:JSON.stringify({name:'подмена.png',mime:'image/png',data:PNG})});
  const c=new Client({connectionString:base});await c.connect();
  await c.query('UPDATE files SET data=$2 WHERE id=$1',[up.body.id,Buffer.from('подменили','utf8')]);
  await c.end();
  const get=await fetch(BASE+'/api/file?id='+encodeURIComponent(up.body.id),
    {headers:{cookie:'aksg='+jar.insp}});
  assert.equal(get.status,409,'выдача остановлена');
  const a=(await call('/api/admin','admin')).body.audit;
  assert.ok(a.some(x=>x.action==='подмена файла обнаружена'),'записано в журнал');
});

test('подбор пароля упирается в ограничение',async()=>{
  const login='inspektor';
  let blocked=0,last=null;
  for(let i=0;i<8;i++){
    last=await call('/api/auth','brute',{method:'POST',
      body:JSON.stringify({action:'login',login,pass:'неверный'+i})});
    if(last.status===429)blocked++;
  }
  assert.ok(blocked>0,'после нескольких попыток вход блокируется');
  assert.match(last.body.error,/много попыток/);
  const a=(await call('/api/admin','admin')).body.audit;
  assert.ok(a.some(x=>x.action.includes('вход заблокирован')),'блокировка попала в журнал');
});

test('журнал изменений и журнал действий нельзя переписать даже из базы',async()=>{
  const c=new Client({connectionString:base});await c.connect();
  await assert.rejects(()=>c.query('UPDATE history SET progress=0 WHERE id=(SELECT min(id) FROM history)'),
    /только на дозапись/);
  await c.query('ROLLBACK').catch(()=>{});
  await assert.rejects(()=>c.query('DELETE FROM audit WHERE id=(SELECT min(id) FROM audit)'),
    /только на дозапись/);
  await c.end();
});

test('плановые сроки не двигаются без основания',async()=>{
  const s=(await call('/api/state','insp')).body;
  const w=s.works.find(x=>x.planEnd);
  const wasEnd=w.planEnd;
  w.planEnd='2027-12-31';
  const no=await call('/api/state','insp',{method:'PUT',body:JSON.stringify(s)});
  assert.equal(no.status,400,'без основания отказ');
  assert.match(no.body.error,/основани/i);
  const fresh=(await call('/api/state','insp')).body;
  assert.equal(fresh.works.find(x=>x.id===w.id).planEnd,wasEnd,'в базе срок прежний');
  const w2=fresh.works.find(x=>x.id===w.id);
  w2.planEnd='2027-12-31';w2.planReason='Справка ГИПа №12 от 18.11.2026';
  const ok=await call('/api/state','insp',{method:'PUT',body:JSON.stringify(fresh)});
  assert.equal(ok.status,200,'с основанием проходит');
  const h=(await call('/api/history','insp')).body.history;
  assert.ok(h.some(x=>x.work===w.id&&/Основание: Справка ГИПа/.test(x.note||'')),
    'основание записано в хронологию');
});

test('резервная копия: только администратору и без паролей',async()=>{
  assert.equal((await call('/api/backup','insp')).status,403);
  const r=await fetch(BASE+'/api/backup',{headers:{cookie:'aksg='+jar.admin}});
  assert.equal(r.status,200);
  assert.match(r.headers.get('content-disposition'),/attachment/);
  const d=await r.json();
  assert.equal(d.format,'aksg-backup');
  for(const k of ['works','sections','evidence','history','audit','devices','users','files','reports'])
    assert.ok(Array.isArray(d[k]),'в копии есть '+k);
  assert.ok(d.users.length&&!JSON.stringify(d.users).includes('s1$'),'хеши паролей в копию не попали');
  assert.ok(d.files.every(f=>/^[0-9a-f]{64}$/.test(f.sha256)),'у файлов в копии есть хеши');
});

/* ---------------- уведомления ---------------- */
test('система сама видит, что требует внимания',async()=>{
  const r=await call('/api/notify','insp');
  assert.equal(r.status,200);
  assert.ok(Array.isArray(r.body.alerts));
  const kinds=new Set(r.body.alerts.map(a=>a.kind));
  assert.ok([...kinds].every(k=>['overdue','deviation','noproof','review'].includes(k)),'поводы известного вида');
  assert.ok(r.body.alerts.every(a=>a.work&&a.text),'у каждого сигнала есть работа и текст');
  assert.ok(!r.body.settings,'инспектор настроек не видит');
});

test('сводка для показа собирается текстом',()=>{
  const N=require('./lib/notify.js');
  const text=N.digestText([{kind:'overdue',work:'W2',text:'Балласт: срок прошёл'},
    {kind:'noproof',work:'W6',text:'Земполотно: факт без документа'}],'21.11.2026');
  assert.match(text,/Просрочено/);
  assert.match(text,/Без подтверждения/);
  assert.match(text,/Балласт/);
  assert.equal(N.digestText([],'21.11.2026').includes('отклонений нет'),true);
});

test('наружу уведомления не уходят: отправки в сторонние сервисы в коде нет',()=>{
  const fs=require('node:fs');
  const code=fs.readFileSync('./lib/notify.js','utf8')+fs.readFileSync('./api/notify.js','utf8');
  assert.ok(!/telegram|api\.telegram|sendMessage|smtp|resend/i.test(code),
    'уведомления живут в приложении, во внешние сервисы ничего не отправляется');
  assert.ok(!fs.existsSync('./api/cron.js'),'планировщик убран');
});

/* ---------- архив вложений: место освобождается, доказательная база остаётся ---------- */
test('архив вместо удаления: файл уезжает, сведения и хеш остаются, возврат сходится',async()=>{
  /* кладём свежий файл */
  const up=await call('/api/file','insp',{method:'POST',
    body:JSON.stringify({name:'архивный.png',mime:'image/png',work:'W1',data:PNG})});
  assert.equal(up.status,200);
  const id=up.body.id;
  /* привязываем к подтверждению — именно оно не должно пострадать */
  const s=(await call('/api/state','insp')).body;
  s.evidence.push({id:'E-arch-1',work:'W1',type:'Фото',ref:'Снимок для архива',date:'2026-11-21',note:'',
    fileId:id,fileName:'архивный.png',fileSize:up.body.size,fileMime:'image/png'});
  assert.equal((await call('/api/state','insp',{method:'PUT',body:JSON.stringify(s)})).status,200);

  /* план видит только администратор */
  assert.equal((await call('/api/archive','insp')).status,403,'инспектору архив недоступен');
  const plan=(await call('/api/archive','admin')).body;
  assert.ok(plan.plan.files>0,'есть что выгружать');
  assert.ok(plan.plan.parts.length>0,'части посчитаны');

  const was=(await call('/api/file?usage=1','admin')).body.bytes;

  /* выгрузка не трогает базу */
  const pack=(await call('/api/archive','admin',{method:'POST',
    body:JSON.stringify({action:'export',ids:[id]})})).body;
  assert.equal(pack.format,'aksg-files-archive');
  assert.equal(pack.files.length,1);
  assert.ok(pack.files[0].data.length>0,'содержимое в архиве есть');
  assert.equal((await call('/api/file?usage=1','admin')).body.bytes,was,'после выгрузки место ещё занято');

  /* чужой хеш место не освобождает */
  assert.equal((await call('/api/archive','admin',{method:'POST',
    body:JSON.stringify({action:'release',ref:'АКСГ_архив_тест',files:{[id]:'не тот хеш'}})})).status,409);

  /* освобождение по совпавшему хешу */
  const rel=(await call('/api/archive','admin',{method:'POST',
    body:JSON.stringify({action:'release',ref:'АКСГ_архив_тест',
      files:{[id]:pack.files[0].sha256}})})).body;
  assert.equal(rel.archived,1);
  assert.ok(rel.freed>0,'место освободилось');
  assert.ok((await call('/api/file?usage=1','admin')).body.bytes<was,'в базе стало меньше');

  /* подтверждение на месте, файл помечен как архивный */
  const after=(await call('/api/state','insp')).body;
  const ev=after.evidence.find(e=>e.id==='E-arch-1');
  assert.ok(ev,'подтверждение не исчезло');
  assert.equal(ev.fileName,'архивный.png','имя сохранилось');
  assert.equal(ev.fileSha,pack.files[0].sha256,'хеш сохранился');
  assert.ok(ev.fileArchived,'видно, что файл в архиве');

  /* выдача говорит, где файл, а не «не найден» */
  const get=await fetch(BASE+'/api/file?id='+encodeURIComponent(id),{headers:{cookie:'aksg='+jar.insp}});
  assert.equal(get.status,410);
  assert.match((await get.json()).error,/архив/i);

  /* подменённое содержимое обратно не встанет */
  const fake=Buffer.from('подмена').toString('base64');
  const badBack=(await call('/api/archive','admin',{method:'POST',
    body:JSON.stringify({action:'restore',files:[{id,name:'архивный.png',data:fake}]})})).body;
  assert.equal(badBack.restored,0);
  assert.match(badBack.skipped.join(' '),/хеш/i);

  /* возврат настоящего файла */
  const back=(await call('/api/archive','admin',{method:'POST',
    body:JSON.stringify({action:'restore',files:pack.files})})).body;
  assert.equal(back.restored,1);
  const again=await fetch(BASE+'/api/file?id='+encodeURIComponent(id),{headers:{cookie:'aksg='+jar.insp}});
  assert.equal(again.status,200,'файл снова открывается');
  assert.equal((await again.arrayBuffer()).byteLength,up.body.size,'вернулся целым');
});

/* ---------- продольный профиль ---------- */
test('профиль: загрузка ведомости, выдача и замена',async()=>{
  /* инспектор грузит ведомость */
  const up=await call('/api/profile','insp',{method:'POST',body:JSON.stringify({profile:[
    {pk:'ПК 0+00',ground:142.3,design:144.1},
    {pk:'ПК 20+00',ground:141.05,design:143.6},
    {pk:'10',ground:140,design:141}]})});
  assert.equal(up.status,200);
  assert.equal(up.body.saved,3);
  assert.equal(up.body.from,0);
  assert.equal(up.body.to,20);

  const got=(await call('/api/profile','insp')).body.profile;
  assert.equal(got.length,3);
  assert.deepEqual(got.map(r=>r.pk),[0,10,20],'точки отсортированы по пикету');
  assert.equal(got[0].design,144.1);

  /* профиль приходит вместе с графиком */
  const st=(await call('/api/state','insp')).body;
  assert.equal(st.profile.length,3,'профиль есть в состоянии');

  /* повторная загрузка заменяет профиль целиком, а не добавляет */
  const again=await call('/api/profile','insp',{method:'POST',
    body:JSON.stringify({profile:[{pk:'5',ground:1,design:2}]})});
  assert.equal(again.body.saved,1);
  assert.equal((await call('/api/profile','insp')).body.profile.length,1,'старые точки убраны');

  /* пустая ведомость не стирает профиль молча */
  assert.equal((await call('/api/profile','insp',{method:'POST',
    body:JSON.stringify({profile:[]})})).status,400);
  assert.equal((await call('/api/profile','insp')).body.profile.length,1,'профиль на месте');
});

test('профиль: руководитель смотрит, но не меняет',async()=>{
  assert.equal((await call('/api/profile','boss2')).status,200,'читать можно');
  assert.equal((await call('/api/profile','boss2',{method:'POST',
    body:JSON.stringify({profile:[{pk:'1',ground:1,design:2}]})})).status,403);
  assert.equal((await fetch(BASE+'/api/profile')).status,401,'без входа нельзя');
});
