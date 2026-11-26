/* Загрузка пакета, собранного в поле без связи.
   Пакет: {format:'aksg-batch',version:1,author,device,collectedAt,works:[...],evidence:[...]}
   Работа применяется, если её правка свежее той, что лежит на сервере. */
const {send,body,handler,need,method}=require('../lib/http.js');
const db=require('../lib/db.js');
const E=require('../lib/engine.js');
const crypto=require('node:crypto');
const sha256=b=>crypto.createHash('sha256').update(b).digest('hex');

const ts=v=>{const t=Date.parse(v||'');return isNaN(t)?0:t};

module.exports=handler(async(req,res)=>{
  method(req,'POST');
  const u=await need(req,{write:true});
  const b=await body(req);
  if(!b||b.format!=='aksg-batch'||!Array.isArray(b.works))
    throw Object.assign(new Error('Это не пакет АКСГ: нужен файл, выгруженный кнопкой «Пакет для поля»'),{status:400});

  const id=String(b.id||crypto.randomUUID());
  if((await db.q('SELECT 1 FROM batches WHERE id=$1',[id])).rows.length)
    return send(res,200,{ok:true,already:true,message:'Этот пакет уже загружен раньше — данные не продублированы'});

  const state=await db.readState();
  const byId=new Map(state.works.map(w=>[w.id,w]));
  const report={applied:[],skipped:[],created:[],evidence:0};

  for(const raw of b.works){
    if(!raw||!raw.id)continue;
    const w=byId.get(raw.id);
    const when=ts(raw.updatedAt);
    if(!w){
      const nw=E.normalize({sections:state.sections,works:[raw],evidence:[]}).works[0];
      if(!nw)continue;
      await db.q(`INSERT INTO works(project_id,id,name,section,pk_from,pk_to,plan_start,plan_end,
          progress,status,source,dep,note,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT DO NOTHING`,
        [db.PROJECT,nw.id,nw.name,nw.section||state.sections[0]?.id||'S1',nw.pkFrom,nw.pkTo,
         nw.planStart||null,nw.planEnd||null,nw.progress,nw.status,nw.source,nw.dep,nw.note,u.login]);
      await db.q(`INSERT INTO history(project_id,work_id,progress,source,actor,note)
                  VALUES($1,$2,$3,$4,$5,'из полевого пакета')`,[db.PROJECT,nw.id,nw.progress,nw.source,b.author||u.login]);
      report.created.push(nw.id);
      continue;
    }
    const serverWhen=ts(w.updatedAt);
    if(when&&serverWhen&&when<serverWhen){
      report.skipped.push({id:w.id,reason:'на сервере более свежая правка'});
      continue;
    }
    const progress=Math.max(0,Math.min(100,Number(raw.progress)||0));
    const status=progress>=100?'done':(raw.status||w.status);
    await db.q(`UPDATE works SET progress=$3,status=$4,source=$5,note=$6,updated_at=now(),updated_by=$7
                WHERE project_id=$1 AND id=$2`,
      [db.PROJECT,w.id,progress,status,raw.source||'manual',String(raw.note??w.note).slice(0,1000),u.login]);
    if(Number(w.progress)!==progress){
      await db.q(`INSERT INTO history(project_id,work_id,progress,source,actor,note,at)
                  VALUES($1,$2,$3,$4,$5,'из полевого пакета',COALESCE($6::timestamptz,now()))`,
        [db.PROJECT,w.id,progress,raw.source||'manual',b.author||u.login,raw.updatedAt||null]);
    }
    report.applied.push(w.id);
  }

  /* вложения из поля: фото и документы, снятые без связи */
  for(const f of (b.files||[])){
    if(!f||!f.id||!f.data)continue;
    const buf=Buffer.from(String(f.data).replace(/^data:[^,]*,/,''),'base64');
    if(!buf.length||buf.length>4*1024*1024){report.skipped.push({id:f.id,reason:'файл не принят'});continue}
    const r=await db.q(`INSERT INTO files(id,project_id,work_id,name,mime,size,sha256,taken_at,device,data,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
      [String(f.id).slice(0,120),db.PROJECT,String(f.work||'').slice(0,60),String(f.name||'файл').slice(0,300),
       String(f.mime||'application/octet-stream').slice(0,100),buf.length,sha256(buf),
       f.taken||null,String(f.device||b.device||'').slice(0,120),buf,b.author||u.login]);
    report.files=(report.files||0)+r.rowCount;
  }

  for(const e of (b.evidence||[])){
    if(!e||!e.id||!e.work)continue;
    const r=await db.q(`INSERT INTO evidence(project_id,id,work_id,type,ref,date,note,created_by,file_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [db.PROJECT,e.id,e.work,String(e.type||'').slice(0,100),String(e.ref||'').slice(0,300),
       e.date||null,String(e.note||'').slice(0,1000),b.author||u.login,e.fileId||null]);
    report.evidence+=r.rowCount;
  }

  const rev=await db.bumpRev();
  await db.q(`INSERT INTO batches(id,project_id,author,device,collected_at,works,facts,evidence,skipped,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'applied')`,
    [id,db.PROJECT,String(b.author||u.login).slice(0,120),String(b.device||'').slice(0,120),
     b.collectedAt||null,b.works.length,report.applied.length+report.created.length,
     report.evidence,report.skipped.length]);
  db.audit(u.login,u.role,'загружен полевой пакет',{id,...report});
  return send(res,200,{ok:true,rev,report});
});
