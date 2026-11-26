/* Офлайн-оболочка: страница открывается без связи, данные берутся из устройства.
   Пока связь есть — всегда берём свежие файлы с сервера, кеш остаётся запасным вариантом.
   Иначе после обновления сайта в браузере продолжала бы жить старая версия. */
const CACHE='aksg-shell-v18';
const SHELL=['/','/index.html','/styles.css','/app.js','/engine.js','/manifest.webmanifest','/icon.svg','/import-schedule.js',
  '/xlsx.full.min.js'];   /* нужен, чтобы Excel собирался и без связи */

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys()
    .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim()));
});
self.addEventListener('message',e=>{if(e.data==='skipWaiting')self.skipWaiting()});

self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin||u.pathname.startsWith('/api/'))return;
  e.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    try{
      const net=await fetch(e.request,{cache:'no-cache'});
      if(net&&net.ok)cache.put(e.request,net.clone());
      return net;
    }catch(err){
      const hit=await cache.match(e.request,{ignoreSearch:true});
      return hit||await cache.match('/index.html')||Response.error();
    }
  })());
});
