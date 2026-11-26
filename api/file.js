/* Вложения к подтверждениям: фото с камеры, акты, схемы, журналы.
   POST — загрузить (инспектор и администратор), GET ?id= — открыть (любой, кто вошёл). */
const crypto=require('node:crypto');
const {send,body,handler,need,method}=require('../lib/http.js');
const db=require('../lib/db.js');

const MAX=3.5*1024*1024;                 /* больше Vercel в одном запросе не пропустит */
const MAX_IMG=1.2*1024*1024;             /* снимок столько весить не должен: уменьшаем его на устройстве */
const mb=n=>(n/1048576).toFixed(n<10485760?1:0)+' МБ';
const OK_MIME=/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf|application\/vnd\.openxmlformats|application\/msword|text\/plain)/;

module.exports=handler(async(req,res)=>{
  method(req,'GET','POST');

  if(req.method==='GET'){
    await need(req);
    const qs=new URL(req.url,'http://x').searchParams;
    /* сколько места занято — это нужно знать до выезда на участок, а не после */
    if(qs.get('usage')){await db.init();return send(res,200,await db.storage())}
    const id=qs.get('id');
    if(!id)throw Object.assign(new Error('Не указан файл'),{status:400});
    const r=await db.q(`SELECT name,mime,data,sha256,archive_ref,
         to_char(archived_at,'DD.MM.YYYY') archived
       FROM files WHERE id=$1 AND project_id=$2`,[id,db.PROJECT]);
    const f=r.rows[0];
    if(!f)throw Object.assign(new Error('Файл не найден'),{status:404});
    /* файл не удалён, он в архиве: говорим где именно, а не «не найден» */
    if(f.archived)throw Object.assign(new Error(
      `«${f.name}» выгружен в архив ${f.archive_ref||''} от ${f.archived}. `+
      'Сведения и хеш файла сохранены — попросите администратора вернуть его из архива.'),{status:410});
    /* контроль целостности: пересчитываем хеш при каждой выдаче */
    const now=crypto.createHash('sha256').update(f.data).digest('hex');
    if(f.sha256&&f.sha256!==now){
      db.audit('система','','подмена файла обнаружена',{id,было:f.sha256,стало:now});
      throw Object.assign(new Error('Файл не совпадает с сохранённым хешем — выдача остановлена'),{status:409});
    }
    res.statusCode=200;
    res.setHeader('x-content-sha256',f.sha256||now);
    res.setHeader('content-type',f.mime||'application/octet-stream');
    res.setHeader('content-disposition','inline; filename*=UTF-8\'\''+encodeURIComponent(f.name||'file'));
    res.setHeader('cache-control','private, max-age=86400');
    return res.end(f.data);
  }

  const u=await need(req,{write:true});
  const b=await body(req);
  const data=String(b.data||'').replace(/^data:[^,]*,/,'');
  if(!data)throw Object.assign(new Error('Пустой файл'),{status:400});
  const buf=Buffer.from(data,'base64');
  if(!buf.length)throw Object.assign(new Error('Файл не разобран'),{status:400});
  if(buf.length>MAX)throw Object.assign(new Error('Файл больше 3,5 МБ — уменьшите снимок или приложите ссылку'),{status:413});
  const mime=String(b.mime||'application/octet-stream').slice(0,100);
  if(!OK_MIME.test(mime))throw Object.assign(new Error('Такой тип файла не принимается: фото, PDF, документ Word или текст'),{status:400});
  /* снимок, пришедший без сжатия, забивает базу за несколько выездов */
  if(/^image\//.test(mime)&&buf.length>MAX_IMG)
    throw Object.assign(new Error(`Снимок весит ${mb(buf.length)}. Фотографии принимаются до ${mb(MAX_IMG)} — `+
      'приложение уменьшает их само, сделайте снимок через кнопку «Сфотографировать».'),{status:413});

  await db.init();
  /* общая квота: место кончается тихо, поэтому говорим об этом заранее */
  const st=await db.storage();
  if(st.bytes+buf.length>st.quota){
    db.audit(u.login,u.role,'отказ: кончилось место под вложения',{need:buf.length,free:st.free});
    throw Object.assign(new Error(`Место под вложения кончилось: занято ${mb(st.bytes)} из ${mb(st.quota)}. `+
      'Обратитесь к администратору — нужно выгрузить архив и освободить место.'),{status:507});
  }

  const id=String(b.id||('F'+Date.now().toString(36)+Math.random().toString(36).slice(2,8))).slice(0,120);
  const sha256=crypto.createHash('sha256').update(buf).digest('hex');
  await db.q(`INSERT INTO files(id,project_id,work_id,name,mime,size,sha256,taken_at,device,data,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
    [id,db.PROJECT,String(b.work||'').slice(0,60),String(b.name||'файл').slice(0,300),mime,buf.length,sha256,
     b.taken||null,String(b.device||'').slice(0,120),buf,u.login]);
  db.audit(u.login,u.role,'загружен файл подтверждения',{id,name:b.name,size:buf.length,sha256});
  const after=await db.storage();
  return send(res,200,{id,name:b.name,size:buf.length,mime,sha256,storage:after,
    warn:after.warn?`Место под вложения заполнено на ${after.pct} %`:''});
});
