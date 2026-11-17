(()=>{'use strict';
 const $=id=>document.getElementById(id),path='/api/owner/parcel2go-live-credentials';let descriptor,csrf,attempted=false,closed=false,timer,controller,deadline=0;
 const stages={request:'request admission',origin:'origin admission',csrf:'CSRF check',owner_auth:'owner authentication',body:'request body',workspace_lock:'workspace lock wait',fresh_owner_auth:'fresh owner authentication',review_binding:'review binding',credential_admission:'durable credential admission',saved_status:'saved-status confirmation',status_read:'saved-status authentication',status_review:'saved-status review',window:'entry window'};
 const causes={refused:'refused',unavailable:'unavailable',deadline:'server deadline reached',cancelled:'request cancelled'};
 const serverDiagnostic=d=>d&&typeof d==='object'&&!Array.isArray(d)&&Object.keys(d).sort().join('|')==='cause|durationMs|schema|stage'&&d.schema==='parcel2go-entry-diagnostic/v1'&&Object.hasOwn(stages,d.stage)&&Object.hasOwn(causes,d.cause)&&Number.isSafeInteger(d.durationMs)&&d.durationMs>=0&&d.durationMs<=2000
  ?'Check: '+stages[d.stage]+'. Reason: '+causes[d.cause]+'. Server elapsed: '+d.durationMs+' ms (capped at 2000 ms).':null;
 const diagnosticFrom=d=>['unconfirmed','unavailable'].includes(d?.status)?serverDiagnostic(d.diagnostic):null;
 const httpStatus=r=>[400,401,403,404,405,408,409,413,429,500,502,503,504].includes(r.status)?r.status:null;
 const detail=(diagnostic,stage,cause,began,http)=>{const elapsed=performance.now()-began,duration=Number.isFinite(elapsed)?Math.max(0,Math.min(5000,Math.floor(elapsed))):0;return (diagnostic??'Check: '+stage+'. Reason: '+cause+'. Browser elapsed: '+duration+' ms (capped at 5000 ms).')+(http===null?'':' HTTP '+http+'.');};
 const clear=()=>{$('clientId').value='';$('clientSecret').value='';$('confirmed').checked=false};
 const disable=()=>{for(const e of $('entry').elements)e.disabled=true};
 const alive=()=>!closed&&!attempted&&performance.now()<deadline;
 function expire(){if(closed||attempted)return;if(performance.now()<deadline){timer=setTimeout(expire,Math.max(1,Math.ceil(deadline-performance.now())));return;}closed=true;clear();disable();$('status').textContent='Entry window expired. Nothing further can be submitted.';controller?.abort();}
 window.addEventListener('pagehide',()=>{closed=true;clear();disable();clearTimeout(timer);controller?.abort()});
 document.addEventListener('visibilitychange',()=>{if(document.hidden)clear()});
 $('entry').addEventListener('input',()=>{$('save').disabled=!(alive()&&$('confirmed').checked&&$('clientId').value.length>=8&&$('clientSecret').value.length>=8)});
 $('entry').addEventListener('submit',async e=>{
  e.preventDefault();if(!alive()||!$('confirmed').checked)return;attempted=true;clearTimeout(timer);
  const body={clientId:$('clientId').value,clientSecret:$('clientSecret').value,requestId:descriptor.requestId,expectedRevision:descriptor.expectedRevision,reviewDigest:descriptor.reviewDigest,confirmed:true};clear();disable();
  try{sessionStorage.setItem('p2g-live-entry-'+descriptor.requestId,'attempted');}catch{body.clientId='';body.clientSecret='';$('status').textContent='Private submission blocked because one-use browser storage is unavailable.';return;}
  controller=new AbortController();const began=performance.now(),postDeadline=Math.min(began+5000,deadline);let timedOut=false,cause='network unavailable',http=null,diagnostic=null;
  const timeout=setTimeout(()=>{timedOut=true;controller.abort()},Math.max(1,postDeadline-performance.now()));
  const current=()=>{if(performance.now()>=postDeadline){timedOut=true;controller.abort()}if(closed||controller.signal.aborted)throw Error()};
  $('status').textContent='Saving privately. Do not submit again.';
  try{
   const r=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body),signal:controller.signal});current();http=httpStatus(r);cause='invalid response';
   const result=await r.json();current();
   if(!r.ok||result?.status!=='stored'||result.requestId!==descriptor.requestId){cause=r.ok?'invalid response':'response refused';diagnostic=diagnosticFrom(result);throw Error()}
   $('status').textContent='Credentials stored. No Parcel2Go token or quote request was made.';
  }catch{
   if(!closed){if(performance.now()>=deadline){cause='entry window ended';diagnostic=null;}else if(timedOut){cause='browser deadline reached';diagnostic=null;}
    $('status').textContent='Save unconfirmed. Reload to check saved status; do not submit again. '+detail(diagnostic,'save request',cause,began,http);}
  }finally{body.clientId='';body.clientSecret='';clearTimeout(timeout);}
 });
 (async()=>{
  const began=performance.now();let stage='session/status request',cause='network unavailable',http=null,diagnostic=null;
  const load=async(url,label)=>{try{return await fetch(url,{credentials:'same-origin',cache:'no-store'});}catch{stage=label;throw Error();}};
  try{
   const [a,b]=await Promise.all([load('/api/auth/session','session request'),load(path,'saved-status request')]);if(closed)return;
   stage='session request';http=httpStatus(a);if(!a.ok){cause='response refused';throw Error()}
   cause='invalid response';const session=await a.json();if(closed)return;
   stage='saved-status request';http=httpStatus(b);const d=await b.json();if(closed)return;
   if(!b.ok){cause='response refused';diagnostic=diagnosticFrom(d);throw Error()}
   if(d?.status==='stored'){$('status').textContent='Credentials are already stored. No repeat submission is needed.';return;}
   diagnostic=diagnosticFrom(d);
   if(d?.status!=='ready'||d.canSubmit!==true||typeof d.requestId!=='string'||typeof d.reviewDigest!=='string'||!Number.isFinite(d.remainingMs)||d.remainingMs<=0||d.remainingMs>300000||typeof session?.csrf!=='string'||session.csrf.length<16)throw Error();
   stage='browser one-use storage';cause='unavailable';if(sessionStorage.getItem('p2g-live-entry-'+d.requestId))throw Error();
   descriptor=d;csrf=session.csrf;deadline=performance.now()+d.remainingMs;$('account').textContent='Parcel2Go account: '+d.principalEmail+' (Runvara alias: '+d.accountAlias+').';$('review').hidden=false;$('status').textContent='Review the account and terms before saving.';timer=setTimeout(expire,Math.max(1,Math.ceil(d.remainingMs)));
  }catch{clear();disable();if(!closed)$('status').textContent='Private entry is unavailable or needs saved-status reconciliation. Do not retry credentials. '+detail(diagnostic,stage,cause,began,http);}
 })();
})();
