/* АКСГ — клиентская часть: роли, офлайн-работа, автосохранение, темы. */
'use strict';
const E=window.AKSG;
const K={state:'aksg.p125.state',queue:'aksg.p125.queue',theme:'aksg.theme',tab:'aksg.tab'};
const AUTOSAVE=10*60*1000;         /* принудительная отправка раз в 10 минут */
const DEBOUNCE=2500;               /* обычная отправка через пару секунд после правки */

const $=(s,el=document)=>el.querySelector(s);
const $$=(s,el=document)=>[...el.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=s=>s?String(s).split('-').reverse().join('.'):'—';
const hhmm=d=>new Date(d).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
const fmtDT=s=>{const m=String(s||'').match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d:\d\d)/);
  return m?`${m[3]}.${m[2]}.${m[1]} ${m[4]}`:String(s||'')};
const nowIso=()=>new Date().toISOString();
const uid=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const ls={get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}},
          set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}},
          del(k){try{localStorage.removeItem(k)}catch(e){}}};

let S={sections:[],works:[],evidence:[],pending:[]},ME=null,REV=0,ROLES={},NOW=0,SCH={forecast:{},cycles:[]};

/* вложения (фото, акты, схемы) живут в устройстве, пока не уйдут на сервер */
const IDB=(()=>{
  let p=null;
  const open=()=>p||(p=new Promise((ok,no)=>{
    const r=indexedDB.open('aksg-files',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('f');
    r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);
  }));
  const tx=async(mode,fn)=>{
    const db=await open();
    return new Promise((ok,no)=>{
      const t=db.transaction('f',mode),req=fn(t.objectStore('f'));
      t.oncomplete=()=>ok(req&&req.result);t.onerror=()=>no(t.error);
    });
  };
  return{put:(k,v)=>tx('readwrite',s=>s.put(v,k)),get:k=>tx('readonly',s=>s.get(k)),
         del:k=>tx('readwrite',s=>s.delete(k))};
})();
const b64=b=>new Promise(ok=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(',')[1]);r.readAsDataURL(b)});
const kb=n=>n>=1048576?(n/1048576).toFixed(n<104857600?1:0)+' МБ':Math.max(1,Math.round(n/1024))+' КБ';
/* Снимок с планшета весит 4–8 МБ, а место в базе общее и небольшое.
   Уменьшаем прямо на устройстве: сперва по размеру кадра, потом по качеству,
   пока не уложимся в PHOTO_TARGET. Доказательная сила снимка от этого не страдает:
   1600 точек по длинной стороне — это крупнее, чем лист А4 при печати. */
const PHOTO_SIDE=1600, PHOTO_TARGET=900*1024, PHOTO_MAX=1.1*1024*1024;
async function shrink(file){
  if(!/^image\/(jpeg|png|webp)$/.test(file.type))return file;
  try{
    const img=await createImageBitmap(file);
    if(file.size<=PHOTO_TARGET&&Math.max(img.width,img.height)<=PHOTO_SIDE)return file;
    const draw=side=>{
      const k=Math.min(1,side/Math.max(img.width,img.height));
      const c=document.createElement('canvas');
      c.width=Math.max(1,Math.round(img.width*k));c.height=Math.max(1,Math.round(img.height*k));
      const x=c.getContext('2d');x.imageSmoothingQuality='high';
      x.drawImage(img,0,0,c.width,c.height);
      return c;
    };
    let best=null;
    for(const side of [PHOTO_SIDE,1200]){
      const c=draw(side);
      for(const q of [0.72,0.6,0.5,0.42]){
        const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',q));
        if(!blob)continue;
        if(!best||blob.size<best.size)best=blob;
        if(blob.size<=PHOTO_TARGET){best=blob;break}
      }
      if(best&&best.size<=PHOTO_TARGET)break;
    }
    if(!best||best.size>=file.size)return file;
    return new File([best],String(file.name||'photo').replace(/\.\w+$/,'')+'.jpg',{type:'image/jpeg'});
  }catch(e){return file}
}
const deviceName=()=>{
  const u=navigator.userAgent;
  const m=u.match(/\((?:iPhone|iPad)[^)]*\)/)||u.match(/\(Android[^;)]*/)||u.match(/\(([^;)]+)/);
  return ((m?m[0]:'').replace(/[()]/g,'')+' · '+(navigator.platform||'')).trim().slice(0,120);
};
async function keepFile(file,work){
  const small=await shrink(file);
  if(/^image\//.test(small.type)&&small.size>PHOTO_MAX)
    throw new Error(`Снимок весит ${kb(small.size)} — уменьшить его на этом устройстве не вышло. `+
      'Сделайте фото прямо из приложения кнопкой «Сфотографировать» или уменьшите разрешение камеры.');
  if(small.size>3.4*1024*1024)throw new Error('Файл больше 3,5 МБ. Сделайте снимок меньшего размера.');
  if(STORAGE.quota&&STORAGE.free!=null&&small.size>STORAGE.free)
    throw new Error(`В хранилище осталось ${kb(STORAGE.free)} — файл не поместится. `+
      'Сообщите администратору: нужно выгрузить архив и освободить место.');
  const id='F'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  await IDB.put(id,small);
  /* когда снято и чем — это и есть доказательная сила снимка */
  fileMeta[id]={taken:new Date(file.lastModified||Date.now()).toISOString(),device:deviceName()};
  fileQueue.add(id);cacheLocal();
  return{fileId:id,fileName:small.name||'файл',fileSize:small.size,
    fileMime:small.type||'application/octet-stream',fileTaken:fileMeta[id].taken.slice(0,16).replace('T',' '),
    fileDevice:fileMeta[id].device,work};
}
async function pushFiles(){
  for(const id of [...fileQueue]){
    let blob;try{blob=await IDB.get(id)}catch(e){blob=null}
    if(!blob){fileQueue.delete(id);continue}
    const ev=S.evidence.find(e=>e.fileId===id);
    try{
      const r=await fetch('/api/file',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({id,name:blob.name||'файл',mime:blob.type,work:ev?ev.work:'',
          taken:(fileMeta[id]||{}).taken||null,device:(fileMeta[id]||{}).device||'',data:await b64(blob)})});
      if(r.ok||r.status===400||r.status===413){fileQueue.delete(id);if(r.ok)IDB.del(id).catch(()=>{})}
      else return false;
    }catch(e){return false}
  }
  cacheLocal();return true;
}
let pending=new Set(ls.get(K.queue,{}).works||[]);
let newEvidence=new Set(ls.get(K.queue,{}).evidence||[]);
let fileQueue=new Set(ls.get(K.queue,{}).files||[]);
let fileMeta=ls.get(K.queue,{}).meta||{};
let savedAt=ls.get(K.queue,{}).savedAt||null,dirty=pending.size>0,pushing=false,timer=null,status='load';
const RO=()=>!(ME&&ME.can.write);

/* ---------------- тема ---------------- */
function applyTheme(){
  const t=ls.get(K.theme,'system');
  document.documentElement.dataset.theme=t==='system'?'':t;
  if(t==='system')document.documentElement.removeAttribute('data-theme');
  const b=$('#themeBtn');
  if(b)b.innerHTML='Тема<span class="themefull">: '+({system:'как в системе',light:'светлая',dark:'тёмная'}[t])+'</span>';
}
function cycleTheme(){
  const order=['system','light','dark'],t=ls.get(K.theme,'system');
  ls.set(K.theme,order[(order.indexOf(t)+1)%3]);applyTheme();
}

/* ---------------- связь и сохранение ---------------- */
function setStatus(kind,text){
  status=kind;
  const el=$('#state');if(!el)return;
  el.className='state'+(kind==='off'?' off':kind==='err'?' err':'');
  el.innerHTML='<i></i><span>'+esc(text)+'</span>';
}
function stamp(){
  if(RO())return setStatus('ok','только просмотр');
  if(pushing)return setStatus('ok','сохраняю…');
  if(!navigator.onLine)return setStatus('off',pending.size?('нет связи · не отправлено: '+pending.size):'нет связи');
  if(pending.size||fileQueue.size)return setStatus('off','не отправлено: '+(pending.size+fileQueue.size));
  setStatus('ok',savedAt?('сохранено '+hhmm(savedAt)):'синхронизировано');
}
function cacheLocal(){ls.set(K.state,{rev:REV,...S});
  ls.set(K.queue,{works:[...pending],evidence:[...newEvidence],files:[...fileQueue],meta:fileMeta,savedAt});}

function touch(id){
  if(id){pending.add(id);const w=S.works.find(x=>x.id===id);if(w)w.updatedAt=nowIso()}
  dirty=true;cacheLocal();stamp();
  clearTimeout(timer);timer=setTimeout(push,DEBOUNCE);
}
async function push(force){
  if(RO()||pushing)return;
  if(!dirty&&!force)return;
  if(!navigator.onLine){stamp();return}
  pushing=true;stamp();
  try{
    await pushFiles();
    const r=await fetch('/api/state',{method:'PUT',headers:{'content-type':'application/json'},
      body:JSON.stringify({rev:REV,sections:S.sections,works:S.works,evidence:S.evidence})});
    if(r.status===409){
      const d=await r.json();
      if(d.state){const mine=new Set(pending);
        const srv=d.state;
        for(const w of srv.works){const my=S.works.find(x=>x.id===w.id);
          if(my&&mine.has(w.id))Object.assign(w,{progress:my.progress,status:my.status,note:my.note,updatedAt:my.updatedAt})}
        S={sections:srv.sections,works:srv.works,evidence:srv.evidence,pending:srv.pending||[]};REV=srv.rev;
        cacheLocal();render();
        pushing=false;return push(true);
      }
    }
    if(r.status===401){pushing=false;return gate()}
    if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||('код '+r.status));
    REV=(await r.json()).rev;pending.clear();newEvidence.clear();dirty=false;savedAt=Date.now();
    cacheLocal();
  }catch(e){setStatus('off','не отправлено: '+pending.size);pushing=false;stamp();return}
  pushing=false;stamp();
}
/* сколько места занято под вложения: знаем до выезда, а не когда уже не сохранилось */
let STORAGE=ls.get('aksg.storage',{bytes:0,count:0,quota:0,free:null,pct:0,warn:false});
async function pullStorage(){
  if(!navigator.onLine)return;
  try{
    const r=await fetch('/api/file?usage=1');
    if(!r.ok)return;
    STORAGE=await r.json();ls.set('aksg.storage',STORAGE);
  }catch(e){}
}
async function pull(){
  if(!navigator.onLine)return false;
  try{
    const r=await fetch('/api/state');
    if(r.status===401){gate();return false}
    if(!r.ok)return false;
    const d=await r.json();
    ME=d.user;
    if(pending.size){                      /* свои несохранённые правки не теряем */
      for(const w of d.works){const my=S.works.find(x=>x.id===w.id);
        if(my&&pending.has(w.id))Object.assign(w,{progress:my.progress,status:my.status,note:my.note,updatedAt:my.updatedAt})}
    }
    S={sections:d.sections,works:d.works,evidence:d.evidence,profile:d.profile||[],pending:d.pending||[]};REV=d.rev;
    cacheLocal();pullStorage();return true;
  }catch(e){return false}
}

