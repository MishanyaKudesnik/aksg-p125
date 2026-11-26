/* АКСГ — движок контрольно-сетевого графика.
   Чистые функции без DOM: используются интерфейсом (index.html), сервером и тестами (test.js). */
(function(root,factory){
  if(typeof module!=='undefined'&&module.exports)module.exports=factory();
  else root.AKSG=factory();
})(typeof self!=='undefined'?self:this,function(){
'use strict';
const DAY=864e5;
const STATUS={plan:'Не начата',work:'В работе',done:'Выполнена',block:'Заблокирована'};
const SRC={manual:'Вручную',excel:'Excel',camera:'Камера/датчик',act:'Акт/журнал'};
/* предел прогноза: работа не может растянуться больше чем в POSTPONE раз
   от своей плановой длительности — иначе 1% за месяц даёт дату в 2050 году */
const POSTPONE=5;

const ts=s=>{const t=s?Date.parse(String(s).slice(0,10)+'T00:00:00Z'):NaN;return isNaN(t)?NaN:t};
const iso=t=>new Date(t).toISOString().slice(0,10);
const today=d=>{const x=d?new Date(d):new Date();return Date.UTC(x.getFullYear(),x.getMonth(),x.getDate())};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const days=ms=>Math.round(ms/DAY);

/* ---------- пикетаж ----------
   Железнодорожная привычка: расстояние пишут как «ПК 125+50» — 125-й пикет и ещё 50 метров.
   Внутри храним пикеты числом (125.5), наружу всегда показываем привычную запись. */
const PK_M=100;                      /* метров в пикете */
function pkFmt(v){
  const m=Math.round((+v||0)*PK_M);
  const sign=m<0?'-':'',a=Math.abs(m);
  return sign+Math.floor(a/PK_M)+'+'+String(a%PK_M).padStart(2,'0');
}
const pkLabel=v=>'ПК '+pkFmt(v);
function pkRange(a,b){
  const x=pkFmt(a),y=pkFmt(b);
  return x===y?'ПК '+x:'ПК '+x+' – ПК '+y;
}
/* принимаем и «125+50», и «125,5», и «125» — человек пишет как привык */
function pkParse(s){
  if(typeof s==='number')return isFinite(s)?s:0;
  const str=String(s==null?'':s).replace(/ПК/gi,'').replace(/\s+/g,'').replace(',','.');
  if(!str)return 0;
  const m=str.match(/^(-?\d+(?:\.\d+)?)\+(\d+(?:\.\d+)?)$/);
  if(m){const base=+m[1],add=+m[2]/PK_M;return base<0?base-add:base+add}
  const v=parseFloat(str);
  return isFinite(v)?v:0;
}

const LIMIT={id:60,name:300,note:1000,dep:200,ref:300,type:100};
const cap=(v,n)=>String(v==null?'':v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,n);
function newWork(id,name,section,pkFrom,pkTo,planStart,planEnd,progress,status,source,dep,note){
  return{id:cap(id,LIMIT.id),name:cap(name,LIMIT.name),section:cap(section,LIMIT.id),
    pkFrom:pkParse(pkFrom),pkTo:pkParse(pkTo),planStart,planEnd,
    progress:clamp(+progress||0,0,100),status:status||'plan',source:source||'manual',
    dep:cap(dep,LIMIT.dep),note:cap(note,LIMIT.note),history:[]};
}
const depIds=w=>String(w&&w.dep||'').split(/[,;\s]+/).filter(Boolean);
/* плановая длительность, не меньше суток; перевёрнутые даты не ломают расчёт */
const duration=w=>{const a=ts(w.planStart),b=ts(w.planEnd);
  return (isNaN(a)||isNaN(b))?DAY:Math.max(DAY,b-a)};
const planEndTs=w=>{const a=ts(w.planStart),b=ts(w.planEnd);
  if(!isNaN(b))return isNaN(a)?b:Math.max(b,a);   /* окончание не раньше начала */
  return isNaN(a)?today()+DAY:a+DAY;};            /* дат нет — считаем от сегодня */
const planStartTs=w=>{const a=ts(w.planStart);return isNaN(a)?planEndTs(w)-duration(w):a};
/* дата первой записи о факте — когда работа реально пошла */
function firstFactTs(w){
  const h=(w.history||[]).map(r=>ts(r.d)).filter(x=>!isNaN(x));
  return h.length?Math.min.apply(null,h):NaN;
}
/* фактическая дата закрытия: первая запись истории со 100% */
function doneTs(w){
  const t=(w.history||[]).filter(r=>r&&+r.p>=100).map(r=>ts(r.d)).filter(x=>!isNaN(x));
  return t.length?Math.min.apply(null,t):NaN;
}

/* порядок обхода с учётом зависимостей; циклы разрываются и возвращаются отдельно */
function orderWorks(works){
  const byId=new Map(works.map(w=>[w.id,w]));
  const mark=new Map(),out=[],cycles=new Set();
  const visit=w=>{
    const s=mark.get(w.id);
    if(s==='done')return;
    if(s==='open'){cycles.add(w.id);return}
    mark.set(w.id,'open');
    for(const id of depIds(w)){const p=byId.get(id);if(p&&p.id!==w.id)visit(p)}
    mark.set(w.id,'done');out.push(w);
  };
  works.forEach(visit);
  return{order:out,cycles:[...cycles]};
}

/* прогноз по всему графику: план + факт + сдвиг от предшественников */
function schedule(works,now){
  now=now==null?today():now;
  const {order,cycles}=orderWorks(works);
  const byId=new Map(works.map(w=>[w.id,w]));
  const res={};
  for(const w of order){
    const a=planStartTs(w),b=planEndTs(w),dur=duration(w);
    let depEnd=0,blockers=[];
    for(const id of depIds(w)){
      const p=byId.get(id),r=res[id];
      if(!p)continue;
      if(r)depEnd=Math.max(depEnd,r.end);
      if(p.status!=='done'&&p.progress<100)blockers.push(id);
    }
    const done=w.status==='done'||w.progress>=100;
    let start,end,capped=false;
    if(done){
      const d=doneTs(w);
      end=!isNaN(d)?d:Math.min(b,Math.max(a,now));
      start=Math.min(a,end);
    }else if(w.progress>0){
      /* работа идёт: темп меряем от реального начала (план или первая запись факта),
         а не от даты, на которую её сдвинул предшественник */
      const f=firstFactTs(w);
      const base=Math.min(a,isNaN(f)?a:f);
      const limit=POSTPONE*dur;
      if(now>base){
        const rate=w.progress/(now-base);               /* процентов за миллисекунду */
        const remaining=(100-w.progress)/rate;
        capped=remaining>limit;
        end=now+Math.min(remaining,limit);
      }else end=Math.max(a,depEnd)+dur;
      start=Math.min(base,Math.max(a,depEnd));
      /* закончиться раньше своего предшественника работа всё равно не может */
      end=Math.max(end,depEnd,now);
    }else{
      /* не начата: раньше сегодняшнего дня и раньше предшественника не стартует */
      start=Math.max(a,depEnd,now);
      end=Math.max(start+dur,now);
    }
    if(isNaN(start))start=now;
    if(isNaN(end))end=Math.max(now,isNaN(b)?now:b);
    res[w.id]={start,end,shiftDays:Math.max(0,days(end-b)),capped,blockers,
               startDate:iso(start),endDate:iso(end)};
  }
  /* работы из циклов могли не попасть в обход — считаем их по плану */
  for(const w of works)if(!res[w.id]){
    const b=planEndTs(w);
    res[w.id]={start:planStartTs(w),end:b,shiftDays:0,capped:false,blockers:depIds(w),
               startDate:iso(planStartTs(w)),endDate:iso(b),cycle:true};
  }
  return{forecast:res,cycles};
}

/* оценка одной работы; sch — результат schedule() для того же now */
function assess(w,opts){
  opts=opts||{};
  const now=opts.now==null?today():opts.now;
  const sch=opts.schedule||schedule(opts.works||[w],now);
  const f=sch.forecast[w.id]||{end:planEndTs(w),shiftDays:0,blockers:[],capped:false};
  const a=planStartTs(w),b=planEndTs(w);
  const done=w.status==='done'||w.progress>=100;
  const expected=done?100:(now<=a?0:now>=b?100:Math.round((now-a)/(b-a)*100));
  const deviation=done?0:Math.max(0,expected-w.progress);
  const overdue=!done&&now>b;
  const delayDays=done?0:Math.max(f.shiftDays,overdue?days(now-b):0);
  let level='ok';
  if(!done){
    if(overdue||deviation>=25)level='bad';
    else if(deviation>=10||delayDays>=7)level='warn';
  }
  const evidence=opts.evidence||[];
  return{expected,deviation,overdue,delayDays,level,done,
    forecastEnd:f.end,forecastDate:iso(f.end),capped:!!f.capped,
    blockers:f.blockers||[],cycle:!!f.cycle,
    startedEarly:(f.blockers||[]).length>0&&w.progress>0,
    noProof:w.progress>0&&!evidence.some(e=>e.work===w.id)};
}

/* сводка по проекту */
function summary(state,now){
  const works=state.works||[],ev=state.evidence||[];
  const sch=schedule(works,now);
  const rows=works.map(w=>({work:w,a:assess(w,{now,works,evidence:ev,schedule:sch})}));
  const avg=works.length?Math.round(rows.reduce((s,r)=>s+r.work.progress,0)/works.length):0;
  return{schedule:sch,rows,
    progress:avg,
    done:rows.filter(r=>r.a.done).length,
    deviations:rows.filter(r=>r.a.level==='bad').length,
    risks:rows.filter(r=>r.a.level==='warn').length,
    noProof:rows.filter(r=>r.a.noProof).length,
    cascade:rows.filter(r=>r.a.blockers.length&&r.a.delayDays>0),
    sections:(state.sections||[]).map(s=>{
      const ws=works.filter(w=>w.section===s.id);
      return{...s,works:ws.length,
        progress:ws.length?Math.round(ws.reduce((x,w)=>x+w.progress,0)/ws.length):0}})};
}

/* изменение факта: статус и история идут следом автоматически */
function setProgress(w,value,date){
  const v=clamp(Math.round(+value||0),0,100);
  if(v===w.progress)return false;
  w.history=w.history||[];
  w.history.push({d:date||iso(today()),p:v});
  w.progress=v;
  if(v>=100)w.status='done';
  else if(w.status==='done')w.status='work';
  else if(v>0&&w.status==='plan')w.status='work';
  return true;
}

/* ---- импорт графика из таблицы ---- */
const pick=(row,keys,avoid)=>{
  for(const k of Object.keys(row)){
    const kk=k.toLowerCase().trim();
    if(avoid&&avoid.some(x=>kk.includes(x)))continue;
    if(keys.some(x=>kk.includes(x)))return row[k];
  }
  return'';
};
const NOT_DATE=['пикет','пк ',' пк','участ'];
const toNum=v=>{const s=String(v==null?'':v).replace(/[^\d.,-]/g,'').replace(',','.');
  return s===''?0:(parseFloat(s)||0)};
function toDate(v){
  if(v instanceof Date&&!isNaN(v))return iso(Date.UTC(v.getFullYear(),v.getMonth(),v.getDate()));
  const s=String(v==null?'':v).trim();let m;
  if((m=s.match(/^(\d{4})-(\d{2})-(\d{2})/)))return m[1]+'-'+m[2]+'-'+m[3];
  if((m=s.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/))){
    const y=m[3].length===2?'20'+m[3]:m[3];
    return y+'-'+String(m[2]).padStart(2,'0')+'-'+String(m[1]).padStart(2,'0');
  }
  return'';
}
const toStatus=v=>{const s=String(v||'').toLowerCase();
  return s.includes('выпол')||s.includes('готов')||s.includes('законч')?'done'
    :s.includes('работ')||s.includes('ход')?'work'
    :s.includes('блок')||s.includes('приостан')?'block':'plan'};

function importRows(rows,state,mode,defaultDate){
  state.works=state.works||[];state.sections=state.sections||[];state.evidence=state.evidence||[];
  if(mode==='replace'){state.works=[];state.evidence=[];state.sections=[]}
  const today0=defaultDate||iso(today());
  let added=0,skipped=0;
  let nid=state.works.reduce((m,w)=>Math.max(m,parseInt(String(w.id).replace(/\D/g,''),10)||0),0);
  for(const row of rows||[]){
    const name=String(pick(row,['работ','наимен'])).trim();
    if(!name){skipped++;continue}
    /* в выгрузках пикет пишут и числом, и как «ПК 125+50» — принимаем оба вида */
    const pkFrom=pkParse(pick(row,['пк от','пикет нач','пк с','от пк'])),
          pkTo=pkParse(pick(row,['пк до','пикет кон','пк по','до пк']));
    const secName=String(pick(row,['участ'])).trim()||'Участок 1';
    let sec=state.sections.find(s=>s.name===secName||s.id===secName);
    if(!sec){
      sec={id:'S'+(state.sections.length+1),name:secName,from:pkFrom,to:pkTo||pkFrom+100};
      state.sections.push(sec);
    }else{sec.from=Math.min(sec.from,pkFrom);sec.to=Math.max(sec.to,pkTo)}
    let planStart=toDate(pick(row,['план с','план начал','дата начал','начал','старт'],NOT_DATE)),
        planEnd=toDate(pick(row,['план по','дата оконч','оконч','конец','финиш'],NOT_DATE));
    if(!planStart)planStart=planEnd||today0;
    if(!planEnd)planEnd=planStart;
    if(ts(planEnd)<ts(planStart)){const t=planStart;planStart=planEnd;planEnd=t}  /* перевёрнутые даты */
    let id=String(pick(row,['id','№','код'])).trim();
    if(!id||state.works.some(w=>w.id===id))id='W'+(++nid);
    else nid=Math.max(nid,parseInt(id.replace(/\D/g,''),10)||0);
    const progress=clamp(toNum(pick(row,['факт','%','готов'])),0,100);
    let status=toStatus(pick(row,['статус']));
    if(progress>=100)status='done';else if(status==='done')status='work';
    state.works.push(newWork(id,name,sec.id,pkFrom,pkTo,planStart,planEnd,progress,status,'excel',
      String(pick(row,['после','предш','зависит'])).trim(),String(pick(row,['примеч'])).trim()));
    added++;
  }
  return{added,skipped};
}

/* ---------- продольный профиль ----------
   Отметка земли и проектная отметка на пикете. Рабочая отметка — разница между ними:
   плюс это насыпь, минус выемка. Уклон считаем по проектной линии в тысячных (‰),
   как и принято на профиле. Ничего не достраиваем: что в ведомости, то и показываем. */
function profileRows(rows){
  const out=[],seen=new Set();
  for(const r of rows||[]){
    if(!r)continue;
    const pk=pkParse(r.pk!=null?r.pk:pick(r,['пикет','пк']));
    /* пустая клетка — это «нет отметки», а не ноль: иначе профиль провалится в землю */
    const num=v=>{const s=String(v==null?'':v).trim();
      if(!s||!/\d/.test(s))return null;
      const n=toNum(s);return isFinite(n)?n:null};
    const g=num(r.ground!=null?r.ground:pick(r,['отметка земли','земля','существ','чёрная','черная']));
    const d=num(r.design!=null?r.design:pick(r,['проектная','проект','красная','бровк']));
    if(!isFinite(pk))continue;
    if(g==null&&d==null)continue;
    if(seen.has(pk))continue;
    seen.add(pk);
    out.push({pk,ground:g,design:d,
      note:cap(r.note!=null?r.note:pick(r,['примеч']),LIMIT.note)});
  }
  out.sort((a,b)=>a.pk-b.pk);
  return out;
}
/* рабочая отметка: насыпь (+) или выемка (−) */
const working=r=>(r&&r.ground!=null&&r.design!=null)?Math.round((r.design-r.ground)*100)/100:null;
/* уклон проектной линии между двумя точками, в тысячных */
function slope(a,b){
  if(!a||!b||a.design==null||b.design==null)return null;
  const L=(b.pk-a.pk)*PK_M;
  if(!L)return null;
  return Math.round((b.design-a.design)/L*1000*10)/10;
}
/* сводка по профилю: диапазон отметок, насыпи и выемки, самый крутой уклон */
function profileSummary(rows){
  const p=(rows||[]).filter(r=>r&&isFinite(r.pk));
  if(!p.length)return{points:0};
  const vals=p.flatMap(r=>[r.ground,r.design]).filter(v=>v!=null&&isFinite(v));
  let fill=0,cutN=0,steep=null;
  for(let i=0;i<p.length;i++){
    const w=working(p[i]);
    if(w!=null){if(w>0.05)fill++;else if(w<-0.05)cutN++}
    if(i){const s=slope(p[i-1],p[i]);
      if(s!=null&&(steep==null||Math.abs(s)>Math.abs(steep.i)))steep={i:s,from:p[i-1].pk,to:p[i].pk}}
  }
  return{points:p.length,from:p[0].pk,to:p[p.length-1].pk,
    min:vals.length?Math.min.apply(null,vals):null,max:vals.length?Math.max.apply(null,vals):null,
    fill,cut:cutN,steep};
}

/* ---------- виды работ (слои стройки) ----------
   В чате проекта это был главный вопрос: как привязать пикетаж к КСГ так, чтобы с одного взгляда
   было видно, где какие работы и где отставание. Цветом показываем СОСТОЯНИЕ (четыре цвета),
   а вид работ разносим по строкам-слоям — иначе на двух десятках видов работ получается
   «тысяча цветов», в которой ничего не разобрать.
   Слои идут снизу вверх в порядке строительства пути. */
const KINDS=[
  {id:'zem', name:'Земляное полотно',  hint:'насыпь, выемка, водоотвод',
   re:/земл|полотн|насып|выемк|грунт|водоотв|планиров|уступ|срезк|корчев|рекульт|откос/i},
  {id:'isso',name:'Искусственные сооружения', hint:'трубы, мосты, путепроводы',
   re:/труб|мост|путепров|водопроп|исскуств|искусств|иссо|эстакад/i},
  {id:'vsp', name:'Верхнее строение пути', hint:'балласт, РШР, стрелочные переводы',
   re:/балласт|щебен|щебён|рельсошпал|ршр|укладк|путь|пути|стрелочн|выправк|подбивк/i},
  {id:'scb', name:'СЦБ и связь', hint:'светофоры, кабель, автоблокировка',
   re:/сцб|связ|кабел|светофор|автоблок|пост эц|эц\b/i},
  {id:'el',  name:'Электрификация', hint:'контактная сеть, тяговые подстанции',
   re:/электриф|контактн|тягов|опоры кс|эчк|энерг/i},
  {id:'etc', name:'Прочие работы', hint:'всё, что не отнесено к основным этапам', re:null},
];
/* вид работы определяем по её названию: отдельного поля в графике заказчика нет */
function workKind(w){
  const s=String((w&&w.name)||'');
  for(const k of KINDS)if(k.re&&k.re.test(s))return k.id;
  return 'etc';
}
const kindName=id=>(KINDS.find(k=>k.id===id)||{}).name||id;

/* ---------- кривые освоения (S-кривая) ----------
   Три линии на одном поле: сколько должно быть сделано по плану, сколько сделано на самом деле
   и куда всё идёт, если темп не изменится. Это главный график строительного графика:
   по расхождению плана и факта видно отставание раньше, чем сорвётся срок. */
const expectedAt=(w,t)=>{
  const a=planStartTs(w),b=planEndTs(w);
  if(isNaN(a)||isNaN(b)||t<=a)return 0;
  if(t>=b)return 100;
  return (t-a)/(b-a)*100;
};
/* По работе — точки, в которых известен факт.
   Если хронология есть, берём её: это настоящие записи.
   Если работу завели сразу с процентом (загрузили из Excel) и записей нет, восстанавливаем ход
   по её же плану, но не выше достигнутого процента: «шла по плану, пока не остановилась».
   Ничего сверх известного такая линия не показывает и выше факта не поднимается. */
function factPoints(w,history){
  const out=[];
  for(const h of history||[]){
    if(h.work!==w.id)continue;
    const d=ts(String(h.at||'').slice(0,10));
    if(!isNaN(d))out.push({t:d,p:clamp(+h.progress||0,0,100)});
  }
  const p=clamp(+w.progress||0,0,100);
  const u=ts(String(w.updatedAt||'').slice(0,10));
  if(!out.length&&p>0){
    const a=planStartTs(w),b=planEndTs(w);
    if(!isNaN(a)&&!isNaN(b)&&b>a){
      const n=16;
      for(let i=0;i<=n;i++){
        const t=Math.round(a+(b-a)*i/n);
        out.push({t,p:Math.min(expectedAt(w,t),p),guess:true});
      }
    }
  }
  if(!isNaN(u))out.push({t:u,p});
  out.sort((a,b)=>a.t-b.t||a.p-b.p);
  return out;
}
/* сколько работ в кривой восстановлено по плану, а не по записям */
const guessed=(works,history)=>(works||[]).filter(w=>
  +w.progress>0&&!(history||[]).some(h=>h.work===w.id)).length;
const valueAt=(pts,t)=>{let v=0;for(const x of pts){if(x.t>t)break;v=x.p}return v};

function curves(state,opts){
  const o=opts||{};
  const works=(state.works||[]).filter(w=>!isNaN(planStartTs(w))&&!isNaN(planEndTs(w)));
  const now=o.now||today();
  const n=Math.max(8,Math.min(200,o.points||60));
  if(!works.length)return{t0:now,t1:now,now,points:n,plan:[],fact:[],forecast:[],
    planNow:0,factNow:0,endPlan:now,endForecast:now};
  const sch=o.schedule||schedule(works,now);
  const hist=o.history||[];
  const pts=new Map(works.map(w=>[w.id,factPoints(w,hist)]));
  const ends=works.map(w=>(sch.forecast[w.id]||{}).end||planEndTs(w));
  const firstFact=works.flatMap(w=>pts.get(w.id).map(x=>x.t));
  const t0=Math.min.apply(null,works.map(planStartTs).concat(firstFact.length?[Math.min.apply(null,firstFact)]:[],[now]));
  const endPlan=Math.max.apply(null,works.map(planEndTs));
  const endForecast=Math.max.apply(null,ends.concat([endPlan]));
  const t1=Math.max(endForecast,now);
  const span=(t1-t0)||1;
  const avg=f=>works.reduce((s,w)=>s+f(w),0)/works.length;
  /* прогноз работы: от сегодняшнего факта до ста процентов к расчётной дате окончания */
  const forecastAt=(w,t)=>{
    const p=clamp(+w.progress||0,0,100);
    if(p>=100)return 100;
    const end=(sch.forecast[w.id]||{}).end||planEndTs(w);
    if(!(end>now))return 100;
    if(t<=now)return p;
    if(t>=end)return 100;
    return p+(100-p)*(t-now)/(end-now);
  };
  const plan=[],fact=[],forecast=[];
  for(let i=0;i<=n;i++){
    const t=Math.round(t0+span*i/n);
    plan.push({t,v:Math.round(avg(w=>expectedAt(w,t))*10)/10});
    if(t<=now)fact.push({t,v:Math.round(avg(w=>valueAt(pts.get(w.id),t))*10)/10});
    if(t>=now)forecast.push({t,v:Math.round(avg(w=>forecastAt(w,t))*10)/10});
  }
  /* точка «сегодня» всегда присутствует на обеих линиях, иначе они не стыкуются */
  const factNow=Math.round(avg(w=>valueAt(pts.get(w.id),now))*10)/10;
  const planNow=Math.round(avg(w=>expectedAt(w,now))*10)/10;
  if(!fact.length||fact[fact.length-1].t!==now)fact.push({t:now,v:factNow});
  if(!forecast.length||forecast[0].t!==now)forecast.unshift({t:now,v:factNow});
  else forecast[0]={t:now,v:factNow};
  return{t0,t1,now,points:n,plan,fact,forecast,planNow,factNow,endPlan,endForecast,
    guessed:guessed(works,hist),works:works.length};
}

/* приведение внешних данных к рабочему виду: сервер и восстановление из JSON */
function normalize(state){
  const s={sections:[],works:[],evidence:[],...(state||{})};
  s.sections=(s.sections||[]).filter(x=>x&&x.id).map(x=>({id:cap(x.id,LIMIT.id),
    name:cap(x.name||x.id,LIMIT.name),from:+x.from||0,to:+x.to||0}));
  const seen=new Set();
  s.works=(s.works||[]).filter(x=>x&&x.id).filter(x=>{
    if(seen.has(x.id))return false;seen.add(x.id);return true;
  }).map(x=>{
    const w=newWork(x.id,x.name,x.section,x.pkFrom,x.pkTo,x.planStart,x.planEnd,x.progress,x.status,x.source,x.dep,x.note);
    w.history=Array.isArray(x.history)?x.history.filter(h=>h&&h.d):[];
    if(x.updatedAt)w.updatedAt=x.updatedAt;
    if(x.planReason)w.planReason=cap(x.planReason,300);
    if(x.updatedBy)w.updatedBy=x.updatedBy;
    if(w.progress>=100)w.status='done';
    if(!s.sections.some(sec=>sec.id===w.section))w.section=(s.sections[0]||{}).id||w.section;
    return w;
  });
  const ids=new Set(s.works.map(w=>w.id));
  s.works.forEach(w=>{w.dep=depIds(w).filter(d=>ids.has(d)&&d!==w.id).join(', ')});
  s.evidence=(s.evidence||[]).filter(e=>e&&e.id&&ids.has(e.work)).map(e=>{
    const o={id:cap(e.id,LIMIT.id),work:e.work,type:cap(e.type,LIMIT.type),ref:cap(e.ref,LIMIT.ref),
      date:cap(e.date,20),note:cap(e.note,LIMIT.note)};
    if(e.fileId){o.fileId=cap(e.fileId,120);o.fileName=cap(e.fileName,LIMIT.name);
      o.fileSize=+e.fileSize||0;o.fileMime=cap(e.fileMime,100);o.fileSha=cap(e.fileSha,64);
      o.fileTaken=cap(e.fileTaken,20);o.fileDevice=cap(e.fileDevice,120);o.fileBy=cap(e.fileBy,60);
      if(e.fileArchived){o.fileArchived=cap(e.fileArchived,20);o.fileArchiveRef=cap(e.fileArchiveRef,200)}}
    return o;
  });
  return s;
}

return{DAY,POSTPONE,STATUS,SRC,LIMIT,PK_M,pkFmt,pkLabel,pkRange,pkParse,
  expectedAt,factPoints,guessed,curves,KINDS,workKind,kindName,
  profileRows,working,slope,profileSummary,
  cap,ts,iso,today,days,clamp,newWork,depIds,duration,firstFactTs,
  planStartTs,planEndTs,orderWorks,schedule,assess,summary,setProgress,
  importRows,normalize,toDate,toNum,toStatus,pick};
});
