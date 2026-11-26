/* Разбор настоящего графика заказчика. Файл-образец: fixtures/grafik-zakazchika.xlsx */
const {test}=require('node:test');
const assert=require('node:assert');
const fs=require('node:fs'),path=require('node:path');
const XLSX=require('./public/xlsx.full.min.js');
const P=require('./public/import-schedule.js');

const grid=(()=>{
  const buf=fs.readFileSync(path.join(__dirname,'fixtures','grafik-zakazchika.xlsx'));
  const wb=XLSX.read(buf,{type:'buffer'});
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true,blankrows:true});
})();
const parsed=P.parseSchedule(grid);
const byName=n=>parsed.works.find(w=>w.name.startsWith(n));

test('клетка «факт/план» и запятая как разделитель',()=>{
  assert.deepEqual(P.cell('200/400'),{fact:200,plan:400,raw:'200/400'});
  assert.deepEqual(P.cell('1,2/2'),{fact:1.2,plan:2,raw:'1.2/2'});
  assert.equal(P.cell(4).fact,4);
  assert.equal(P.cell('0,6').fact,0.6);
  assert.equal(P.cell(''),null);
});

test('пикетаж вытаскивается из названия работы',()=>{
  assert.deepEqual(P.pickets('Монтаж трубопровода ПК 125+50'),{from:125.5,to:125.5});
  assert.deepEqual(P.pickets('Путь от ПК 10+00 до ПК 25+50'),{from:10,to:25.5});
  assert.equal(P.pickets('Балластировка пути'),null);
});

test('шапка согласования не мешает: заголовки и год найдены',()=>{
  assert.ok(parsed.ok,parsed.error||'');
  assert.equal(parsed.year,2023);
  assert.ok(parsed.meta.headerRow>=9,'строка заголовков найдена ниже шапки');
  assert.ok(parsed.meta.weeks>=20,'недельная сетка распознана, недель: '+parsed.meta.weeks);
});

test('разделы графика становятся участками',()=>{
  assert.equal(parsed.sections.length,6);
  assert.ok(parsed.sections[0].name.startsWith('Верхнее строение'));
  assert.ok(parsed.sections.some(s=>s.name.includes('энергетического хозяйства')));
  assert.ok(parsed.works.every(w=>parsed.sections.some(s=>s.id===w.section)),'каждая работа в разделе');
});

test('работы, сроки из недельной сетки и процент из объёмов',()=>{
  assert.equal(parsed.works.length,34);
  assert.ok(parsed.meta.dated>=30,'со сроками: '+parsed.meta.dated);
  assert.equal(parsed.meta.period.from,'2023-01-08');
  assert.equal(parsed.meta.period.to,'2023-06-30');
  const grunt=byName('Разработка грунта');
  assert.equal(grunt.planStart,'2023-03-01','первая неделя с данными — март');
  assert.equal(grunt.planEnd,'2023-06-14');
  assert.equal(grunt.progress,28,'1240 из 4459.43');
  assert.equal(grunt.status,'work');
  const svetofor=byName('Установка светофоров');
  assert.equal(svetofor.progress,100);
  assert.equal(svetofor.status,'done');
});

test('единицы, объём и факт попадают в примечание работы',()=>{
  const kabel=byName('Прокладка кабелей СЦБ');
  assert.match(kabel.note,/54\.54 км/);
  assert.match(kabel.note,/факт 28/);
  assert.match(kabel.note,/Устройства СЦБ/,'подзаголовок сохранён');
});

test('нестыковки заказчика попадают в предупреждения, а не в тихую ошибку',()=>{
  assert.ok(parsed.warnings.length,'предупреждения есть');
  assert.ok(parsed.warnings.some(w=>w.includes('Монтаж муфт')&&w.includes('100')),
    'выполнено больше проектного объёма — отмечено');
  assert.ok(parsed.warnings.some(w=>w.includes('нет недель')),'работы без сроков отмечены');
  assert.equal(byName('Монтаж муфт').progress,100,'процент всё равно в пределах нормы');
});

