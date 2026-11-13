// Internal-only transport for the synthetic owner panel. No production mount.
import {metaStrictJson} from './meta-publication-bounded.mjs';
export function createExactOwnerHttp({mode='disabled/v1',panel,monotonic=()=>performance.now()}={}){
 const reply=(status,value)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"}});
 if(mode==='disabled/v1')return {handle:async()=>reply(404,{error:'Unavailable'})};
 if(mode!=='synthetic-owner-http/v1'||typeof panel?.review!=='function'||typeof panel?.decide!=='function')throw Error('Unavailable');
 return {async handle(req){let timer,reader;const controller=new AbortController(),abort=()=>controller.abort();req.signal.addEventListener('abort',abort,{once:true});try{
 const u=new URL(req.url),id=u.searchParams.get('id');if(u.origin!=='http://127.0.0.1:4173'||u.pathname!=='/api/offline/exact-owner-review'||!id||u.searchParams.size!==1||!/^approval_[a-f0-9-]{36}$/.test(id))return reply(404,{error:'Unavailable'});
 if(req.signal.aborted)throw Error();const headers=Object.fromEntries(req.headers);if(headers['sec-fetch-site']&&!['same-origin','none'].includes(headers['sec-fetch-site']))return reply(403,{error:'Origin refused'});
 const request={headers,signal:controller.signal};if(req.method==='GET')return reply(200,await panel.review(request,id));if(req.method!=='POST')return reply(405,{error:'Method refused'});
 if(headers.origin!==u.origin||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(headers['content-type']??''))return reply(403,{error:'Request refused'});
 let reject;const cancelled=new Promise((_,r)=>{reject=r;});const stop=()=>{controller.abort();reject(Error('Request closed'));};controller.signal.addEventListener('abort',()=>reject(Error('Request closed')),{once:true});timer=setTimeout(stop,2000);
 const start=monotonic();let last=start;const checkTime=()=>{const t=monotonic();if(!Number.isFinite(t)||!Number.isFinite(start)||t<last||t-start>=2000||controller.signal.aborted)throw Error('Request closed');last=t;};checkTime();
 reader=req.body?.getReader();if(!reader)throw Error();let size=0,count=0;const chunks=[];for(;;){checkTime();const {value,done}=await Promise.race([reader.read(),cancelled]);checkTime();if(done)break;if(!(value instanceof Uint8Array)||!value.length||++count>2048||(size+=value.length)>2048)throw Error();chunks.push(value);}clearTimeout(timer);checkTime();const confirmation=metaStrictJson(Buffer.concat(chunks));checkTime();
 return reply(200,await panel.decide(request,id,confirmation));
 }catch{return reply(409,{error:'Decision unconfirmed; reconcile without retry'});}finally{clearTimeout(timer);req.signal.removeEventListener('abort',abort);reader?.cancel().catch(()=>{});}}};
}