/* ---------------- вход ---------------- */
async function boot(){
  applyTheme();
  const r=await fetch('/api/auth').catch(()=>null);
  const d=r&&r.ok?await r.json():null;
  ROLES=(d&&d.roles)||{};
  if(d&&d.user){ME=d.user;return start()}
  const cached=ls.get(K.state,null);
  if(cached&&!navigator.onLine){            /* офлайн: пускаем к сохранённым данным */
    ME={login:'офлайн',name:'Работа без связи',role:'inspector',can:{write:true,admin:false}};
    return start();
  }
  gate(d&&d.firstRun);
}
function gate(firstRun){
  $('#app').classList.add('hide');$('#gate').classList.remove('hide');
  let mode='login';
  const body=$('#gateBody'),msg=$('#gateMsg'),hint=$('#gateHint');
  const draw=()=>{
    $$('#gateTabs button').forEach(b=>b.setAttribute('aria-selected',b.dataset.g===mode));
    $('#gateGo').textContent=mode==='login'?'Войти':'Создать учётную запись';
    body.innerHTML=mode==='login'
      ?`<div class="fl"><label>Логин</label><input name="login" autocomplete="username" required></div>
        <div class="fl"><label>Пароль</label><input name="pass" type="password" autocomplete="current-password" required></div>`
      :`<div class="fl"><label>Имя и фамилия</label><input name="name" autocomplete="name" placeholder="Михаил Мишуков"></div>
        <div class="fl"><label>Логин</label><input name="login" autocomplete="username" required placeholder="латиницей"></div>
        <div class="fl"><label>Пароль</label><input name="pass" type="password" autocomplete="new-password" required placeholder="не короче 8 знаков"></div>
        ${firstRun?'':'<div class="fl"><label>Код приглашения</label><input name="code" placeholder="XXXX-XXXX" required></div>'}`;
    hint.innerHTML=mode==='login'
      ?'Нет доступа? Попросите код приглашения у администратора проекта.'
      :(firstRun?'Система пустая: первый зарегистрировавшийся становится администратором.'
                :'Код выдаёт администратор. Роль — инспектор, руководитель или администратор — заложена в коде.');
    msg.innerHTML='';
  };
  $('#gateTabs').onclick=e=>{const b=e.target.closest('button');if(b){mode=b.dataset.g;draw()}};
  $('#gateForm').onsubmit=async e=>{
    e.preventDefault();
    const f=new FormData(e.target),data={action:mode==='login'?'login':'register'};
    for(const [k,v] of f.entries())data[k]=v;
    $('#gateGo').disabled=true;
    try{
      const r=await fetch('/api/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
      const d=await r.json();
      if(!r.ok)throw new Error(d.error||'не получилось');
      ME=d.user;$('#gate').classList.add('hide');start();
    }catch(err){msg.innerHTML=`<div class="note">${esc(err.message)}</div>`}
    $('#gateGo').disabled=false;
  };
  draw();
}

/* ---------------- что требует внимания ---------------- */
let ALERTS=[],ALERT_T={},SEEN=new Set(ls.get('aksg.seen',[]));
const alertKey=a=>a.kind+':'+a.work;
const freshAlerts=()=>ALERTS.filter(a=>!SEEN.has(alertKey(a)));

async function loadAlerts(){
  if(!navigator.onLine)return;
  try{
    const r=await fetch('/api/notify');
    if(!r.ok)return;
    const d=await r.json();
    const before=new Set(ALERTS.map(alertKey));
    ALERTS=d.alerts||[];ALERT_T=d.titles||{};
    drawBell();
    /* о новом поводе сообщаем сразу, даже если человек смотрит другую вкладку браузера */
    const appeared=ALERTS.filter(a=>!before.has(alertKey(a))&&!SEEN.has(alertKey(a)));
    if(appeared.length&&before.size)notifySystem(appeared);
  }catch(e){}
}
function notifySystem(list){
  if(!('Notification' in window)||Notification.permission!=='granted')return;
  const first=list[0];
  try{
    new Notification(list.length>1?`АКСГ: ${list.length} новых повода`:'АКСГ: новое отклонение',
      {body:first.text.slice(0,180),tag:'aksg-alerts',icon:'/icon.svg'});
  }catch(e){}
}
function drawBell(){
  const b=$('#bell');if(!b)return;
  const n=ALERTS.length,fresh=freshAlerts().length;
  b.classList.remove('hide');
  b.classList.toggle('calm',!n);
  b.classList.toggle('pulse',!!fresh);
  b.textContent=n?(fresh?`Требует внимания: ${n} · ${fresh} ${fresh===1?'новое':'новых'}`:`Требует внимания: ${n}`)
    :'Всё по плану';
  b.onclick=showAlerts;
}
function showAlerts(){
  const by={};for(const a of ALERTS)(by[a.kind]=by[a.kind]||[]).push(a);
  const can='Notification' in window;
  const perm=can?Notification.permission:'unsupported';
  $('#form').innerHTML=`
   <h2>Что требует внимания</h2>
   ${ALERTS.length?Object.keys(by).map(k=>`
     <h3 style="margin-top:8px">${esc(ALERT_T[k]||k)} — ${by[k].length}</h3>
     <div class="alerts">${by[k].map(a=>`<div class="a${SEEN.has(alertKey(a))?'':' fresh'}" data-w="${esc(a.work)}">
        <span class="chip c-${k==='noproof'||k==='review'||k==='storage'?'warn':'bad'}">${esc(a.work)}</span>
        <span class="grow">${esc(a.text)}${SEEN.has(alertKey(a))?'':' <b class="newmark">новое</b>'}</span></div>`).join('')}</div>`).join('')
    :'<p class="hint">Просрочек, отклонений и непроверенных сводок нет. Можно работать спокойно.</p>'}
   ${can&&perm!=='granted'?`<div class="note" style="margin-top:14px"><div>
      <b>Подсказывать прямо на экране?</b> Разрешите уведомления, и приложение само сообщит о новой
      просрочке, даже если вкладка свёрнута. Ничего никуда не отправляется — сообщение показывает браузер.
      <div class="btnrow" style="margin-top:8px"><button type="button" class="btn sm pri" id="askperm">Разрешить</button></div>
      </div></div>`:''}
   ${perm==='granted'?'<p class="hint">Уведомления на экране включены.</p>':''}
   <div class="foot"><button class="btn pri" value="x">Закрыть</button></div>`;
  const ap=$('#askperm');
  if(ap)ap.onclick=async()=>{try{await Notification.requestPermission()}catch(e){}showAlerts()};
  /* всё, что человек увидел, перестаёт быть новым */
  ALERTS.forEach(a=>SEEN.add(alertKey(a)));
  ls.set('aksg.seen',[...SEEN].slice(-200));
  setTimeout(drawBell,400);
  const d=$('#dlg');
  d.onclick=e=>{const row=e.target.closest('[data-w]');
    if(row){const w=S.works.find(x=>x.id===row.dataset.w);if(w){d.close('x');setTimeout(()=>editWork(w),120)}}};
  d.showModal();
  d.onclose=()=>{d.onclick=null};
}

/* ---------------- разделы ---------------- */
const TABS={
  dash:{t:'Дашборд',n:'Дашборд'},
  ksg:{t:'КСГ — работы',n:'КСГ',act:'+ Работа',write:true},
  line:{t:'Пикетаж',n:'Пикетаж',act:'+ Участок',write:true},
  chart:{t:'Графики',n:'Графики'},
  proof:{t:'Подтверждения факта',n:'Факты',act:'+ Подтверждение',write:true},
  hist:{t:'Хронология',n:'Хронология'},
  io:{t:'Файлы и работа без связи',n:'Файлы'},
  admin:{t:'Люди и доступы',n:'Люди',admin:true}
};
const ICON={
  dash:'<path d="M3 13h8V3H3zM13 21h8V11h-8zM13 7h8V3h-8zM3 21h8v-4H3z"/>',
  ksg:'<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="19" cy="18" r="2"/>',
  line:'<path d="M3 12h18M7 8v8M12 8v8M17 8v8"/>',
  chart:'<path d="M4 19V5M4 19h16"/><path d="M7 15l4-5 3 3 5-7"/>',
  proof:'<path d="M20 6 9 17l-5-5"/>',
  hist:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  io:'<path d="M12 3v12M8 11l4 4 4-4M4 21h16"/>',
  admin:'<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0112 0M16 11h5M18.5 8.5v5"/>'
};
let tab=location.hash.slice(1)||ls.get(K.tab,'dash');

function start(){
  $('#gate').classList.add('hide');$('#app').classList.remove('hide');
  $('#who').innerHTML=`<i>${esc((ME.name||ME.login).slice(0,2).toUpperCase())}</i>
    <div><b>${esc(ME.name||ME.login)}</b><span>${esc((ROLES[ME.role]||{}).name||ME.role)}</span></div>`;
  const items=Object.entries(TABS).filter(([k,v])=>!v.admin||ME.can.admin);
  $('#navlist').innerHTML=items.map(([k,v])=>
    `<a href="#${k}" data-k="${k}"><svg viewBox="0 0 24 24">${ICON[k]}</svg><span>${esc(v.n)}</span></a>`).join('');
  if(!/^report/.test(tab)&&(!TABS[tab]||(TABS[tab].admin&&!ME.can.admin)))tab='dash';
  $('#today').value=E.iso(E.today());
  $('#today').onchange=()=>render();
  $('#themeBtn').onclick=cycleTheme;
  $('#exitBtn').onclick=async()=>{
    if(pending.size&&!confirm('Есть неотправленные правки ('+pending.size+'). Выйти всё равно?'))return;
    await fetch('/api/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'logout'})}).catch(()=>{});
    ls.del(K.state);ls.del(K.queue);location.reload();
  };
  addEventListener('hashchange',()=>{tab=location.hash.slice(1)||'dash';render()});
  addEventListener('online',()=>{stamp();pull().then(()=>{render();push(true)})});
  addEventListener('offline',stamp);
  addEventListener('beforeunload',e=>{if(pending.size){e.preventDefault();e.returnValue=''}});
  matchMedia('(min-width:1200px)').addEventListener('change',()=>render());
  setInterval(()=>push(true),AUTOSAVE);
  loadAlerts();setInterval(loadAlerts,5*60*1000);
  setInterval(()=>{if(!pending.size&&navigator.onLine&&!pushing)pull().then(ok=>ok&&render())},60000);

  const cached=ls.get(K.state,null);
  if(cached){S={sections:cached.sections||[],works:cached.works||[],evidence:cached.evidence||[],
    profile:cached.profile||[]};REV=cached.rev||0}
  render();
  pull().then(ok=>{if(ok)render();stamp();if(pending.size)push(true)});
}

/* крупные числа приятнее, когда они добегают до значения, а не возникают из ниоткуда */
function countUp(el,to,suffix){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){el.textContent=to+(suffix||'');return}
  const dur=650,t0=performance.now();
  const step=now=>{
    const k=Math.min(1,(now-t0)/dur), e=1-Math.pow(1-k,3);
    el.textContent=Math.round(to*e)+(suffix||'');
    if(k<1)requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function animateNumbers(root){
  for(const el of (root||document).querySelectorAll('[data-count]')){
    const to=+el.dataset.count,suf=el.dataset.suffix||'';
    el.textContent='0'+suf;countUp(el,to,suf);
  }
}
function render(){
  const cfg=tab==='report'?{t:'Отчёт на дату'}:tab==='report-simple'?{t:'Отчёт простым языком'}:(TABS[tab]||TABS.dash);
  if(TABS[tab])ls.set(K.tab,tab);
  $('#title').textContent=cfg.t;
  document.title=cfg.t+' · АКСГ';
  $$('#navlist a').forEach(a=>a.dataset.k===tab?a.setAttribute('aria-current','page'):a.removeAttribute('aria-current'));
  const act=$('#act');
  const showAct=cfg.act&&!RO();
  act.textContent=cfg.act||'';act.classList.toggle('hide',!showAct);
  act.onclick=showAct?{ksg:()=>editWork(null),line:()=>editSection(null),proof:()=>editProof()}[tab]:null;
  NOW=E.ts($('#today').value)||E.today();
  SCH=E.schedule(S.works,NOW);
  const m=$('#main');m.onclick=null;m.innerHTML='';
  ({dash,ksg,line,chart:charts,proof,hist,io,admin,report,'report-simple':reportPlain}[tab]||dash)(m);
  /* появление проигрываем при смене раздела, а не при каждом фоновом обновлении:
     иначе страница моргает раз в минуту */
  if(tab!==lastTab){m.classList.remove('swap');void m.offsetWidth;m.classList.add('swap');
    animateNumbers(m);lastTab=tab}
  else m.classList.remove('swap');
  stamp();
}
const calc=w=>{
  const a=E.assess(w,{now:NOW,works:S.works,evidence:S.evidence,schedule:SCH});
  return{...a,blockerWorks:a.blockers.map(id=>S.works.find(v=>v.id===id)).filter(Boolean)};
};
const LVL={ok:'В норме',warn:'Риск',bad:'Отклонение'};
const pendingFor=id=>(S.pending||[]).filter(p=>p.work===id);
/* подтверждено / ждёт подтверждения / не подтверждено — единая метка на работе */
function proofState(w){
  if(pendingFor(w.id).length)return['ждёт подтверждения','warn'];
  if(S.evidence.some(e=>e.work===w.id))return['подтверждено','ok'];
  return w.progress>0?['не подтверждено','bad']:null;
}
const chip=(t,c)=>`<span class="chip c-${c}">${esc(t)}</span>`;
const mark=(w,c)=>w.status==='done'?chip('Выполнена','ok'):chip(LVL[c.level],c.level);
const secName=id=>(S.sections.find(s=>s.id===id)||{}).name||id;
/* рядом с пикетажем название участка не должно повторять его же в скобках:
   «Участок 1 (ПК 0 – ПК 120), ПК 0+00 – ПК 120+00» читается тяжело */
const secShort=id=>String(secName(id)).replace(/\s*\([^)]*ПК[^)]*\)\s*$/i,'').trim()||secName(id);
const eta=w=>(SCH.forecast[w.id]||{}).end||E.planEndTs(w);
/* темп: процентов в день сейчас и сколько нужно, чтобы успеть к плановому сроку */
function tempo(w){
  const a=E.planStartTs(w),b=E.planEndTs(w);
  if(w.status==='done'||w.progress>=100)return null;
  const elapsed=(NOW-a)/E.DAY, left=(b-NOW)/E.DAY;
  const now=w.progress>0&&elapsed>=1?w.progress/elapsed:0;
  const need=left>=1?(100-w.progress)/left:null;
  if(!now&&!need)return null;
  return{now,need};
}
const tempoText=w=>{const t=tempo(w);if(!t)return'';
  const n=x=>String(x>=10?Math.round(x):Math.round(x*10)/10).replace('.',',');
  if(!t.now)return t.need!=null?` · чтобы успеть, нужно ${n(t.need)} %/день`:' · плановый срок уже прошёл';
  return ` · темп ${n(t.now)} %/день`+(t.need!=null?`, нужно ${n(t.need)}`:', срок уже прошёл');};

/* ---------------- пересказ простым языком ----------------
   Руководителю нужны не проценты и коды работ, а ответ на вопрос «как идут дела». */
const plural=(n,one,few,many)=>{const a=Math.abs(n)%100,b=a%10;
  return n+' '+(a>10&&a<20?many:b===1?one:b>=2&&b<=4?few:many)};
const monthName=d=>new Date(d).toLocaleDateString('ru-RU',{month:'long',year:'numeric'});
function plainFacts(){
  const rows=S.works.map(w=>({w,c:calc(w)}));
  const done=rows.filter(r=>r.c.done);
  const going=rows.filter(r=>!r.c.done&&r.w.progress>0);
  const idle=rows.filter(r=>!r.c.done&&!r.w.progress);
  const late=rows.filter(r=>r.c.level==='bad');
  const risk=rows.filter(r=>r.c.level==='warn');
  const noProof=rows.filter(r=>r.c.noProof);
  const pend=(S.pending||[]).length;
  const total=rows.length?Math.round(rows.reduce((s,r)=>s+r.w.progress,0)/rows.length):0;
  const planEnd=rows.length?Math.max(...rows.map(r=>E.planEndTs(r.w))):0;
  const realEnd=rows.length?Math.max(...rows.map(r=>eta(r.w))):0;
  const slip=planEnd&&realEnd?Math.round((realEnd-planEnd)/E.DAY):0;
  const last=S.works.flatMap(w=>(w.history||[]).map(h=>h.d)).sort().slice(-1)[0];
  return{rows,done,going,idle,late,risk,noProof,pend,total,planEnd,realEnd,slip,last,
    mood:late.length?'bad':risk.length?'warn':'ok'};
}
function plainLines(f){
  const L=[];
  L.push(`Работы выполнены на ${f.total} %. Всего в графике ${plural(f.rows.length,'работа','работы','работ')}: `+
    `${f.done.length} закрыто, ${f.going.length} в работе, ${f.idle.length} ещё не начинали.`);
  if(f.late.length)
    L.push(`${plural(f.late.length,'работа отстаёт','работы отстают','работ отстают')} настолько, что это уже отклонение. `+
      `Самая тяжёлая — «${f.late[0].w.name}»: по плану должна была быть готова ${fmt(f.late[0].w.planEnd)}, сделано ${f.late[0].w.progress} %.`);
  else if(f.risk.length)
    L.push(`Срывов нет, но ${plural(f.risk.length,'работа идёт','работы идут','работ идут')} медленнее плана — стоит присмотреть.`);
  else L.push('Отстающих работ нет: всё идёт по плану.');
  if(f.slip>0)L.push(`Если темп не изменится, последняя работа закончится ${fmt(E.iso(f.realEnd))} — `+
    `это на ${plural(f.slip,'день','дня','дней')} позже плана.`);
  else if(f.realEnd)L.push(`По текущему темпу объект закрывается ${fmt(E.iso(f.realEnd))} — в срок.`);
  if(f.noProof.length)L.push(`У ${plural(f.noProof.length,'работы','работ','работ')} внесён факт, но нет документа — акта или фотографии. `+
    `Пока это слова, а не подтверждённый объём.`);
  else L.push('Каждый внесённый объём подтверждён документом.');
  if(f.pend)L.push(`${plural(f.pend,'сводка','сводки','сводок')} от камер и датчиков ждёт проверки инспектором — в цифрах выше они не учтены.`);
  if(f.last)L.push(`Последняя отметка о работах внесена ${fmt(f.last)}.`);
  return L;
}
const MOOD={ok:['Всё по плану','ok'],warn:['Есть риски','warn'],bad:['Есть отставание','bad']};

/* ---------------- дашборд ---------------- */
let lastTab=null,ksgX=0;
let dashView=ls.get('aksg.dashview','');
function dash(m){
  const plain=(dashView||(ME.role==='manager'?'plain':'tech'))==='plain';
  if(plain)return dashPlain(m);
  dashTech(m);
}
/* Кабинет руководителя: то же состояние, но словами. */
function dashPlain(m){
  const f=plainFacts(),lines=plainLines(f),mood=MOOD[f.mood];
  const secs=S.sections.map(s=>{
    const ws=f.rows.filter(r=>r.w.section===s.id);
    const p=ws.length?Math.round(ws.reduce((a,r)=>a+r.w.progress,0)/ws.length):0;
    const bad=ws.filter(r=>r.c.level==='bad').length,warn=ws.filter(r=>r.c.level==='warn').length;
    return{s,p,bad,warn,n:ws.length,
      text:!ws.length?'работы не заведены'
        :bad?`${plural(bad,'работа отстаёт','работы отстают','работ отстают')}`
        :warn?`${plural(warn,'работа идёт','работы идут','работ идут')} медленнее плана`
        :'идёт по плану'};
  });
  m.innerHTML=`
  <div class="card plain">
    <div class="mood ${f.mood}"><span class="dot"></span>${esc(mood[0])}</div>
    <div class="big"><span data-count="${f.total}" data-suffix=" %">${f.total} %</span></div>
    <div class="sub">готовность объекта на ${fmt($('#today').value)}</div>
    <ul class="plines">${lines.map(l=>`<li>${esc(l)}</li>`).join('')}</ul>
    <div class="btnrow" style="margin-top:var(--s16)">
      <a class="btn pri" href="#report-simple">Отчёт простым языком</a>
      <a class="btn" href="#report">Технический отчёт</a>
      <button class="btn" id="toTech">Подробный вид</button>
    </div>
  </div>

  <div class="card"><h3>Как идёт объект</h3>
    <p class="hint">Серая линия — план, красная — факт, пунктир — прогноз при нынешнем темпе.</p>
    <div id="dashCurve"></div>
    <div class="btnrow" style="margin-top:12px"><a class="btn" href="#chart">Все графики</a></div></div>

  <div class="card"><h3>Как идут участки</h3>
    ${secs.map(x=>`<div class="rowline">
      <div class="grow"><div>${esc(x.s.name)}</div>
        <div class="small mut">${plural(x.n,'работа','работы','работ')} · ${esc(x.text)}</div></div>
      <div style="min-width:120px"><div class="bar"><i style="--w:${x.p}%;background:var(--${x.bad?'bad':x.warn?'warn':'ok'})"></i></div>
        <div class="small mut" style="text-align:right">${x.p} %</div></div>
    </div>`).join('')||'<div class="empty">Участки не заведены</div>'}
  </div>

  ${f.late.concat(f.risk).length?`<div class="card"><h3>Что мешает прямо сейчас</h3>
    ${f.late.concat(f.risk).slice(0,6).map(r=>`<div class="rowline" data-go="${r.w.id}">
      <div class="grow"><div>${esc(r.w.name)}</div>
        <div class="small mut">${esc(secName(r.w.section))} · сделано ${r.w.progress} %, ожидалось ${r.c.expected} % ·
          ${r.c.overdue?'срок прошёл':'отстаёт'} на ${plural(r.c.delayDays,'день','дня','дней')}</div></div>
      ${chip(r.c.level==='bad'?'отставание':'риск',r.c.level)}</div>`).join('')}
    </div>`:''}`;
  sCurve($('#dashCurve'),{h:260});
  $('#toTech').onclick=()=>{dashView='tech';ls.set('aksg.dashview','tech');render()};
  m.onclick=e=>{const r=e.target.closest('[data-go]');if(r)editWork(S.works.find(w=>w.id===r.dataset.go))};
}
function dashTech(m){
  const rows=S.works.map(w=>({w,c:calc(w)}));
  const done=rows.filter(r=>r.c.done).length;
  const total=rows.length?Math.round(rows.reduce((s,r)=>s+r.w.progress,0)/rows.length):0;
  const bad=rows.filter(r=>r.c.level==='bad'),warn=rows.filter(r=>r.c.level==='warn');
  const noProof=rows.filter(r=>r.c.noProof);
  const cascade=rows.filter(r=>r.c.blockers.length&&r.c.delayDays>0);
  const kpi=(l,v,c,p)=>`<div class="card kpi"><span>${l}</span><b style="color:var(--${c})"${
      /^\d+ ?%?$/.test(String(v))?` data-count="${parseInt(v,10)}" data-suffix="${String(v).includes('%')?' %':''}"`:''}>${v}</b>
    ${p!=null?`<div class="bar"><i style="--w:${p}%;background:var(--${c})"></i></div>`:''}</div>`;
  const list=(a,fn,empty)=>a.length?a.map(fn).join(''):`<div class="empty">${empty}</div>`;
  m.innerHTML=`
  ${pending.size||fileQueue.size?`<div class="note warn"><div>
     <b>Не отправлено: ${pending.size} ${pending.size===1?'правка':'правок'}${fileQueue.size?', файлов '+fileQueue.size:''}.</b>
     ${navigator.onLine?' Идёт отправка на сервер.':' Связи нет — всё сохраняется в устройстве.'}
     ${navigator.onLine?'':`<div class="btnrow" style="margin-top:10px">
        <button class="btn pri" id="dashEdits">Сохранить правки в Excel</button>
        <a class="btn" href="#io">Собрать пакет</a></div>`}</div></div>`:''}
  ${SCH.cycles.length?`<div class="note"><div>Зависимости закольцованы: ${esc(SCH.cycles.join(', '))}. Прогноз по ним считается только по плану — поправьте поле «Предшественники».</div></div>`:''}
  ${(S.pending||[]).length?`<div class="note warn"><div>
     <b>Ждут проверки: ${S.pending.length}.</b> Сводки от оборудования не меняют факт сами — их подтверждает человек.
     <a href="#ksg"> Открыть КСГ</a></div></div>`:''}
  <div class="grid k4">
    ${kpi('Общая готовность',total+'%','brand',total)}
    ${kpi('Работ выполнено',done+' / '+rows.length,'ok',rows.length?Math.round(done/rows.length*100):0)}
    ${kpi('Отклонения',bad.length,'bad')}
    ${kpi('Без подтверждения',noProof.length,'warn')}
  </div>
  <div class="card"><h3>Освоение: план, факт, прогноз</h3>
    <div id="dashCurve"></div>
    <div class="btnrow" style="margin-top:12px"><a class="btn" href="#chart">Все графики: Гантт, участки, отклонения</a></div></div>
  <div class="grid k2">
    <div class="card"><h3>Требуют решения</h3>
      ${list(bad.concat(warn),r=>`<div class="rowline" data-go="${r.w.id}">
        <div class="grow"><div>${esc(r.w.name)}</div>
          <div class="small mut">${esc(secShort(r.w.section))} · ${PKR(r.w.pkFrom,r.w.pkTo)}</div></div>
        <div class="small mut">ожид. ${r.c.expected}% / факт ${r.w.progress}%</div>
        ${chip(r.c.delayDays+' дн.',r.c.level)}</div>`,'Отклонений нет — все работы идут по плану')}</div>
    <div class="card"><h3>Каскад зависимостей</h3>
      ${list(cascade,r=>`<div class="rowline" data-go="${r.w.id}">
        <div class="grow"><div>${esc(r.w.name)}</div>
          <div class="small mut">ждёт ${r.c.blockerWorks.map(b=>b.id+' · '+b.name).join(', ')}</div></div>
        ${chip('+'+r.c.delayDays+' дн.','warn')}</div>`,'Сдвигов от предшественников нет')}</div>
  </div>
  <div class="card"><h3>Готовность по участкам</h3>
    ${list(S.sections,s=>{const ws=S.works.filter(w=>w.section===s.id);
      const p=ws.length?Math.round(ws.reduce((a,w)=>a+w.progress,0)/ws.length):0;
      return `<div style="margin-top:12px"><div class="rowline" style="border:0;padding:0 0 6px">
        <span class="grow">${esc(s.name)}</span><b>${p}%</b></div>
        <div class="bar"><i style="--w:${p}%"></i></div></div>`},'Участки не заведены')}</div>
  <div class="btnrow"><button class="btn" id="toPlain">Вид простым языком</button>
    <a class="btn" href="#report">Технический отчёт</a>
    <a class="btn" href="#report-simple">Отчёт простым языком</a></div>
  <p class="hint">Ожидаемый процент считается линейно между плановыми датами. Отставание от 10 пунктов — риск, от 25 пунктов или просрочка — отклонение. Нажмите на работу, чтобы открыть карточку.</p>`;
  sCurve($('#dashCurve'),{h:280});
  $('#toPlain').onclick=()=>{dashView='plain';ls.set('aksg.dashview','plain');render()};
  const de=$('#dashEdits');if(de)de.onclick=saveEdits;
  m.onclick=e=>{const r=e.target.closest('[data-go]');if(r)editWork(S.works.find(w=>w.id===r.dataset.go))};
}


/* ================= графики =================
   Цифровизация графика — это прежде всего сам график: план против факта, полосы работ,
   связи между ними. Всё рисуется обычным SVG, без внешних библиотек:
   значит, работает офлайн и печатается вместе с отчётом. */
let HIST=null,histAt=0,histP=null;
function loadHistory(){
  if(HIST&&Date.now()-histAt<120000)return Promise.resolve(HIST);
  if(histP)return histP;
  histP=fetch('/api/history?limit=500').then(r=>r.ok?r.json():null)
    .then(d=>{HIST=(d&&d.history)||[];histAt=Date.now();histP=null;return HIST})
    .catch(()=>{HIST=HIST||[];histP=null;return HIST});
  return histP;
}
/* подписи месяцев на оси времени */
function monthTicks(t0,t1,max){
  const out=[],d=new Date(t0);d.setUTCDate(1);
  while(d.getTime()<=t1){
    if(d.getTime()>=t0)out.push({t:d.getTime(),
      s:d.toLocaleDateString('ru-RU',{month:'short',year:'2-digit',timeZone:'UTC'})});
    d.setUTCMonth(d.getUTCMonth()+1);
  }
  const step=Math.ceil(out.length/(max||10))||1;
  return out.filter((_,i)=>i%step===0);
}
const dline=(pts,x,y)=>pts.map((p,i)=>(i?'L':'M')+x(p.t).toFixed(1)+' '+y(p.v).toFixed(1)).join(' ');
const cut=(s,n)=>{s=String(s||'');return s.length>n?s.slice(0,n-1)+'…':s};

/* ---- 1. Кривая освоения: план, факт, прогноз ---- */
async function sCurve(box,opt){
  if(!box)return;
  const o=opt||{};
  box.innerHTML='<div class="empty">Считаю график…</div>';
  const hist=await loadHistory();
  if(!document.body.contains(box))return;
  const c=E.curves(S,{now:NOW,history:hist,schedule:SCH,points:o.points||72});
  if(!c.plan.length){box.innerHTML='<div class="empty">Нет работ с плановыми сроками</div>';return}
  const W=1000,H=o.h||300,L=40,R=16,T=16,B=28;
  const x=t=>L+(t-c.t0)/((c.t1-c.t0)||1)*(W-L-R);
  const y=v=>T+(100-v)/100*(H-T-B);
  const late=c.endForecast>c.endPlan;
  const gap=Math.round((c.factNow-c.planNow)*10)/10;
  box.innerHTML=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:${H}px" role="img"
      aria-label="Кривая освоения: план, факт, прогноз">
    ${[0,25,50,75,100].map(v=>`<line x1="${L}" y1="${y(v)}" x2="${W-R}" y2="${y(v)}" stroke="var(--line)"/>
      <text x="${L-6}" y="${y(v)+4}" font-size="11" fill="var(--mut)" text-anchor="end">${v}</text>`).join('')}
    ${monthTicks(c.t0,c.t1,9).map(k=>`<line x1="${x(k.t)}" y1="${T}" x2="${x(k.t)}" y2="${H-B}" stroke="var(--line)" opacity=".6"/>
      <text x="${x(k.t)}" y="${H-B+16}" font-size="11" fill="var(--mut)" text-anchor="middle">${esc(k.s)}</text>`).join('')}
    <path d="${dline(c.plan,x,y)}" fill="none" stroke="var(--idle)" stroke-width="3" stroke-linejoin="round"/>
    <path class="draw" pathLength="1" d="${dline(c.fact,x,y)}" fill="none" stroke="var(--brand)" stroke-width="3"
      stroke-linejoin="round" stroke-linecap="round"/>
    <path d="${dline(c.forecast,x,y)}" fill="none" stroke="var(--${late?'warn':'ok'})" stroke-width="2.5"
      stroke-dasharray="7 5" stroke-linejoin="round"/>
    <line x1="${x(c.now)}" y1="${T}" x2="${x(c.now)}" y2="${H-B}" stroke="var(--brand)" stroke-width="2"/>
    <circle cx="${x(c.now)}" cy="${y(c.factNow)}" r="4.5" fill="var(--brand)"/>
    <circle cx="${x(c.now)}" cy="${y(c.planNow)}" r="4" fill="var(--idle)"/>
    <text x="${x(c.now)+6}" y="${T+12}" font-size="11" fill="var(--brand)">сегодня</text>
  </svg>
  <div class="legend">
    <span><i style="background:var(--idle)"></i>план ${c.planNow} %</span>
    <span><i style="background:var(--brand)"></i>факт ${c.factNow} %</span>
    <span><i class="dash" style="background:var(--${late?'warn':'ok'})"></i>прогноз до ${fmt(E.iso(c.endForecast))}</span>
  </div>
  <p class="hint">${gap<0
    ? `Факт ниже плана на <b>${Math.abs(gap)}</b> пункта. По сегодняшнему темпу объект закроется
       ${late?`<b>${fmt(E.iso(c.endForecast))}</b> вместо ${fmt(E.iso(c.endPlan))}`:'в плановый срок'}.`
    : `Факт идёт вровень с планом или выше. Прогнозная дата — ${fmt(E.iso(c.endForecast))}.`}
    ${c.guessed
      ? `Факт по ${c.guessed} из ${c.works} работ восстановлен по их же плану — записей в хронологии
         по ним пока нет. Линия не поднимается выше достигнутого процента.`
      : 'Факт построен по записям хронологии.'}</p>`;
}

/* ---- 2. Диаграмма Гантта со связями ---- */
function ganttChart(box){
  if(!box)return;
  const ws=S.works.filter(w=>!isNaN(E.planStartTs(w))&&!isNaN(E.planEndTs(w)))
    .sort((a,b)=>E.planStartTs(a)-E.planStartTs(b));
  if(!ws.length){box.innerHTML='<div class="empty">Нет работ с плановыми сроками</div>';return}
  const t0=Math.min.apply(null,ws.map(E.planStartTs).concat([NOW]));
  const t1=Math.max.apply(null,ws.map(w=>Math.max(E.planEndTs(w),eta(w))).concat([NOW]));
  const L=228,R=16,T=30,RH=26,H=T+ws.length*RH+22,W=1000;
  const x=t=>L+(t-t0)/((t1-t0)||1)*(W-L-R);
  const yc=i=>T+i*RH+RH/2;
  const pos={};ws.forEach((w,i)=>{pos[w.id]={i,x1:x(E.planStartTs(w)),x2:x(E.planEndTs(w)),y:yc(i)}});
  const col=w=>w.status==='done'?'ok':calc(w).level;
  box.innerHTML=`<div class="scroll"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:720px;height:${H}px"
      role="img" aria-label="Диаграмма Гантта">
    ${monthTicks(t0,t1,12).map(k=>`<line x1="${x(k.t)}" y1="${T-8}" x2="${x(k.t)}" y2="${H-14}" stroke="var(--line)"/>
      <text x="${x(k.t)}" y="${T-14}" font-size="11" fill="var(--mut)" text-anchor="middle">${esc(k.s)}</text>`).join('')}
    ${ws.map((w,i)=>`<line x1="${L}" y1="${T+i*RH}" x2="${W-R}" y2="${T+i*RH}" stroke="var(--line)" opacity=".5"/>`).join('')}
    ${ws.map(w=>E.depIds(w).filter(d=>pos[d]).map(d=>{
      const a=pos[d],b=pos[w.id],mx=Math.max(a.x2+8,b.x1-10);
      return `<path d="M${a.x2} ${a.y} H${mx} V${b.y} H${b.x1-4}" fill="none" stroke="var(--mut)"
        stroke-width="1" opacity=".5"/><circle cx="${b.x1-3}" cy="${b.y}" r="2" fill="var(--mut)"/>`;
    }).join('')).join('')}
    ${ws.map((w,i)=>{
      const c=col(w),a=pos[w.id],f=eta(w),wd=Math.max(3,a.x2-a.x1);
      const fx=x(f),tail=fx>a.x2+1;
      return `<g><title>${esc(w.id+' '+w.name)} · план ${fmt(w.planStart)} → ${fmt(w.planEnd)} · факт ${w.progress} %${
          tail?' · прогноз '+fmt(E.iso(f)):''}</title>
        <text x="8" y="${a.y+4}" font-size="12" fill="var(--ink)">${esc(cut(w.id+' '+w.name,30))}</text>
        <rect x="${a.x1}" y="${a.y-8}" width="${wd}" height="16" rx="4" fill="var(--idle-soft)" stroke="var(--line)"/>
        ${tail?`<rect x="${a.x2}" y="${a.y-5}" width="${Math.max(2,fx-a.x2)}" height="10" rx="3"
            fill="var(--warn)" opacity=".35"/>`:''}
        <rect class="grow" x="${a.x1}" y="${a.y-8}" width="${Math.max(0,wd*w.progress/100)}" height="16" rx="4"
          fill="var(--${c})" opacity=".9"/>
        <text x="${a.x1+wd+6}" y="${a.y+4}" font-size="11" fill="var(--mut)">${w.progress} %</text></g>`;
    }).join('')}
    <line x1="${x(NOW)}" y1="${T-8}" x2="${x(NOW)}" y2="${H-14}" stroke="var(--brand)" stroke-width="2"/>
    <text x="${x(NOW)}" y="${H-2}" font-size="11" fill="var(--brand)" text-anchor="middle">сегодня</text>
  </svg></div>
  <div class="legend">
    <span><i style="background:var(--idle-soft);border:1px solid var(--line)"></i>плановый срок</span>
    <span><i style="background:var(--ok)"></i>сделано</span>
    <span><i style="background:var(--warn);opacity:.45"></i>прогнозный хвост за план</span>
    <span><i class="arrow"></i>связь «после»</span>
  </div>`;
}

/* ---- 3. Участки: ожидание против факта ---- */
function sectionBars(box){
  if(!box)return;
  const rows=S.sections.map(s=>{
    const ws=S.works.filter(w=>w.section===s.id);
    const f=ws.length?ws.reduce((a,w)=>a+w.progress,0)/ws.length:0;
    const e=ws.length?ws.reduce((a,w)=>a+E.expectedAt(w,NOW),0)/ws.length:0;
    return{s,n:ws.length,f:Math.round(f),e:Math.round(e)};
  });
  if(!rows.length){box.innerHTML='<div class="empty">Участки не заведены</div>';return}
  const W=1000,H=250,L=40,R=16,T=14,B=46;
  const y=v=>T+(100-v)/100*(H-T-B);
  const bw=Math.min(74,(W-L-R)/rows.length/2.6);
  const cx=i=>L+(W-L-R)*(i+0.5)/rows.length;
  box.innerHTML=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:${H}px" role="img"
      aria-label="Готовность по участкам: ожидание и факт">
    ${[0,25,50,75,100].map(v=>`<line x1="${L}" y1="${y(v)}" x2="${W-R}" y2="${y(v)}" stroke="var(--line)"/>
      <text x="${L-6}" y="${y(v)+4}" font-size="11" fill="var(--mut)" text-anchor="end">${v}</text>`).join('')}
    ${rows.map((r,i)=>{
      const c=cx(i),lvl=r.f+10<r.e?(r.f+25<r.e?'bad':'warn'):'ok';
      return `<g><title>${esc(r.s.name)} · ожидалось ${r.e} %, сделано ${r.f} %</title>
        <rect class="growY" x="${c-bw-3}" y="${y(r.e)}" width="${bw}" height="${H-B-y(r.e)}" rx="4" fill="var(--idle)" opacity=".55"/>
        <rect class="growY" x="${c+3}" y="${y(r.f)}" width="${bw}" height="${H-B-y(r.f)}" rx="4" fill="var(--${lvl})"/>
        <text x="${c-bw/2-3}" y="${y(r.e)-5}" font-size="11" fill="var(--mut)" text-anchor="middle">${r.e}</text>
        <text x="${c+bw/2+3}" y="${y(r.f)-5}" font-size="12" font-weight="600" fill="var(--${lvl})" text-anchor="middle">${r.f}</text>
        <text x="${c}" y="${H-B+18}" font-size="12" fill="var(--ink)" text-anchor="middle">${esc(cut(secShort(r.s.id),22))}</text>
        <text x="${c}" y="${H-B+34}" font-size="11" fill="var(--mut)" text-anchor="middle">${esc(E.pkRange(r.s.from,r.s.to))}</text></g>`;
    }).join('')}
  </svg>
  <div class="legend"><span><i style="background:var(--idle);opacity:.55"></i>ожидалось к сегодня</span>
    <span><i style="background:var(--ok)"></i>сделано</span></div>`;
}

/* ---- 4. Отклонение по работам: факт минус ожидание ---- */
function devBars(box){
  if(!box)return;
  const rows=S.works.map(w=>({w,d:Math.round(w.progress-E.expectedAt(w,NOW)),c:calc(w)}))
    .sort((a,b)=>a.d-b.d);
  if(!rows.length){box.innerHTML='<div class="empty">Работы не заведены</div>';return}
  const W=1000,RH=24,T=22,H=T+rows.length*RH+24,L=250,R=40;
  const mid=L+(W-L-R)/2, half=(W-L-R)/2;
  const max=Math.max(25,...rows.map(r=>Math.abs(r.d)));
  const px=d=>d/max*half;
  box.innerHTML=`<div class="scroll"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:620px;height:${H}px"
      role="img" aria-label="Отклонение по работам в пунктах">
    <line x1="${mid}" y1="${T-10}" x2="${mid}" y2="${H-20}" stroke="var(--line)"/>
    <text x="${mid}" y="${T-14}" font-size="11" fill="var(--mut)" text-anchor="middle">0</text>
    <text x="${mid-half}" y="${T-14}" font-size="11" fill="var(--mut)" text-anchor="start">−${max} п.п.</text>
    <text x="${mid+half}" y="${T-14}" font-size="11" fill="var(--mut)" text-anchor="end">+${max} п.п.</text>
    ${rows.map((r,i)=>{
      const y=T+i*RH+RH/2, w=px(Math.abs(r.d));
      const c=r.d<=-25?'bad':r.d<=-10?'warn':r.d<0?'idle':'ok';
      return `<g><title>${esc(r.w.id+' '+r.w.name)} · сделано ${r.w.progress} %, ожидалось ${Math.round(E.expectedAt(r.w,NOW))} %</title>
        <text x="8" y="${y+4}" font-size="12" fill="var(--ink)">${esc(cut(r.w.id+' '+r.w.name,32))}</text>
        <rect class="${r.d<0?'growL':'grow'}" x="${r.d<0?mid-w:mid}" y="${y-7}" width="${Math.max(1,w)}" height="14" rx="3" fill="var(--${c})"/>
        <text x="${r.d<0?mid-w-6:mid+w+6}" y="${y+4}" font-size="11" fill="var(--${c})"
          text-anchor="${r.d<0?'end':'start'}">${r.d>0?'+':''}${r.d}</text></g>`;
    }).join('')}
  </svg></div>
  <p class="hint">Сколько пунктов работа недобрала или набрала сверх ожидаемого на отчётную дату.
    Слева — отстающие, справа — идущие с опережением.</p>`;
}

/* ---- раздел «Графики» ---- */
function charts(m){
  if(!S.works.length){m.innerHTML='<div class="card empty">Работы не заведены — графики появятся после загрузки графика работ.</div>';return}
  m.innerHTML=`
  <div class="card"><h3>Освоение: план, факт, прогноз</h3>
    <p class="hint">Серая линия — как должно идти по плану, красная — как идёт на самом деле,
      пунктир — куда придём при нынешнем темпе.</p>
    <div id="chSc"></div></div>
  <div class="card"><h3>Диаграмма Гантта</h3>
    <p class="hint">Полоса — плановый срок работы, заливка внутри — выполненный объём,
      тонкие линии — связи «после».</p>
    <div id="chG"></div></div>
  <div class="card"><h3>Участки: ожидание и факт</h3>
    <p class="hint">Серый столбец — сколько должно быть сделано на отчётную дату, цветной — сколько сделано.</p>
    <div id="chSec"></div></div>
  <div class="card"><h3>Отклонение по работам</h3><div id="chDev"></div></div>`;
  sCurve($('#chSc'),{h:320});
  ganttChart($('#chG'));
  sectionBars($('#chSec'));
  devBars($('#chDev'));
}


/* ================= работы по пикетажу: слои стройки =================
   Сделано по обсуждению в чате проекта: «нужно видеть, как работы делятся по пикетажам,
   где отставание и где какие виды работ». Цветом — состояние (четыре цвета), видами работ —
   строки-слои, снизу вверх в порядке стройки. Клик по отрезку выбирает пикет:
   под лентой показывается поперечник на этом месте и список работ. */
let PKSEL=ls.get('aksg.pksel',null),LAYER=ls.get('aksg.layer','');
const kindColor=w=>w.status==='done'?'ok':calc(w).level;

function pkBounds(){
  const a=S.sections.map(s=>+s.from).concat(S.works.map(w=>+w.pkFrom)).filter(isFinite);
  const b=S.sections.map(s=>+s.to).concat(S.works.map(w=>+w.pkTo)).filter(isFinite);
  const lo=a.length?Math.min.apply(null,a):0, hi=b.length?Math.max.apply(null,b):lo+100;
  return{lo,hi:hi>lo?hi:lo+100};
}
/* что происходит на этом пикете в данном слое */
function atPk(kind,pk){
  const ws=S.works.filter(w=>E.workKind(w)===kind&&pk>=Math.min(w.pkFrom,w.pkTo)&&pk<=Math.max(w.pkFrom,w.pkTo));
  if(!ws.length)return null;
  const done=ws.every(w=>w.status==='done');
  const worst=ws.some(w=>calc(w).level==='bad')?'bad':ws.some(w=>calc(w).level==='warn')?'warn':'ok';
  const p=Math.round(ws.reduce((a,w)=>a+w.progress,0)/ws.length);
  return{works:ws,level:done?'ok':worst,done,progress:p};
}

function layersView(box){
  const {lo,hi}=pkBounds(),sp=hi-lo||1;
  const kinds=E.KINDS.filter(k=>S.works.some(w=>E.workKind(w)===k.id)).reverse(); /* снизу вверх */
  if(!kinds.length){box.innerHTML='<div class="card empty">Работы не заведены</div>';return}
  const shown=LAYER?kinds.filter(k=>k.id===LAYER):kinds;
  const W=1000,L=172,R=24,T=34,RH=46,H=T+shown.length*RH+40;
  const x=pk=>L+(pk-lo)/sp*(W-L-R);
  const step=sp>400?100:sp>150?50:sp>60?20:10;
  const ticks=[];for(let v=Math.ceil(lo/step)*step;v<=hi;v+=step)ticks.push(v);

  box.innerHTML=`
  <div class="filters" id="layerPick">
    <button data-l="" aria-pressed="${!LAYER}">Все слои</button>
    ${E.KINDS.filter(k=>S.works.some(w=>E.workKind(w)===k.id)).map(k=>
      `<button data-l="${k.id}" aria-pressed="${LAYER===k.id}">${esc(k.name)}</button>`).join('')}
  </div>
  <div class="scroll"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:700px;height:${H}px" id="pkband"
      role="img" aria-label="Работы по пикетажу, слои стройки">
    ${ticks.map(v=>`<line x1="${x(v)}" y1="${T-12}" x2="${x(v)}" y2="${H-26}" stroke="var(--line)"/>
      <text x="${x(v)}" y="${H-8}" font-size="11" fill="var(--mut)" text-anchor="middle">${PK(v)}</text>`).join('')}
    ${S.sections.map(s=>`<line x1="${x(s.to)}" y1="${T-18}" x2="${x(s.to)}" y2="${H-26}" stroke="var(--mut)"
        stroke-dasharray="4 4" opacity=".7"/>
      <text x="${(x(s.from)+x(s.to))/2}" y="${T-20}" font-size="11" fill="var(--mut)" text-anchor="middle">${esc(secShort(s.id))}</text>`).join('')}
    ${shown.map((k,i)=>{
      const y=T+i*RH, ws=S.works.filter(w=>E.workKind(w)===k.id);
      return `<g><text x="8" y="${y+22}" font-size="12" fill="var(--ink)">${esc(cut(k.name,22))}</text>
        <text x="8" y="${y+36}" font-size="10" fill="var(--mut)">${esc(cut(k.hint,24))}</text>
        <rect x="${L}" y="${y+8}" width="${W-L-R}" height="24" rx="5" fill="var(--idle-soft)" opacity=".55"/>
        ${ws.map(w=>{
          const a=x(Math.min(w.pkFrom,w.pkTo)),b=x(Math.max(w.pkTo,w.pkFrom)),wd=Math.max(4,b-a);
          const c=kindColor(w);
          return `<g class="seg" data-w="${esc(w.id)}" style="cursor:pointer">
            <title>${esc(w.id+' '+w.name)} · ${PKR(w.pkFrom,w.pkTo)} · факт ${w.progress} % · ${esc(w.status==='done'?'выполнена':LVL[calc(w).level])}</title>
            <rect x="${a}" y="${y+8}" width="${wd}" height="24" rx="5" fill="var(--${c})" opacity=".22"/>
            <rect class="grow" x="${a}" y="${y+8}" width="${Math.max(2,wd*w.progress/100)}" height="24" rx="5" fill="var(--${c})"/>
            ${wd>58?`<text x="${a+6}" y="${y+24}" font-size="11" fill="#fff" style="pointer-events:none">${w.progress} %</text>`:''}
          </g>`}).join('')}
      </g>`}).join('')}
    ${PKSEL!=null?`<line x1="${x(PKSEL)}" y1="${T-18}" x2="${x(PKSEL)}" y2="${H-26}" stroke="var(--brand)" stroke-width="2"/>
      <circle cx="${x(PKSEL)}" cy="${T-18}" r="4" fill="var(--brand)"/>`:''}
  </svg></div>
  <div class="legend">
    <span><i style="background:var(--ok)"></i>в норме или закрыто</span>
    <span><i style="background:var(--warn)"></i>риск</span>
    <span><i style="background:var(--bad)"></i>отставание</span>
    <span><i style="background:var(--idle-soft);border:1px solid var(--line)"></i>работ нет</span>
    <span class="mut">бледная заливка — плановый фронт, яркая — выполнено</span>
  </div>
  <p class="hint">Нажмите на ленту, чтобы выбрать пикет: ниже появится поперечник пути на этом месте
    и список работ, которые его затрагивают.</p>
  <div id="pkDetail"></div>`;

  $('#layerPick').onclick=e=>{const b=e.target.closest('button');if(!b)return;
    LAYER=b.dataset.l;ls.set('aksg.layer',LAYER);layersView(box)};
  const svg=$('#pkband');
  svg.onclick=e=>{
    const g=e.target.closest('.seg');
    const r=svg.getBoundingClientRect();
    const vx=(e.clientX-r.left)/r.width*W;
    if(vx>L){PKSEL=Math.round((lo+(vx-L)/(W-L-R)*sp)*100)/100;ls.set('aksg.pksel',PKSEL)}
    if(g&&e.detail===2){const w=S.works.find(v=>v.id===g.dataset.w);if(w)return editWork(w)}
    layersView(box);
  };
  pkDetail($('#pkDetail'));
}

/* ---- поперечник пути на выбранном пикете ----
   Конструкция у железной дороги по всей длине почти одна и та же — об этом и говорили в чате.
   Поэтому слои рисуем типовые, а цветом показываем состояние наших работ на этом пикете. */
function pkDetail(box){
  if(!box)return;
  if(PKSEL==null){box.innerHTML='<p class="hint">Пикет не выбран.</p>';return}
  const here=E.KINDS.map(k=>({k,s:atPk(k.id,PKSEL)})).filter(x=>x.s);
  const st=id=>{const x=here.find(v=>v.k.id===id);return x?x.s:null};
  const fill=id=>{const s=st(id);return s?`var(--${s.level})`:'var(--idle-soft)'};
  const op=id=>{const s=st(id);return s?(s.done?.95:0.3+0.6*s.progress/100):1};
  const W=760,H=320;
  /* слой, по которому работ нет, всё равно должен читаться: даём ему контур, а не пустоту */
  const edge=id=>st(id)?'var(--line)':'var(--mut)';
  const lbl=(x,y,id,text,anchor)=>{const s=st(id);
    return `<text x="${x}" y="${y}" font-size="11" text-anchor="${anchor||'start'}"
      fill="var(--${s?s.level:'mut'})">${esc(text)}${s?' · '+s.progress+' %':' · работ нет'}</text>`};
  box.innerHTML=`
  <div class="grid k2" style="margin-top:14px">
    <div class="card" style="margin:0">
      <h3>Поперечник на ${PK(PKSEL)}</h3>
      <p class="hint">Типовая конструкция пути — по всей длине она почти одна и та же.
        Цвет слоя — состояние наших работ этого вида на выбранном пикете,
        насыщенность — сколько выполнено.</p>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:${H}px" role="img"
          aria-label="Поперечный профиль пути на выбранном пикете">
        <line x1="20" y1="252" x2="740" y2="252" stroke="var(--line)" stroke-dasharray="5 4"/>
        <text x="20" y="268" font-size="10" fill="var(--mut)">природный рельеф</text>

        <path d="M120 252 L300 150 L560 150 L740 252 Z" fill="${fill('zem')}" opacity="${op('zem')}"
          stroke="${edge('zem')}"/>
        <path d="M330 150 L368 112 L512 112 L550 150 Z" fill="${fill('vsp')}" opacity="${op('vsp')}"
          stroke="${edge('vsp')}"/>
        <rect x="378" y="104" width="124" height="8" rx="2" fill="${fill('vsp')}" opacity="${op('vsp')}"
          stroke="${edge('vsp')}"/>
        <rect x="396" y="96" width="7" height="10" rx="1" fill="var(--ink)" opacity=".7"/>
        <rect x="477" y="96" width="7" height="10" rx="1" fill="var(--ink)" opacity=".7"/>

        <line x1="600" y1="150" x2="600" y2="46" stroke="${fill('el')}" opacity="${op('el')}" stroke-width="7"/>
        <line x1="600" y1="46" x2="596" y2="150" stroke="${edge('el')}" stroke-width="1" opacity=".6"/>
        <line x1="600" y1="54" x2="440" y2="66" stroke="${fill('el')}" opacity="${op('el')}" stroke-width="3"/>
        <line x1="440" y1="66" x2="440" y2="94" stroke="${fill('el')}" opacity="${op('el')}" stroke-width="2"/>

        <rect x="236" y="206" width="24" height="34" rx="4" fill="${fill('scb')}" opacity="${op('scb')}"
          stroke="${edge('scb')}"/>
        <line x1="248" y1="206" x2="248" y2="172" stroke="${fill('scb')}" opacity="${op('scb')}" stroke-width="5"/>
        <circle cx="248" cy="168" r="6" fill="${fill('scb')}" opacity="${op('scb')}" stroke="${edge('scb')}"/>

        <ellipse cx="690" cy="236" rx="30" ry="11" fill="${fill('isso')}" opacity="${op('isso')}"
          stroke="${edge('isso')}"/>
        <ellipse cx="690" cy="236" rx="13" ry="5" fill="var(--card)" stroke="${edge('isso')}"/>

        ${lbl(560,100,'vsp','балласт и путь')}
        ${lbl(614,44,'el','контактная сеть')}
        ${lbl(196,200,'scb','СЦБ','end')}
        ${lbl(20,38,'zem','земляное полотно')}
        ${lbl(740,268,'isso','водопропуск','end')}
      </svg>
    </div>
    <div class="card" style="margin:0">
      <h3>Что идёт на ${PK(PKSEL)}</h3>
      ${here.length?here.map(({k,s})=>`<div class="rowline">
        <div class="grow"><div>${esc(k.name)}</div>
          <div class="small mut">${s.works.map(w=>esc(w.id+' '+cut(w.name,28))).join(' · ')}</div></div>
        <div style="min-width:92px"><div class="bar"><i style="--w:${s.progress}%;background:var(--${s.level})"></i></div>
          <div class="small mut" style="text-align:right">${s.progress} %</div></div></div>`).join('')
        :'<div class="empty">На этом пикете работ нет</div>'}
      ${here.length?`<p class="hint" style="margin-top:12px">Двойной клик по отрезку на ленте открывает карточку работы.</p>`:''}
    </div>
  </div>`;
}


/* ================= продольный профиль =================
   То, как профиль выглядит на бумаге у проектировщика: сверху линии земли и проектная,
   снизу «подвал» с отметками, рабочими отметками и уклонами. Сверху добавлена полоса
   состояния работ — ради этого всё и затевалось: видно не только какой здесь профиль,
   но и что на этом месте сделано. */
function profileView(box){
  const prof=(S.profile||[]).filter(r=>r&&isFinite(r.pk));
  const ro=RO();
  const head=`<div class="rowline" style="border:0;padding:0 0 10px">
    <div class="grow"><h3 style="margin:0">Продольный профиль</h3></div>
    ${ro?'':`<label class="btn sm">Загрузить профиль
      <input type="file" id="profFile" accept=".xlsx,.xls,.csv" class="hide"></label>`}</div>
    <div id="profMsg" class="small mut"></div>`;
  if(!prof.length){
    box.innerHTML=`<div class="card">${head}
      <div class="empty" style="text-align:left">
        <p>Профиль ещё не загружен. Нужна ведомость проектировщика — таблица с колонками
        <b>Пикет</b>, <b>Отметка земли</b>, <b>Проектная отметка</b>; примечание необязательно.</p>
        <p class="hint">Пикет понимается и как «ПК 125+50», и как число. Отметки — в метрах.
        Система ничего не достраивает: что в ведомости, то и на чертеже.</p>
        ${ro?'':`<div class="btnrow"><button class="btn sm" id="profDemo">Заполнить демонстрационными отметками</button></div>
        <p class="hint">Кнопка ставит четырнадцать условных точек, чтобы посмотреть, как выглядит раздел.
        Они помечены как демонстрационные и заменяются первой же загрузкой настоящей ведомости.</p>`}
      </div></div>`;
    bindProfileUpload();
    const dm=$('#profDemo');
    if(dm)dm.onclick=async()=>{
      const msg=$('#profMsg');msg.textContent='Заполняю…';
      try{
        const r=await fetch('/api/profile',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({demo:true})});
        const d=await r.json();
        if(!r.ok)throw new Error(d.error||'код '+r.status);
        await pull();render();
      }catch(e){msg.innerHTML=`<span style="color:var(--bad)">Не вышло: ${esc(e.message)}</span>`}
    };
    return;
  }
  const sum=E.profileSummary(prof);
  const lo=sum.from,hi=sum.to,sp=(hi-lo)||1;
  const pad=Math.max(0.5,(sum.max-sum.min)*0.15)||1;
  const h0=sum.min-pad,h1=sum.max+pad,hs=(h1-h0)||1;
  const W=1000,L=126,R=18,T=22,PH=190,SH=16,RH=20;
  const rows=['Проектная отметка','Отметка земли','Рабочая отметка','Уклон ‰ / длина','Пикет'];
  const H=T+PH+SH+8+rows.length*RH+10;
  const x=pk=>L+(pk-lo)/sp*(W-L-R);
  const y=h=>T+(h1-h)/hs*PH;
  const base=T+PH;
  /* состояние работ на пикете — то же, что в слоях, но одной полосой */
  const worstAt=pk=>{
    const ws=S.works.filter(w=>pk>=Math.min(w.pkFrom,w.pkTo)&&pk<=Math.max(w.pkFrom,w.pkTo));
    if(!ws.length)return null;
    if(ws.every(w=>w.status==='done'))return'ok';
    return ws.some(w=>calc(w).level==='bad')?'bad':ws.some(w=>calc(w).level==='warn')?'warn':'ok';
  };
  const N=120,strip=[];
  for(let i=0;i<N;i++){
    const a=lo+sp*i/N,b=lo+sp*(i+1)/N,lv=worstAt((a+b)/2);
    if(lv)strip.push(`<rect x="${x(a)}" y="${T+PH+4}" width="${Math.ceil(x(b)-x(a))+1}" height="${SH-4}"
      fill="var(--${lv})" opacity=".85"/>`);
  }
  const marks=[];
  for(let k=Math.ceil(h0);k<=h1;k++)if((k-Math.ceil(h0))%2===0)marks.push(k);
  const cell=(i,txt,cls)=>{
    const a=x(prof[i].pk);
    return `<text x="${a}" y="${0}" font-size="10" fill="var(--${cls||'ink'})" text-anchor="middle"
      transform="translate(0,${0})">${esc(txt)}</text>`;
  };
  const rowY=n=>base+SH+8+n*RH+14;

  box.innerHTML=`<div class="card">${head}
  <p class="hint">Чёрная линия — земля, красная — проектная. Заливка между ними: зелёная насыпь,
    жёлтая выемка. Полоса под чертежом — состояние наших работ на этом месте.</p>
  <div class="scroll"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:780px;height:${H}px"
      role="img" aria-label="Продольный профиль пути">
    ${marks.map(m=>`<line x1="${L}" y1="${y(m)}" x2="${W-R}" y2="${y(m)}" stroke="var(--line)" opacity=".7"/>
      <text x="${L-6}" y="${y(m)+4}" font-size="10" fill="var(--mut)" text-anchor="end">${m}</text>`).join('')}
    ${prof.map(r=>`<line x1="${x(r.pk)}" y1="${T}" x2="${x(r.pk)}" y2="${base+SH+8+rows.length*RH}"
       stroke="var(--line)" opacity=".55"/>`).join('')}
    ${prof.slice(0,-1).map((r,i)=>{
      const n=prof[i+1];
      if(r.ground==null||r.design==null||n.ground==null||n.design==null)return'';
      const up=((r.design-r.ground)+(n.design-n.ground))/2>=0;
      return `<polygon points="${x(r.pk)},${y(r.ground)} ${x(r.pk)},${y(r.design)}
        ${x(n.pk)},${y(n.design)} ${x(n.pk)},${y(n.ground)}"
        fill="var(--${up?'ok':'warn'})" opacity=".16"/>`}).join('')}
    <polyline points="${prof.filter(r=>r.ground!=null).map(r=>x(r.pk)+','+y(r.ground)).join(' ')}"
      fill="none" stroke="var(--ink)" stroke-width="2"/>
    <polyline class="draw" pathLength="1"
      points="${prof.filter(r=>r.design!=null).map(r=>x(r.pk)+','+y(r.design)).join(' ')}"
      fill="none" stroke="var(--brand)" stroke-width="2.5"/>
    ${strip.join('')}
    <text x="8" y="${T+PH/2}" font-size="11" fill="var(--mut)">отметки, м</text>
    <text x="8" y="${base+SH}" font-size="10" fill="var(--mut)">работы</text>
    ${rows.map((r,i)=>`<text x="8" y="${rowY(i)}" font-size="11" fill="var(--mut)">${esc(r)}</text>
      <line x1="${L}" y1="${rowY(i)+5}" x2="${W-R}" y2="${rowY(i)+5}" stroke="var(--line)"/>`).join('')}
    ${prof.map(r=>{
      const w=E.working(r);
      return `<g><title>${PK(r.pk)} · земля ${r.ground!=null?r.ground.toFixed(2):'—'} ·
          проект ${r.design!=null?r.design.toFixed(2):'—'}${w!=null?' · '+(w>0?'насыпь ':'выемка ')+Math.abs(w).toFixed(2)+' м':''}</title>
        <text x="${x(r.pk)}" y="${rowY(0)}" font-size="10" fill="var(--brand)" text-anchor="middle">${r.design!=null?r.design.toFixed(2):'—'}</text>
        <text x="${x(r.pk)}" y="${rowY(1)}" font-size="10" fill="var(--ink)" text-anchor="middle">${r.ground!=null?r.ground.toFixed(2):'—'}</text>
        <text x="${x(r.pk)}" y="${rowY(2)}" font-size="10" text-anchor="middle"
          fill="var(--${w==null?'mut':w>0?'ok':'warn'})">${w==null?'—':(w>0?'+':'')+w.toFixed(2)}</text>
        <text x="${x(r.pk)}" y="${rowY(4)}" font-size="10" fill="var(--mut)" text-anchor="middle">${E.pkFmt(r.pk)}</text>
      </g>`}).join('')}
    ${prof.slice(0,-1).map((r,i)=>{
      const n=prof[i+1],s=E.slope(r,n),mx=(x(r.pk)+x(n.pk))/2,len=Math.round((n.pk-r.pk)*100);
      if(s==null)return'';
      return `<text x="${mx}" y="${rowY(3)-4}" font-size="9" fill="var(--ink)" text-anchor="middle">${s>0?'+':''}${s}</text>
        <text x="${mx}" y="${rowY(3)+6}" font-size="9" fill="var(--mut)" text-anchor="middle">${len} м</text>`;
    }).join('')}
    ${PKSEL!=null&&PKSEL>=lo&&PKSEL<=hi?`<line x1="${x(PKSEL)}" y1="${T}" x2="${x(PKSEL)}" y2="${base+SH}"
      stroke="var(--brand)" stroke-width="2" stroke-dasharray="4 3"/>`:''}
  </svg></div>
  <div class="legend">
    <span><i style="background:var(--ink)"></i>земля</span>
    <span><i style="background:var(--brand)"></i>проектная линия</span>
    <span><i style="background:var(--ok);opacity:.4"></i>насыпь</span>
    <span><i style="background:var(--warn);opacity:.4"></i>выемка</span>
    <span><i style="background:var(--bad)"></i>полоса под чертежом — состояние работ на этом месте</span>
  </div>
  <div class="grid k4" style="margin-top:14px">
    <div class="card kpi" style="margin:0"><span>Точек в профиле</span><b>${sum.points}</b></div>
    <div class="card kpi" style="margin:0"><span>Отметки, м</span><b>${sum.min.toFixed(1)}–${sum.max.toFixed(1)}</b></div>
    <div class="card kpi" style="margin:0"><span>Насыпь / выемка</span><b>${sum.fill} / ${sum.cut}</b></div>
    <div class="card kpi" style="margin:0"><span>Самый крутой уклон</span>
      <b>${sum.steep?(sum.steep.i>0?'+':'')+sum.steep.i+' ‰':'—'}</b>
      ${sum.steep?`<div class="small mut">${PKR(sum.steep.from,sum.steep.to)}</div>`:''}</div>
  </div>
  <p class="hint">Отметки и уклоны — данные проектировщика из загруженной ведомости.
    Система их не пересчитывает и не достраивает.</p></div>`;
  bindProfileUpload();
}
function bindProfileUpload(){
  const f=$('#profFile');if(!f)return;
  f.onchange=async e=>{
    const file=e.target.files[0];if(!file)return;
    const msg=$('#profMsg');msg.textContent='Читаю ведомость…';
    try{
      await loadXLSX();
      const wb=XLSX.read(await file.arrayBuffer(),{type:'array'});
      const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
      const prof=E.profileRows(rows);
      if(!prof.length)throw new Error('не нашёл колонки «Пикет» и отметки');
      const r=await fetch('/api/profile',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({profile:prof})});
      const d=await r.json();
      if(!r.ok)throw new Error(d.error||'код '+r.status);
      msg.innerHTML=`<span style="color:var(--ok)">Загружено точек: ${d.saved}, с ${PK(d.from)} по ${PK(d.to)}.</span>`;
      await pull();render();
    }catch(err){msg.innerHTML=`<span style="color:var(--bad)">Не вышло: ${esc(err.message)}</span>`}
  };
}

