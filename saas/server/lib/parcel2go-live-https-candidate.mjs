// Unmounted transport candidate. No mounted route invokes this boundary.
// Activation requires a future trusted composition with fresh durable admission;
// constructing this low-level boundary is not evidence of owner approval.
import https from 'node:https';
import {createHash} from 'node:crypto';
import {createParcel2GoLiveMockHttp} from './parcel2go-live-mock-http.mjs';
const deny=()=>Object.assign(new Error('Parcel2Go transport unavailable; reconcile before retry.'),{code:'PARCEL2GO_TRANSPORT_CLOSED'});
export function createParcel2GoLiveHttpsCandidate({mode='disabled/v1',expiresAt,approvedBodyHashes,assertAuthorized,now=Date.now,monotonic=()=>performance.now()}={}){
 if(mode==='disabled/v1')return Object.freeze({send:async()=>{throw deny();},close:()=>{}});
 if(mode!=='approved-https-candidate/v1'||typeof assertAuthorized!=='function')throw deny();
 const start=now(),mono=monotonic(),expiry=Date.parse(expiresAt);
 if(!Number.isSafeInteger(start)||!Number.isFinite(mono)||!Number.isFinite(expiry)||expiry<=start||expiry-start>300000)throw deny();
 const hashes={token:approvedBodyHashes?.token,quote:approvedBodyHashes?.quote};
 if(!Object.values(hashes).every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)))throw deny();
 let closed=false,last=start,lastMono=mono;
 const check=()=>{const t=now(),m=monotonic();if(closed||!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono||t>=expiry||m-mono>=expiry-start)throw deny();last=t;lastMono=m;};
 // Share the strictly bounded, single-attempt parser with the offline transport.
 // No environment flags, arbitrary URLs, agents, redirects or automatic retries.
 const boundary=createParcel2GoLiveMockHttp({mode:'offline-wire-mock/v1',mockRequest:(url,options,cb)=>{
  check();return https.request(url,{...options,rejectUnauthorized:true,minVersion:'TLSv1.2'},cb);
 }});
 const close=()=>{closed=true;boundary.close();};
 const authorize=(operation)=>{
  const result=assertAuthorized(Object.freeze({operation,bodyHash:hashes[operation]}));
  if(result!==true){
   // Never await an approval. Consume a mistakenly returned rejection so a
   // trusted composition error cannot become an unhandled process rejection.
   Promise.resolve(result).catch(()=>{});
   throw deny();
  }
 };
 const send=async args=>{
  try{
   check();const {operation,body,token,timeoutMs}=args;
   if(!['token','quote'].includes(operation)||typeof body!=='string'||createHash('sha256').update(body).digest('hex')!==hashes[operation])throw deny();
   // Deliberately synchronous. Async/pending approvals must not send any bytes.
   authorize(operation);
   check();const remaining=Math.floor(Math.min(expiry-last,expiry-start-(lastMono-mono)));
   if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw deny();
   const result=await boundary.send({operation,body,token,timeoutMs:Math.min(timeoutMs,remaining)});
   try{check();authorize(operation);check();}catch{result.fill(0);throw deny();}
   return result;
  }catch{close();throw deny();}
 };
 return Object.freeze({send,close});
}
