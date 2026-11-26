/* Что система считает поводом для уведомления.
   Уведомления живут в самом приложении: сигнал в шапке и, если человек разрешил, сообщение
   от браузера на экране. Ничего никуда не отправляется — внешних сервисов здесь нет. */
const db=require('./db.js');
const E=require('./engine.js');

/* ---------- что считается поводом ---------- */
const DAY=864e5;
const ru=s=>String(s||'').split('-').reverse().join('.');
async function alerts(now){
  const st=await db.readState();
  const t=now||E.today();
  const sch=E.schedule(st.works,t);
  const out=[];
  for(const w of st.works){
    const a=E.assess(w,{now:t,works:st.works,evidence:st.evidence,schedule:sch});
    if(a.done)continue;
    if(a.overdue)out.push({kind:'overdue',work:w.id,name:w.name,days:a.delayDays,
      text:`${w.name}: плановый срок прошёл ${ru(E.iso(E.planEndTs(w)))}, факт ${w.progress} %`});
    else if(a.level==='bad')out.push({kind:'deviation',work:w.id,name:w.name,days:a.delayDays,
      text:`${w.name}: отставание ${a.deviation} п.п., прогноз ${ru(a.forecastDate)} (+${a.delayDays} дн.)`});
    if(a.noProof)out.push({kind:'noproof',work:w.id,name:w.name,
      text:`${w.name}: факт ${w.progress} % без подтверждающего документа`});
  }
  /* сводки оборудования, которые висят на проверке дольше суток */
  const pend=await db.q(`SELECT id,work_id,device,progress::float8 progress,
      EXTRACT(EPOCH FROM (now()-at))/3600 hours FROM reports
      WHERE project_id=$1 AND status='review' AND at < now()-interval '24 hours'`,[db.PROJECT]);
  for(const p of pend.rows){
    const w=st.works.find(x=>x.id===p.work_id);
    out.push({kind:'review',work:p.work_id,name:w?w.name:p.work_id,hours:Math.round(p.hours),
      text:`${w?w.name:p.work_id}: сводка от «${p.device}» (${p.progress} %) ждёт проверки ${Math.round(p.hours/24)} сут.`});
  }
  /* место под вложения — такой же повод, как отклонение: узнать об этом надо заранее */
  try{
    const st=await db.storage();
    if(st.warn)out.push({kind:'storage',work:'—',name:'Хранилище',
      text:`Место под фотографии и документы заполнено на ${st.pct} % `+
        `(${Math.round(st.bytes/1048576)} из ${Math.round(st.quota/1048576)} МБ). `+
        'Выгрузите архив, пока загрузка подтверждений не остановилась.'});
  }catch(e){}
  const order={overdue:0,deviation:1,storage:2,review:3,noproof:4};
  out.sort((a,b)=>(order[a.kind]-order[b.kind])||((b.days||0)-(a.days||0)));
  return out;
}

const TITLE={overdue:'Просрочено',deviation:'Отклонение',storage:'Место в хранилище',
  review:'Ждёт проверки',noproof:'Без подтверждения'};

function digestText(list,date){
  if(!list.length)return`АКСГ, ${date}: отклонений нет, все работы идут по плану.`;
  const by={};for(const a of list)(by[a.kind]=by[a.kind]||[]).push(a);
  const parts=[`АКСГ — сводка на ${date}`];
  for(const k of ['overdue','deviation','storage','review','noproof']){
    if(!by[k])continue;
    parts.push('');
    parts.push(`${TITLE[k]} — ${by[k].length}:`);
    for(const a of by[k].slice(0,10))parts.push('• '+a.text);
    if(by[k].length>10)parts.push(`…и ещё ${by[k].length-10}`);
  }
  parts.push('');
  parts.push('Открыть: https://aksg-p125.vercel.app');
  return parts.join('\n');
}

module.exports={alerts,digestText,TITLE};