/* ---------------- КСГ ---------------- */
let F={sec:'',lvl:''};
function ksg(m){
  m.innerHTML=`<div class="filters" id="filters"></div><div id="ksgbody"></div>`;
  drawFilters();drawKsg();
}
function drawFilters(){
  const f=[['sec','','Все участки'],...S.sections.map(s=>['sec',s.id,s.name.replace(/\s*\(.*\)/,'')]),
           ['lvl','bad','Только отклонения'],['lvl','warn','Риск']];
  $('#filters').innerHTML=f.map(([k,v,t])=>
    `<button data-k="${k}" data-v="${v}" aria-pressed="${F[k]===v}">${esc(t)}</button>`).join('');
  $('#filters').onclick=e=>{const b=e.target.closest('button');if(!b)return;
    F[b.dataset.k]=F[b.dataset.k]===b.dataset.v?'':b.dataset.v;drawFilters();drawKsg()};
}
const visible=()=>S.works.map(w=>({w,c:calc(w)}))
  .filter(r=>(!F.sec||r.w.section===F.sec)&&(!F.lvl||r.c.level===F.lvl));
function drawKsg(){
  const rows=visible(),wide=matchMedia('(min-width:1200px)').matches;
  $('#ksgbody').innerHTML=rows.length?(wide?table(rows):cards(rows))
    :`<div class="card empty">${S.works.length?'Нет работ по выбранному фильтру'
      :'Работ пока нет. Добавьте первую или загрузите график в разделе «Файлы».'}</div>`;
  bindKsg();
}
function cards(rows){
  const ro=RO();
  return `<div class="cards">`+rows.map(({w,c})=>`
   <div class="card wcard" data-id="${w.id}">
     <div class="top"><h3 class="grow">${esc(w.name)}</h3>${mark(w,c)}</div>
     ${(()=>{const p=proofState(w);return p?chip(p[0],p[1]):''})()}
     <div class="small mut">${esc(secShort(w.section))} · ${PKR(w.pkFrom,w.pkTo)} · план ${fmt(w.planStart)} → ${fmt(w.planEnd)}</div>
     <div class="bar"><i style="--w:${w.progress}%;background:var(--${w.status==='done'?'ok':c.level})"></i></div>
     <div class="fact"><b>${w.progress}%</b>
       ${ro?'':`<input type="range" min="0" max="100" step="5" value="${w.progress}" data-range aria-label="Факт по работе ${esc(w.name)}">
       <button class="btn sq" data-step="-5" aria-label="Минус 5 процентов">−</button>
       <button class="btn sq" data-step="5" aria-label="Плюс 5 процентов">+</button>`}</div>
     <div class="small" style="${c.noProof?'color:var(--warn)':'color:var(--mut)'}">
       ${w.status==='done'?'Работа закрыта':'прогноз '+fmt(E.iso(eta(w)))+(c.delayDays?' · +'+c.delayDays+' дн.':'')}
       ${esc(tempoText(w))}
       ${c.capped?' · темп очень низкий, прогноз ограничен':''}
       ${c.startedEarly?' · начата до завершения '+c.blockers.join(', '):''}</div>
     ${pendingFor(w.id).map(p=>`<div class="note warn" style="padding:8px 10px">
       <div class="grow small"><b>${esc(p.device)}: ${p.progress}%</b>${p.progress!==w.progress
         ? ` — у нас ${w.progress}%, расхождение ${Math.abs(p.progress-w.progress)} п.п.`:' — совпадает с учтённым'}
         ${p.ref?'<br>'+esc(p.ref):''}</div>
       ${RO()?'':`<div class="btnrow" style="margin-top:8px">
         <button class="btn sm pri" data-accept="${p.id}">Принять</button>
         <button class="btn sm" data-reject="${p.id}">Отклонить</button></div>`}</div>`).join('')}
     <div class="acts">
       ${ro?'':'<button class="btn pri" data-proof>Подтвердить факт</button>'}
       <button class="btn" data-edit>${ro?'Подробно':'Детали'}</button></div>
   </div>`).join('')+`</div>`;
}
function table(rows){
  const ro=RO(),dis=ro?' disabled':'';
  const all=S.works.flatMap(w=>[E.planStartTs(w),E.planEndTs(w),eta(w)]).filter(n=>!isNaN(n));
  all.push(NOW);
  const t0=Math.min.apply(null,all),t1=Math.max.apply(null,all),span=(t1-t0)||1;
  const pos=t=>Math.max(0,Math.min(100,(t-t0)/span*100));
  return `<div class="card scroll" id="ksgscroll"><div class="froze-hint" id="frozeHint">
    <b>ID и Работа</b> закреплены слева <span class="sep">·</span> остальные колонки листаются вбок
    <span class="arr">→</span></div><table class="froze"><thead><tr>
   <th>ID</th><th>Работа</th><th>Участок</th><th>ПК</th><th>План с</th><th>План по</th><th>Факт %</th>
   <th>Статус</th><th style="min-width:176px">План / прогноз</th><th>Оценка</th><th></th></tr></thead><tbody>`+
   rows.map(({w,c})=>{const f=eta(w);return `<tr data-id="${w.id}">
   <td class="mut">${w.id}</td>
   <td><input data-f="name" value="${esc(w.name)}" style="min-width:208px"${dis}></td>
   <td><select data-f="section"${dis}>${S.sections.map(s=>`<option value="${s.id}" ${s.id===w.section?'selected':''}>${esc(s.id)}</option>`).join('')}</select></td>
   <td style="white-space:nowrap" class="pkcell"><input data-f="pkFrom" value="${E.pkFmt(w.pkFrom)}" inputmode="decimal"
     title="Пикет начала: 125+50 — это 125-й пикет и ещё 50 м" style="width:74px;display:inline-block"${dis}>–<input
     data-f="pkTo" value="${E.pkFmt(w.pkTo)}" inputmode="decimal"
     title="Пикет конца" style="width:74px;display:inline-block"${dis}></td>
   <td><input data-f="planStart" type="date" value="${w.planStart||''}" style="min-width:124px"${dis}></td>
   <td><input data-f="planEnd" type="date" value="${w.planEnd||''}" style="min-width:124px"${dis}></td>
   <td><input data-f="progress" type="number" min="0" max="100" value="${w.progress}" style="width:64px"${dis}></td>
   <td><select data-f="status" style="min-width:118px"${dis}>${Object.entries(E.STATUS).map(([k,v])=>`<option value="${k}" ${k===w.status?'selected':''}>${v}</option>`).join('')}</select></td>
   <td><div class="gantt">
     <div class="pl" style="left:${pos(E.planStartTs(w))}%;width:${Math.max(1,pos(E.planEndTs(w))-pos(E.planStartTs(w)))}%"></div>
     <div class="fc" style="left:${pos(E.planStartTs(w))}%;width:${Math.max(1,pos(Math.max(f,E.planStartTs(w)))-pos(E.planStartTs(w)))}%;background:var(--${w.status==='done'?'ok':c.level})"></div>
     <div class="now" style="left:${pos(NOW)}%"></div></div>
     <div class="small mut" style="margin-top:3px">прогноз ${fmt(E.iso(f))}</div></td>
   <td>${mark(w,c)}${c.delayDays?`<div class="small mut">+${c.delayDays} дн.</div>`:''}
     ${c.noProof?'<div class="small" style="color:var(--warn)">нет подтверждения</div>':''}</td>
   <td><button class="btn sm" data-edit>${ro?'Подробно':'Детали'}</button></td></tr>`}).join('')+
   `</tbody></table></div>`;
}
/* пикетаж всегда показываем в привычном виде «ПК 125+50» */
const PK=v=>E.pkLabel(v), PKR=(a,b)=>E.pkRange(a,b);
function setProgress(w,v){
  if(RO())return;
  if(!E.setProgress(w,v,$('#today').value))return;
  touch(w.id);drawKsg();
}
function bindKsg(){
  const sc=$('#ksgscroll');
  if(sc){
    /* колонки встают к краю закреплённого блока, а не замирают разрезанными пополам */
    const th=sc.querySelectorAll('thead th');
    const w1=th.length?th[0].getBoundingClientRect().width:0;
    const fw=th.length>1?w1+th[1].getBoundingClientRect().width:0;
    if(fw){sc.style.setProperty('--fz1',w1.toFixed(2)+'px');
      sc.style.scrollPaddingLeft=Math.ceil(fw)+'px';sc.classList.add('snap')}
    /* перерисовка не должна сбрасывать таблицу обратно влево: человек листает и смотрит */
    sc.scrollLeft=ksgX;
    const upd=()=>{ksgX=sc.scrollLeft;sc.classList.toggle('shifted',sc.scrollLeft>4)};
    sc.addEventListener('scroll',upd,{passive:true});upd();
  }
  const body=$('#ksgbody');
  body.onclick=e=>{
    const acc=e.target.closest('[data-accept]'),rej=e.target.closest('[data-reject]');
    if(acc)return decide(+acc.dataset.accept,'accept');
    if(rej)return decide(+rej.dataset.reject,'reject');
    const host=e.target.closest('[data-id]');if(!host)return;
    const w=S.works.find(v=>v.id===host.dataset.id);
    if(e.target.closest('[data-step]'))return setProgress(w,w.progress+ +e.target.closest('[data-step]').dataset.step);
    if(e.target.closest('[data-edit]'))return editWork(w);
    if(e.target.closest('[data-proof]'))return editProof(w.id);
  };
  body.oninput=e=>{if(e.target.matches('[data-range]'))
    e.target.closest('[data-id]').querySelector('.fact b').textContent=e.target.value+'%'};
  body.onchange=e=>{
    const host=e.target.closest('[data-id]');if(!host||RO())return;
    const w=S.works.find(v=>v.id===host.dataset.id);
    if(e.target.matches('[data-range]'))return setProgress(w,+e.target.value);
    const f=e.target.dataset.f;if(!f)return;
    let v=e.target.value;
    if(f==='progress')return setProgress(w,+v);
    if(f==='pkFrom'||f==='pkTo')v=Math.max(0,E.pkParse(v));
    if((f==='planStart'||f==='planEnd')&&v!==w[f]){
      const why=prompt('Плановые сроки меняются только с основанием.\nСправка ГИПа, распоряжение:');
      if(!why||!why.trim()){drawKsg();return}
      w.planReason=why.trim();
    }
    w[f]=v;
    if(f==='status'&&v==='done')w.progress=100;
    touch(w.id);drawKsg();
  };
}

