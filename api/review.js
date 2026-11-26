/* Сводки от оборудования и подрядчика ждут проверки человеком.
   GET  — список того, что на проверке (всем, кто вошёл)
   POST — принять или отклонить (инспектор и администратор) */
const {send,body,handler,need,method}=require('../lib/http.js');
const db=require('../lib/db.js');

module.exports=handler(async(req,res)=>{
  method(req,'GET','POST');

  if(req.method==='GET'){
    await need(req);
    const r=await db.q(`SELECT r.id,r.work_id "work",w.name "workName",r.progress::float8 progress,
        r.source,r.device,r.ref,r.note,r.status,r.decided_by "decidedBy",r.reason,
        to_char(r.at,'YYYY-MM-DD HH24:MI') at,
        to_char(r.decided_at,'YYYY-MM-DD HH24:MI') "decidedAt"
      FROM reports r LEFT JOIN works w ON w.project_id=r.project_id AND w.id=r.work_id
      WHERE r.project_id=$1 ORDER BY r.at DESC LIMIT 300`,[db.PROJECT]);
    return send(res,200,{reports:r.rows});
  }

  const u=await need(req,{write:true});
  const b=await body(req);
  const id=+b.id||0;
  const rep=(await db.q('SELECT * FROM reports WHERE id=$1 AND project_id=$2',[id,db.PROJECT])).rows[0];
  if(!rep)throw Object.assign(new Error('Сводка не найдена'),{status:404});
  if(rep.status!=='review')throw Object.assign(new Error('По этой сводке решение уже принято'),{status:409});

  if(b.decision==='reject'){
    const reason=String(b.reason||'').slice(0,500);
    if(!reason)throw Object.assign(new Error('Укажите, почему сводка отклонена'),{status:400});
    await db.q(`UPDATE reports SET status='rejected',decided_by=$2,decided_at=now(),reason=$3 WHERE id=$1`,
      [id,u.login,reason]);
    db.audit(u.login,u.role,'сводка отклонена',{id,work:rep.work_id,reason});
    return send(res,200,{ok:true,status:'rejected'});
  }
  if(b.decision!=='accept')throw Object.assign(new Error('Нужно решение: accept или reject'),{status:400});

  const w=(await db.q('SELECT * FROM works WHERE project_id=$1 AND id=$2',[db.PROJECT,rep.work_id])).rows[0];
  if(!w)throw Object.assign(new Error('Работа удалена — принимать нечего'),{status:404});
  const progress=Math.max(0,Math.min(100,Math.round(Number(rep.progress))));
  const status=progress>=100?'done':(progress>0&&w.status==='plan'?'work':w.status);
  await db.q(`UPDATE works SET progress=$3,status=$4,source='camera',updated_at=now(),updated_by=$5
              WHERE project_id=$1 AND id=$2`,[db.PROJECT,rep.work_id,progress,status,u.login]);
  await db.q(`INSERT INTO history(project_id,work_id,progress,source,actor,note)
     VALUES($1,$2,$3,'camera',$4,$5)`,
    [db.PROJECT,rep.work_id,progress,u.login,`принято от «${rep.device}»${rep.ref?' · '+rep.ref:''}`]);
  if(rep.ref)
    await db.q(`INSERT INTO evidence(project_id,id,work_id,type,ref,date,note,created_by)
       VALUES($1,$2,$3,'Кадр с камеры наблюдения',$4,current_date,$5,$6) ON CONFLICT DO NOTHING`,
      [db.PROJECT,'Er'+rep.id,rep.work_id,String(rep.ref).slice(0,300),
       String(rep.note||'').slice(0,1000),rep.device]);
  await db.q(`UPDATE reports SET status='accepted',decided_by=$2,decided_at=now() WHERE id=$1`,[id,u.login]);
  const rev=await db.bumpRev();
  db.audit(u.login,u.role,'сводка принята',{id,work:rep.work_id,progress});
  return send(res,200,{ok:true,status:'accepted',rev,progress});
});
