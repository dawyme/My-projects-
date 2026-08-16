/** Dumps fully-rendered dashboard HTML for visual inspection. */
require('dotenv').config();
const fs=require('fs'),path=require('path'),esbuild=require('esbuild');
const {JSDOM,VirtualConsole}=require('jsdom');
const app=require('../src/app');
const ADMIN=path.join(__dirname,'..','..','admin');
const TAG=/<script type="module">([\s\S]*?)<\/script>/;
function page(file){let h=fs.readFileSync(path.join(ADMIN,file),'utf8').replace(/<link[^>]+fonts\.googleapis[^>]*>/g,'');
  const m=h.match(TAG); if(!m)return h; const e=path.join(ADMIN,'.snap.js'); fs.writeFileSync(e,m[1]);
  const c=esbuild.buildSync({entryPoints:[e],bundle:true,write:false,format:'iife',target:'es2020'}).outputFiles[0].text;
  fs.unlinkSync(e); return h.replace(TAG,`<script>${c}</script>`);}
function inst(w,base){const jar=new Map();const sync=()=>{for(const p of (w.document.cookie||'').split(';')){const i=p.indexOf('=');if(i>0)jar.set(p.slice(0,i).trim(),p.slice(i+1).trim());}};
  w.fetch=async(i,init={})=>{sync();const u=new URL(String(i),base).toString();const h=new Headers(init.headers||{});
    const ck=[...jar].map(([k,v])=>`${k}=${v}`).join('; ');if(ck)h.set('cookie',ck);
    const r=await fetch(u,{...init,headers:h,redirect:'manual'});
    for(const c of r.headers.getSetCookie?.()||[]){const [p]=c.split(';');const i2=p.indexOf('=');jar.set(p.slice(0,i2),p.slice(i2+1));w.document.cookie=p+'; path=/';}
    return r;};w.Headers=Headers;}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const srv=app.listen(0,async()=>{
  const base=`http://127.0.0.1:${srv.address().port}`;
  const login=await fetch(base+'/api/csrf-token');
  const csrf=(await login.json()).data.csrfToken;
  const cookie=login.headers.getSetCookie()[0].split(';')[0];
  const lr=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','x-csrf-token':csrf,cookie},body:JSON.stringify({email:'admin@ndsairconditioning.com',password:'Admin@12345'})});
  const session=JSON.stringify({accessToken:(await lr.json()).data.accessToken});
  const vc=new VirtualConsole();
  const dom=new JSDOM(page('index.html'),{url:base+'/admin/index.html',runScripts:'dangerously',resources:'usable',pretendToBeVisual:true,virtualConsole:vc,
    beforeParse(w){inst(w,base);w.localStorage.setItem('nds.auth',session);w.scrollTo=()=>{};w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});}});
  const w=dom.window; w.document.cookie=cookie+'; path=/';
  const routes=process.argv.slice(2).length?process.argv.slice(2):['#/'];
  await wait(3000);
  const out=path.join(__dirname,'..','data','snapshots'); fs.mkdirSync(out,{recursive:true});
  for(const r of routes){ w.location.hash=r; await wait(3500);
    const css=fs.readFileSync(path.join(ADMIN,'css','admin.css'),'utf8');
    const html=`<!DOCTYPE html><html data-theme="${w.document.documentElement.dataset.theme}"><head><meta charset="utf-8"><style>${css}</style></head><body>${w.document.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g,"")}</body></html>`;
    const name=r.replace(/[#/]/g,'')||'dashboard';
    fs.writeFileSync(path.join(out,name+'.html'),html);
    console.log('wrote',name+'.html', w.document.getElementById('view').textContent.slice(0,60).replace(/\s+/g,' '));
  }
  process.exit(0);
});
