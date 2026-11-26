/* Локальный запуск: те же обработчики из api/, что и на Vercel.
   node dev-server.js   →  http://localhost:3000
   Адрес базы берётся из переменной DATABASE_URL или из файла .env.local */
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const DIR=__dirname;

try{
  for(const line of fs.readFileSync(path.join(DIR,'.env.local'),'utf8').split('\n')){
    const m=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^["']|["']$/g,'');
  }
}catch(e){}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
const PORT=+process.env.PORT||3000;

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    const name=url.pathname.slice(5).replace(/[^a-z0-9_-]/gi,'');
    const file=path.join(DIR,'api',name+'.js');
    if(!fs.existsSync(file)){res.writeHead(404,{'content-type':'application/json'});return res.end('{"error":"нет такого метода"}')}
    try{
      delete require.cache[require.resolve(file)];          /* правки подхватываются без перезапуска */
      const handler=require(file);
      return handler(req,res);
    }catch(e){
      console.error(e);
      res.writeHead(500,{'content-type':'application/json; charset=utf-8'});
      return res.end(JSON.stringify({error:String(e.message||e)}));
    }
  }
  let p=url.pathname==='/'?'/index.html':url.pathname;
  const file=path.join(DIR,'public',path.normalize(p).replace(/^(\.\.[/\\])+/,''));
  if(!file.startsWith(path.join(DIR,'public'))||!fs.existsSync(file)||fs.statSync(file).isDirectory()){
    res.writeHead(404);return res.end('not found');
  }
  res.writeHead(200,{'content-type':MIME[path.extname(file)]||'application/octet-stream','cache-control':'no-cache'});
  fs.createReadStream(file).pipe(res);
});
server.listen(PORT,()=>{
  const db=(process.env.DATABASE_URL||process.env.POSTGRES_URL||'').replace(/:[^:@/]*@/,':***@');
  console.log('АКСГ: http://localhost:'+PORT);
  console.log('база: '+(db||'НЕ ЗАДАНА — укажите DATABASE_URL в .env.local'));
});