/* решение по сводке оборудования принимает человек */
async function decide(id,decision){
  let reason='';
  if(decision==='reject'){
    reason=prompt('Почему сводка отклонена? Это останется в журнале.')||'';
    if(!reason.trim())return;
  }
  try{
    const r=await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({id,decision,reason})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'не вышло');
    await pull();render();loadAlerts();
  }catch(e){alert('Не получилось: '+e.message)}
}

/* ---------------- карточки правки ---------------- */
const openSheet=cb=>{const d=$('#dlg');d.showModal();d.onclose=()=>cb(d.returnValue)};
function editWork(w){
  const ro=RO(),isNew=!w;
  if(isNew){const n=Math.max(0,...S.works.map(v=>+String(v.id).slice(1)||0))+1;
    w=E.newWork('W'+n,'Новая работа',S.sections[0]?.id||'S1',0,10,$('#today').value,$('#today').value,0,'plan','manual','','')}
  const d=ro?' disabled':'';
  $('#form').innerHTML=`
   <h2>${isNew?'Новая работа':'Работа '+w.id}</h2>
   <div class="fl"><label>Наименование</label><input name="name" value="${esc(w.name)}" required${d}></div>
   <div class="two">
     <div class="fl"><label>Участок</label><select name="section"${d}>${S.sections.map(s=>`<option value="${s.id}" ${s.id===w.section?'selected':''}>${esc(s.name)}</option>`).join('')}</select></div>
     <div class="fl"><label>Предшественники (ID через запятую)</label><input name="dep" value="${esc(w.dep)}" placeholder="W1, W2"${d}></div>
     <div class="fl"><label>Пикет от</label><input name="pkFrom" value="${E.pkFmt(w.pkFrom)}" inputmode="decimal"
       placeholder="125+50"${d}><span class="hint">125+50 — 125-й пикет и ещё 50 м</span></div>
     <div class="fl"><label>Пикет до</label><input name="pkTo" value="${E.pkFmt(w.pkTo)}" inputmode="decimal"
       placeholder="130+00"${d}></div>
     <div class="fl"><label>План с</label><input name="planStart" type="date" value="${w.planStart||''}"${d}></div>
     <div class="fl"><label>План по</label><input name="planEnd" type="date" value="${w.planEnd||''}"${d}></div>
     <div class="fl"><label>Факт, %</label><input name="progress" type="number" min="0" max="100" value="${w.progress}"${d}></div>
     <div class="fl"><label>Статус</label><select name="status"${d}>${Object.entries(E.STATUS).map(([k,v])=>`<option value="${k}" ${k===w.status?'selected':''}>${v}</option>`).join('')}</select></div>
   </div>
   <div class="fl"><label>Источник факта</label><select name="source"${d}>${Object.entries(E.SRC).map(([k,v])=>`<option value="${k}" ${k===w.source?'selected':''}>${v}</option>`).join('')}</select></div>
   <div class="fl"><label>Примечание</label><input name="note" value="${esc(w.note)}"${d}></div>
   <div class="fl hide" id="planwhy"><label>Основание изменения сроков — справка ГИПа, распоряжение</label>
     <input name="planReason" placeholder="Справка ГИПа №12 от 18.11.2026"></div>
   ${w.updatedBy?`<p class="hint">Последняя правка: ${esc(w.updatedBy)}${w.updatedAt?', '+esc(String(w.updatedAt).slice(0,16).replace('T',' ')):''}</p>`:''}
   <div class="foot">
     ${ro?'<button class="btn" value="x">Закрыть</button>'
        :`<button class="btn pri" value="ok">Сохранить</button>
          <button class="btn" value="x" formnovalidate>Отмена</button>
          ${isNew?'':'<button class="btn bad" value="del" formnovalidate>Удалить</button>'}`}
   </div>`;
  const watch=()=>{
    const f=$('#form'),ps=f.querySelector('[name=planStart]'),pe=f.querySelector('[name=planEnd]');
    const show=()=>{const ch=ps.value!==(w.planStart||'')||pe.value!==(w.planEnd||'');
      $('#planwhy').classList.toggle('hide',!ch);
      f.querySelector('[name=planReason]').required=ch};
    ps.onchange=pe.onchange=show;show();
  };
  if(!ro)watch();
  openSheet(r=>{
    if(ro||r==='x'||!r)return;
    if(r==='del'){if(!confirm('Удалить работу '+w.id+'? Подтверждения по ней тоже удалятся.'))return;
      S.works=S.works.filter(v=>v.id!==w.id);S.evidence=S.evidence.filter(v=>v.work!==w.id);
      touch();render();return}
    const f=new FormData($('#form'));
    const prog=Math.max(0,Math.min(100,+f.get('progress')||0));
    if(prog!==w.progress)E.setProgress(w,prog,$('#today').value);
    const planChanged=f.get('planStart')!==(w.planStart||'')||f.get('planEnd')!==(w.planEnd||'');
    if(planChanged){
      const why=String(f.get('planReason')||'').trim();
      if(!why){alert('Плановые сроки меняются только с основанием — укажите справку ГИПа или распоряжение.');return}
      w.planReason=why;
    }
    Object.assign(w,{name:f.get('name'),section:f.get('section'),dep:f.get('dep'),note:f.get('note'),
      pkFrom:E.pkParse(f.get('pkFrom')),pkTo:E.pkParse(f.get('pkTo')),planStart:f.get('planStart'),planEnd:f.get('planEnd'),
      status:f.get('status'),source:f.get('source')});
    if(w.status==='done')w.progress=100;
    if(isNew)S.works.push(w);
    touch(w.id);render();
  });
}
function editSection(s){
  if(RO())return;
  const isNew=!s;
  if(isNew)s={id:'S'+(Math.max(0,...S.sections.map(v=>+String(v.id).slice(1)||0))+1),
    name:'Участок '+(S.sections.length+1),from:0,to:100};
  const used=S.works.filter(w=>w.section===s.id).length;
  $('#form').innerHTML=`
   <h2>${isNew?'Новый участок':'Участок '+s.id}</h2>
   <div class="fl"><label>Название</label><input name="name" value="${esc(s.name)}" required></div>
   <div class="two">
     <div class="fl"><label>Пикет от</label><input name="from" value="${E.pkFmt(s.from)}" inputmode="decimal"
       placeholder="0+00"></div>
     <div class="fl"><label>Пикет до</label><input name="to" value="${E.pkFmt(s.to)}" inputmode="decimal"
       placeholder="120+00"></div></div>
   ${isNew?'':`<p class="hint">Работ на участке: ${used}${used?'. Удалить можно только пустой участок.':''}</p>`}
   <div class="foot"><button class="btn pri" value="ok">Сохранить</button>
     <button class="btn" value="x" formnovalidate>Отмена</button>
     ${!isNew&&!used?'<button class="btn bad" value="del" formnovalidate>Удалить</button>':''}</div>`;
  openSheet(r=>{
    if(r==='del'){S.sections=S.sections.filter(v=>v.id!==s.id);touch();render();return}
    if(r!=='ok')return;
    const f=new FormData($('#form'));
    Object.assign(s,{name:f.get('name'),from:E.pkParse(f.get('from')),to:E.pkParse(f.get('to'))});
    if(isNew)S.sections.push(s);
    touch();render();
  });
}
const PROOF={
  'Фото':{accept:'image/*',camera:true,ref:'Что на снимке',need:false,
    hint:'Сфотографируйте выполненный объём. Снимок уменьшится сам и уйдёт в базу вместе с записью.'},
  'Акт':{accept:'application/pdf,image/*',ref:'Номер и дата акта',need:true,
    hint:'Приложите скан или фотографию подписанного акта.',place:'Акт КС-2 №14 от 16.10.2026'},
  'Исполнительная схема':{accept:'application/pdf,image/*',ref:'Обозначение схемы',need:true,
    hint:'Приложите файл схемы: PDF или фотография листа.'},
  'Журнал работ':{accept:'image/*',camera:true,ref:'Номер записи в журнале',need:true,
    hint:'Сфотографируйте страницу журнала с записью.'},
  'Кадр с камеры наблюдения':{accept:'image/*',ref:'Камера и время',need:false,
    hint:'Кадр, выгруженный с камеры на объекте.'},
  'Без файла':{accept:null,ref:'Чем подтверждено',need:true,
    hint:'Запись без вложения: например, ссылка на внешнюю систему или устное подтверждение.'}
};
function editProof(workId){
  if(RO())return;
  if(!S.works.length)return alert('Сначала добавьте работу');
  let type='Фото',picked=null,preview=null,busy=false;

  const draw=()=>{
    const cfg=PROOF[type];
    $('#form').innerHTML=`
     <h2>Подтверждение факта</h2>
     <div class="fl"><label>Работа</label><select name="work">${S.works.map(w=>
        `<option value="${w.id}" ${w.id===workId?'selected':''}>${w.id} · ${esc(w.name)}</option>`).join('')}</select></div>
     <div class="fl"><label>Чем подтверждаем</label><select name="type" id="ptype">${Object.keys(PROOF).map(k=>
        `<option ${k===type?'selected':''}>${esc(k)}</option>`).join('')}</select></div>
     <p class="hint">${esc(cfg.hint)}</p>
     ${cfg.accept?`<div class="drop" id="pdrop">
        ${picked?`<div style="display:flex;gap:12px;align-items:center;width:100%;text-align:left">
            ${preview?`<img src="${preview}" alt="" style="width:76px;height:76px;object-fit:cover;border-radius:10px;flex:none">`
              :`<div style="width:76px;height:76px;border-radius:10px;background:var(--soft);display:grid;place-items:center;flex:none">PDF</div>`}
            <div class="grow"><div>${esc(picked.name)}</div>
              <div class="small mut">${kb(picked.size)}${navigator.onLine?'':' · уйдёт на сервер, когда появится связь'}</div></div>
            <button type="button" class="btn sm bad" id="pclear">Убрать</button></div>`
          :`<div>${cfg.camera?'Снимите камерой или выберите файл':'Выберите файл: PDF или фотография'}</div>
            <div class="btnrow" style="justify-content:center">
              ${cfg.camera?`<label class="btn pri">Снять камерой
                 <input type="file" accept="image/*" capture="environment" id="pcam" class="hide"></label>`:''}
              <label class="btn">Выбрать файл<input type="file" accept="${cfg.accept}" id="pfile" class="hide"></label>
            </div>`}
      </div>`:''}
     <div class="two">
       <div class="fl"><label>${esc(cfg.ref)}${cfg.need?'':' (можно не заполнять)'}</label>
         <input name="ref" ${cfg.need?'required':''} placeholder="${esc(cfg.place||'')}" value="${esc(($('#form').querySelector('[name=ref]')||{}).value||'')}"></div>
       <div class="fl"><label>Дата</label><input name="date" type="date" value="${$('#today').value}"></div>
     </div>
     <div class="fl"><label>Примечание</label><input name="note" placeholder="ПК 40–95"></div>
     <div id="pmsg"></div>
     <div class="foot"><button class="btn pri" value="ok" id="pok">Сохранить</button>
       <button class="btn" value="x" formnovalidate>Отмена</button></div>`;
    $('#ptype').onchange=e=>{type=e.target.value;if(!PROOF[type].accept){picked=null;preview=null}draw()};
    const take=async e=>{
      const f=e.target.files&&e.target.files[0];if(!f)return;
      $('#pmsg').innerHTML='<p class="hint">Готовлю файл…</p>';
      try{
        picked=await shrink(f);
        preview=/^image\//.test(picked.type)?URL.createObjectURL(picked):null;
        if(picked.size>3.4*1024*1024)throw new Error('Файл больше 3,5 МБ, приложите снимок поменьше');
        draw();
      }catch(err){picked=null;preview=null;draw();$('#pmsg').innerHTML=`<div class="note">${esc(err.message)}</div>`}
    };
    const cam=$('#pcam'),fil=$('#pfile'),clr=$('#pclear');
    if(cam)cam.onchange=take;
    if(fil)fil.onchange=take;
    if(clr)clr.onclick=()=>{picked=null;preview=null;draw()};
    const d=$('#pdrop');
    if(d&&!picked){
      d.ondragover=e=>{e.preventDefault();d.classList.add('over')};
      d.ondragleave=()=>d.classList.remove('over');
      d.ondrop=e=>{e.preventDefault();d.classList.remove('over');take({target:{files:e.dataTransfer.files}})};
    }
  };
  draw();

  const dlg=$('#dlg');dlg.showModal();
  dlg.onclose=async()=>{
    if(dlg.returnValue!=='ok'||busy)return;
    busy=true;
    const f=new FormData($('#form')),id=uid('E'),work=f.get('work');
    const ev={id,work,type:f.get('type'),ref:f.get('ref')||f.get('type'),date:f.get('date'),note:f.get('note')};
    try{
      if(picked)Object.assign(ev,await keepFile(picked,work));
    }catch(err){alert(err.message);return}
    S.evidence.push(ev);newEvidence.add(id);
    touch(work);render();
    if(navigator.onLine)push(true);
  };
}

