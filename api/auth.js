/* Вход, регистрация, выход, сведения о текущем пользователе. */
const {send,body,handler,method}=require('../lib/http.js');
const auth=require('../lib/auth.js');
const db=require('../lib/db.js');
const limit=require('../lib/limit.js');

module.exports=handler(async(req,res)=>{
  method(req,'GET','POST');
  if(req.method==='GET'){
    await db.init();
    const u=await auth.currentUser(req);
    const first=u?false:((await db.q('SELECT count(*)::int c FROM users')).rows[0].c===0);
    return send(res,200,{user:u?{login:u.login,name:u.name,role:u.role,can:u.can}:null,
      roles:auth.ROLES,firstRun:first});
  }
  const b=await body(req);
  if(b.action==='logout'){await auth.logout(req,res);return send(res,200,{ok:true})}
  if(b.action==='register'){
    const g=await limit.hit('reg:'+limit.ip(req),{limit:10,windowSec:3600,blockSec:3600});
    if(!g.ok){res.setHeader('retry-after',String(g.retryAfter));
      return send(res,429,{error:'Слишком много регистраций с этого адреса. Повторите позже.'})}
    const u=await auth.register(req,res,b);
    return send(res,200,{user:{login:u.login,name:u.name,role:u.role,
      can:{write:auth.ROLES[u.role].write,admin:auth.ROLES[u.role].admin}}});
  }
  if(b.action==='login'){
    const g=await limit.guardLogin(req,b.login);
    if(!g.ok){
      db.audit(String(b.login||'').slice(0,60),'','вход заблокирован: много попыток',{retryAfter:g.retryAfter});
      res.setHeader('retry-after',String(g.retryAfter));
      return send(res,429,{error:`Слишком много попыток входа. Повторите через ${Math.ceil(g.retryAfter/60)} мин.`});
    }
    const u=await auth.login(req,res,b.login,b.pass);
    if(!u){
      db.audit(String(b.login||'').slice(0,60),'','неудачный вход');
      return send(res,401,{error:'Неверный логин или пароль'});
    }
    for(const k of (g.keys||[]))limit.reset(k);
    return send(res,200,{user:{login:u.login,name:u.name,role:u.role,
      can:{write:auth.ROLES[u.role].write,admin:auth.ROLES[u.role].admin}}});
  }
  return send(res,400,{error:'Неизвестное действие'});
});
