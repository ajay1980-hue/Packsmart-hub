// Mounted private-entry transport boundary. No provider, credential codec, or store.
// Host composition must supply authenticated/locked admission; disabled by default.
import {metaStrictJson} from './meta-publication-bounded.mjs';
const fail=()=>{throw new Error('Private credential admission refused; reconcile without retry.');};
export function createCredentialHttpBoundary({enabled=false,origin,authenticate,admit,now=()=>performance.now(),maxMs=2000}={}){
 let closed=false;
 if(enabled&&(typeof origin!=='string'||new URL(origin).origin!==origin||!origin.startsWith('https://')||typeof authenticate!=='function'||typeof admit!=='function'||!Number.isFinite(maxMs)||maxMs<=0||maxMs>2000))fail();
 return Object.freeze({close(){closed=true;},async handle(request){
  let body,secretInput,timedOut=false,iterator,finished=false,merged;const chunks=[];const start=now();let last=start;
  const check=()=>{const t=now();if(!enabled||closed||timedOut||request.signal?.aborted||!Number.isFinite(t)||t<last||t-start>=maxMs)fail();last=t;};
  const bounded=async fn=>{check();let timer;try{return await Promise.race([Promise.resolve().then(()=>{check();return fn();}),new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;reject(new Error('Deadline'));},Math.max(1,maxMs-(now()-start)));})]);}finally{clearTimeout(timer);}};
  try{
   check();if(request.method!=='POST'||request.origin!==origin||request.contentType!=='application/json'||typeof request.csrf!=='string'||request.csrf.length<16)fail();
   const auth=await bounded(()=>authenticate(request));check();
   // Host verifies signed cookie/current strict owner. Bearer-only callers fail here.
   if(auth?.method!=='signed-cookie'||auth.role!=='owner'||auth.csrf!==request.csrf)fail();
   let length=0,count=0;iterator=request.body[Symbol.asyncIterator]();while(true){const next=await bounded(()=>iterator.next());if(next.done){finished=true;break;}const chunk=next.value;check();if(!(chunk instanceof Uint8Array))fail();length+=chunk.byteLength;if(length>12288||++count>256)fail();chunks.push(Buffer.from(chunk));}
   check();merged=Buffer.concat(chunks);body=metaStrictJson(merged);
   if(!body||Array.isArray(body)||Object.keys(body).sort().join('|')!=='clientId|clientSecret|confirmed|expectedRevision|requestId|reviewDigest'||body.confirmed!==true)fail();
   if(typeof body.reviewDigest!=='string'||! /^[a-f0-9]{64}$/.test(body.reviewDigest))fail();
   for(const k of ['clientId','clientSecret'])if(typeof body[k]!=='string'||body[k].length<8||body[k].length>4096||/[\x00-\x20\x7f]/.test(body[k]))fail();
   for(const k of ['requestId','expectedRevision'])if(typeof body[k]!=='string'||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body[k]))fail();
   secretInput={clientId:body.clientId,clientSecret:body.clientSecret};check();
   const result=await bounded(()=>admit({auth,requestId:body.requestId,expectedRevision:body.expectedRevision,credentials:secretInput,reviewDigest:body.reviewDigest,assertCurrent:check}));check();
   // Never relay arbitrary admission output or provider/database exceptions.
   if(result?.status!=='stored'||result.requestId!==body.requestId)fail();
   return {status:200,body:{status:'stored',requestId:body.requestId},headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}};
  }catch{return {status:409,body:{status:'unconfirmed',message:'Credential save is unconfirmed or refused. Check saved status; do not repeat it.'},headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}};}
  finally{for(const chunk of chunks)chunk.fill(0);merged?.fill(0);if(iterator&&!finished&&typeof iterator.return==='function'){try{Promise.resolve(iterator.return()).catch(()=>{});}catch{}}if(body&&typeof body==='object'){body.clientId='';body.clientSecret='';}if(secretInput){secretInput.clientId='';secretInput.clientSecret='';}}
 }});
}
