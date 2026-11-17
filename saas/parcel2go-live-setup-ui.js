(()=>{'use strict';
 const button=document.getElementById('prepare'),status=document.getElementById('status'),entry=document.getElementById('entry');let closed=false,controller;
 const stages={window:'setup window',request:'request admission',origin:'origin admission',owner_auth:'owner authentication',csrf:'CSRF check',workspace_lock:'workspace lock wait',fresh_owner_auth:'fresh owner authentication',account_revision:'account/revision checks'};
 const causes={unavailable:'unavailable',refused:'refused',deadline:'server deadline reached',cancelled:'request cancelled'};
 const serverDiagnostic=d=>d&&typeof d==='object'&&!Array.isArray(d)&&Object.keys(d).sort().join('|')==='cause|durationMs|schema|stage'&&d.schema==='parcel2go-setup-diagnostic/v1'&&
  Object.hasOwn(stages,d.stage)&&Object.hasOwn(causes,d.cause)&&Number.isSafeInteger(d.durationMs)&&d.durationMs>=0&&d.durationMs<=2000
  ?`Check: ${stages[d.stage]}. Reason: ${causes[d.cause]}. Server elapsed: ${d.durationMs} ms (capped at 2000 ms).`:null;
 window.addEventListener('pagehide',()=>{closed=true;controller?.abort();button.disabled=true;entry.hidden=true});
 button.addEventListener('click',async()=>{
  if(closed||button.disabled)return;button.disabled=true;entry.hidden=true;controller=new AbortController();
  const began=performance.now();let stage='session request',cause='unavailable',http=null,diagnostic=null,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort()},5000);
  const current=()=>{if(closed||controller.signal.aborted)throw Error()};
  const httpStatus=r=>[400,401,403,404,405,408,409,413,429,500,502,503,504].includes(r.status)?r.status:null;
  try{
   const a=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store',signal:controller.signal});current();http=httpStatus(a);
   if(!a.ok){cause='response refused';throw Error()}
   cause='invalid response';const s=await a.json();current();if(typeof s?.csrf!=='string'||s.csrf.length<16)throw Error();
   stage='setup request';cause='unavailable';http=null;
   const r=await fetch('/api/owner/parcel2go-live-setup',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'X-CSRF-Token':s.csrf},signal:controller.signal});current();http=httpStatus(r);
   cause='invalid response';const d=await r.json();current();
   if(!r.ok||d?.status!=='prepared'||d.entryPath!=='/parcel2go-live-entry.html'||d.providerCallsAllowed!==false||d.savePerformed!==false){
    cause=r.ok?'invalid response':'response refused';
    if(!r.ok&&d?.status==='unavailable'&&d.providerCallsAllowed===false&&d.savePerformed===false)diagnostic=serverDiagnostic(d.diagnostic);
    throw Error();
   }
   entry.hidden=false;status.textContent='Ready to review. No credentials have been saved by this action.';
  }catch{
   if(!closed){
    const elapsed=performance.now()-began,duration=Number.isFinite(elapsed)?Math.max(0,Math.min(5000,Math.floor(elapsed))):0;
    const local=`Check: ${stage}. Reason: ${timedOut?'browser deadline reached':cause}. Browser elapsed: ${duration} ms (capped at 5000 ms).`;
    status.textContent='Preparation unavailable. No credentials were sent. '+(diagnostic??local)+(http===null?'':` HTTP ${http}.`);
   }
  }finally{clearTimeout(timer);if(!closed)button.disabled=false}
 });
})();
