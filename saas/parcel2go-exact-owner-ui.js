// Unmounted synthetic decision panel. No provider request or production route.
(()=>{'use strict';window.RunvaraExactOwnerUI={create({decide}){let root,epoch=0,timer,controller;function clear(){epoch++;clearTimeout(timer);controller?.abort();root?.replaceChildren();}function mount(target,v){clear();root=target;const gen=epoch;const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;root.append(n);return n;};
 if(v?.schema!=='runvara-exact-owner-panel/v1'||v.synthetic!==true||v.operationalExecution!==false||v.maxSpendMinor!==0||v.currency!=='GBP'||v.bookingAllowed!==false||v.labelsAllowed!==false||v.collectionsAllowed!==false||v.permission!=='one_quote_only'||v.maxTokenRequests!==1||v.maxQuoteRequests!==1||!Number.isFinite(v.remainingMs)||v.remainingMs<0||v.remainingMs>300000||! /^[a-f0-9]{64}$/.test(v.operationHash??'')){el('p','Review unavailable');return;}
 const snapshot=structuredClone(v);v=snapshot;const end=performance.now()+v.remainingMs;let spent=false;el('h2','Synthetic quote approval review');el('p','This records a test decision only. It does not send parcel data, buy a label or book a collection.');
 for(const [label,value] of [['Account',v.accountId],['Recipient',v.reviewSummary?.recipient],['Collection',v.reviewSummary?.collection],['Delivery',v.reviewSummary?.delivery],['Parcel',v.reviewSummary?.parcel],['Estimate evidence',v.reviewSummary?.estimateProvenance],['Terms',v.termsReference],['Account evidence',v.accountEvidenceReference],['Expires',v.expiresAt]])el('p',label+': '+String(value??''));
 const label=el('label','I have reviewed these exact details. '),check=document.createElement('input');check.type='checkbox';label.append(check);const approve=el('button','Approve test decision'),reject=el('button','Reject'),status=el('p',v.status==='pending'?'Awaiting your decision':'Already decided');
 const update=()=>{const expired=performance.now()>=end;check.disabled=spent||expired||v.status!=='pending';approve.disabled=check.disabled||!check.checked;reject.disabled=check.disabled;if(expired){controller?.abort();status.textContent='Review expired; reload to reconcile.';}return expired;};check.onchange=update;
 function expire(){if(gen!==epoch)return;if(!update())timer=setTimeout(expire,Math.max(1,Math.ceil(end-performance.now())));}expire();
 async function submit(decision){if(spent||performance.now()>=end||v.status!=='pending'||decision==='approved'&&!check.checked)return;spent=true;update();controller=new AbortController();status.textContent='Saving decision…';try{const result=await decide(snapshot.approvalId,{decision,revision:snapshot.revision,operationHash:snapshot.operationHash},{signal:controller.signal});if(gen!==epoch)return;if(performance.now()>=end){update();return;}if(result?.durableDecision!==true||result.operationalExecution!==false||result.synthetic!==true||result.approvalId!==snapshot.approvalId||result.operationHash!==snapshot.operationHash||result.status!==decision)throw Error();status.textContent='Test decision saved: '+decision+'. No quote executed.';}catch{if(gen===epoch){if(performance.now()>=end)update();else status.textContent='Decision unconfirmed. Reload to reconcile; do not retry.';}}}
 approve.onclick=()=>submit('approved');reject.onclick=()=>submit('rejected');update();}
 return {mount,clear};}};})();