test('пустой и посторонний лист не притворяются графиком',()=>{
  assert.equal(P.parseSchedule([]).ok,false);
  assert.equal(P.parseSchedule([['привет','мир'],[1,2]]).ok,false);
  assert.match(P.parseSchedule([['что-то']]).error,/Наименование/);
});

/* ---------- пикетаж в привычной записи «ПК 125+50» ---------- */
const E=require('./public/engine.js');

test('пикет показывается так, как его пишут путейцы', ()=>{
  assert.equal(E.pkLabel(125.5),'ПК 125+50');
  assert.equal(E.pkFmt(0),'0+00');
  assert.equal(E.pkFmt(120),'120+00');
  assert.equal(E.pkFmt(7.07),'7+07');          /* метры всегда двумя знаками */
  assert.equal(E.pkRange(10,25.5),'ПК 10+00 – ПК 25+50');
  assert.equal(E.pkRange(120,120),'ПК 120+00'); /* точка, а не пустой диапазон */
});

test('пикет принимается и записью, и числом', ()=>{
  assert.equal(E.pkParse('125+50'),125.5);
  assert.equal(E.pkParse('ПК 125 + 50'),125.5);
  assert.equal(E.pkParse('125,5'),125.5);
  assert.equal(E.pkParse('260'),260);
  assert.equal(E.pkParse(42),42);
  assert.equal(E.pkParse(''),0);
  assert.equal(E.pkParse('ерунда'),0);
});

test('запись и разбор не теряют значение по кругу', ()=>{
  for(const v of [0,1,7.07,99.99,125.5,260,1000.25])
    assert.equal(E.pkParse(E.pkFmt(v)),Math.round(v*100)/100,'ПК '+v);
});

test('работа хранит пикет числом, откуда бы он ни пришёл', ()=>{
  const w=E.newWork('W9','Проба','S1','ПК 125+50','130+00','2026-01-01','2026-02-01',0,'plan');
  assert.equal(w.pkFrom,125.5);
  assert.equal(w.pkTo,130);
});

test('в выгрузке Excel пикет читается обратно', ()=>{
  const st={sections:[],works:[]};
  E.importRows([{'Работа':'Срезка','Участок':'У1','ПК от':'ПК 125+50','ПК до':'ПК 130+00',
    'План с':'01.03.2027','План по':'10.03.2027','Факт %':0}],st);
  assert.equal(st.works[0].pkFrom,125.5);
  assert.equal(st.works[0].pkTo,130);
});

/* ---------- кривые освоения: план, факт, прогноз ---------- */
const mk=(id,a,b,p,dep)=>{const w=E.newWork(id,'Работа '+id,'S1',0,10,a,b,p,p>=100?'done':p?'work':'plan','manual',dep||'');return w};

test('план идёт от нуля до ста между плановыми датами', ()=>{
  const w=mk('W1','2026-01-01','2026-03-01',0);
  assert.equal(E.expectedAt(w,E.ts('2025-12-01')),0,'до начала — ноль');
  assert.equal(Math.round(E.expectedAt(w,E.ts('2026-02-01'))),53);
  assert.equal(E.expectedAt(w,E.ts('2026-04-01')),100,'после срока — сто');
});

test('кривая освоения: три линии, стыкуются в точке «сегодня»', ()=>{
  const w=mk('W1','2026-01-01','2026-03-01',50);
  w.updatedAt='2026-02-01T00:00:00Z';
  const now=E.ts('2026-02-01');
  const c=E.curves({works:[w]},{now,points:20,
    history:[{work:'W1',progress:20,at:'2026-01-15 10:00'}]});
  assert.equal(c.factNow,50,'факт на сегодня — текущий процент');
  assert.equal(c.fact[0].v,0,'до первой записи факт нулевой');
  assert.ok(c.fact.some(x=>x.v===20),'промежуточная запись видна на линии');
  assert.equal(c.fact[c.fact.length-1].t,now,'факт заканчивается сегодня');
  assert.equal(c.forecast[0].t,now,'прогноз начинается сегодня');
  assert.equal(c.forecast[0].v,c.factNow,'линии стыкуются');
  assert.equal(c.forecast[c.forecast.length-1].v,100,'прогноз доходит до ста');
  assert.ok(c.plan.every((x,i,a)=>!i||x.v>=a[i-1].v),'план не убывает');
});