/* ---------------- пикетаж ---------------- */
let lineView=ls.get('aksg.lineview','layers');
function line(m){
  if(!S.sections.length){m.innerHTML='<div class="card empty">Участков пока нет.</div>';return}
  m.innerHTML=`<div class="filters" id="lv">
      <button data-v="layers" aria-pressed="${lineView==='layers'}">Слои работ</button>
      <button data-v="prof" aria-pressed="${lineView==='prof'}">Продольный профиль</button>
      <button data-v="pk" aria-pressed="${lineView==='pk'}">Схема по пикетажу</button>
      <button data-v="time" aria-pressed="${lineView==='time'}">Время и пикетаж</button>
    </div><div id="linebody"></div>`;
  $('#lv').onclick=e=>{const b=e.target.closest('button');if(!b)return;
    lineView=b.dataset.v;ls.set('aksg.lineview',lineView);line(m)};
  if(lineView==='time')return timeChainage($('#linebody'));
  if(lineView==='layers')return layersView($('#linebody'));
  if(lineView==='prof')return profileView($('#linebody'));
  drawRails($('#linebody'));
}
/* Диаграмма «время–пикетаж»: по горизонтали путь, по вертикали время.
   Так видно, какие работы сходятся на одном участке в одно время, — по Ганту этого не разглядеть. */
