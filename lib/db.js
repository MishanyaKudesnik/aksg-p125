/* Доступ к PostgreSQL + схема базы. Один и тот же код локально и на Vercel. */
const {Pool}=require('pg');
const PROJECT=1;
let pool=null,ready=null;

function connectionString(){
  return process.env.DATABASE_URL||process.env.POSTGRES_URL||process.env.PGURL||'';
}
function getPool(){
  if(pool)return pool;
  const cs=connectionString();
  if(!cs)throw Object.assign(new Error('Не задана переменная DATABASE_URL с адресом базы'),{status:500});
  const local=/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(cs);
  pool=new Pool({connectionString:cs,max:3,idleTimeoutMillis:10000,connectionTimeoutMillis:10000,
    ssl:local?false:{rejectUnauthorized:false}});
  pool.on('error',()=>{});
  return pool;
}
const q=(text,params)=>getPool().query(text,params);

const SCHEMA=`
CREATE TABLE IF NOT EXISTS users(
  id BIGSERIAL PRIMARY KEY,
  login TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'inspector',
  pass TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ);
CREATE UNIQUE INDEX IF NOT EXISTS users_login_uq ON users (lower(login));

CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites(
  code TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  uses_left INT NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS projects(
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  rev INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS sections(
  project_id BIGINT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  pk_from NUMERIC NOT NULL DEFAULT 0,
  pk_to NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id,id));

CREATE TABLE IF NOT EXISTS works(
  project_id BIGINT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  section TEXT NOT NULL DEFAULT '',
  pk_from NUMERIC NOT NULL DEFAULT 0,
  pk_to NUMERIC NOT NULL DEFAULT 0,
  plan_start DATE,
  plan_end DATE,
  progress NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'plan',
  source TEXT NOT NULL DEFAULT 'manual',
  dep TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(project_id,id));
CREATE INDEX IF NOT EXISTS works_section_idx ON works(project_id,section);

CREATE TABLE IF NOT EXISTS evidence(
  project_id BIGINT NOT NULL,
  id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  date DATE,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(project_id,id));
CREATE INDEX IF NOT EXISTS evidence_work_idx ON evidence(project_id,work_id);

CREATE TABLE IF NOT EXISTS devices(
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ);

/* продольный профиль: отметка земли и проектная отметка на пикете.
   Это данные проектировщика, их загружают из ведомости — система их не придумывает. */
CREATE TABLE IF NOT EXISTS profile(
  project_id BIGINT NOT NULL,
  pk NUMERIC NOT NULL,
  ground NUMERIC,
  design NUMERIC,
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(project_id,pk));

CREATE TABLE IF NOT EXISTS files(
  id TEXT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  work_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INT NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL DEFAULT '',
  data BYTEA NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS history(
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL,
  work_id TEXT NOT NULL,
  progress NUMERIC,
  source TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS history_work_idx ON history(project_id,work_id,at DESC);

CREATE TABLE IF NOT EXISTS audit(
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  detail JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit(at DESC);

CREATE TABLE IF NOT EXISTS reports(
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL,
  work_id TEXT NOT NULL,
  progress NUMERIC,
  source TEXT NOT NULL DEFAULT 'camera',
  device TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'review',
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TIMESTAMPTZ,
  reason TEXT NOT NULL DEFAULT '',
  at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(project_id,status,at DESC);

CREATE TABLE IF NOT EXISTS settings(
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS attempts(
  k TEXT PRIMARY KEY,
  n INT NOT NULL DEFAULT 0,
  until TIMESTAMPTZ,
  first_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS batches(
  id TEXT PRIMARY KEY,
  project_id BIGINT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  collected_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  works INT NOT NULL DEFAULT 0,
  facts INT NOT NULL DEFAULT 0,
  evidence INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'applied');
`;

