/* Продольный профиль: отметки земли и проектные отметки по пикетам.
   Это данные проектировщика — система их не выдумывает, их загружают из ведомости.
   GET — всем, кто вошёл. POST — замена профиля целиком (инспектор и администратор). */
const {send,body,handler,need,method,fail}=require('../lib/http.js');
const db=require('../lib/db.js');
const E=require('../lib/engine.js');

module.exports=handler(async(req,res)=>{
  method(req,'GET','POST');

  if(req.method==='GET'){
    await need(req);
    await db.init();
    const r=await db.q(`SELECT pk::float8 pk,ground::float8 ground,design::float8 design,note
       FROM profile WHERE project_id=$1 ORDER BY pk`,[db.PROJECT]);
    return send(res,200,{profile:r.rows});
  }

  const u=await need(req,{write:true});
  const b=await body(req);
  await db.init();
  /* показать, как это выглядит, на демонстрационных отметках — по явной кнопке, а не молча */
  if(b.demo){
    const n=await db.seedProfile();
    db.audit(u.login,u.role,'профиль заполнен демонстрационными отметками',{points:n});
    return send(res,200,{saved:n,demo:true});
  }
  const rows=E.profileRows(b.profile);
  if(!rows.length)throw fail('В файле не нашлось ни одной строки с пикетом и отметкой',400);
  if(rows.length>5000)throw fail('Слишком много точек профиля: больше 5000 за раз не принимаем',400);
  const c=await db.getPool().connect();
  try{
    await c.query('BEGIN');
    await c.query('DELETE FROM profile WHERE project_id=$1',[db.PROJECT]);
    for(const r of rows)
      await c.query(`INSERT INTO profile(project_id,pk,ground,design,note) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT (project_id,pk) DO UPDATE SET ground=EXCLUDED.ground,design=EXCLUDED.design,
        note=EXCLUDED.note`,[db.PROJECT,r.pk,r.ground,r.design,r.note||'']);
    await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e}
  finally{c.release()}
  db.audit(u.login,u.role,'загружен продольный профиль',{points:rows.length,
    from:rows[0].pk,to:rows[rows.length-1].pk});
  return send(res,200,{saved:rows.length,from:rows[0].pk,to:rows[rows.length-1].pk});
});