function timeChainage(box){
  const ws=S.works.filter(w=>!isNaN(E.planStartTs(w)));
  if(!ws.length){box.innerHTML='<div class="card empty">Нет работ со сроками</div>';return}
  const lo=Math.min(...S.sections.map(s=>s.from)),hi=Math.max(...S.sections.map(s=>s.to));
  const sp=(hi-lo)||1;
  const t0=Math.min(...ws.map(w=>E.planStartTs(w)),NOW);
  const t1=Math.max(...ws.map(w=>Math.max(E.planEndTs(w),eta(w))),NOW);
  const ts=(t1-t0)||1;
  const W=1000,H=Math.max(380,Math.min(760,ws.length*26+120)),L=54,R=16,T=28,B=34;
  const x=pk=>L+(pk-lo)/sp*(W-L-R);
  const y=t=>T+(t-t0)/ts*(H-T-B);
  /* отметки месяцев по вертикали */
  const marks=[];const d=new Date(t0);d.setUTCDate(1);
  while(d.getTime()<=t1){
    if(d.getTime()>=t0)marks.push({t:d.getTime(),
      s:d.toLocaleDateString('ru-RU',{month:'short',year:'2-digit',timeZone:'UTC'})});
    d.setUTCMonth(d.getUTCMonth()+1);
  }
  const step=sp>400?100:sp>150?50:20;
  const cols=[];for(let v=Math.ceil(lo/step)*step;v<=hi;v+=step)cols.push(v);
  const col=w=>w.status==='done'?'var(--ok)':'var(--'+calc(w).level+')';
  box.innerHTML=`<div class="card">
    <h3>Время и пикетаж</h3>
    <p class="hint">По горизонтали — путь, по вертикали — время. Каждая полоса это работа: где она идёт
      и когда. Пересечение полос по горизонтали означает, что работы столкнутся на одном участке.
      Серая линия — план, цветная — прогноз. Красная горизонталь — отчётная дата.</p>
    <div class="scroll"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:680px;height:${H}px" role="img"
        aria-label="Диаграмма время-пикетаж">
      ${cols.map(v=>`<line x1="${x(v)}" y1="${T}" x2="${x(v)}" y2="${H-B}" stroke="var(--line)"/>
        <text x="${x(v)}" y="${H-B+18}" font-size="11" fill="var(--mut)" text-anchor="middle">${PK(v)}</text>`).join('')}
      ${marks.map(k=>`<line x1="${L}" y1="${y(k.t)}" x2="${W-R}" y2="${y(k.t)}" stroke="var(--line)"/>
        <text x="6" y="${y(k.t)+4}" font-size="11" fill="var(--mut)">${esc(k.s)}</text>`).join('')}
      ${ws.map(w=>{
        const a=E.planStartTs(w),b=E.planEndTs(w),f=eta(w);
        const x1=x(w.pkFrom),x2=x(Math.max(w.pkTo,w.pkFrom+sp*0.004));
        return `<g><title>${esc(w.name)} · ${PKR(w.pkFrom,w.pkTo)} · план ${fmt(w.planStart)} → ${fmt(w.planEnd)} · ${w.progress}%</title>
          <line x1="${x1}" y1="${y(a)}" x2="${x2}" y2="${y(b)}" stroke="var(--idle)" stroke-width="5"
            stroke-linecap="round" opacity=".6"/>
          <line class="draw" pathLength="1" x1="${x1}" y1="${y(a)}" x2="${x2}" y2="${y(Math.max(f,a))}" stroke="${col(w)}" stroke-width="3"
            stroke-linecap="round"/>
          <circle cx="${x1}" cy="${y(a)}" r="3.5" fill="${col(w)}"/></g>`}).join('')}
      <line x1="${L}" y1="${y(NOW)}" x2="${W-R}" y2="${y(NOW)}" stroke="var(--brand)" stroke-width="2"/>
      <text x="${W-R}" y="${y(NOW)-5}" font-size="11" fill="var(--brand)" text-anchor="end">сегодня</text>
    </svg></div>
    <p class="hint">Идея взята из Trimble TILOS — отраслевого стандарта для линейных объектов:
      дорог, тоннелей и железных дорог.</p>
  </div>`;
}
function drawRails(box){
  const m=box;
  const lo=Math.min(...S.sections.map(s=>s.from)),hi=Math.max(...S.sections.map(s=>s.to));
  const sp=(hi-lo)||1,p=v=>(v-lo)/sp*100,step=sp>400?100:sp>150?50:20;
  m.innerHTML=`<div class="card">
   <h3>Линейная схема объекта · ${PKR(lo,hi)}</h3>
   <p class="hint">Каждая полоса — работа на своём участке пути. Цвет показывает оценку, затемнение внутри — выполненный объём.</p>
   ${S.sections.map(s=>{const ws=S.works.filter(w=>w.section===s.id);
     return `<div class="rowline" style="border:0;padding:18px 0 6px"><h2 class="grow">${esc(s.name)}</h2>
       ${RO()?'':`<button class="btn sm" data-sec="${s.id}">Изменить</button>`}</div><div class="railbox">`+
     (ws.length?ws.map(w=>{const c=calc(w);
       return `<div class="railrow">
         <div class="small"><div>${esc(w.name)}</div><div class="mut">${PKR(w.pkFrom,w.pkTo)}</div></div>
         <div class="rail"><div class="seg" style="left:${p(w.pkFrom)}%;width:${Math.max(1.5,p(w.pkTo)-p(w.pkFrom))}%;background:var(--${w.status==='plan'?'idle':w.status==='done'?'ok':c.level})">
           <i style="--w:${w.progress}%"></i><span style="position:relative">${w.progress}%</span></div></div></div>`}).join('')
       :'<div class="empty">На участке нет работ</div>')+`</div>`}).join('')}
   <div class="railrow" style="margin-top:4px"><div></div><div class="scaleline">
     ${Array.from({length:Math.floor(sp/step)+1},(_,i)=>lo+i*step).map(v=>`<span style="left:${Math.min(98,p(v))}%">${PK(v)}</span>`).join('')}
   </div></div></div>`;
  m.onclick=e=>{const b=e.target.closest('[data-sec]');
    if(b)editSection(S.sections.find(s=>s.id===b.dataset.sec))};
}

/* ---------------- подтверждения ---------------- */
function proof(m){
  const noProof=S.works.filter(w=>calc(w).noProof);
  m.innerHTML=`
   ${noProof.length?`<div class="card"><h3>Работы без подтверждения — ${noProof.length}</h3>
     <p class="hint">По этим работам введён факт, но нет документа.</p>
     ${noProof.map(w=>`<div class="rowline" data-id="${w.id}"><div class="grow">${esc(w.name)}
       <div class="small mut">${esc(secName(w.section))} · факт ${w.progress}%</div></div>
       ${RO()?'':'<button class="btn sm" data-proof>Подтвердить</button>'}</div>`).join('')}</div>`:''}
   <div class="card"><h3>Все подтверждения</h3>
   ${S.evidence.length?S.evidence.map(e=>{const w=S.works.find(v=>v.id===e.work);
     const waiting=e.fileId&&fileQueue.has(e.fileId);
     return `<div class="rowline">
       ${e.fileId&&!waiting&&!e.fileArchived&&/^image\//.test(e.fileMime||'')?
          `<a href="/api/file?id=${encodeURIComponent(e.fileId)}" target="_blank" rel="noopener" style="flex:none">
             <img src="/api/file?id=${encodeURIComponent(e.fileId)}" alt="" style="width:56px;height:56px;object-fit:cover;border-radius:8px;display:block"></a>`:''}
       <div class="grow"><div>${esc(e.ref)}</div>
       <div class="small mut">${esc(e.type)} · ${fmt(e.date)} · ${esc(e.work)} ${esc(w?w.name:'(работа удалена)')}${e.note?' · '+esc(e.note):''}</div>
       ${e.fileId?`<div class="small">${waiting
          ?'<span style="color:var(--warn)">файл в устройстве, уйдёт на сервер со связью</span>'
          :e.fileArchived
          ?`<span>${esc(e.fileName||'файл')}</span><span class="mut"> · ${kb(e.fileSize||0)}</span>
            <span class="chip c-idle" title="Содержимое файла выгружено в архив ${esc(e.fileArchiveRef||'')}, сведения и хеш остались в базе">в архиве с ${esc(e.fileArchived)}</span>
            ${e.fileSha?`<span class="mut" title="Хеш SHA-256: ${esc(e.fileSha)}"> · SHA-256 ${esc(e.fileSha.slice(0,8))}…</span>`:''}`
          :`<a href="/api/file?id=${encodeURIComponent(e.fileId)}" target="_blank" rel="noopener">${esc(e.fileName||'файл')}</a>
            <span class="mut"> · ${kb(e.fileSize||0)}</span>
            ${e.fileSha?`<span class="mut" title="Хеш SHA-256 — по нему видно подмену файла: ${esc(e.fileSha)}"> · SHA-256 ${esc(e.fileSha.slice(0,8))}…</span>`:''}
            ${e.fileTaken?`<div class="mut">снято ${esc(fmtDT(e.fileTaken))}${e.fileDevice?' · '+esc(e.fileDevice):''}${e.fileBy?' · загрузил '+esc(e.fileBy):''}</div>`:''}`}</div>`:''}</div>
       ${RO()?'':`<button class="btn sm bad" data-del="${e.id}">Удалить</button>`}</div>`}).join('')
     :'<div class="empty">Пока ничего не добавлено</div>'}</div>`;
  m.onclick=e=>{
    const del=e.target.closest('[data-del]');
    if(del&&!RO()){S.evidence=S.evidence.filter(v=>v.id!==del.dataset.del);touch();render();return}
    const row=e.target.closest('[data-id]');
    if(row&&e.target.closest('[data-proof]'))editProof(row.dataset.id);
  };
}

/* ---------------- хронология ---------------- */
async function hist(m){
  m.innerHTML='<div class="card empty">Загружаю…</div>';
  try{
    const r=await fetch('/api/history?limit=300');
    if(!r.ok)throw new Error('нет связи с сервером');
    const d=await r.json();
    m.innerHTML=`
     <div class="card"><h3>Загруженные полевые пакеты</h3>
      ${d.batches.length?d.batches.map(b=>`<div class="rowline"><div class="grow">
         <div>${esc(b.author)} · ${esc(b.appliedAt)}</div>
         <div class="small mut">работ в пакете: ${b.works}, применено фактов: ${b.facts}, подтверждений: ${b.evidence}${b.skipped?', пропущено: '+b.skipped:''}${b.collectedAt?' · собран '+esc(b.collectedAt):''}</div>
        </div>${chip('пакет','idle')}</div>`).join('')
        :'<div class="empty">Пакеты из поля ещё не загружали</div>'}</div>
     <div class="card"><h3>История изменений факта</h3>
      ${d.history.length?d.history.map(h=>`<div class="rowline"><div class="grow">
         <div>${esc(h.name||h.work)} — ${h.progress}%</div>
         <div class="small mut">${esc(h.at)} · ${esc(h.actor||'—')} · источник: ${esc(E.SRC[h.source]||h.source||'—')}${h.note?' · '+esc(h.note):''}</div>
        </div><span class="small mut">${esc(h.work)}</span></div>`).join('')
        :'<div class="empty">Изменений пока не было</div>'}</div>`;
  }catch(e){
    m.innerHTML=`<div class="card empty">Хронология хранится на сервере. ${esc(e.message)}.</div>`;
  }
}