test('без хронологии факт опирается на дату изменения записи', ()=>{
  const w=mk('W1','2026-01-01','2026-03-01',40);
  w.updatedAt='2026-02-10T00:00:00Z';
  const c=E.curves({works:[w]},{now:E.ts('2026-02-20'),points:30,history:[]});
  assert.equal(c.factNow,40);
  assert.equal(c.fact[0].v,0,'раньше изменения ничего не придумываем');
});

test('отставание видно по расхождению плана и факта', ()=>{
  const a=mk('W1','2026-01-01','2026-03-01',10),b=mk('W2','2026-01-01','2026-03-01',10);
  a.updatedAt=b.updatedAt='2026-02-01T00:00:00Z';
  const c=E.curves({works:[a,b]},{now:E.ts('2026-02-01'),points:12,history:[]});
  assert.ok(c.planNow>c.factNow,'план выше факта');
  assert.ok(c.endForecast>c.endPlan,'прогнозная дата позже плановой');
});

test('работы без дат в кривую не попадают и её не ломают', ()=>{
  const good=mk('W1','2026-01-01','2026-03-01',50);
  const bad=E.newWork('W2','Без дат','S1',0,10,'','',0,'plan');
  const c=E.curves({works:[good,bad]},{now:E.ts('2026-02-01'),points:10,history:[]});
  assert.ok(c.plan.length,'кривая построена');
  assert.ok(c.plan.every(x=>isFinite(x.v)),'нет NaN');
});

test('пустой график не роняет расчёт', ()=>{
  const c=E.curves({works:[]},{now:E.ts('2026-02-01')});
  assert.deepEqual(c.plan,[]);
  assert.equal(c.factNow,0);
});

test('без хронологии ход работы восстанавливается по её плану, но не выше факта', ()=>{
  const w=mk('W1','2026-09-01','2026-10-15',100);
  w.updatedAt='2026-11-20T00:00:00Z';
  const c=E.curves({works:[w]},{now:E.ts('2026-11-26'),points:10,history:[]});
  assert.equal(c.fact[0].v,0,'в начале ноль');
  assert.equal(c.factNow,100,'в конце — достигнутый процент');
  assert.ok(c.fact.some(x=>x.v>0&&x.v<100),'между ними есть ход, а не обрыв');
  assert.ok(c.fact.every(x=>x.v<=100),'выше факта линия не идёт');
  assert.equal(c.guessed,1,'в подписи честно сказано, что работа восстановлена');
});

test('восстановленная линия не превышает достигнутый процент', ()=>{
  const w=mk('W1','2026-01-01','2026-06-01',40);
  w.updatedAt='2026-05-01T00:00:00Z';
  const c=E.curves({works:[w]},{now:E.ts('2026-05-01'),points:20,history:[]});
  assert.ok(c.fact.every(x=>x.v<=40),'потолок — 40 %');
  assert.equal(c.factNow,40);
});

test('если хронология есть, ничего не восстанавливается', ()=>{
  const w=mk('W1','2026-01-01','2026-06-01',40);
  w.updatedAt='2026-05-01T00:00:00Z';
  const c=E.curves({works:[w]},{now:E.ts('2026-05-01'),points:20,
    history:[{work:'W1',progress:40,at:'2026-04-20 09:00'}]});
  assert.equal(c.guessed,0);
  assert.equal(c.fact[0].v,0,'до записи — ноль, план не подставляется');
});

