/* Private owner renewal. Reads never approve or execute; all writes are explicit. */
(function () {
  'use strict';
  const BASE='/api/owner/shopify-runtime-renewal';
  const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
  const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join('|')===keys.split(' ').sort().join('|');
  const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;
  const scopes=['read_inventory','read_orders','read_products'];
  const validRemaining=x=>Number.isSafeInteger(x)&&x>=0&&x<=300000;
  const confirmation='Approve one existing-connection renewal; no import or order reads.';
  function status(x){
    if(!exact(x,'schema enabled state expectedRevision canReview canRun canClose approval outcome terminal')||x.schema!=='runvara-shopify-runtime-owner/v2'||x.enabled!==true
      ||!['ready','expired','stopped','check_result'].includes(x.state)||!uuid(x.expectedRevision)||!['canReview','canRun','canClose','terminal'].every(k=>typeof x[k]==='boolean')
      ||!['none','approved','stored','uncertain','closed'].includes(x.outcome))throw Error('Invalid status');
    const a=x.approval;
    if(a!==null&&(!exact(a,'requestId previousRequestId expiresAt remainingMs')||!uuid(a.requestId)||!uuid(a.previousRequestId)||a.requestId===a.previousRequestId||!iso(a.expiresAt)||!validRemaining(a.remainingMs)))throw Error('Invalid approval');
    if(x.canRun&&(!a||x.outcome!=='approved'||x.state!=='ready'||x.canReview||!x.canClose||a.remainingMs<=0))throw Error('Invalid execution state');
    if(x.canClose&&!a||x.outcome==='none'&&a||x.outcome!=='none'&&!a)throw Error('Invalid state');
    if(x.terminal&&(!a||!['stored','closed'].includes(x.outcome))||x.outcome==='stored'&&!x.terminal||x.outcome==='closed'&&(x.canClose||!x.terminal))throw Error('Invalid terminal result');
    return x;
  }
  function review(x){
    if(!exact(x,'schema review remainingMs')||x.schema!=='runvara-shopify-runtime-review/v2'||!validRemaining(x.remainingMs))throw Error('Invalid review');
    const r=x.review;
    if(!exact(r,'requestId expectedRevision previousRequestId connectionId domain action scopes expiresAt confirmation issuedAt termsVersion challenge')||!uuid(r.requestId)||!uuid(r.expectedRevision)||!uuid(r.previousRequestId)
      ||r.requestId===r.previousRequestId||r.connectionId!=='conn_d3e0af94-fd74-4791-aed2-59b2f9ddd2e8'||r.domain!=='wavtzm-vy.myshopify.com'||r.action!=='renew_expired/v1'
      ||JSON.stringify(r.scopes)!==JSON.stringify(scopes)||!iso(r.expiresAt)||!iso(r.issuedAt)||Date.parse(r.expiresAt)<=Date.parse(r.issuedAt)||Date.parse(r.expiresAt)>Date.parse(r.issuedAt)+300000
      ||r.termsVersion!=='shopify-expired-renewal-terms/v1'||typeof r.challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(r.challenge)||r.confirmation!==confirmation)throw Error('Invalid binding');
    return r;
  }
  function create({request,getContext,onAuthFailure}){
    let root,enabled=false,snapshot=null,draft=null,busy=false,message='',unknown=false,pending=null,generation=0,cancel,timer,session;
    const clocks=new Map(),expired=new Set();
    const context=()=>getContext();
    const owner=()=>{const c=context();return c.session===session&&!c.closed&&c.view==='channels'&&c.session?.ownerWorkspace===true&&c.session.user?.role==='owner'&&c.session.workspace?.id==='packsmart-solutions';};
    const storageKey=()=>`runvara-runtime-renewal:${session?.workspace?.id}:${session?.user?.id}`;
    const node=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
    function observe(id,remaining,start){
      const now=performance.now(),old=clocks.get(id);
      if(!validRemaining(remaining)||!Number.isFinite(now)||now<start||old&&now<old.last){expired.add(id);return;}
      const deadline=Math.min(start+remaining,old?.deadline??Infinity);clocks.set(id,{deadline,last:now});if(now>=deadline)expired.add(id);
    }
    function open(id){const c=clocks.get(id),now=performance.now();if(!c)return false;if(now<c.last||now>=c.deadline)expired.add(id);c.last=now;return !expired.has(id);}
    function allowed(id){
      if(!owner()||!enabled||busy)return false;
      const a=snapshot?.approval;
      if(id==='runtime-renewal-check')return true;
      if(id==='runtime-renewal-stop')return Boolean(snapshot?.canClose&&(!unknown||pending&&pending.phase!=='close'&&pending.requestId===a?.requestId));
      if(unknown)return false;
      if(id==='runtime-renewal-review')return !draft&&(!snapshot||snapshot.canReview);
      if(id==='runtime-renewal-approve')return Boolean(draft&&open(draft.requestId));
      if(id==='runtime-renewal-run')return Boolean(snapshot?.canRun&&a&&open(a.requestId));
      return false;
    }
    function mark(phase,id){pending={phase,requestId:id};unknown=true;sessionStorage.setItem(storageKey(),JSON.stringify(pending));}
    function clearMarker(){sessionStorage.removeItem(storageKey());pending=null;unknown=false;}
    function accept(value,start,expected){
      const next=status(value);if(expected&&next.approval?.requestId!==expected)throw Error('Wrong result');
      snapshot=next;if(next.approval)observe(next.approval.requestId,next.approval.remainingMs,start);
      // Only a corroborated matching terminal result clears the UI marker.
      // Missing/other/uncertain reads never reset permission or allow replay.
      if(pending&&next.approval?.requestId===pending.requestId&&next.terminal&&(pending.phase!=='close'||!next.canClose))clearMarker();
    }
    async function action(kind){
      const ids={review:'runtime-renewal-review',approve:'runtime-renewal-approve',run:'runtime-renewal-run',status:'runtime-renewal-check',close:'runtime-renewal-stop'};
      if(!allowed(ids[kind]))return;
      const write=['approve','run','close'].includes(kind),r=kind==='approve'?draft:snapshot?.approval;
      if(kind==='approve'&&!window.confirm('Approve one renewal for the existing Packsmart Shopify connection? Existing credentials go only to wavtzm-vy.myshopify.com. It replaces verified expired access, retaining product, inventory and order-read capabilities for about 24 hours. Credentials or tokens could be misused if exposed. The server reads saved workspace data internally and keeps audit/retention records. No import or order read. This approval does not execute the renewal; Run once is separate.'))return;
      if(kind==='run'&&!window.confirm('Run this approved Shopify renewal once now? An uncertain attempt will not be retried. Stopping afterwards does not revoke an issued token.'))return;
      const epoch=generation,current=()=>generation===epoch&&owner();
      busy=true;cancel=new AbortController();message=write?'Waiting for the saved result. Do not repeat.':'Checking saved authorization only.';render();
      const started=performance.now();
      try{
        if(write)mark(kind,r.requestId);
        const body=kind==='approve'?draft:write?{requestId:r.requestId,expectedRevision:snapshot.expectedRevision}:undefined;
        const value=await request(BASE+'/'+kind,{...(write?{method:'POST',body:JSON.stringify(body)}:{}),shopifyRuntimeRequest:true,signal:cancel.signal,isCurrent:current});
        if(!current())return;
        if(kind==='review'){draft=review(value);observe(draft.requestId,value.remainingMs,started);message='Review ready. Approval and Run once are separate actions.';}
        else{
          accept(value,started,write?r.requestId:null);draft=null;
          if(kind==='approve'&&snapshot.outcome==='approved'&&snapshot.canRun)clearMarker();
          message=kind==='close'&&!snapshot.canClose?(snapshot.terminal?'Stopped. Permission closed; retained evidence and any issued access remain.':'Stopped. Permission closed; issuer outcome is still uncertain. Operator reconciliation required; do not retry.'):
            unknown&&(!pending||snapshot.approval?.requestId!==pending.requestId)?'Stopped. This read does not resolve the pending request. Operator reconciliation required; do not retry.':
            snapshot.outcome==='stored'?'Check result: replacement saved encrypted and receipt verified. '+(snapshot.canClose?'Stop this permission; this does not revoke issued access.':'Permission closed; issued access remains.'):
            snapshot.outcome==='uncertain'?'Stopped. Outcome is uncertain; operator reconciliation required without another attempt.':kind==='status'?'Saved result checked. No renewal was repeated.':'Approved. Select Run once only when ready.';
        }
      }catch(error){if(current()){
        draft=null;
        if(write||unknown||pending){message='Stopped. Check result before any further action. An uncertain operation must not be repeated.';unknown=true;}
        else{snapshot=null;message='Saved authorization could not be read. Check result again. This read submitted no approval or renewal.';}
        if(error.status===401||error.status===403)onAuthFailure?.();
      }}
      finally{if(current()){busy=false;cancel=null;render();}}
    }
    function render(){
      clearTimeout(timer);if(!root)return;root.replaceChildren();root.hidden=!owner();if(!owner())return;
      root.append(node('h3','Shopify access renewal'));
      if(!enabled){root.append(node('p','Off. Runtime renewal is not enabled. No approval or renewal can run here.'));return;}
      const a=draft||snapshot?.approval,closed=a&&!open(a.requestId),label=snapshot?.state==='check_result'?'Check result':unknown||snapshot?.state==='stopped'?'Stopped':closed?'Expired':'Ready';
      const state=node('p',label);state.id='runtime-renewal-state';state.setAttribute('role','status');root.append(state);
      root.append(node('p','Existing Packsmart connection: wavtzm-vy.myshopify.com. Review, approval and execution are separate. Opening or reloading this page starts no renewal or import.'));
      root.append(node('p','One attempt, up to five minutes including processing. Existing scopes: read_inventory, read_orders, read_products. No scope expansion or order/customer queries. Stop does not revoke an issued token.'));
      if(a)root.append(node('p','Permission ends: '+a.expiresAt));
      const row=node('div','');row.className='button-row';
      for(const [kind,id,text] of [['review','runtime-renewal-review','Review renewal'],['approve','runtime-renewal-approve','Approve this renewal'],['run','runtime-renewal-run','Run once'],['status','runtime-renewal-check','Check result'],['close','runtime-renewal-stop','Stop permission']]){
        const b=node('button',text);b.id=id;b.type='button';b.className=kind==='approve'||kind==='run'?'primary':'secondary';b.disabled=!allowed(id);b.onclick=()=>action(kind);row.append(b);
      }
      root.append(row);const result=node('p',message);result.id='runtime-renewal-result';result.setAttribute('role','status');root.append(result);
      if(a&&open(a.requestId))timer=setTimeout(render,Math.max(1,clocks.get(a.requestId).deadline-performance.now()));
    }
    function clear(){generation++;cancel?.abort();cancel=null;clearTimeout(timer);busy=false;draft=null;snapshot=null;message='';root?.replaceChildren();}
    function mount(element,capability){
      const next=context().session;if(next!==session){clear();session=next;unknown=false;pending=null;}
      root=element;enabled=exact(capability,'enabled')&&capability.enabled===true;
      try{const value=sessionStorage.getItem(storageKey());if(value){unknown=true;const parsed=JSON.parse(value);pending=exact(parsed,'phase requestId')&&['approve','run','close'].includes(parsed.phase)&&uuid(parsed.requestId)?parsed:null;}}catch{unknown=true;pending=null;}
      render();
    }
    return Object.freeze({mount,clear,allowsControl:allowed});
  }
  window.RunvaraShopifyRuntime=Object.freeze({create});
})();