async function init(){
  if(ready)return ready;
  ready=(async()=>{
    await q(SCHEMA);
    await q(`ALTER TABLE evidence ADD COLUMN IF NOT EXISTS file_id TEXT`);
    await q(`ALTER TABLE files ADD COLUMN IF NOT EXISTS sha256 TEXT NOT NULL DEFAULT ''`);
    await q(`ALTER TABLE files ADD COLUMN IF NOT EXISTS taken_at TIMESTAMPTZ`);
    await q(`ALTER TABLE files ADD COLUMN IF NOT EXISTS device TEXT NOT NULL DEFAULT ''`);
    /* архив: сведения о файле остаются в базе навсегда, тяжёлое содержимое уезжает в файл архива */
    await q(`ALTER TABLE files ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
    await q(`ALTER TABLE files ADD COLUMN IF NOT EXISTS archive_ref TEXT NOT NULL DEFAULT ''`);
    /* журнал изменений и журнал действий только дописываются: правка и удаление запрещены в самой базе */
    await q(`CREATE OR REPLACE FUNCTION aksg_append_only() RETURNS trigger AS $$
             BEGIN RAISE EXCEPTION 'Журнал % доступен только на дозапись: изменение и удаление запрещены',
               TG_TABLE_NAME USING ERRCODE='42501'; END; $$ LANGUAGE plpgsql`);
    for(const tb of ['history','audit']){
      await q(`DROP TRIGGER IF EXISTS ${tb}_append_only ON ${tb}`);
      await q(`CREATE TRIGGER ${tb}_append_only BEFORE UPDATE OR DELETE ON ${tb}
               FOR EACH ROW EXECUTE FUNCTION aksg_append_only()`);
    }
    await q(`INSERT INTO projects(id,name) SELECT $1,'P125 «Центр управления» — АКСГ'
             WHERE NOT EXISTS(SELECT 1 FROM projects WHERE id=$1)`,[PROJECT]);
    const n=await q('SELECT count(*)::int c FROM works WHERE project_id=$1',[PROJECT]);
    if(!n.rows[0].c)await seed();
    return true;
  })().catch(e=>{ready=null;throw e});
  return ready;
}

/* демонстрационный график, чтобы пустая система не пугала пустым экраном */
async function seed(){
  const S=[['S1','Участок 1 (ПК 0 – ПК 120)',0,120],['S2','Участок 2 (ПК 120 – ПК 260)',120,260]];
  for(const s of S)await q(`INSERT INTO sections(project_id,id,name,pk_from,pk_to) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING`,[PROJECT,...s]);
  const W=[
   ['W1','Земляное полотно','S1',0,120,'2026-09-01','2026-10-15',100,'done','act','',''],
   ['W2','Отсыпка щебёночного балласта','S1',0,120,'2026-10-10','2026-11-10',80,'work','camera','W1',''],
   ['W3','Укладка рельсошпальной решётки','S1',0,120,'2026-11-05','2026-12-10',35,'work','camera','W2',''],
   ['W4','Устройство СЦБ','S1',0,120,'2026-12-05','2027-01-20',0,'plan','manual','W3',''],
   ['W5','Электрификация','S1',0,120,'2027-01-10','2027-03-01',0,'plan','manual','W4',''],
   ['W6','Земляное полотно','S2',120,260,'2026-10-01','2026-11-25',60,'work','excel','',''],
   ['W7','Отсыпка щебёночного балласта','S2',120,260,'2026-11-20','2026-12-30',0,'plan','manual','W6',''],
   ['W8','Укладка рельсошпальной решётки','S2',120,260,'2027-01-05','2027-02-15',0,'plan','manual','W7','Ожидание поставки шпал']];
  for(const w of W)await q(`INSERT INTO works(project_id,id,name,section,pk_from,pk_to,plan_start,plan_end,
      progress,status,source,dep,note,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'система')
      ON CONFLICT DO NOTHING`,[PROJECT,...w]);
  const E=[['E1','W1','Акт','Акт КС-2 №14 от 16.10.2026','2026-10-16',''],
           ['E2','W2','Фото','cam-07 / 08.11.2026','2026-11-08','ПК 40–95']];
  for(const e of E)await q(`INSERT INTO evidence(project_id,id,work_id,type,ref,date,note,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,'система') ON CONFLICT DO NOTHING`,[PROJECT,...e]);
  await q(`INSERT INTO history(project_id,work_id,progress,source,actor,note)
           VALUES($1,'W1',100,'act','система','Загружен демонстрационный график')`,[PROJECT]);
  await seedProfile();
}

/* Демонстрационный продольный профиль. Настоящий загружают ведомостью проектировщика;
   этот появляется только пока в проекте стоит демонстрационный график и профиля ещё нет,
   чтобы раздел не открывался пустым. На загруженный из Excel график он не подставляется. */
async function seedProfile(){
  const P=[[0,142.30,144.10],[20,141.05,143.60],[40,139.80,142.40],[60,140.65,141.90],
           [80,142.90,142.60],[100,145.20,143.80],[120,146.10,145.00],[140,145.40,146.20],
           [160,143.10,146.80],[180,141.70,146.30],[200,142.20,145.10],[220,144.60,144.20],
           [240,146.80,144.00],[260,147.50,144.60]];
  for(const x of P)await q(`INSERT INTO profile(project_id,pk,ground,design,note)
      VALUES($1,$2,$3,$4,'демонстрационные данные')
      ON CONFLICT (project_id,pk) DO UPDATE SET ground=EXCLUDED.ground,design=EXCLUDED.design,
      note=EXCLUDED.note`,[PROJECT,...x]);
  return P.length;
}

/* ---------- состояние графика ---------- */
const D=`to_char(%s,'YYYY-MM-DD')`;
async function readState(){
  await init();
  const [p,sec,works,prof,ev]=await Promise.all([
    q('SELECT rev FROM projects WHERE id=$1',[PROJECT]),
    q('SELECT id,name,pk_from::float8 "from",pk_to::float8 "to" FROM sections WHERE project_id=$1 ORDER BY id',[PROJECT]),
    q(`SELECT id,name,section,pk_from::float8 "pkFrom",pk_to::float8 "pkTo",
        to_char(plan_start,'YYYY-MM-DD') "planStart",to_char(plan_end,'YYYY-MM-DD') "planEnd",
        progress::float8 progress,status,source,dep,note,
        to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') "updatedAt",updated_by "updatedBy"
       FROM works WHERE project_id=$1 ORDER BY id`,[PROJECT]),
    q(`SELECT pk::float8 pk,ground::float8 ground,design::float8 design,note
       FROM profile WHERE project_id=$1 ORDER BY pk`,[PROJECT]),
    q(`SELECT e.id,e.work_id work,e.type,e.ref,to_char(e.date,'YYYY-MM-DD') date,e.note,
          e.file_id "fileId",f.name "fileName",f.size "fileSize",f.mime "fileMime",f.sha256 "fileSha",
          to_char(f.taken_at,'YYYY-MM-DD HH24:MI') "fileTaken",f.device "fileDevice",f.created_by "fileBy",
          to_char(f.archived_at,'DD.MM.YYYY') "fileArchived",NULLIF(f.archive_ref,'') "fileArchiveRef"
       FROM evidence e LEFT JOIN files f ON f.id=e.file_id
       WHERE e.project_id=$1 ORDER BY e.id`,[PROJECT]),
  ]);
  const pend=await q(`SELECT id,work_id "work",progress::float8 progress,device,ref,note,
        to_char(at,'YYYY-MM-DD HH24:MI') at
      FROM reports WHERE project_id=$1 AND status='review' ORDER BY at`,[PROJECT]);
  const hist=await q(`SELECT work_id w,progress::float8 p,to_char(at,'YYYY-MM-DD') d
                      FROM history WHERE project_id=$1 ORDER BY at`,[PROJECT]);
  const byWork={};
  for(const h of hist.rows)(byWork[h.w]=byWork[h.w]||[]).push({d:h.d,p:h.p});
  return{rev:p.rows[0]?p.rows[0].rev:0,sections:sec.rows,
    works:works.rows.map(w=>({...w,history:byWork[w.id]||[]})),evidence:ev.rows,
    profile:prof.rows,pending:pend.rows};
}

/* полная запись состояния (обычное сохранение из интерфейса) */
async function writeState(state,actor){
  await init();
  const c=await getPool().connect();
  try{
    await c.query('BEGIN');
    const cur=await c.query('SELECT progress::float8 p FROM works WHERE project_id=$1',[PROJECT]);
    const old=new Map((await c.query(`SELECT id,progress::float8 p,source,
        to_char(plan_start,'YYYY-MM-DD') ps,to_char(plan_end,'YYYY-MM-DD') pe
        FROM works WHERE project_id=$1`,[PROJECT])).rows.map(r=>[r.id,r]));
    /* плановые сроки нельзя двигать молча: нужно основание (справка ГИПа, распоряжение) */
    const planChanges=[];
    for(const w of state.works){
      const o=old.get(w.id);if(!o)continue;
      const ps=w.planStart||null,pe=w.planEnd||null;
      if((o.ps||null)===ps&&(o.pe||null)===pe)continue;
      const reason=String(w.planReason||'').trim();
      if(!reason){
        await c.query('ROLLBACK');
        throw Object.assign(new Error(
          `Работа ${w.id} «${w.name}»: плановые сроки меняются только с основанием (справка ГИПа, распоряжение)`),
          {status:400,work:w.id});
      }
      planChanges.push({w,o,reason});
    }
    await c.query('DELETE FROM sections WHERE project_id=$1',[PROJECT]);
    await c.query('DELETE FROM works WHERE project_id=$1',[PROJECT]);
    await c.query('DELETE FROM evidence WHERE project_id=$1',[PROJECT]);
    for(const s of state.sections)
      await c.query('INSERT INTO sections(project_id,id,name,pk_from,pk_to) VALUES($1,$2,$3,$4,$5)',
        [PROJECT,s.id,s.name,s.from,s.to]);
    for(const w of state.works){
      await c.query(`INSERT INTO works(project_id,id,name,section,pk_from,pk_to,plan_start,plan_end,
          progress,status,source,dep,note,updated_at,updated_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),$14)`,
        [PROJECT,w.id,w.name,w.section,w.pkFrom,w.pkTo,w.planStart||null,w.planEnd||null,
         w.progress,w.status,w.source,w.dep,w.note,actor]);
      const o=old.get(w.id);
      if(!o||Number(o.p)!==Number(w.progress))
        await c.query(`INSERT INTO history(project_id,work_id,progress,source,actor) VALUES($1,$2,$3,$4,$5)`,
          [PROJECT,w.id,w.progress,w.source,actor]);
    }
    for(const e of state.evidence)
      await c.query(`INSERT INTO evidence(project_id,id,work_id,type,ref,date,note,created_by,file_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [PROJECT,e.id,e.work,e.type,e.ref,e.date||null,e.note,actor,
         (e.fileId&&!String(e.fileId).startsWith('local:'))?e.fileId:null]);
    for(const{w,o,reason}of planChanges)
      await c.query(`INSERT INTO history(project_id,work_id,progress,source,actor,note)
         VALUES($1,$2,$3,'manual',$4,$5)`,
        [PROJECT,w.id,w.progress,actor,
         `план: было ${o.ps||'—'} → ${o.pe||'—'}, стало ${w.planStart||'—'} → ${w.planEnd||'—'}. Основание: ${reason.slice(0,300)}`]);
    const r=await c.query('UPDATE projects SET rev=rev+1,updated_at=now() WHERE id=$1 RETURNING rev',[PROJECT]);
    await c.query('COMMIT');
    return r.rows[0].rev;
  }catch(e){await c.query('ROLLBACK');throw e}
  finally{c.release()}
}

async function bumpRev(){const r=await q('UPDATE projects SET rev=rev+1,updated_at=now() WHERE id=$1 RETURNING rev',[PROJECT]);return r.rows[0].rev}
async function audit(actor,role,action,detail){
  try{await q('INSERT INTO audit(actor,role,action,detail) VALUES($1,$2,$3,$4)',[actor||'',role||'',action,detail?JSON.stringify(detail):null])}catch(e){}
}
/* ---------- место под вложения ----------
   База бесплатного тарифа небольшая, а фотографии — самое тяжёлое, что в неё кладут.
   Поэтому у вложений есть своя квота: предупреждаем заранее и не даём забить базу молча. */
const QUOTA=Math.max(16,parseInt(process.env.FILES_QUOTA_MB||'350',10)||350)*1024*1024;
const WARN_AT=0.8;
async function storage(){
  /* место занимают только файлы, которые лежат в базе; выгруженные в архив его не занимают,
     хотя их сведения и хеш остаются на месте */
  const r=await q(`SELECT
      COALESCE(SUM(size) FILTER (WHERE archived_at IS NULL),0)::bigint bytes,
      COUNT(*) FILTER (WHERE archived_at IS NULL)::int count,
      COALESCE(MAX(size) FILTER (WHERE archived_at IS NULL),0)::int biggest,
      COUNT(*) FILTER (WHERE archived_at IS NOT NULL)::int archived,
      COALESCE(SUM(size) FILTER (WHERE archived_at IS NOT NULL),0)::bigint "archivedBytes"
    FROM files WHERE project_id=$1`,[PROJECT]);
  const x=r.rows[0],bytes=Number(x.bytes||0);
  return{bytes,count:x.count,biggest:x.biggest,
    archived:x.archived,archivedBytes:Number(x.archivedBytes||0),
    quota:QUOTA,free:Math.max(0,QUOTA-bytes),pct:Math.min(100,Math.round(bytes/QUOTA*100)),
    warn:bytes>=QUOTA*WARN_AT};
}

module.exports={PROJECT,q,init,readState,writeState,bumpRev,audit,getPool,connectionString,
  storage,QUOTA,seedProfile};
