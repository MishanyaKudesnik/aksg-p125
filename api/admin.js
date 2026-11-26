/* Администрирование: люди, роли, коды приглашения, журнал действий. */
const {send,body,handler,need,method}=require('../lib/http.js');
const crypto=require('node:crypto');
const db=require('../lib/db.js');
const auth=require('../lib/auth.js');
const sha=s=>crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports=handler(async(req,res)=>{
  method(req,'GET','POST');
  const u=await need(req,{admin:true});

  if(req.method==='GET'){
    const [users,invites,audit,devices]=await Promise.all([
      db.q(`SELECT id,login,name,role,active,to_char(created_at,'YYYY-MM-DD') "createdAt",
             to_char(last_seen,'YYYY-MM-DD HH24:MI') "lastSeen" FROM users ORDER BY id`),
      db.q(`SELECT code,role,note,uses_left "usesLeft",created_by "createdBy",
             to_char(created_at,'YYYY-MM-DD') "createdAt" FROM invites ORDER BY created_at DESC`),
      db.q(`SELECT actor,role,action,detail,to_char(at,'YYYY-MM-DD HH24:MI') at
             FROM audit ORDER BY at DESC LIMIT 200`),
      db.q(`SELECT id,name,note,active,created_by "createdBy",
             to_char(created_at,'YYYY-MM-DD') "createdAt",
             to_char(last_seen,'YYYY-MM-DD HH24:MI') "lastSeen" FROM devices ORDER BY id`),
    ]);
    return send(res,200,{users:users.rows,invites:invites.rows,audit:audit.rows,
      devices:devices.rows,roles:auth.ROLES});
  }

  const b=await body(req);
  const act=b.action;

  if(act==='invite'){
    const role=b.role||'inspector';
    if(!auth.ROLES[role])throw Object.assign(new Error('Неизвестная роль'),{status:400});
    const code=auth.inviteCode();
    const uses=Math.max(1,Math.min(50,parseInt(b.uses,10)||1));
    await db.q('INSERT INTO invites(code,role,note,uses_left,created_by) VALUES($1,$2,$3,$4,$5)',
      [code,role,String(b.note||'').slice(0,200),uses,u.login]);
    db.audit(u.login,u.role,'создан код приглашения',{code,role,uses});
    return send(res,200,{code,role,uses});
  }
  if(act==='device'){
    const name=String(b.name||'').trim().slice(0,120);
    if(!name)throw Object.assign(new Error('Нужно название устройства'),{status:400});
    const key=crypto.randomBytes(18).toString('hex');
    await db.q('INSERT INTO devices(name,token,note,created_by) VALUES($1,$2,$3,$4)',
      [name,sha(key),String(b.note||'').slice(0,200),u.login]);
    db.audit(u.login,u.role,'добавлено устройство',{name});
    return send(res,200,{name,key});
  }
  if(act==='device-active'){
    await db.q('UPDATE devices SET active=$2 WHERE id=$1',[+b.id||0,!!b.active]);
    db.audit(u.login,u.role,b.active?'устройство включено':'устройство отключено',{id:b.id});
    return send(res,200,{ok:true});
  }
  if(act==='invite-delete'){
    await db.q('DELETE FROM invites WHERE code=$1',[String(b.code||'')]);
    db.audit(u.login,u.role,'удалён код приглашения',{code:b.code});
    return send(res,200,{ok:true});
  }
  if(act==='role'){
    if(!auth.ROLES[b.role])throw Object.assign(new Error('Неизвестная роль'),{status:400});
    if(String(b.login).toLowerCase()===u.login.toLowerCase()&&b.role!=='admin')
      throw Object.assign(new Error('Нельзя снять роль администратора с самого себя'),{status:400});
    await db.q('UPDATE users SET role=$2 WHERE lower(login)=lower($1)',[b.login,b.role]);
    db.audit(u.login,u.role,'изменена роль',{login:b.login,role:b.role});
    return send(res,200,{ok:true});
  }
  if(act==='active'){
    if(String(b.login).toLowerCase()===u.login.toLowerCase())
      throw Object.assign(new Error('Нельзя отключить самого себя'),{status:400});
    await db.q('UPDATE users SET active=$2 WHERE lower(login)=lower($1)',[b.login,!!b.active]);
    if(!b.active)await db.q('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE lower(login)=lower($1))',[b.login]);
    db.audit(u.login,u.role,b.active?'доступ открыт':'доступ закрыт',{login:b.login});
    return send(res,200,{ok:true});
  }
  if(act==='password'){
    if(String(b.pass||'').length<8)throw Object.assign(new Error('Пароль не короче 8 знаков'),{status:400});
    await db.q('UPDATE users SET pass=$2 WHERE lower(login)=lower($1)',[b.login,auth.makePass(b.pass)]);
    await db.q('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE lower(login)=lower($1))',[b.login]);
    db.audit(u.login,u.role,'сброшен пароль',{login:b.login});
    return send(res,200,{ok:true});
  }
  throw Object.assign(new Error('Неизвестное действие'),{status:400});
});
