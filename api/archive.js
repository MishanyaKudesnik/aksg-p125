/* Архив вложений: содержимое файлов уезжает в файл архива, сведения остаются в базе.
   Подтверждение не исчезает никогда — остаются имя, размер, автор, дата и хеш SHA-256,
   по которому файл из архива сверяется при возврате. Удаления здесь нет вообще:
   освобождение места и доказательная база — разные вещи.
   Только администратор. */
const crypto=require('node:crypto');
const {send,body,handler,need,method,fail}=require('../lib/http.js');
const db=require('../lib/db.js');

/* в один кусок кладём столько, чтобы ответ пролез через платформу (base64 тяжелее на треть) */
const CHUNK=2*1024*1024;
const mb=n=>(n/1048576).toFixed(n<10485760?2:1)+' МБ';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');

/* что можно выгрузить: файлы старше указанной даты, которые ещё лежат в базе */
async function plan(before){
  const r=await db.q(`SELECT id,name,size,to_char(created_at,'YYYY-MM-DD') "day"
     FROM files WHERE project_id=$1 AND archived_at IS NULL
       AND ($2::date IS NULL OR created_at < $2::date)
     ORDER BY created_at,id`,[db.PROJECT,before||null]);
  const parts=[];let cur=[],bytes=0;
  for(const f of r.rows){
    if(cur.length&&bytes+f.size>CHUNK){parts.push({ids:cur,bytes});cur=[];bytes=0}
    cur.push(f.id);bytes+=f.size;
  }
  if(cur.length)parts.push({ids:cur,bytes});
  return{files:r.rows.length,bytes:r.rows.reduce((a,f)=>a+f.size,0),
    parts:parts.map((p,i)=>({n:i+1,count:p.ids.length,bytes:p.bytes,ids:p.ids})),
    oldest:r.rows[0]?r.rows[0].day:null,newest:r.rows.length?r.rows[r.rows.length-1].day:null};
}

module.exports=handler(async(req,res)=>{
  method(req,'GET','POST');
  const u=await need(req,{admin:true});
  await db.init();

  if(req.method==='GET'){
    const qs=new URL(req.url,'http://x').searchParams;
    const [p,arch]=await Promise.all([
      plan(qs.get('before')),
      db.q(`SELECT archive_ref ref,COUNT(*)::int count,COALESCE(SUM(size),0)::bigint bytes,
              to_char(MAX(archived_at),'YYYY-MM-DD HH24:MI') at
            FROM files WHERE project_id=$1 AND archived_at IS NOT NULL
            GROUP BY archive_ref ORDER BY MAX(archived_at) DESC`,[db.PROJECT]),
    ]);
    return send(res,200,{plan:p,archives:arch.rows.map(a=>({...a,bytes:Number(a.bytes)})),
      storage:await db.storage()});
  }

  const b=await body(req);
  const act=b.action;

  /* 1. Выгрузка куска: содержимое файлов + их хеши. База при этом не меняется. */
  if(act==='export'){
    const ids=(Array.isArray(b.ids)?b.ids:[]).slice(0,500).map(String);
    if(!ids.length)throw fail('Не указано, какие файлы выгружать',400);
    const r=await db.q(`SELECT id,work_id "work",name,mime,size,sha256,device,
         to_char(taken_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') taken,created_by "createdBy",
         to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SS"Z"') "createdAt",data
       FROM files WHERE project_id=$1 AND id=ANY($2) AND archived_at IS NULL ORDER BY created_at`,
      [db.PROJECT,ids]);
    const files=r.rows.map(f=>{
      const now=sha(f.data);
      if(f.sha256&&f.sha256!==now)
        throw fail(`Файл «${f.name}» не совпадает с сохранённым хешем — архив не собран`,409);
      return{...f,sha256:f.sha256||now,data:f.data.toString('base64')};
    });
    db.audit(u.login,u.role,'собран кусок архива вложений',{count:files.length});
    return send(res,200,{format:'aksg-files-archive',version:1,
      at:new Date().toISOString(),by:u.login,count:files.length,
      bytes:files.reduce((a,f)=>a+f.size,0),files});
  }

  /* 2. Освобождение места: только после того, как администратор подтвердил сохранение архива.
        Сверяем хеши — место освобождается лишь у того, что действительно уехало. */
  if(act==='release'){
    const ref=String(b.ref||'').slice(0,200);
    const got=b.files&&typeof b.files==='object'?b.files:null;   /* {id: sha256} */
    if(!ref)throw fail('Не указано имя файла архива',400);
    if(!got||!Object.keys(got).length)throw fail('Не указано, что сохранено в архив',400);
    const ids=Object.keys(got).slice(0,500);
    const r=await db.q(`SELECT id,name,sha256,size FROM files
       WHERE project_id=$1 AND id=ANY($2) AND archived_at IS NULL`,[db.PROJECT,ids]);
    const ok=[],bad=[];
    for(const f of r.rows){
      if(String(got[f.id]||'')===f.sha256&&f.sha256)ok.push(f);else bad.push(f.name||f.id);
    }
    if(!ok.length)throw fail('Ни один файл не сошёлся по хешу — место не освобождено',409);
    await db.q(`UPDATE files SET data=''::bytea,archived_at=now(),archive_ref=$3
       WHERE project_id=$1 AND id=ANY($2) AND archived_at IS NULL`,
      [db.PROJECT,ok.map(f=>f.id),ref]);
    const freed=ok.reduce((a,f)=>a+f.size,0);
    db.audit(u.login,u.role,'вложения выгружены в архив',{ref,count:ok.length,freed,bad:bad.length});
    return send(res,200,{archived:ok.length,freed,freedText:mb(freed),
      skipped:bad,storage:await db.storage()});
  }

  /* 3. Возврат из архива: файл встаёт на место, если хеш совпал с тем, что записано в базе. */
  if(act==='restore'){
    const files=Array.isArray(b.files)?b.files:null;
    if(!files||!files.length)throw fail('В файле архива нет вложений',400);
    let back=0,already=0;const bad=[];
    for(const f of files.slice(0,500)){
      const buf=Buffer.from(String(f.data||''),'base64');
      if(!buf.length){bad.push(f.name||f.id);continue}
      const r=await db.q('SELECT sha256,archived_at FROM files WHERE id=$1 AND project_id=$2',
        [String(f.id||''),db.PROJECT]);
      const row=r.rows[0];
      if(!row){bad.push((f.name||f.id)+' — такого файла в базе нет');continue}
      if(!row.archived_at){already++;continue}
      if(row.sha256&&row.sha256!==sha(buf)){bad.push((f.name||f.id)+' — хеш не совпал');continue}
      await db.q(`UPDATE files SET data=$3,archived_at=NULL,archive_ref='' WHERE id=$1 AND project_id=$2`,
        [f.id,db.PROJECT,buf]);
      back++;
    }
    db.audit(u.login,u.role,'вложения возвращены из архива',{back,already,bad:bad.length});
    return send(res,200,{restored:back,already,skipped:bad,storage:await db.storage()});
  }

  throw fail('Неизвестное действие',400);
});
