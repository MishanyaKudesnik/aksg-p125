/* Ограничение частоты: защита от подбора пароля и от потока запросов с одного адреса.
   Счётчики лежат в базе — на Vercel каждый запрос может попасть в новый процесс. */
const db=require('./db.js');

const ip=req=>String(req.headers['x-forwarded-for']||req.socket&&req.socket.remoteAddress||'')
  .split(',')[0].trim().slice(0,45)||'неизвестно';

/* Проверить и отметить попытку. Возвращает {ok} либо {ok:false, retryAfter} */
async function hit(key,{limit=5,windowSec=900,blockSec=900}={}){
  await db.init();
  const r=await db.q(`INSERT INTO attempts(k,n,first_at) VALUES($1,1,now())
     ON CONFLICT (k) DO UPDATE SET
       n=CASE WHEN attempts.first_at < now()-($2||' seconds')::interval THEN 1 ELSE attempts.n+1 END,
       first_at=CASE WHEN attempts.first_at < now()-($2||' seconds')::interval THEN now() ELSE attempts.first_at END
     RETURNING n,until`,[key,windowSec]);
  const row=r.rows[0];
  if(row.until&&new Date(row.until).getTime()>Date.now())
    return{ok:false,retryAfter:Math.ceil((new Date(row.until).getTime()-Date.now())/1000)};
  if(row.n>limit){
    await db.q(`UPDATE attempts SET until=now()+($2||' seconds')::interval WHERE k=$1`,[key,blockSec]);
    return{ok:false,retryAfter:blockSec};
  }
  return{ok:true,left:limit-row.n};
}
/* Успешный вход обнуляет счётчик */
const reset=key=>db.q('DELETE FROM attempts WHERE k=$1',[key]).catch(()=>{});

/* Готовая проверка для входа: и по логину, и по адресу */
async function guardLogin(req,login){
  const keys=['login:'+String(login||'').toLowerCase().slice(0,60),'ip:'+ip(req)];
  for(const k of keys){
    const r=await hit(k,{limit:k.startsWith('ip:')?20:5,windowSec:900,blockSec:900});
    if(!r.ok)return{...r,key:k};
  }
  return{ok:true,keys};
}
module.exports={hit,reset,ip,guardLogin};
