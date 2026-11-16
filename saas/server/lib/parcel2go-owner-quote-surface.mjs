// Private Node adapter. The production mount supplies explicit finite activation;
// default construction neither reads assets nor creates a runner.
import {readFileSync} from 'node:fs';
import {createParcel2GoRecordedOwnerReview,PARCEL2GO_RECORDED_REVIEW_PATH} from './parcel2go-recorded-owner-review.mjs';
export const PARCEL2GO_OWNER_QUOTE_PAGE='/owner/parcel2go-quote';
export const PARCEL2GO_OWNER_QUOTE_SCRIPT='/parcel2go-exact-owner-ui.js';
const privateHeaders={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
 'Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"};
const unavailable=()=>new Response(JSON.stringify({error:'Unavailable'}),{status:404,headers:{...privateHeaders,'Content-Type':'application/json'}});

// Lazy paused-mode bridge: authentication can reject without consuming a body.
// Cancellation releases listeners and stops reading without destroying the
// response socket; incomplete POSTs are answered with Connection: close.
function bodyStream(req){
 let pending,ended=false;const clean=()=>{req.off('readable',read);req.off('end',read);req.off('error',error);};
 const settle=()=>{const p=pending;pending=null;clean();p?.resolve();};
 const error=()=>{pending?.controller.error(Error('Request closed'));settle();};
 function read(){if(!pending)return;try{const chunk=req.read(2049);if(chunk!==null){pending.controller.enqueue(new Uint8Array(chunk));settle();}
  else if(req.readableEnded){pending.controller.close();ended=true;settle();}}catch{error();}}
 const stream=new ReadableStream({pull(controller){return new Promise(resolve=>{pending={controller,resolve};req.on('readable',read);req.on('end',read);req.on('error',error);read();});},
  cancel(){ended=true;settle();req.pause();}},{highWaterMark:0});
 return {stream,close(){if(!ended){pending?.controller.close();ended=true;settle();req.pause();}}};
}

export function createParcel2GoOwnerQuoteSurface(options={}){
 const enabled=options.mode==='unmounted-owner-quote-surface/v1';
 if(!enabled&&(options.mode??'disabled/v1')!=='disabled/v1')throw Error('Unavailable');
 let review,origin,api,page,html,script,closed=false;const active=new Set();
 if(enabled){
  ({origin}=options);review=createParcel2GoRecordedOwnerReview({...options,mode:'unmounted-owner-input-quote/v1'});
  api=`${PARCEL2GO_RECORDED_REVIEW_PATH}?requestId=${options.requestId}`;page=`${PARCEL2GO_OWNER_QUOTE_PAGE}?requestId=${options.requestId}`;
  html=readFileSync(new URL('../../parcel2go-owner-quote.html',import.meta.url));script=readFileSync(new URL('../../parcel2go-exact-owner-ui.js',import.meta.url));
 }
 const close=()=>{closed=true;review?.close();for(const c of active)c.abort();};
 return Object.freeze({close,async handle(req,res){
  const abort=new AbortController();active.add(abort);let bridge;
  const cancel=()=>abort.abort();req.once('aborted',cancel);res.once('close',cancel);
  let response;
  try{
   if(!enabled||closed||req.aborted||res.destroyed||!['GET','POST'].includes(req.method)||![api,page,PARCEL2GO_OWNER_QUOTE_SCRIPT].includes(req.url))response=unavailable();
   else if(req.url!==api&&req.method!=='GET')response=unavailable();
   else{
    if(req.method==='POST')bridge=bodyStream(req);
    // Use only the configured origin; Host/forwarded headers cannot select it.
    const request=new Request(origin+api,{method:req.method,headers:req.headers,signal:abort.signal,
     ...(bridge?{body:bridge.stream,duplex:'half'}:{})});
    response=await review.handle(request);
    if(response.ok&&req.url!==api)response=new Response(req.url===page?html:script,{headers:{...privateHeaders,
     'Content-Type':req.url===page?'text/html; charset=utf-8':'text/javascript; charset=utf-8'}});
   }
   if(abort.signal.aborted||closed)response=unavailable();
   let bytes=Buffer.from(await response.arrayBuffer());
   // Do not release an already-built result if the host closes during the final
   // asynchronous body conversion. The original controller has already stopped.
   if(abort.signal.aborted||closed){response=unavailable();bytes=Buffer.from(JSON.stringify({error:'Unavailable'}));}
   if(!req.aborted&&!res.destroyed&&!res.writableEnded){
    const headers=Object.fromEntries(response.headers);
    if(req.method==='POST'&&!req.readableEnded)headers.connection='close';
    res.writeHead(response.status,headers);res.end(bytes);
   }
  }catch{
   if(!abort.signal.aborted&&!res.destroyed&&!res.writableEnded){res.writeHead(409,{...privateHeaders,'Content-Type':'application/json',Connection:'close'});res.end(JSON.stringify({error:'Outcome unconfirmed; reconcile without retry'}));}
  }finally{bridge?.close();active.delete(abort);req.off('aborted',cancel);res.off('close',cancel);}
 }});
}
