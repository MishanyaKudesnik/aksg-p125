/* Учётные записи, сессии, роли и права. */
const crypto=require('node:crypto');
const db=require('./db.js');

const ROLES={
  inspector:{name:'Инспектор',  write:true,  admin:false, note:'Вносит факт по работам, добавляет подтверждения, работает в поле'},
  manager:  {name:'Руководитель',write:false, admin:false, note:'Видит весь ход работ, отклонения и хронологию, данные не меняет'},
  admin:    {name:'Администратор',write:true, admin:true,  note:'Управляет людьми, ролями и кодами доступа, помогает остальным'}
};
const DAY=864e5, SESSION_DAYS=30;

const hash=(pass,salt)=>crypto.scryptSync(String(pass),salt,32).toString('hex');
function makePass(pass){const salt=crypto.randomBytes(12).toString('hex');return 's1$'+salt+'$'+hash(pass,salt)}
function checkPass(pass,stored){
  const [v,salt,want]=String(stored||'').split('$');
  if(v!=='s1'||!salt||!want)return false;
  const got=hash(pass,salt);
  const a=Buffer.from(got),b=Buffer.from(want);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
const token=()=>crypto.randomBytes(24).toString('base64url');
const inviteCode=()=>crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/,'$1-');

function cookies(req){
  const out={};
  for(const part of String(req.headers.cookie||'').split(';')){
    const i=part.indexOf('=');if(i<0)continue;
    out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
const setCookie=(res,value,maxAgeSec)=>res.setHeader('Set-Cookie',
  `aksg=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`+
  (process.env.VERCEL?'; Secure':''));

async function currentUser(req){
  const t=cookies(req).aksg;
  if(!t)return null;
  await db.init();
  const r=await db.q(`SELECT u.id,u.login,u.name,u.role,u.active,s.expires_at
     FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1`,[t]);
  const row=r.rows[0];
  if(!row)return null;
  if(new Date(row.expires_at).getTime()<Date.now()){await db.q('DELETE FROM sessions WHERE token=$1',[t]);return null}
  if(!row.active)return null;
  db.q('UPDATE users SET last_seen=now() WHERE id=$1',[row.id]).catch(()=>{});
  return{id:row.id,login:row.login,name:row.name,role:row.role,token:t,
    can:{write:ROLES[row.role]?.write||false,admin:ROLES[row.role]?.admin||false}};
}

async function login(req,res,loginName,pass){
  await db.init();
  const r=await db.q('SELECT * FROM users WHERE lower(login)=lower($1)',[String(loginName||'').trim()]);
  const u=r.rows[0];
  if(!u||!u.active||!checkPass(pass,u.pass))return null;
  const t=token();
  await db.q('INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,now()+interval \'30 days\')',[t,u.id]);
  setCookie(res,t,SESSION_DAYS*86400);
  db.audit(u.login,u.role,'вход');
  return{id:u.id,login:u.login,name:u.name,role:u.role};
}

/* Регистрация: первый человек в пустой системе становится администратором,
   остальным нужен код приглашения с заранее заданной ролью. */
async function register(req,res,{login:loginName,name,pass,code}){
  await db.init();
  loginName=String(loginName||'').trim();
  if(!/^[a-zA-Z0-9._-]{3,32}$/.test(loginName))
    throw Object.assign(new Error('Логин: 3–32 знака, латиница, цифры, точка, дефис или подчёркивание'),{status:400});
  if(String(pass||'').length<8)throw Object.assign(new Error('Пароль не короче 8 знаков'),{status:400});
  const exists=await db.q('SELECT 1 FROM users WHERE lower(login)=lower($1)',[loginName]);
  if(exists.rows.length)throw Object.assign(new Error('Такой логин уже занят'),{status:409});

  const count=(await db.q('SELECT count(*)::int c FROM users')).rows[0].c;
  let role='inspector',used=null;
  if(count===0)role='admin';
  else{
    const c=String(code||'').trim().toUpperCase();
    if(!c)throw Object.assign(new Error('Нужен код приглашения — его выдаёт администратор'),{status:400});
    const inv=(await db.q('SELECT * FROM invites WHERE upper(code)=$1',[c])).rows[0];
    if(!inv||inv.uses_left<1)throw Object.assign(new Error('Код не найден или уже использован'),{status:400});
    role=inv.role;used=inv.code;
  }
  const r=await db.q('INSERT INTO users(login,name,role,pass) VALUES($1,$2,$3,$4) RETURNING id',
    [loginName,String(name||'').slice(0,120),role,makePass(pass)]);
  if(used)await db.q('UPDATE invites SET uses_left=uses_left-1 WHERE code=$1',[used]);
  const t=token();
  await db.q('INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,now()+interval \'30 days\')',[t,r.rows[0].id]);
  setCookie(res,t,SESSION_DAYS*86400);
  db.audit(loginName,role,count===0?'создан первый администратор':'регистрация по коду',{code:used});
  return{id:r.rows[0].id,login:loginName,name,role};
}

async function logout(req,res){
  const t=cookies(req).aksg;
  if(t)await db.q('DELETE FROM sessions WHERE token=$1',[t]).catch(()=>{});
  setCookie(res,'',0);
}

module.exports={ROLES,currentUser,login,register,logout,makePass,checkPass,inviteCode,cookies,setCookie};
