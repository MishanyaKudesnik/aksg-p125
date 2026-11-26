/* Разбор настоящего «Графика производства работ» заказчика.
   На вход — лист как массив строк (XLSX.utils.sheet_to_json(ws,{header:1})).
   Понимает: шапку согласования, строку заголовков, разделы, недельную сетку по месяцам,
   клетки вида «200/400» (факт/план) и запятую как десятичный разделитель. */
(function(root,factory){
  if(typeof module!=='undefined'&&module.exports)module.exports=factory();
  else root.AKSGImport=factory();
})(typeof self!=='undefined'?self:this,function(){
'use strict';

const MONTH={январ:1,феврал:2,март:3,апрел:4,май:5,мая:5,июн:6,июл:7,август:8,сентябр:9,
             октябр:10,ноябр:11,декабр:12};
const txt=v=>v==null?'':String(v).replace(/\s+/g,' ').trim();
const low=v=>txt(v).toLowerCase();
const pad=n=>String(n).padStart(2,'0');
const iso=(y,m,d)=>y+'-'+pad(m)+'-'+pad(d);
const lastDay=(y,m)=>new Date(Date.UTC(y,m,0)).getUTCDate();

/* «200/400» → факт 200, план 400; «1,2/2» → 1.2 и 2; просто «4» → факт 4 */
function cell(v){
  if(v==null||v==='')return null;
  if(typeof v==='number')return{fact:v,plan:null,raw:v};
  const s=txt(v).replace(',','.');
  const m=s.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
  if(m)return{fact:parseFloat(m[1]),plan:parseFloat(m[2]),raw:s};
  const one=s.match(/^-?\d+(?:\.\d+)?$/);
  if(one)return{fact:parseFloat(s),plan:null,raw:s};
  return{fact:null,plan:null,raw:s,text:true};
}
const num=v=>{
  if(v==null||v==='')return null;
  if(typeof v==='number')return v;
  const s=txt(v).replace(',','.').replace(/[^\d.-]/g,'');
  const n=parseFloat(s);return isFinite(n)?n:null;
};
/* «ПК 125+50» и диапазоны «ПК 10+00 – ПК 25+50» внутри названия работы */
function pickets(name){
  const out=[];const re=/ПК\s*(\d+)(?:\s*\+\s*(\d+))?/gi;let m;
  while((m=re.exec(name)))out.push(+m[1]+(m[2]?+m[2]/100:0));
  if(!out.length)return null;
  return{from:Math.min.apply(null,out),to:Math.max.apply(null,out)};
}

function parseSchedule(rows,opts){
  opts=opts||{};
  const warn=[],R=rows||[];
  const width=R.reduce((m,r)=>Math.max(m,(r||[]).length),0);

  /* 1. строка заголовков */
  let head=-1;
  for(let i=0;i<Math.min(R.length,40);i++){
    const line=(R[i]||[]).map(low);
    if(line.some(v=>v.includes('наимен'))&&line.some(v=>/ед\.?\s*изм|объ[еёe]м|стоим/.test(v))){head=i;break}
  }
  if(head<0)return{ok:false,error:'Не нашёл строку заголовков — нужна колонка «Наименование работ»',warnings:warn};

  const H=(R[head]||[]).map(low);
  const find=re=>{for(let c=0;c<width;c++)if(H[c]&&re.test(H[c]))return c;return -1};
  const col={
    name:find(/наимен/),unit:find(/ед\.?\s*изм/),volume:find(/проектн.*об|^об[ьъ][еёe]м/),
    cost:find(/стоим/),factPrev:find(/выполнено в/),planYear:find(/план на \d{4}/),
    factNow:find(/выполнено по состоянию|выполнено на/),extra:find(/дополнительн/)
  };
  if(col.name<0)return{ok:false,error:'Не нашёл колонку с наименованием работ',warnings:warn};

  /* 2. год графика */
  let year=null;
  for(let i=0;i<=head;i++)for(const v of (R[i]||[])){
    const m=txt(v).match(/20\d\d/);if(m)year=+m[0];
  }
  year=opts.year||year||new Date().getUTCFullYear();

  /* 3. месяцы и недели: месяц объявлен один раз и тянется вправо до следующего */
  const monthOf=[];let cur=null;
  for(let c=0;c<width;c++){
    const t=low(R[head][c]);
    const hit=Object.keys(MONTH).find(k=>t.startsWith(k));
    if(hit)cur=MONTH[hit];
    monthOf[c]=c>=Math.max(col.name,col.volume,col.factNow,col.extra)?cur:null;
  }
  let weekRow=-1;
  for(let i=head+1;i<Math.min(head+5,R.length);i++){
    let hits=0;
    for(let c=0;c<width;c++){
      const v=R[i]&&R[i][c];
      if(monthOf[c]&&typeof v==='number'&&v>=1&&v<=6)hits++;
    }
    if(hits>=4){weekRow=i;break}
  }
  const span={};                      /* колонка → {начало, конец} недели */
  let weeks=0;
  if(weekRow>=0){
    for(let c=0;c<width;c++){
      const m=monthOf[c],w=R[weekRow][c];
      if(!m||typeof w!=='number')continue;
      const d1=1+(w-1)*7,d2=Math.min(d1+6,lastDay(year,m));
      if(d1>lastDay(year,m))continue;
      span[c]={from:iso(year,m,d1),to:iso(year,m,d2)};weeks++;
    }
  }
  if(!weeks)warn.push('Недельная сетка не распознана — сроки работ придётся проставить вручную');

  /* 4. строки */
  const sections=[],works=[];
  let sec=null,group='';
  const addSection=name=>{
    const id='S'+(sections.length+1);
    sec={id,name:name.replace(/^\s*раздел\s*\d*\.?\s*/i,'').trim()||name,from:0,to:0};
    sections.push(sec);return sec;
  };
  for(let i=(weekRow>=0?weekRow:head)+1;i<R.length;i++){
    const row=R[i]||[];
    const name=txt(row[col.name])||txt(row[0]);
    if(!name)continue;
    const filled=row.filter(v=>v!=null&&v!=='').length;

    if(/^\s*раздел\b/i.test(name)||(filled<=1&&name.length>8&&!/^\d+$/.test(name))){
      addSection(name);group='';continue;
    }
    const volume=num(row[col.volume]),cost=num(row[col.cost]);
    const factNow=num(row[col.factNow]),factPrev=num(row[col.factPrev]);
    const unit=txt(row[col.unit]);
    /* строка-подзаголовок: есть только стоимость, ни объёма, ни единиц */
    if(!unit&&volume==null&&cost!=null){group=name;continue}
    if(!sec)addSection('Объект');

    let from=null,to=null,hasPlan=false;
    for(const c in span){
      const v=cell(row[c]);
      if(!v||(v.fact==null&&v.plan==null))continue;
      hasPlan=true;
      if(!from||span[c].from<from)from=span[c].from;
      if(!to||span[c].to>to)to=span[c].to;
    }
    const fact=factNow!=null?factNow:factPrev;
    let progress=0;
    if(volume&&volume>0&&fact!=null){
      progress=Math.round(fact/volume*100);
      if(progress>100){warn.push(`«${name}»: выполнено ${fact} при проектном объёме ${volume} — засчитано как 100 %`);progress=100}
      if(progress<0)progress=0;
    }
    const pk=pickets(name);
    const note=[group,unit&&volume!=null?`${volume} ${unit}`:'',fact!=null?`факт ${fact}`:'',
                txt(row[col.extra])&&`доп. объём: ${txt(row[col.extra])}`].filter(Boolean).join(' · ');
    if(!hasPlan)warn.push(`«${name}»: в графике нет недель — срок не определён`);
    works.push({
      id:'W'+(works.length+1),name,section:sec.id,
      pkFrom:pk?pk.from:0,pkTo:pk?pk.to:0,
      planStart:from||'',planEnd:to||'',
      progress,status:progress>=100?'done':progress>0?'work':'plan',
      source:'excel',dep:'',note:note.slice(0,300),
      unit,volume,fact,cost
    });
  }
  /* пикеты участка — по его работам */
  for(const s of sections){
    const ws=works.filter(w=>w.section===s.id);
    s.from=ws.length?Math.min.apply(null,ws.map(w=>w.pkFrom)):0;
    s.to=ws.length?Math.max.apply(null,ws.map(w=>w.pkTo)):0;
  }
  const dated=works.filter(w=>w.planStart&&w.planEnd);
  return{ok:true,year,sections:sections.filter(s=>works.some(w=>w.section===s.id)),works,
    warnings:warn,
    meta:{headerRow:head+1,weekRow:weekRow>=0?weekRow+1:null,weeks,
      period:dated.length?{from:dated.map(w=>w.planStart).sort()[0],
                           to:dated.map(w=>w.planEnd).sort().slice(-1)[0]}:null,
      dated:dated.length,columns:col}};
}
return{parseSchedule,cell,num,pickets,MONTH};
});