/* ---------------- файлы и работа без связи ---------------- */
async function pack(all){
  const ids=all?S.works.map(w=>w.id):[...pending];
  const works=S.works.filter(w=>ids.includes(w.id));
  const files=[];
  for(const fid of fileQueue){
    try{
      const b=await IDB.get(fid);if(!b)continue;
      const ev=S.evidence.find(e=>e.fileId===fid);
      files.push({id:fid,name:b.name||'файл',mime:b.type,work:ev?ev.work:'',
        taken:(fileMeta[fid]||{}).taken||null,device:(fileMeta[fid]||{}).device||'',data:await b64(b)});
    }catch(e){}
  }
  return{format:'aksg-batch',version:1,id:uid('B'),project:'P125',files,
    author:ME.name||ME.login,device:(navigator.platform||'')+' '+(navigator.userAgent.match(/\((.*?)\)/)||['',''])[1],
    collectedAt:nowIso(),
    works:works.map(w=>({id:w.id,name:w.name,section:w.section,pkFrom:w.pkFrom,pkTo:w.pkTo,
      planStart:w.planStart,planEnd:w.planEnd,progress:w.progress,status:w.status,source:w.source,
      dep:w.dep,note:w.note,updatedAt:w.updatedAt||nowIso()})),
    evidence:S.evidence.filter(e=>all||newEvidence.has(e.id))};
}
function download(name,text,type){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([text],{type:type||'application/json;charset=utf-8'}));
  a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),4000);
}
const csvCell=v=>{const s=String(v??'');return /[";\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
/* правки, которые ещё не ушли на сервер, — отдельным файлом Excel */
async function editsBook(){
  await loadXLSX();
  const rows=S.works.filter(w=>pending.has(w.id)).map(w=>{
    const c=calc(w);
    return [w.id,w.name,secName(w.section),E.pkFmt(w.pkFrom),E.pkFmt(w.pkTo),w.planStart,w.planEnd,w.progress,
      E.STATUS[w.status],E.SRC[w.source],E.iso(eta(w)),c.delayDays,w.note,
      (w.updatedAt||'').slice(0,16).replace('T',' '),ME.name||ME.login];
  });
  const head=['ID','Работа','Участок','ПК от','ПК до','План с','План по','Факт %','Статус','Источник',
    'Прогноз','Задержка, дн.','Примечание','Когда изменено','Кто вносил'];
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([head,...rows]),'Правки');
  const ev=S.evidence.filter(e=>newEvidence.has(e.id)).map(e=>
    [e.work,e.type,e.ref,e.date,e.note,e.fileName||'',e.fileId&&fileQueue.has(e.fileId)?'файл в устройстве':'']);
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(
    [['Работа','Чем подтверждено','Документ','Дата','Примечание','Файл','Состояние'],...ev]),'Подтверждения');
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([
    ['Отчётная дата',$('#today').value],['Кто вносил',ME.name||ME.login],['Логин',ME.login],
    ['Собрано',new Date().toLocaleString('ru-RU')],['Правок работ',rows.length],['Подтверждений',ev.length],
    ['Файлов ждёт отправки',fileQueue.size]]),'Сведения');
  return wb;
}
async function saveEdits(){
  if(!pending.size&&!newEvidence.size)return alert('Несохранённых правок нет — всё уже на сервере.');
  try{
    const wb=await editsBook();
    XLSX.writeFile(wb,`АКСГ_правки_${E.iso(Date.now())}_${ME.login}.xlsx`);
  }catch(e){alert('Не вышло собрать файл: '+e.message)}
}
function csv(){
  const head=['ID','Работа','Участок','ПК от','ПК до','План с','План по','Факт %','Статус','Источник','После','Примечание','Прогноз','Задержка, дн.'];
  const rows=S.works.map(w=>{const c=calc(w);
    return [w.id,w.name,secName(w.section),E.pkFmt(w.pkFrom),E.pkFmt(w.pkTo),w.planStart,w.planEnd,w.progress,
      E.STATUS[w.status],E.SRC[w.source],w.dep,w.note,E.iso(eta(w)),c.delayDays]});
  return '﻿'+[head,...rows].map(r=>r.map(csvCell).join(';')).join('\r\n');
}
/* место под вложения — одной строкой, понятной без расчётов */
function storageCard(){
  const s=STORAGE;
  if(!s||!s.quota)return '<div id="storageBox"></div>';
  const lvl=s.pct>=90?'bad':s.pct>=80?'warn':'ok';
  return `<div class="card" id="storageBox">
    <h3>Место под фотографии и документы</h3>
    <div class="rowline" style="border:0;padding:6px 0">
      <b style="font-size:20px">${kb(s.bytes)}</b><span class="mut grow">из ${kb(s.quota)} · файлов: ${s.count}</span>
      <span class="chip c-${lvl}">${s.pct} %</span></div>
    <div class="bar"><i style="--w:${Math.max(1,s.pct)}%;background:var(--${lvl})"></i></div>
    <p class="hint" style="margin-top:10px">${
      s.pct>=80
        ?'<b>Место заканчивается.</b> Выгрузите «Пакет со всем графиком» — в нём сохраняются и файлы — и передайте администратору, чтобы освободить место в базе.'
        :'Снимки уменьшаются прямо на устройстве до 1600 точек по длинной стороне (примерно 300–700 КБ), поэтому места хватает надолго. Исходник остаётся в галерее устройства.'}</p>
  </div>`;
}
/* карточку рисуем сразу из запомненных цифр, а свежие подставляем, когда доедут */
function refreshStorageCard(){
  pullStorage().then(()=>{const b=$('#storageBox');if(b)b.outerHTML=storageCard()});
}
function io(m){
  const ro=RO();
  m.innerHTML=`
  <div class="note${pending.size?' warn':' ok'}"><div>
    ${pending.size?`<b>Не отправлено правок: ${pending.size}.</b> Если связи нет — выгрузите пакет и загрузите его из места, где интернет есть.`
      :'<b>Все правки на сервере.</b> Пакет пригодится, если собираетесь работать там, где связи не будет.'}
  </div></div>
  <div class="grid k2">
    <div class="card"><h3>Работа в поле без связи</h3>
      <p class="hint">Сайт продолжает работать без интернета: правки сохраняются в устройстве. Пакет — это файл со всем, что вы внесли; его можно переслать и загрузить из любого места, где связь есть.</p>
      <div class="btnrow" style="margin-top:12px">
        <button class="btn pri" id="saveEdits" ${ro?'disabled':''}>Правки в Excel (${pending.size+newEvidence.size})</button>
        <button class="btn" id="packNew" ${ro?'disabled':''}>Пакет с моими правками</button>
        <button class="btn" id="packAll">Пакет со всем графиком</button>
        <button class="btn" id="csv">Весь график в CSV</button>
      </div>
      <p class="hint" style="margin-top:10px"><b>Excel</b> — чтобы увезти правки с собой и показать в офисе: читается без нашего сайта.
        <b>Пакет</b> — тот же набор плюс фотографии; его загружают обратно в систему, и данные встают на место.
        Оба файла собираются без интернета.</p>
      <p class="hint" style="margin-top:10px">Пакет сохраняется файлом вида <code>АКСГ_пакет_2026-11-20.json</code>. Он читается этим же сайтом и содержит дату сбора, автора и устройство.</p>
    </div>
    ${storageCard()}
    <div class="card"><h3>Загрузить пакет из поля</h3>
      <div class="drop" id="drop">
        <div>Перетащите файл пакета <code>.json</code></div>
        <label class="btn">Выбрать файл<input type="file" id="fi" accept=".json,application/json" class="hide" ${ro?'disabled':''}></label>
      </div>
      <div id="res" class="small" style="margin-top:12px"></div>
      <p class="hint">Правка применяется, если она свежее той, что уже лежит на сервере. Повторная загрузка того же пакета ничего не продублирует.</p>
    </div>
    <div class="card"><h3>Загрузить график работ</h3>
      <p class="hint">Понимает настоящий «График производства работ» заказчика: шапку согласования, разделы,
        недельную сетку по месяцам и клетки вида «200/400». Сроки работ берутся из сетки, процент —
        из проектного объёма и выполнения. Обычная таблица с заголовками «Работа», «Участок», «План с»,
        «План по», «Факт %» тоже подойдёт.</p>
      <div class="btnrow" style="margin:12px 0">
        <label class="btn">Выбрать файл .xlsx или .csv<input type="file" id="xl" accept=".xlsx,.xls,.csv" class="hide" ${ro?'disabled':''}></label>
      </div>
      <div id="xres"></div>
    </div>
    <div class="card"><h3>Выгрузка и копии</h3>
      <div class="btnrow">
        <button class="btn" id="xlsx">Скачать Excel</button>
        <button class="btn" id="json">Копия всей базы (JSON)</button>
        <a class="btn pri" href="#report">Отчёт на дату</a>
      </div>
      <p class="hint" style="margin-top:10px">Данные хранятся на сервере в PostgreSQL: график, факты, подтверждения, хронология и журнал действий. Копия нужна для архива или переноса.</p>
    </div>
  </div>`;

  refreshStorageCard();
  $('#saveEdits').onclick=saveEdits;
  $('#packNew').onclick=()=>{
    if(!pending.size)return alert('Неотправленных правок нет — выгрузите пакет со всем графиком.');
    pack(false).then(p=>download(`АКСГ_пакет_${E.iso(Date.now())}_${ME.login}.json`,JSON.stringify(p,null,1)));
  };
  $('#packAll').onclick=()=>pack(true).then(p=>download(`АКСГ_полный_${E.iso(Date.now())}.json`,JSON.stringify(p,null,1)));
  $('#csv').onclick=()=>download(`АКСГ_${E.iso(Date.now())}.csv`,csv(),'text/csv;charset=utf-8');
  $('#json').onclick=()=>download('aksg_backup.json',JSON.stringify({rev:REV,...S},null,1));


  const upload=async f=>{
    if(!f)return;
    const res=$('#res');res.innerHTML='Загружаю…';
    try{
      const data=JSON.parse(await f.text());
      const r=await fetch('/api/sync',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
      const d=await r.json();
      if(!r.ok)throw new Error(d.error||'код '+r.status);
      if(d.already)res.innerHTML=`<span class="mut">${esc(d.message)}</span>`;
      else res.innerHTML=`<span style="color:var(--ok)">Готово. Применено: ${d.report.applied.length}, создано: ${d.report.created.length}, подтверждений: ${d.report.evidence}${d.report.skipped.length?`, пропущено: ${d.report.skipped.length}`:''}.</span>`;
      await pull();render();
    }catch(e){res.innerHTML=`<span style="color:var(--bad)">Не вышло: ${esc(e.message)}</span>`}
  };
  $('#fi').onchange=e=>upload(e.target.files[0]);
  const d=$('#drop');
  d.ondragover=e=>{e.preventDefault();d.classList.add('over')};
  d.ondragleave=()=>d.classList.remove('over');
  d.ondrop=e=>{e.preventDefault();d.classList.remove('over');upload(e.dataTransfer.files[0])};

  $('#xl').onchange=async e=>{
    const f=e.target.files[0];if(!f)return;
    const out=$('#xres');out.innerHTML='<p class="hint">Читаю файл…</p>';
    try{
      await loadXLSX();
      const wb=XLSX.read(await f.arrayBuffer(),{type:'array',cellDates:false});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const grid=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,blankrows:true});
      const parsed=window.AKSGImport?AKSGImport.parseSchedule(grid):{ok:false};
      if(parsed.ok&&parsed.works.length)return preview(parsed,f.name,out);
      const rows=XLSX.utils.sheet_to_json(ws,{defval:'',raw:false,dateNF:'yyyy-mm-dd'});
      const probe={sections:JSON.parse(JSON.stringify(S.sections)),works:[],evidence:[]};
      const r=E.importRows(rows,probe,'add',$('#today').value);
      if(!r.added)throw new Error('не нашёл ни одной работы — проверьте, тот ли это лист');
      preview({ok:true,year:null,sections:probe.sections,works:probe.works,warnings:[],
        meta:{weeks:0,dated:probe.works.filter(w=>w.planStart&&w.planEnd).length,period:null}},f.name,out);
    }catch(err){out.innerHTML=`<div class="note">Не вышло разобрать файл: ${esc(err.message)}</div>`}
  };
  function preview(p,fileName,out){
    const w=p.works,sec=p.sections;
    out.innerHTML=`
      <div class="note ok"><div><b>Разобрал «${esc(fileName)}».</b>
        Разделов: ${sec.length}, работ: ${w.length}${p.year?`, год графика: ${p.year}`:''}.
        ${p.meta.period?`Сроки с ${fmt(p.meta.period.from)} по ${fmt(p.meta.period.to)}, из недельной сетки — ${p.meta.dated} работ.`
          :'Сроки в файле не найдены — проставьте их вручную.'}
        ${p.meta.headerRow?`<div class="small mut" style="margin-top:6px">Как разобран файл: заголовки в строке ${p.meta.headerRow},
          недельных колонок ${p.meta.weeks}. Если структура файла другая — разбор это покажет, и строки без
          распознанных колонок просто не попадут в список выше.</div>`:''}</div></div>
      <div class="scroll" style="margin:12px 0"><table style="min-width:640px"><thead><tr>
        <th>Работа</th><th>Раздел</th><th>План</th><th>Факт</th></tr></thead><tbody>
        ${w.slice(0,8).map(x=>`<tr><td>${esc(x.name)}</td>
          <td class="small mut">${esc((sec.find(s=>s.id===x.section)||{}).name||'')}</td>
          <td class="small">${x.planStart?fmt(x.planStart)+' → '+fmt(x.planEnd):'<span class="mut">нет</span>'}</td>
          <td>${x.progress}%</td></tr>`).join('')}
        ${w.length>8?`<tr><td colspan="4" class="mut small">…и ещё ${w.length-8}</td></tr>`:''}
      </tbody></table></div>
      ${p.warnings.length?`<div class="note warn"><div><b>Нестыковки в файле — ${p.warnings.length}:</b>
        <ul style="margin:6px 0 0 18px;padding:0">${p.warnings.slice(0,6).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>
        ${p.warnings.length>6?`<div class="small mut">…и ещё ${p.warnings.length-6}</div>`:''}
        <div class="small mut" style="margin-top:6px">Загрузить можно и так — это пометки, а не ошибки разбора.</div></div></div>`:''}
      <div class="btnrow">
        <button class="btn pri" id="applyAdd">Добавить к текущим</button>
        <button class="btn bad" id="applyRep">Заменить весь график</button>
        <button class="btn" id="applyNo">Отмена</button></div>`;
    const apply=mode=>{
      if(mode==='replace'&&!confirm('Заменить весь график? Текущие работы, участки и подтверждения удалятся.'))return;
      if(mode==='replace'){S.works=[];S.evidence=[];S.sections=[]}
      const map={};
      for(const s of sec){
        let ex=S.sections.find(o=>o.name===s.name);
        if(!ex){ex={id:'S'+(S.sections.length+1),name:s.name,from:s.from,to:s.to};S.sections.push(ex)}
        map[s.id]=ex.id;
      }
      let n=Math.max(0,...S.works.map(x=>+String(x.id).slice(1)||0));
      for(const x of w){
        const id='W'+(++n);
        const nw=E.newWork(id,x.name,map[x.section]||S.sections[0].id,x.pkFrom,x.pkTo,
          x.planStart||$('#today').value,x.planEnd||x.planStart||$('#today').value,
          x.progress,x.status,'excel','',x.note);
        nw.updatedAt=nowIso();
        S.works.push(nw);pending.add(id);
      }
      touch();render();
      out.innerHTML=`<div class="note ok"><div>Готово: добавлено работ — ${w.length}, участков — ${sec.length}.
        ${navigator.onLine?'Данные уходят на сервер.':'Связи нет — всё сохранено в устройстве и уйдёт позже.'}</div></div>`;
    };
    $('#applyAdd').onclick=()=>apply('add');
    $('#applyRep').onclick=()=>apply('replace');
    $('#applyNo').onclick=()=>{out.innerHTML=''};
  }
  $('#xlsx').onclick=async()=>{
    try{
      await loadXLSX();
      const head=['ID','Работа','Участок','ПК от','ПК до','План с','План по','Факт %','Статус','Источник','После','Примечание'];
      const wb=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([head,...S.works.map(w=>
        [w.id,w.name,secName(w.section),E.pkFmt(w.pkFrom),E.pkFmt(w.pkTo),w.planStart,w.planEnd,w.progress,
         E.STATUS[w.status],E.SRC[w.source],w.dep,w.note])]),'КСГ');
      XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Работа','Тип','Документ','Дата','Примечание'],
        ...S.evidence.map(e=>[e.work,e.type,e.ref,e.date,e.note])]),'Подтверждения');
      XLSX.writeFile(wb,'КСГ_'+$('#today').value+'.xlsx');
    }catch(e){alert('Excel доступен только при подключении к интернету. Без связи выгрузите CSV или пакет.')}
  };
}
let xlsxP=null;
function loadXLSX(){
  return xlsxP||(xlsxP=new Promise((ok,no)=>{
    if(window.XLSX)return ok();
    const s=document.createElement('script');
    s.src='/xlsx.full.min.js';
    s.onload=()=>ok();s.onerror=()=>no(new Error('не удалось загрузить библиотеку Excel'));
    document.head.appendChild(s);
  }));
}

/* ---------------- отчёт на дату ---------------- */
function report(m){
  const date=$('#today').value;
  const rows=S.works.map(w=>({w,c:calc(w)}));
  const done=rows.filter(r=>r.c.done).length;
  const total=rows.length?Math.round(rows.reduce((s,r)=>s+r.w.progress,0)/rows.length):0;
  const bad=rows.filter(r=>r.c.level==='bad'),warn=rows.filter(r=>r.c.level==='warn');
  const noProof=rows.filter(r=>r.c.noProof);
  const cascade=rows.filter(r=>r.c.blockers.length&&r.c.delayDays>0);
  const pend=S.pending||[];
  const proofs=S.evidence.length;
  const withFile=S.evidence.filter(e=>e.fileId).length;
  const num=x=>String(x);
  const cell=(v,cls)=>`<td${cls?` class="${cls}"`:''}>${v}</td>`;

  m.innerHTML=`
  <div class="btnrow noprint" style="margin-bottom:4px">
    <button class="btn pri" id="doprint">Печать или PDF</button>
    <a class="btn" href="#dash">Закрыть отчёт</a>
    <span class="hint" style="align-self:center">В окне печати выберите «Сохранить как PDF» — получится файл для заказчика.</span>
  </div>

  <div class="card report">
    <div class="rhead">
      <div><h2>Отчёт о ходе работ на ${fmt(date)}</h2>
        <div class="small mut">P125 «Центр управления» · контрольно-сетевой график<br>
          Заказчик: ДКСС ОАО «РЖД»</div></div>
      <div class="small mut" style="text-align:right">
        Сформировал: ${esc(ME.name||ME.login)}<br>
        ${esc((ROLES[ME.role]||{}).name||ME.role)}<br>
        ${new Date().toLocaleString('ru-RU')}</div>
    </div>

    <table class="sum"><tbody>
      <tr><th>Общая готовность</th>${cell(total+' %')}
          <th>Работ в графике</th>${cell(rows.length)}</tr>
      <tr><th>Выполнено</th>${cell(done)}
          <th>Отклонения</th>${cell(num(bad.length),bad.length?'bad':'')}</tr>
      <tr><th>Риски</th>${cell(num(warn.length),warn.length?'warn':'')}
          <th>Без подтверждения</th>${cell(num(noProof.length),noProof.length?'warn':'')}</tr>
      <tr><th>Подтверждений всего</th>${cell(proofs+', из них с файлом '+withFile)}
          <th>Сводок ждут проверки</th>${cell(num(pend.length),pend.length?'warn':'')}</tr>
    </tbody></table>

    <h3>1. Освоение: план, факт, прогноз</h3>
    <div id="repCurve"></div>

    <h3>2. Готовность по участкам</h3>
    <table class="rtab"><thead><tr><th>Участок</th><th>Пикетаж</th><th>Работ</th><th>Готовность</th></tr></thead><tbody>
    ${S.sections.map(s=>{const ws=S.works.filter(w=>w.section===s.id);
      const p=ws.length?Math.round(ws.reduce((a,w)=>a+w.progress,0)/ws.length):0;
      return `<tr><td>${esc(secShort(s.id))}</td><td>${PKR(s.from,s.to)}</td><td>${ws.length}</td><td>${p} %</td></tr>`
    }).join('')||'<tr><td colspan="4">участки не заведены</td></tr>'}
    </tbody></table>

    <h3>3. Работы, требующие решения</h3>
    ${bad.concat(warn).length?`<table class="rtab"><thead><tr>
      <th>ID</th><th>Работа</th><th>Участок, ПК</th><th>План</th>
      <th>Ожид.</th><th>Факт</th><th>Прогноз</th><th>Задержка</th><th>Причина</th></tr></thead><tbody>
      ${bad.concat(warn).map(({w,c})=>`<tr>
        <td>${esc(w.id)}</td><td>${esc(w.name)}</td>
        <td>${esc(secShort(w.section))}, ${PKR(w.pkFrom,w.pkTo)}</td>
        <td>${fmt(w.planStart)} – ${fmt(w.planEnd)}</td>
        <td>${c.expected} %</td><td>${w.progress} %</td>
        <td>${fmt(E.iso(eta(w)))}</td>
        <td class="${c.level}">${c.delayDays} дн.</td>
        <td>${c.overdue?'срок прошёл':''}${c.blockers.length?(c.overdue?'; ':'')+'ждёт '+c.blockers.join(', '):''}
            ${!c.overdue&&!c.blockers.length?'отставание от плана':''}</td></tr>`).join('')}
      </tbody></table>`:'<p>Отклонений и рисков нет: все работы идут по плану.</p>'}

    ${cascade.length?`<h3>4. Сдвиги по зависимостям</h3>
      <table class="rtab"><thead><tr><th>Работа</th><th>Ждёт</th><th>Сдвиг</th></tr></thead><tbody>
      ${cascade.map(({w,c})=>`<tr><td>${esc(w.id)} ${esc(w.name)}</td>
        <td>${c.blockerWorks.map(b=>esc(b.id+' '+b.name)).join('; ')}</td>
        <td>+${c.delayDays} дн.</td></tr>`).join('')}</tbody></table>`:''}

    <h3>${cascade.length?5:4}. Ход работ — полный перечень</h3>
    <table class="rtab"><thead><tr>
      <th>ID</th><th>Работа</th><th>Участок, ПК</th><th>План</th><th>Факт</th>
      <th>Источник факта</th><th>Подтверждение</th><th>Прогноз</th></tr></thead><tbody>
    ${rows.map(({w,c})=>{const p=proofState(w);
      return `<tr>
      <td>${esc(w.id)}</td><td>${esc(w.name)}</td>
      <td>${esc(secShort(w.section))}, ${PKR(w.pkFrom,w.pkTo)}</td>
      <td>${fmt(w.planStart)} – ${fmt(w.planEnd)}</td>
      <td>${w.progress} %</td>
      <td>${esc(E.SRC[w.source]||w.source)}</td>
      <td class="${p?p[1]:''}">${p?p[0]:'факт не вводился'}</td>
      <td>${w.status==='done'?'закрыта':fmt(E.iso(eta(w)))}</td></tr>`}).join('')}
    </tbody></table>

    <h3>${cascade.length?6:5}. Подтверждения факта</h3>
    ${S.evidence.length?`<table class="rtab"><thead><tr>
      <th>Работа</th><th>Чем подтверждено</th><th>Документ</th><th>Дата</th><th>Файл и контроль целостности</th>
      </tr></thead><tbody>
      ${S.evidence.map(e=>{const w=S.works.find(v=>v.id===e.work);
        return `<tr><td>${esc(e.work)} ${esc(w?w.name:'')}</td><td>${esc(e.type)}</td>
          <td>${esc(e.ref)}</td><td>${fmt(e.date)}</td>
          <td>${e.fileId?`${esc(e.fileName||'файл')}${e.fileSha?`, SHA-256 ${esc(e.fileSha.slice(0,16))}…`:''}
            ${e.fileTaken?`<br><span class="mut">снято ${esc(fmtDT(e.fileTaken))}${e.fileDevice?', '+esc(e.fileDevice):''}</span>`:''}`
            :'<span class="mut">без файла</span>'}</td></tr>`}).join('')}
      </tbody></table>`:'<p>Подтверждений на отчётную дату нет.</p>'}

    ${pend.length?`<h3>${cascade.length?6:5}. Сводки оборудования, ожидающие проверки</h3>
      <table class="rtab"><thead><tr><th>Работа</th><th>Устройство</th><th>Прислано</th>
        <th>Учтённый факт</th><th>Получено</th></tr></thead><tbody>
      ${pend.map(p=>{const w=S.works.find(v=>v.id===p.work);
        return `<tr><td>${esc(p.work)} ${esc(w?w.name:'')}</td><td>${esc(p.device)}</td>
          <td>${p.progress} %</td><td>${w?w.progress+' %':'—'}</td><td>${esc(p.at)}</td></tr>`}).join('')}
      </tbody></table>
      <p class="small">Эти цифры в отчёт не включены: они становятся фактом только после проверки человеком.</p>`:''}

    <div class="note-method">
      <b>Как считались цифры.</b> Ожидаемый процент — линейно между плановыми датами.
      Прогноз окончания — по фактическому темпу работы, с учётом задержек предшественников.
      Отклонение — отставание от ожидаемого на 25 пунктов и более либо просроченный срок; риск — от 10 пунктов
      или сдвиг от предшественника. Факт вводится человеком либо принимается им из сводки оборудования;
      у каждого подтверждающего файла хранится хеш SHA-256, изменение файла задним числом обнаруживается.
      История изменений и журнал действий защищены от правки на уровне базы данных.
    </div>

    <div class="signs">
      <div>Составил: _______________ / ${esc(ME.name||ME.login)}</div>
      <div>Проверил: _______________ / _______________</div>
      <div>Дата: «____» _____________ 20____ г.</div>
    </div>
  </div>`;
  sCurve($('#repCurve'),{h:280});
  $('#doprint').onclick=()=>window.print();
}

