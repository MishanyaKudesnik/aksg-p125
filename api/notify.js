/* Что требует внимания прямо сейчас. Уведомления живут в самом приложении,
   наружу ничего не отправляется. */
const {send,handler,need,method}=require('../lib/http.js');
const N=require('../lib/notify.js');

module.exports=handler(async(req,res)=>{
  method(req,'GET');
  await need(req);
  const list=await N.alerts();
  return send(res,200,{alerts:list,titles:N.TITLE,
    counts:list.reduce((a,x)=>(a[x.kind]=(a[x.kind]||0)+1,a),{})});
});
