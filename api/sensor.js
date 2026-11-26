/* Приём данных от оборудования: камеры, датчики, сторонние системы.
   Устройство присылает свой ключ в заголовке Authorization: Bearer <ключ> или x-device-key.
   Человеческие учётные записи сюда не ходят — у оборудования свои ключи, их выдаёт администратор.

   Пример:
   curl -X POST https://aksg-p125.vercel.app/api/sensor \
     -H "authorization: Bearer <ключ>" -H "content-type: application/json" \
     -d '{"work":"W2","progress":85,"ref":"cam-07 08.11 12:40","note":"ПК 40-95"}'

   Можно прислать сразу несколько: {"reports":[{...},{...}]} */
const crypto=require('node:crypto');
const {send,body,handler,method}=require('../lib/http.js');
const db=require('../lib/db.js');

const sha=s=>crypto.createHash('sha256').update(String(s)).digest('hex');
const fail=(m,s)=>Object.assign(new Error(m),{status:s});

async function device(req){
  const t=(req.headers.authorization||'').replace(/^Bearer\s+/i,'')||req.headers['x-device-key']||'';
  if(!t)throw fail('Нужен ключ устройства',401);
  await db.init();
  const r=await db.q('SELECT id,name,active FROM devices WHERE token=$1',[sha(t)]);
  const d=r.rows[0];
  if(!d||!d.active)throw fail('Ключ не найден или отключён',401);
  db.q('UPDATE devices SET last_seen=now() WHERE id=$1',[d.id]).catch(()=>{});
  return d;
}

/* Сводка оборудования не меняет факт сама: она ложится в очередь на проверку.
   Подтвердить её может только человек с правом записи — инспектор или администратор. */
async function apply(rep,dev){
  if(!rep||typeof rep.work!=='string'||!rep.work.trim())
    return{work:rep&&rep.work,ok:false,error:'нужно поле work'};
  const id=rep.work.trim();
  const w=(await db.q('SELECT * FROM works WHERE project_id=$1 AND id=$2',[db.PROJECT,id])).rows[0];
  if(!w)return{work:id,ok:false,error:'работа не найдена'};
  if(rep.progress===undefined)return{work:id,ok:false,error:'нужно поле progress'};
  const p=Number(rep.progress);
  if(!isFinite(p))return{work:id,ok:false,error:'progress должен быть числом'};
  const progress=Math.max(0,Math.min(100,Math.round(p)));

  /* повтор той же цифры от того же устройства очередь не засоряет */
  const dup=await db.q(`SELECT id FROM reports WHERE project_id=$1 AND work_id=$2 AND device=$3
      AND status='review' AND progress=$4`,[db.PROJECT,id,dev.name,progress]);
  if(dup.rows.length)
    return{work:id,ok:true,status:'review',report:dup.rows[0].id,repeated:true,
      note:'такая же сводка уже ждёт проверки'};

  const r=await db.q(`INSERT INTO reports(project_id,work_id,progress,source,device,ref,note,at)
     VALUES($1,$2,$3,'camera',$4,$5,$6,COALESCE($7::timestamptz,now())) RETURNING id`,
    [db.PROJECT,id,progress,dev.name,String(rep.ref||'').slice(0,300),
     String(rep.note||'').slice(0,1000),rep.at||null]);
  return{work:id,ok:true,status:'review',report:r.rows[0].id,
    progress,current:Number(w.progress),
    note:Number(w.progress)!==progress?'расхождение с учтённым фактом':'совпадает с учтённым фактом'};
}

module.exports=handler(async(req,res)=>{
  method(req,'POST');
  const dev=await device(req);
  const b=await body(req);
  const list=Array.isArray(b.reports)?b.reports:[b];
  if(!list.length)throw fail('Пустой отчёт',400);
  if(list.length>200)throw fail('За один раз принимается не больше 200 записей',413);

  const results=[];
  for(const rep of list)results.push(await apply(rep,dev));
  const done=results.filter(r=>r.ok).length;
  if(!done&&results.length===1)return send(res,results[0].error==='работа не найдена'?404:400,
    {error:results[0].error,results});
  const rev=await db.bumpRev();
  db.audit(dev.name,'устройство','сводка оборудования',{принято:done,всего:results.length});
  return send(res,200,{ok:true,rev,accepted:done,
    message:'Сводка принята и ждёт проверки инспектором — факт пока не изменён',results});
});
module.exports.sha=sha;
