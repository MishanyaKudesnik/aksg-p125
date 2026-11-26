/* Чтение и сохранение графика. Руководителю — только чтение. */
const {send,body,handler,need,method}=require('../lib/http.js');
const db=require('../lib/db.js');
const E=require('../lib/engine.js');

module.exports=handler(async(req,res)=>{
  method(req,'GET','PUT');
  if(req.method==='GET'){
    const u=await need(req);
    const s=await db.readState();
    return send(res,200,{...s,user:{login:u.login,name:u.name,role:u.role,can:u.can}});
  }
  const u=await need(req,{write:true});
  const b=await body(req);
  if(!b||typeof b!=='object'||Array.isArray(b))throw Object.assign(new Error('Ожидался объект состояния'),{status:400});
  if(!Array.isArray(b.works)||!Array.isArray(b.sections))
    throw Object.assign(new Error('Нужны списки works и sections — состояние без них не сохраняется'),{status:400});
  const cur=await db.readState();
  if(b.rev!==cur.rev)return send(res,409,{error:'Данные изменились на сервере',rev:cur.rev,state:cur});
  const rev=await db.writeState(E.normalize(b),u.login);
  db.audit(u.login,u.role,'сохранение графика',{works:b.works.length});
  return send(res,200,{rev});
});
