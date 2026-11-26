/* Хронология: кто, когда и что менял. Доступна всем ролям, менять нельзя никому. */
const {send,handler,need,method}=require('../lib/http.js');
const db=require('../lib/db.js');

module.exports=handler(async(req,res)=>{
  method(req,'GET');
  const u=await need(req);
  const url=new URL(req.url,'http://x');
  const work=url.searchParams.get('work');
  const limit=Math.min(500,Math.max(1,parseInt(url.searchParams.get('limit')||'200',10)||200));
  const rows=work
    ?await db.q(`SELECT h.work_id "work",w.name,h.progress::float8 progress,h.source,h.actor,h.note,
         to_char(h.at,'YYYY-MM-DD HH24:MI') at FROM history h
         LEFT JOIN works w ON w.project_id=h.project_id AND w.id=h.work_id
         WHERE h.project_id=$1 AND h.work_id=$2 ORDER BY h.at DESC LIMIT $3`,[db.PROJECT,work,limit])
    :await db.q(`SELECT h.work_id "work",w.name,h.progress::float8 progress,h.source,h.actor,h.note,
         to_char(h.at,'YYYY-MM-DD HH24:MI') at FROM history h
         LEFT JOIN works w ON w.project_id=h.project_id AND w.id=h.work_id
         WHERE h.project_id=$1 ORDER BY h.at DESC LIMIT $2`,[db.PROJECT,limit]);
  const batches=await db.q(`SELECT id,author,device,works,facts,evidence,skipped,
      to_char(applied_at,'YYYY-MM-DD HH24:MI') "appliedAt",
      to_char(collected_at,'YYYY-MM-DD HH24:MI') "collectedAt"
      FROM batches WHERE project_id=$1 ORDER BY applied_at DESC LIMIT 50`,[db.PROJECT]);
  return send(res,200,{history:rows.rows,batches:batches.rows,role:u.role});
});