/* отчёт простым языком — для руководства и для заказчика */
function reportPlain(m){
  const date=$('#today').value,f=plainFacts(),lines=plainLines(f),mood=MOOD[f.mood];
  const state=w=>{const c=calc(w);
    if(c.done)return'закрыта';
    if(!w.progress)return'не начиналась';
    if(c.overdue)return`срок прошёл, сделано ${w.progress} %`;
    if(c.level==='bad')return`отстаёт, сделано ${w.progress} % вместо ${c.expected} %`;
    if(c.level==='warn')return`идёт медленнее плана, сделано ${w.progress} %`;
    return`идёт по плану, сделано ${w.progress} %`};
  m.innerHTML=`
  <div class="btnrow noprint" style="margin-bottom:4px">
    <button class="btn pri" id="doprint">Печать или PDF</button>
    <a class="btn" href="#report">Технический отчёт</a>
    <a class="btn" href="#dash">Закрыть</a>
    <span class="hint" style="align-self:center">В окне печати выберите «Сохранить как PDF».</span>
  </div>
  <div class="card report">
    <div class="rhead">
      <div><h2>Как идут работы на ${fmt(date)}</h2>
        <div class="small mut">P125 «Центр управления» · строительство ж/д инфраструктуры<br>
          Заказчик: ДКСС ОАО «РЖД». Отчёт без технических подробностей.</div></div>
      <div class="small mut" style="text-align:right">Подготовил: ${esc(ME.name||ME.login)}<br>
        ${new Date().toLocaleString('ru-RU')}</div>
    </div>

    <div class="plainbig"><span class="mood ${f.mood}"><span class="dot"></span>${esc(mood[0])}</span>
      <b>${f.total} %</b> готовность объекта</div>

    <h3>Коротко</h3>
    <ul class="plines">${lines.map(l=>`<li>${esc(l)}</li>`).join('')}</ul>

    <h3>Как шло и как пойдёт</h3>
    <div id="repCurve"></div>

    <h3>По участкам</h3>
    <table class="rtab"><thead><tr><th>Участок</th><th>Где это</th><th>Готовность</th><th>Как идёт</th></tr></thead><tbody>
    ${S.sections.map(s=>{const ws=f.rows.filter(r=>r.w.section===s.id);
      const p=ws.length?Math.round(ws.reduce((a,r)=>a+r.w.progress,0)/ws.length):0;
      const bad=ws.filter(r=>r.c.level==='bad').length,warn=ws.filter(r=>r.c.level==='warn').length;
      return`<tr><td>${esc(secShort(s.id))}</td><td>${PKR(s.from,s.to)}</td><td>${p} %</td>
        <td>${bad?plural(bad,'работа отстаёт','работы отстают','работ отстают'):warn?'есть риски':'по плану'}</td></tr>`
    }).join('')||'<tr><td colspan="4">участки не заведены</td></tr>'}
    </tbody></table>

    <h3>Что происходит с каждой работой</h3>
    <table class="rtab"><thead><tr><th>Работа</th><th>Где</th><th>Что сейчас</th>
      <th>Когда закончится</th><th>Подтверждено</th></tr></thead><tbody>
    ${f.rows.map(({w,c})=>{const p=proofState(w);
      return`<tr><td>${esc(w.name)}</td>
      <td>${esc(secShort(w.section))}, ${PKR(w.pkFrom,w.pkTo)}</td>
      <td class="${c.done?'ok':c.level}">${esc(state(w))}</td>
      <td>${c.done?'готово':fmt(E.iso(eta(w)))}</td>
      <td>${p?esc(p[0]):'факт не вводился'}</td></tr>`}).join('')}
    </tbody></table>

    <div class="note-method">
      <b>Как это читать.</b> «Готовность» — средний процент выполнения по всем работам графика.
      «Когда закончится» — расчёт по тому темпу, с которым работа идёт сейчас, с учётом ожидания
      предшественников. «Подтверждено» означает, что к объёму приложен документ: акт, фотография,
      исполнительная схема или запись журнала. Цифры, присланные камерами и датчиками, попадают в отчёт
      только после того, как их проверит инспектор.
    </div>
    <div class="signs">
      <div>Подготовил: _______________ / ${esc(ME.name||ME.login)}</div>
      <div>Дата: «____» _____________ 20____ г.</div>
    </div>
  </div>`;
  sCurve($('#repCurve'),{h:280});
  $('#doprint').onclick=()=>window.print();
}

/* ---------------- администрирование ---------------- */
/* ---------------- архив вложений (администратор) ---------------- */
let ARCH=null;
const archPost=async b=>{
  const r=await fetch('/api/archive',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(b)});
  const d=await r.json();
  if(!r.ok)throw new Error(d.error||'код '+r.status);
  return d;
};
async function drawArchive(){
  const box=$('#archBody');if(!box)return;
  try{
    const before=($('#archBefore')&&$('#archBefore').value)||'';
    const r=await fetch('/api/archive'+(before?'?before='+before:''));
    if(!r.ok)throw new Error((await r.json()).error||'код '+r.status);
    ARCH=await r.json();
  }catch(e){box.innerHTML=`<div class="empty">Не вышло: ${esc(e.message)}</div>`;return}
  const p=ARCH.plan,s=ARCH.storage;
  const cut=$('#archBefore')?$('#archBefore').value:'';
  box.innerHTML=`
    <div class="rowline" style="border:0;padding:4px 0">
      <div class="grow">В базе лежит <b>${kb(s.bytes)}</b> вложений${
        s.archived?` · в архиве ещё ${s.archived} шт. на ${kb(s.archivedBytes)}`:''}</div></div>
    <div class="rowline" style="border:0;padding:4px 0;gap:10px;flex-wrap:wrap">
      <label class="small mut">Выгрузить то, что загружено до
        <input type="date" id="archBefore" value="${esc(cut)}" style="margin-left:6px"></label>
      <span class="grow"></span>
      <button class="btn" id="archRefresh">Пересчитать</button></div>
    ${p.files
      ? `<div class="note"><div>К выгрузке: <b>${p.files}</b> файл(ов) на <b>${kb(p.bytes)}</b>
           (с ${esc(p.oldest||'—')} по ${esc(p.newest||'—')}), частей: ${p.parts.length}.
           Каждая часть сохранится отдельным файлом — так они проходят через сеть.</div></div>
         <div class="btnrow" style="margin-top:12px">
           <button class="btn pri" id="archRun">Выгрузить архив и освободить место</button></div>`
      : `<div class="empty">${cut?'До этой даты выгружать нечего':'Все вложения уже в архиве или их ещё нет'}</div>`}
    ${ARCH.archives.length?`<h3 style="margin-top:16px">Что уже в архиве</h3>
      ${ARCH.archives.map(a=>`<div class="rowline"><div class="grow"><code>${esc(a.ref)}</code>
        <div class="small mut">${a.count} файл(ов) · ${kb(a.bytes)} · выгружено ${esc(a.at)}</div></div></div>`).join('')}
      <div class="btnrow" style="margin-top:12px">
        <label class="btn">Вернуть файлы из архива<input type="file" id="archBack" accept=".json,application/json"
          class="hide" multiple></label></div>`:''}
    <div id="archLog" class="small mut" style="margin-top:10px"></div>`;
  $('#archRefresh').onclick=drawArchive;
  $('#archBefore').onchange=drawArchive;
  const run=$('#archRun');if(run)run.onclick=runArchive;
  const back=$('#archBack');if(back)back.onchange=e=>restoreArchive([...e.target.files]);
}
async function runArchive(){
  const p=ARCH&&ARCH.plan;if(!p||!p.files)return;
  if(!confirm(`Будет сохранено ${p.parts.length} файл(ов) архива общим весом ${kb(p.bytes)}.\n`+
    'Место в базе освободится только после того, как вы подтвердите сохранение. Продолжить?'))return;
  const log=$('#archLog'),btn=$('#archRun');
  btn.disabled=true;
  const ref=`АКСГ_архив_${E.iso(Date.now())}`;
  const saved={};let done=0;
  try{
    for(const part of p.parts){
      log.textContent=`Собираю часть ${part.n} из ${p.parts.length}…`;
      const pack=await archPost({action:'export',ids:part.ids});
      pack.ref=ref;pack.part=part.n;pack.parts=p.parts.length;
      download(`${ref}_часть${part.n}.json`,JSON.stringify(pack));
      for(const f of pack.files)saved[f.id]=f.sha256;
      done++;
      await new Promise(r=>setTimeout(r,400));   /* браузеру нужно время на каждое сохранение */
    }
  }catch(e){
    btn.disabled=false;
    log.innerHTML=`<span style="color:var(--bad)">Сборка прервалась: ${esc(e.message)}. `+
      'Место не освобождено, файлы на месте.</span>';
    return;
  }
  log.textContent=`Сохранено частей: ${done}. Проверьте их в папке загрузок.`;
  if(!confirm(`Файлы архива сохранены на этот компьютер (${done} шт., имя ${ref}).\n\n`+
    'Проверьте, что они на месте и перенесены в надёжное хранилище.\n'+
    'Освободить место в базе? Сведения о файлах и хеши останутся, содержимое можно вернуть из архива.')){
    btn.disabled=false;log.textContent='Место не освобождено — файлы остались в базе.';return;
  }
  try{
    const r=await archPost({action:'release',ref,files:saved});
    log.innerHTML=`<span style="color:var(--ok)">Готово: в архив ушло ${r.archived} файл(ов), `+
      `освободилось ${r.freedText}.</span>`+
      (r.skipped.length?`<br><span style="color:var(--warn)">Не тронуты (хеш не сошёлся): ${esc(r.skipped.join(', '))}</span>`:'');
    STORAGE=r.storage;ls.set('aksg.storage',STORAGE);
    await pull();await drawArchive();
  }catch(e){
    btn.disabled=false;
    log.innerHTML=`<span style="color:var(--bad)">Не вышло: ${esc(e.message)}</span>`;
  }
}
async function restoreArchive(files){
  const log=$('#archLog');if(!files.length)return;
  let back=0,already=0;const bad=[];
  for(const f of files){
    log.textContent=`Возвращаю из ${f.name}…`;
    try{
      const pack=JSON.parse(await f.text());
      if(pack.format!=='aksg-files-archive')throw new Error('это не файл архива вложений');
      const r=await archPost({action:'restore',files:pack.files});
      back+=r.restored;already+=r.already;bad.push(...r.skipped);
      STORAGE=r.storage;
    }catch(e){bad.push(`${f.name} — ${e.message}`)}
  }
  ls.set('aksg.storage',STORAGE);
  log.innerHTML=`<span style="color:var(--ok)">Вернулось файлов: ${back}${already?`, уже были на месте: ${already}`:''}.</span>`+
    (bad.length?`<br><span style="color:var(--warn)">Не вернулись: ${esc(bad.join('; '))}</span>`:'');
  await pull();await drawArchive();
}

async function admin(m){
  m.innerHTML='<div class="card empty">Загружаю…</div>';
  const r=await fetch('/api/admin');
  if(!r.ok)return m.innerHTML=`<div class="card empty">${esc((await r.json()).error||'нет доступа')}</div>`;
  const d=await r.json();
  await pullStorage();

  const roleSel=(login,role)=>`<select data-role="${esc(login)}">${Object.entries(d.roles).map(([k,v])=>
    `<option value="${k}" ${k===role?'selected':''}>${esc(v.name)}</option>`).join('')}</select>`;
  m.innerHTML=storageCard()+`
  <div class="card"><h3>Люди</h3>
    <div class="scroll"><table style="min-width:720px"><thead><tr>
      <th>Логин</th><th>Имя</th><th>Роль</th><th>Доступ</th><th>Был</th><th></th></tr></thead><tbody>
      ${d.users.map(u=>`<tr>
        <td><b>${esc(u.login)}</b></td><td>${esc(u.name||'—')}</td>
        <td>${roleSel(u.login,u.role)}</td>
        <td>${u.active?chip('открыт','ok'):chip('закрыт','bad')}</td>
        <td class="small mut">${esc(u.lastSeen||'—')}</td>
        <td style="white-space:nowrap">
          <button class="btn sm" data-act="active" data-login="${esc(u.login)}" data-val="${u.active?0:1}">${u.active?'Закрыть':'Открыть'}</button>
          <button class="btn sm" data-act="password" data-login="${esc(u.login)}">Сбросить пароль</button>
        </td></tr>`).join('')}
    </tbody></table></div></div>

  <div class="card"><h3>Коды приглашения</h3>
    <p class="hint">Код задаёт роль, с которой человек войдёт в систему. ${Object.entries(d.roles).map(([k,v])=>`<b>${esc(v.name)}</b> — ${esc(v.note)}`).join('. ')}.</p>
    <div class="btnrow" style="margin:12px 0">
      ${Object.entries(d.roles).map(([k,v])=>`<button class="btn" data-invite="${k}">Код для роли «${esc(v.name)}»</button>`).join('')}
    </div>
    ${d.invites.length?d.invites.map(i=>`<div class="rowline">
      <div class="grow"><code>${esc(i.code)}</code> — ${esc(d.roles[i.role]?.name||i.role)}
        <div class="small mut">осталось применений: ${i.usesLeft} · создал ${esc(i.createdBy)} ${esc(i.createdAt)}</div></div>
      <button class="btn sm bad" data-del-invite="${esc(i.code)}">Удалить</button></div>`).join('')
      :'<div class="empty">Кодов нет — создайте нужный</div>'}</div>

  <div class="card"><h3>Датчики и камеры</h3>
    <p class="hint">У оборудования свои ключи: камера или датчик сами присылают процент выполнения,
      он попадает в факт, хронологию и подтверждения. Ключ показывается один раз — сохраните его.</p>
    <div class="btnrow" style="margin:12px 0"><button class="btn" id="adddev">Добавить устройство</button></div>
    ${(d.devices||[]).length?d.devices.map(v=>`<div class="rowline">
      <div class="grow"><div>${esc(v.name)}</div>
        <div class="small mut">${v.active?'работает':'отключено'} · добавил ${esc(v.createdBy)} ${esc(v.createdAt)}
          · последняя передача: ${esc(v.lastSeen||'ещё не присылало')}${v.note?' · '+esc(v.note):''}</div></div>
      <button class="btn sm" data-dev="${v.id}" data-val="${v.active?0:1}">${v.active?'Отключить':'Включить'}</button>
      </div>`).join(''):'<div class="empty">Оборудование не подключено</div>'}
    <p class="hint" style="margin-top:12px">Как присылать данные:
      <code>POST /api/sensor</code> с заголовком <code>authorization: Bearer КЛЮЧ</code> и телом
      <code>{"work":"W2","progress":85,"ref":"cam-07 08.11"}</code></p></div>

  <div class="card" id="archBox"><h3>Архив вложений</h3>
    <p class="hint">Место в базе освобождают не удалением. Содержимое старых фотографий и актов
      выгружается в файл архива, а в базе остаются сведения: имя, размер, кто и когда загрузил
      и хеш SHA-256. Подтверждение остаётся в графике, а файл в любой момент возвращается обратно —
      по хешу видно, что вернулся именно он.</p>
    <div class="arch" id="archBody"><div class="empty">Считаю…</div></div></div>

  <div class="card"><h3>Резервная копия</h3>
    <p class="hint">Весь проект одним файлом: график, факты, подтверждения, хронология, журнал действий,
      список людей и устройств, перечень файлов с хешами SHA-256. Пароли и содержимое файлов в копию
      не входят. Делайте копию перед каждой защитой и перед массовой загрузкой графика.</p>
    <div class="btnrow" style="margin-top:12px">
      <a class="btn" href="/api/backup" download>Скачать копию</a></div></div>

  <div class="card"><h3>Журнал действий</h3>
    ${d.audit.map(a=>`<div class="rowline"><div class="grow">${esc(a.action)}
      <div class="small mut">${esc(a.at)} · ${esc(a.actor||'—')}${a.detail?' · '+esc(JSON.stringify(a.detail).slice(0,120)):''}</div>
      </div></div>`).join('')||'<div class="empty">Пока пусто</div>'}</div>`;

  drawArchive();

  const post=async b=>{
    const r=await fetch('/api/admin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
    const d=await r.json();
    if(!r.ok)alert(d.error||'не вышло');
    return d;
  };
  m.onchange=async e=>{
    const s=e.target.closest('[data-role]');
    if(s){await post({action:'role',login:s.dataset.role,role:s.value});admin(m)}
  };
  m.onclick=async e=>{
    const dev=e.target.closest('[data-dev]');
    if(dev){await post({action:'device-active',id:+dev.dataset.dev,active:dev.dataset.val==='1'});return admin(m)}
    if(e.target.id==='adddev'){
      const name=prompt('Название устройства — например, «Камера ПК 40-95» или «Датчик объёма №3»');
      if(!name)return;
      const r=await post({action:'device',name});
      if(r.key)prompt('Ключ устройства. Скопируйте его сейчас — второй раз он не покажется:',r.key);
      return admin(m);
    }
    const inv=e.target.closest('[data-invite]');
    if(inv){const d=await post({action:'invite',role:inv.dataset.invite,uses:1});
      if(d.code)alert('Код: '+d.code+'\nПередайте его человеку — при регистрации он получит нужную роль.');
      return admin(m)}
    const del=e.target.closest('[data-del-invite]');
    if(del){await post({action:'invite-delete',code:del.dataset.delInvite});return admin(m)}
    const b=e.target.closest('[data-act]');
    if(!b)return;
    if(b.dataset.act==='active'){await post({action:'active',login:b.dataset.login,active:b.dataset.val==='1'});return admin(m)}
    if(b.dataset.act==='password'){
      const pass=prompt('Новый пароль для '+b.dataset.login+' (не короче 8 знаков)');
      if(pass){await post({action:'password',login:b.dataset.login,pass});alert('Пароль изменён, прежние сессии закрыты')}
    }
  };
}

/* ---------------- старт ---------------- */
applyTheme();
boot();
if('serviceWorker' in navigator&&location.protocol==='https:'){
  navigator.serviceWorker.register('/sw.js').then(r=>r.update()).catch(()=>{});
  let reloading=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(reloading)return;reloading=true;location.reload();   /* подхватываем обновление сайта сами */
  });
}
