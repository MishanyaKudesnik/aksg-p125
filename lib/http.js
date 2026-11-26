/* Общие мелочи для обработчиков: чтение тела, ответы, защита по ролям. */
const auth=require('./auth.js');

const fail=(msg,status)=>Object.assign(new Error(msg),{status});

function send(res,code,data){
  const body=JSON.stringify(data);
  res.statusCode=code;
  res.setHeader('content-type','application/json; charset=utf-8');
  res.setHeader('cache-control','no-store');
  res.end(body);
}
function body(req){
  if(req.body&&typeof req.body==='object')return Promise.resolve(req.body);   /* Vercel уже разобрал */
  return new Promise((ok,no)=>{
    let d='',n=0;
    req.on('data',c=>{n+=c.length;if(n>8e6){no(fail('Тело запроса больше 8 МБ',413));req.destroy();return}d+=c});
    req.on('error',e=>no(fail(String(e.message||e),400)));
    req.on('end',()=>{
      if(!d)return ok({});
      try{ok(JSON.parse(d))}catch(e){no(fail('Тело запроса не разобрано как JSON',400))}
    });
  });
}
/* обёртка: ловит ошибки и отдаёт понятный код вместо пятисотки */
const handler=fn=>async(req,res)=>{
  try{await fn(req,res)}
  catch(e){
    const status=e&&e.status||500;
    if(status>=500)console.error('АКСГ:',e&&e.stack||e);
    try{send(res,status,{error:String(e&&e.message||e)})}catch(x){}
  }
};
async function need(req,{write=false,admin=false}={}){
  const u=await auth.currentUser(req);
  if(!u)throw fail('Нужен вход в систему',401);
  if(admin&&!u.can.admin)throw fail('Доступно только администратору',403);
  if(write&&!u.can.write)throw fail('У вашей роли доступ только на просмотр',403);
  return u;
}
const method=(req,...allowed)=>{
  if(!allowed.includes(req.method))throw fail('Метод не поддерживается',405);
};
module.exports={send,body,handler,need,method,fail};
