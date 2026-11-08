(() => {
  'use strict';
  const PATH='/api/owner/parcel2go-sandbox-quote',uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  const exact=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===names.split(' ').sort().join('|');
  function quote(q,id){
    if(q===null)return true;
    if(!exact(q,'schema requestId observedAt quotes synthetic responseSource syntheticParcel accountVerified liveReady quoteValidity purchaseAllowed')||q.schema!=='runvara-parcel2go-sandbox-quote/v1'||q.requestId!==id||q.synthetic!==false||q.responseSource!=='sandbox-http'||q.syntheticParcel!==true||q.accountVerified!==false||q.liveReady!==false||q.quoteValidity!=='unknown'||q.purchaseAllowed!==false||typeof q.observedAt!=='string'||!Number.isFinite(Date.parse(q.observedAt))||!Array.isArray(q.quotes)||q.quotes.length>50)return false;
    const seen=new Set(),pence=s=>Number(s.replace('.',''));
    return q.quotes.every(v=>{if(!exact(v,'serviceCode totalDecimal netDecimal vatDecimal currency currencySource amountSource tax quoteExpiresAt priceGuaranteed deliveryGuaranteed purchaseAllowed')||typeof v.serviceCode!=='string'||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(v.serviceCode)||seen.has(v.serviceCode)||v.currency!=='GBP'||v.currencySource!=='Quote.CurrencyCode'||v.amountSource!=='Quote.TotalPrice'||v.tax!=='included'||v.quoteExpiresAt!==null||v.priceGuaranteed!==false||v.deliveryGuaranteed!==false||v.purchaseAllowed!==false||!['totalDecimal','netDecimal','vatDecimal'].every(k=>typeof v[k]==='string'&&/^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/.test(v[k]))||pence(v.netDecimal)+pence(v.vatDecimal)!==pence(v.totalDecimal))return false;seen.add(v.serviceCode);return true;});
  }
  function descriptor(v){
    if(!exact(v,'schema requestId expectedRevision accountId connectionId environment expiresAt remainingMs canSubmit outcome scope dataContract quoteCount quote')||v.schema!=='runvara-parcel2go-owner-quote/v1'||!uuid(v.requestId)||!uuid(v.expectedRevision)||v.environment!=='sandbox'||v.scope!=='public-api'||v.dataContract!=='synthetic-gbp-notregistered/v1'||typeof v.canSubmit!=='boolean'||!Number.isSafeInteger(v.remainingMs)||v.remainingMs<0||v.remainingMs>300000||!['not_started','completed','reconcile_no_replay','binding_unverified','state_changed'].includes(v.outcome)||!['accountId','connectionId'].every(k=>typeof v[k]==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(v[k]))||typeof v.expiresAt!=='string'||!Number.isFinite(Date.parse(v.expiresAt))||!quote(v.quote,v.requestId))return null;
    if(v.outcome==='completed'?(!Number.isSafeInteger(v.quoteCount)||v.quoteCount<0||v.quoteCount>50||v.canSubmit||v.quote!==null&&v.quote.quotes.length!==v.quoteCount):(v.quoteCount!==null||v.quote!==null))return null;
    if(v.canSubmit&&(v.outcome!=='not_started'||v.remainingMs===0))return null;return v;
  }
  const messages={not_started:'No sandbox test is recorded.',completed:'The sandbox test receipt is saved. This is not a booking or proof of account eligibility.',reconcile_no_replay:'The attempt is spent or uncertain. Reconcile its saved receipt; do not repeat it.',binding_unverified:'The saved sandbox connection does not match this permission.',state_changed:'Saved workspace changed. This permission cannot run.'};
  window.RunvaraParcel2GoQuote={create({request,getContext}){
    let root,current,epoch=0,busy=false,timer,pending,message='',refreshExpiry;
    const deadlines=new Map(),attempts=new Set(),key=c=>'runvara-p2g-quote:packsmart-solutions:'+c.requestId;
    const owner=()=>{const c=getContext();return c?.session?.ownerWorkspace===true&&!c.closed&&c.session.user?.role==='owner'&&c.session.workspace?.id==='packsmart-solutions'&&c.view==='channels';};
    const spent=c=>{try{return attempts.has(key(c))||sessionStorage.getItem(key(c))==='sent';}catch{return true;}};
    const left=()=>current?Math.max(0,(deadlines.get(current.requestId)??0)-performance.now()):0;
    const editable=()=>Boolean(current&&owner()&&!busy&&current.canSubmit&&left()>0&&!spent(current));
    function clear(){epoch++;clearTimeout(timer);refreshExpiry=null;pending?.abort();pending=null;busy=false;current=null;message='';root?.replaceChildren();root?.classList.add('hidden');}
    function observe(raw,started){const c=descriptor(raw);if(!c||!Number.isFinite(started))return;deadlines.set(c.requestId,Math.min(deadlines.get(c.requestId)??Infinity,started+c.remainingMs));if(current?.requestId===c.requestId)refreshExpiry?.();}
    function mount(node,raw){clear();root=node;current=descriptor(raw);if(!root||!current||!owner())return;
      const generation=epoch,session=getContext().session,active=()=>generation===epoch&&getContext().session===session&&owner();
      const el=(tag,value)=>{const n=document.createElement(tag);if(value)n.textContent=value;return n;};
      root.classList.remove('hidden');root.append(el('h2','One Parcel2Go sandbox quote'),el('p','Account reference: '+current.accountId+'. One token request and one quote using existing encrypted sandbox access. No request runs just by opening this page.'));
      root.append(el('p','Synthetic test only: GBR to GBR; 250 g; 200 × 100 × 50 mm; declared GBP 12.30. Collection and delivery VAT status: NotRegistered as a fictional test assumption, not your VAT status.'));
      root.append(el('p','public-api is broad access. Runvara blocks live, order, payment, profile, shipment and label actions. No customer or order data is sent. Internal saved-workspace reads, reservation, receipt, audit and normal retention still occur. Closing cannot revoke stored credentials or an issued token.'));
      root.append(el('p','Permission ends: '+current.expiresAt));
      const label=el('label','I approve this one synthetic sandbox test. Refusal or uncertainty ends the attempt without retry or scope changes.'),confirm=el('input');confirm.id='p2g-quote-confirm';confirm.type='checkbox';label.prepend(confirm);root.append(label);
      const run=el('button','Run sandbox quote once');run.id='p2g-quote-run';run.type='button';run.className='primary';
      const status=el('button','Check saved quote receipt');status.id='p2g-quote-status';status.type='button';status.className='secondary';
      const result=el('p');result.id='p2g-quote-result';result.setAttribute('role','status');const list=el('div');list.id='p2g-quote-prices';root.append(run,status,result,list);
      function update(){const can=editable();confirm.disabled=!can;run.disabled=!can||!confirm.checked;status.disabled=!owner()||busy;result.textContent=message||messages[current.outcome];list.replaceChildren();
        if(left()<=0){confirm.checked=false;current={...current,quote:null};pending?.abort();result.textContent='This test window has expired. No further provider request is allowed. '+messages[current.outcome];if(current.outcome==='completed')list.append(el('p',String(current.quoteCount)+' result(s) recorded; quote prices are unavailable.'));return;}
        if(current.quote){list.append(el('p','Synthetic sandbox response only. Quote expiry, availability and account eligibility are unverified; no price or delivery guarantee.'));
          for(const q of current.quote.quotes)list.append(el('p',q.serviceCode+': GBP '+q.totalDecimal+' total; GBP '+q.netDecimal+' net; GBP '+q.vatDecimal+' VAT.'));
          if(current.quote.quotes.length===0)list.append(el('p','No quote results returned. This is not confirmation of service eligibility.'));
        }else if(current.outcome==='completed')list.append(el('p',String(current.quoteCount)+' result(s) recorded. Prices were not saved and cannot be recovered by repeating this test.'));
      }
      refreshExpiry=()=>{if(!active())return;clearTimeout(timer);update();if(left()>0)timer=setTimeout(()=>{if(active())update();},left());};
      confirm.addEventListener('change',update);refreshExpiry();
      async function call(method,body){const controller=new AbortController(),started=performance.now();pending=controller;const timeout=setTimeout(()=>controller.abort(),method==='POST'?Math.min(20000,left()):20000);
        try{const value=await request(PATH,{method,body:body?JSON.stringify(body):undefined,signal:controller.signal,isCurrent:active,parcel2goQuoteRequest:true});observe(value,started);return value;}
        finally{clearTimeout(timeout);if(pending===controller)pending=null;}}
      run.addEventListener('click',async()=>{
        if(!active()||!editable()||!confirm.checked)return;
        if(!window.confirm('Run one public-api-only sandbox token request and one quote for the displayed synthetic parcel? The API scope is broad. No orders, payments, shipments or labels. Refusal, timeout or uncertainty must not be retried.'))return;
        if(!active()||!editable())return;
        try{sessionStorage.setItem(key(current),'sent');}catch{message='Attempt tracking is unavailable. Nothing sent.';update();return;}attempts.add(key(current));
        const body={requestId:current.requestId,expectedRevision:current.expectedRevision,confirmed:true};confirm.checked=false;busy=true;message='One sandbox test requested. Do not repeat it.';update();
        try{const value=descriptor(await call('POST',body));if(active()){if(!value||value.requestId!==current.requestId)throw Error('INVALID');current=value;message=messages[value.outcome];}}
        catch{if(active())message='Sandbox test is unconfirmed or refused. Check saved receipt; do not repeat it.';}
        finally{if(active()){busy=false;refreshExpiry();}}
      });
      status.addEventListener('click',async()=>{if(!active()||busy)return;busy=true;update();
        try{const value=descriptor(await call('GET'));if(active()){if(!value||value.requestId!==current.requestId||value.quote!==null)throw Error('INVALID');current=value;message=messages[value.outcome];}}
        catch{if(active())message='Saved receipt is unavailable. Do not repeat the test.';}
        finally{if(active()){busy=false;refreshExpiry();}}
      });
    }
    return {observe,mount,clear,allowsControl(id){return id==='p2g-quote-status'?Boolean(current&&owner()&&!busy):['p2g-quote-confirm','p2g-quote-run'].includes(id)&&editable();}};
  }};
})();