// Separate explicit mode on the existing owner-review component. The synthetic
// panel above retains its test-only contract. Nothing mounts on the normal app.
(()=>{'use strict';
 const SCHEMA='runvara-owner-input-quote-review/v1',PATH='/api/owner/parcel2go-quote-review';
 const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
 const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
 const fail=()=>{throw Error('Review unavailable');};
 window.RunvaraExactOwnerUI.createOwnerInput=function(options={}){
  if((options.mode??'disabled/v1')==='disabled/v1')return {async mount(root){root.replaceChildren(document.createTextNode('Quote review disabled.'));},clear(){}};
  if(options.mode!=='unmounted-owner-input-ui/v1'||location.protocol!=='https:'||!uuid(options.requestId))fail();
  const requestId=options.requestId,path=PATH+'?requestId='+requestId,fetcher=options.fetch??window.fetch.bind(window);
  let root,csrf,epoch=0,closed=true,busy=false,deadline=Infinity,timer,controller,storage,storageReady=false;
  const key=action=>'p2g-owner-quote-'+requestId+'-'+action;
  const el=(parent,tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;parent.append(n);return n;};
  const disable=()=>{root?.querySelectorAll('input,select,button').forEach(n=>{n.disabled=true;});};
  const alive=()=>!closed&&performance.now()<deadline;
  const status=text=>{let n=root.querySelector('[role="status"]');if(!n){n=el(root,'p');n.setAttribute('role','status');}n.textContent=text;};
  const expire=()=>{if(closed)return;if(performance.now()<deadline){timer=setTimeout(expire,Math.max(1,Math.ceil(deadline-performance.now())));return;}disable();controller?.abort();status('Review expired. Reconcile saved status; do not repeat a request.');};
  const clear=()=>{closed=true;epoch++;clearTimeout(timer);controller?.abort();disable();root?.replaceChildren();window.removeEventListener('pagehide',clear);};
  const marker=action=>{if(!storageReady)return true;try{return storage.getItem(key(action))!==null;}catch{storageReady=false;return true;}};
  function mark(action){if(!storageReady||marker(action))fail();storage.setItem(key(action),'attempted');if(storage.getItem(key(action))!=='attempted')fail();}
  function base(v){
   if(v?.schema!==SCHEMA||v.requestId!==requestId||v.sourceVerified!==false||v.accountEntitlementVerified!==false||v.liveReady!==false||v.providerCallsAllowed!==false||!Number.isFinite(v.remainingMs)||v.remainingMs<0||v.remainingMs>300000||typeof v.expiresAt!=='string'||!Number.isFinite(Date.parse(v.expiresAt))||new Date(v.expiresAt).toISOString()!==v.expiresAt)fail();
   if(!['input_required','pending','approved','rejected'].includes(v.status))fail();
   if(v.status!=='input_required'){
    if(!/^approval_[a-f0-9-]{36}$/.test(v.approvalId??'')||!digest(v.operationHash)||v.revision!==1||v.inputSource!=='owner_entered'||v.permission!=='one_quote_only'||v.maxTokenRequests!==1||v.maxQuoteRequests!==1||v.maxSpendMinor!==0||v.currency!=='GBP'||v.bookingAllowed!==false||v.labelsAllowed!==false||v.collectionsAllowed!==false||v.operationalExecution!==false||v.separateExecutionConfirmationRequired!==true||!['not_started','reconcile_no_replay'].includes(v.executionStatus)||typeof v.canExecute!=='boolean')fail();
    for(const k of ['recipient','collection','delivery','parcel','estimateProvenance'])if(typeof v.reviewSummary?.[k]!=='string'||!v.reviewSummary[k].trim()||v.reviewSummary[k].length>1000)fail();
   }
   return structuredClone(v);
  }
  async function request(url,body,gen){
   const active=new AbortController();controller=active;const limit=body?.action==='execute'?12000:2000;
   const timeout=setTimeout(()=>active.abort(),Math.max(1,Math.min(limit,deadline-performance.now())));
   try{const response=await fetcher(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',
     headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},...(body?{body:JSON.stringify(body)}:{}),signal:active.signal});
    if(active.signal.aborted||gen!==epoch||!alive())fail();const text=await response.text();if(text.length>65536||!response.ok||active.signal.aborted||gen!==epoch||!alive())fail();return JSON.parse(text);
   }finally{clearTimeout(timeout);}
  }
  function bound(v,began){deadline=Math.min(deadline,began+v.remainingMs);clearTimeout(timer);timer=setTimeout(expire,Math.max(1,Math.ceil(deadline-performance.now())));}
  function checkbox(parent,name,text){const label=el(parent,'label'),input=el(label,'input');input.type='checkbox';input.name=name;label.append(document.createTextNode(text));return input;}
  function summary(v){
   el(root,'h2','Review the exact parcel');el(root,'p','Owner-entered information. Estimates and reported measurements are not independently verified. This is a price comparison, not a guaranteed dispatch price.');
   const list=el(root,'dl');for(const [label,value] of [['Account',v.accountAlias],['Recipient',v.reviewSummary.recipient],['Collection',v.reviewSummary.collection],['Delivery',v.reviewSummary.delivery],['Parcel',v.reviewSummary.parcel],['Evidence',v.reviewSummary.estimateProvenance],['Terms reference',v.termsReference],['Review expires',v.expiresAt]]){el(list,'dt',label);el(list,'dd',String(value??''));}
  }
  function render(v){
   root.replaceChildren();el(root,'h1','Parcel2Go comparison');
   if(v.status==='input_required'){
    el(root,'p','Enter the complete parcel including all outer packaging. Use your own measurements or label your values as estimates. Preparation saves a review in Runvara; it sends nothing to Parcel2Go.');
    if(marker('prepare')){status('Preparation may already have been attempted. Reconcile saved status; do not submit it again.');return;}
    const form=el(root,'form');form.autocomplete='off';const controls={};
    function field(name,label,values){const wrap=el(form,'label',label+' '),n=el(wrap,values?'select':'input');n.name=name;n.required=true;controls[name]=n;
     if(values){el(n,'option','Choose…').value='';for(const [value,text] of values){const opt=el(n,'option',text);opt.value=value;}}
     else{n.type='text';n.maxLength=name.includes('Postcode')?8:16;if(!name.includes('Postcode'))n.inputMode='decimal';}return n;}
    field('collectionPostcode','Collection postcode');field('deliveryPostcode','Delivery postcode');
    const vat=[['Individual','Individual'],['NotRegistered','Not registered'],['Registered','Registered']];
    field('collectionVatStatus','Collection VAT status (your declaration)',vat);field('deliveryVatStatus','Delivery VAT status (your declaration)',vat);
    field('currency','Declared value currency',[['GBP','GBP']]);
    field('basis','Parcel evidence',[['estimate','Owner estimate'],['measured','Owner-reported measurement']]);
    for(const [name,label] of [['weightGrams','Whole-package weight (grams)'],['lengthMm','Outer length (mm)'],['widthMm','Outer width (mm)'],['heightMm','Outer height (mm)'],['declaredValueDecimal','Contents value (GBP, two decimal places)']])field(name,label);
    const check=checkbox(form,'acknowledgedUnverified',' These values describe the complete package including outer packaging. I understand they are my declarations and have not been independently verified.');
    const prepare=el(form,'button','Prepare exact review');prepare.type='submit';prepare.disabled=true;
    const metric=(name,max,divisor)=>{const v=controls[name].value.trim();if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$/.test(v)||Number(v)<=0||Number(v)>max)return false;
     const [whole,fraction='']=v.split('.');return (BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0')))%divisor===0n;};
    const ready=()=>alive()&&!busy&&check.checked&&Object.values(controls).every(n=>n.value.trim())&&
     ['collectionPostcode','deliveryPostcode'].every(k=>/^(GIR 0AA|[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2})$/.test(controls[k].value.trim()))&&
     metric('weightGrams',1000000,10000n)&&['lengthMm','widthMm','heightMm'].every(k=>metric(k,10000,100n))&&/^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/.test(controls.declaredValueDecimal.value.trim());
    form.oninput=form.onchange=()=>{prepare.disabled=!ready();};
    form.onsubmit=e=>{e.preventDefault();if(!ready())return;
     const d=Object.fromEntries(['currency','collectionVatStatus','deliveryVatStatus','collectionPostcode','deliveryPostcode'].map(k=>[k,controls[k].value.trim()]));
     d.acknowledgedUnverified=true;d.parcel={basis:controls.basis.value,scope:'whole_package',includesOuter:true,...Object.fromEntries(['weightGrams','lengthMm','widthMm','heightMm','declaredValueDecimal'].map(k=>[k,controls[k].value.trim()]))};
     submit('prepare',{declaration:d},v);
    };status('Enter your parcel details.');
   }else{
    summary(v);
    if(v.executionStatus==='reconcile_no_replay'||marker('execute')){status('A quote attempt is recorded or unconfirmed. Reconcile the saved outcome; do not repeat it.');return;}
    if(v.status==='rejected'){status('Review rejected. No quote can be requested from this review.');return;}
    if(v.status==='pending'){
     if(marker('decide')){status('Decision unconfirmed. Reconcile saved status; do not submit it again.');return;}
     const check=checkbox(root,'reviewed',' I have reviewed these exact details and approve one quote comparison.');
     const approve=el(root,'button','Approve exact review'),reject=el(root,'button','Reject');approve.disabled=true;
     check.onchange=()=>{approve.disabled=!alive()||busy||!check.checked;};
     const decide=decision=>submit('decide',{approvalId:v.approvalId,confirmation:{decision,revision:v.revision,operationHash:v.operationHash}},v);
     approve.onclick=()=>{if(check.checked)decide('approved');};reject.onclick=()=>decide('rejected');status('Approval saves your decision. It does not contact Parcel2Go.');
    }else if(v.canExecute){
     const check=checkbox(root,'sendConfirmed',' Send these exact parcel and address details to Parcel2Go for one comparison. No booking or spending is authorised.');
     const send=el(root,'button','Request one quote comparison');send.disabled=true;check.onchange=()=>{send.disabled=!alive()||busy||!check.checked;};
     send.onclick=()=>{if(check.checked)submit('execute',{approvalId:v.approvalId,confirmation:{approvalId:v.approvalId,operationHash:v.operationHash,requestId,confirmed:true}},v);};
     status('Exact review approved. A quote has not been requested by this page.');
    }else status('Quote execution unavailable. Reconcile saved status.');
   }
   if(!alive())expire();
  }
  function result(v,review){
   const q=v?.quote;
   if(v?.status!=='completed'||v.requestId!==requestId||v.inputSource!=='owner_entered'||v.sourceVerified!==false||v.accountEntitlementVerified!==false||v.liveReady!==false||v.purchaseAllowed!==false||q?.requestId!==requestId||q.responseSource!=='live-http'||q.liveReady!==false||q.purchaseAllowed!==false||q.priceGuaranteed!==false||q.deliveryGuaranteed!==false||!Array.isArray(q.quotes)||q.quotes.length>50)fail();
   const seen=new Set();for(const row of q.quotes){
    if(!/^[a-z0-9][a-z0-9-]{0,79}$/.test(row.serviceCode??'')||seen.has(row.serviceCode)||row.currency!=='GBP'||row.purchaseAllowed!==false||row.priceGuaranteed!==false||row.deliveryGuaranteed!==false)fail();seen.add(row.serviceCode);
    for(const k of ['totalDecimal','netDecimal','vatDecimal'])if(typeof row[k]!=='string'||!/^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/.test(row[k]))fail();
    if(BigInt(row.netDecimal.replace('.',''))+BigInt(row.vatDecimal.replace('.',''))!==BigInt(row.totalDecimal.replace('.','')))fail();
   }
   root.replaceChildren();el(root,'h1','Parcel2Go comparison');summary(review);
   el(root,'h2','Returned comparisons');el(root,'p','These amounts use your declared inputs. Prices, service availability and delivery are not guaranteed. No booking, label purchase or collection was made.');
   if(!q.quotes.length)el(root,'p','No supported service comparisons were returned.');
   else{const table=el(root,'table'),head=el(table,'tr');for(const label of ['Service','Total GBP','Net GBP','VAT GBP'])el(head,'th',label);
    for(const row of q.quotes){const tr=el(table,'tr');for(const value of [row.serviceCode,row.totalDecimal,row.netDecimal,row.vatDecimal])el(tr,'td',value);}}
   status('Comparison received. This attempt cannot be repeated.');
  }
  async function submit(action,fields,previous){
   if(busy||!alive())return;const gen=epoch,began=performance.now();busy=true;disable();
   try{mark(action);status(action==='execute'?'Requesting one comparison. Do not submit again.':'Saving review. Do not submit again.');
    const out=await request(path,{action,requestId,...fields},gen);if(gen!==epoch)return;
    if(action==='execute'){result(out,previous);return;}
    const v=base(out);if(action==='prepare'&&v.status!=='pending'||action==='decide'&&(v.durableDecision!==true||v.status!==fields.confirmation.decision||v.operationHash!==previous.operationHash||v.approvalId!==previous.approvalId||JSON.stringify(v.reviewSummary)!==JSON.stringify(previous.reviewSummary)))fail();
    bound(v,began);busy=false;render(v);
   }catch{if(gen===epoch&&!closed){disable();if(!alive())expire();else status('Outcome unconfirmed. Reconcile saved status; do not retry.');}}
  }
  async function mount(target){
   clear();root=target;closed=false;busy=true;deadline=Infinity;const gen=epoch,began=performance.now();window.addEventListener('pagehide',clear,{once:true});
   root.replaceChildren();status('Checking owner review…');
   try{storage=options.storage??window.sessionStorage;storageReady=true;storage.getItem(key('prepare'));
    // The existing authenticated session endpoint supplies CSRF; no token or
    // provider credential is exposed to this component or put in browser storage.
    const session=await request('/api/auth/session',undefined,gen);if(typeof session.csrf!=='string'||session.csrf.length<16)fail();csrf=session.csrf;
    const v=base(await request(path,undefined,gen));if(gen!==epoch)return;bound(v,began);busy=false;render(v);
   }catch{if(gen===epoch&&!closed){storageReady=false;disable();status('Review unavailable or needs reconciliation. No request has been retried.');}}
  }
  return {mount,clear};
 };
 const target=document.querySelector('[data-p2g-owner-quote]');
 if(target&&location.pathname==='/owner/parcel2go-quote'&&location.search&&new URL(location.href).searchParams.size===1){
  try{const ui=window.RunvaraExactOwnerUI.createOwnerInput({mode:'unmounted-owner-input-ui/v1',requestId:new URL(location.href).searchParams.get('requestId')});ui.mount(target);}catch{target.textContent='Quote review unavailable.';}
 }
})();
