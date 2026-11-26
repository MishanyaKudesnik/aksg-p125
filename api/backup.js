/* Резервная копия: весь проект одним файлом. Только администратор.
   Пароли в копию не попадают — после восстановления их задают заново. */
const {send,handler,need,method}=require('../lib/http.js');
const db=require('../lib/db.js');

module.exports=handler(async(req,res)=>{
  method(req,'GET');
  const u=await need(req,{admin:true});
  await db.init();
  const q=s=>db.q(s,[db.PROJECT]);
  const [state,history,audit,devices,users,batches,reports,files]=await Promise.all([
    db.readState(),
    q(`SELECT work_id "work",progress::float8 progress,source,actor,note,
        to_char(at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') at FROM history WHERE project_id=$1 ORDER BY id`),
    db.q(`SELECT actor,role,action,detail,to_char(at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') at
          FROM audit ORDER BY id`),
    db.q(`SELECT name,note,active,created_by "createdBy",
          to_char(created_at,'YYYY-MM-DD') "createdAt" FROM devices ORDER BY id`),
    db.q(`SELECT login,name,role,active,to_char(created_at,'YYYY-MM-DD') "createdAt" FROM users ORDER BY id`),
    q(`SELECT id,author,device,works,facts,evidence,skipped,status,
        to_char(applied_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') "appliedAt" FROM batches WHERE project_id=$1 ORDER BY applied_at`),
    q(`SELECT id,work_id "work",progress::float8 progress,source,device,ref,note,status,
        decided_by "decidedBy",reason,to_char(at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') at
        FROM reports WHERE project_id=$1 ORDER BY id`),
    q(`SELECT id,work_id "work",name,mime,size,sha256,created_by "createdBy",
        to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') "createdAt"
        FROM files WHERE project_id=$1 ORDER BY created_at`),
  ]);
  const dump={
    format:'aksg-backup',version:1,
    madeAt:new Date().toISOString(),madeBy:u.login,
    note:'Пароли и содержимое файлов в копию не входят. Файлы перечислены с хешами SHA-256 для сверки.',
    rev:state.rev,
    sections:state.sections,works:state.works,evidence:state.evidence,
    history:history.rows,audit:audit.rows,devices:devices.rows,users:users.rows,
    batches:batches.rows,reports:reports.rows,files:files.rows
  };
  db.audit(u.login,u.role,'скачана резервная копия',
    {works:dump.works.length,history:dump.history.length,files:dump.files.length});
  const body=JSON.stringify(dump,null,1);
  res.statusCode=200;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('content-disposition','attachment; filename*=UTF-8\'\''+
    encodeURIComponent('АКСГ_копия_'+new Date().toISOString().slice(0,10)+'.json'));
  res.setHeader('cache-control','no-store');
  return res.end(body);
});