/* ---------- виды работ: слои стройки ---------- */
test('работы раскладываются по слоям стройки по названию', ()=>{
  const k=n=>E.workKind({name:n});
  assert.equal(k('Земляное полотно'),'zem');
  assert.equal(k('Срезка растительного слоя'),'zem');
  assert.equal(k('Разработка грунта экскаватором'),'zem');
  assert.equal(k('Отсыпка щебёночного балласта'),'vsp');
  assert.equal(k('Укладка рельсошпальной решётки'),'vsp');
  assert.equal(k('Устройство СЦБ'),'scb');
  assert.equal(k('Прокладка кабеля связи'),'scb');
  assert.equal(k('Электрификация'),'el');
  assert.equal(k('Монтаж опор контактной сети'),'el');
  assert.equal(k('Монтаж трубопровода ПК 17+20'),'isso');
  assert.equal(k('Устройство водопропускной трубы'),'isso');
  assert.equal(k('Непонятная работа'),'etc','что не узнали — в «прочие», а не выброшено');
});

test('у каждого слоя есть человеческое название', ()=>{
  for(const k of E.KINDS){
    assert.ok(k.id&&k.name&&k.hint,'слой описан: '+k.id);
    assert.equal(E.kindName(k.id),k.name);
  }
  assert.equal(E.KINDS[E.KINDS.length-1].id,'etc','«прочие» идут последними');
});

/* ---------- разбор ведомости профиля ---------- */
test('ведомость профиля читается с русскими заголовками', ()=>{
  const r=E.profileRows([
    {'Пикет':'ПК 0+00','Отметка земли':142.3,'Проектная отметка':144.1},
    {'Пикет':'ПК 1+50','Отметка земли':'141,05','Проектная отметка':'143,60'},
    {'Пикет':'','Отметка земли':5},
    {'Пикет':'ПК 2+00'},
  ]);
  assert.equal(r.length,2,'строки без пикета или без отметок пропущены');
  assert.equal(r[1].pk,1.5);
  assert.equal(r[1].ground,141.05,'запятая как разделитель понимается');
});

test('точки профиля не дублируются и идут по возрастанию пикета', ()=>{
  const r=E.profileRows([{pk:20,ground:1,design:2},{pk:0,ground:3,design:4},{pk:20,ground:9,design:9}]);
  assert.deepEqual(r.map(x=>x.pk),[0,20]);
});

test('рабочая отметка: плюс насыпь, минус выемка', ()=>{
  assert.equal(E.working({ground:142.3,design:144.1}),1.8);
  assert.equal(E.working({ground:145.4,design:146.2}),0.8);
  assert.equal(E.working({ground:146.8,design:144.0}),-2.8);
  assert.equal(E.working({ground:null,design:144}),null,'без одной отметки не считаем');
});

test('уклон считается в тысячных по проектной линии', ()=>{
  /* 1 метр подъёма на 1000 м пути — это ровно 1 ‰ */
  assert.equal(E.slope({pk:0,design:100},{pk:10,design:101}),1);
  assert.equal(E.slope({pk:0,design:100},{pk:10,design:99}),-1);
  assert.equal(E.slope({pk:0,design:100},{pk:0,design:101}),null,'нулевая длина — не уклон');
});

test('сводка профиля: диапазон, насыпи, выемки, крутейший уклон', ()=>{
  const r=E.profileRows([{pk:0,ground:100,design:102},{pk:10,ground:105,design:103},
    {pk:20,ground:106,design:101}]);
  const s=E.profileSummary(r);
  assert.equal(s.points,3);
  assert.equal(s.from,0);assert.equal(s.to,20);
  assert.equal(s.min,100);assert.equal(s.max,106);
  assert.equal(s.fill,1,'одна насыпь');
  assert.equal(s.cut,2,'две выемки');
  assert.equal(s.steep.i,-2,'самый крутой участок — две тысячных вниз');
});

test('пустая ведомость не ломает сводку', ()=>{
  assert.equal(E.profileSummary([]).points,0);
  assert.equal(E.profileRows(null).length,0);
});
