(() => {
  'use strict';
  const PATH='/api/owner/parcel2go-credentials';
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  function descriptor(v){
    const keys='accountId canSubmit connectionId environment expectedRevision expiresAt outcome providerCalls remainingMs requestId schema scope'.split(' ').sort().join('|');
    if(!v||Array.isArray(v)||Object.keys(v).sort().join('|')!==keys||v.schema!=='runvara-parcel2go-credential-entry/v1'
      ||!uuid(v.requestId)||!uuid(v.expectedRevision)||v.environment!=='sandbox'||v.scope!=='public-api'||v.providerCalls!==false
      ||typeof v.canSubmit!=='boolean'||!Number.isSafeInteger(v.remainingMs)||v.remainingMs<0||v.remainingMs>300000
      ||!['not_started','stored','reconcile_no_replay','connection_exists','state_changed'].includes(v.outcome)
      ||!['accountId','connectionId'].every(k=>typeof v[k]==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(v[k]))
      ||typeof v.expiresAt!=='string'||!Number.isFinite(Date.parse(v.expiresAt)))return null;
    return v;
  }
  window.RunvaraParcel2GoEntry={create({request,getContext}){
    let root=null,current=null,epoch=0,timer=null,controller=null,busy=false,message='',refreshExpiry=null;const deadlines=new Map(),attempts=new Set();
    const key=c=>'runvara-p2g-entry:packsmart-solutions:'+c.requestId;
    const attempted=c=>{try{return attempts.has(key(c))||sessionStorage.getItem(key(c))==='sent';}catch{return true;}};
    const owner=()=>{const c=getContext();return c?.session?.ownerWorkspace===true&&!c.closed&&c.session.user?.role==='owner'&&c.session.workspace?.id==='packsmart-solutions'&&c.view==='channels';};
    const left=()=>current?Math.max(0,(deadlines.get(current.requestId)??0)-performance.now()):0;
    const editable=()=>Boolean(current&&owner()&&!busy&&current.canSubmit&&left()>0&&!attempted(current));
    const clearFields=()=>root?.querySelectorAll('input').forEach(e=>{if(e.type==='checkbox')e.checked=false;else e.value='';});
    function clear(){epoch++;clearTimeout(timer);refreshExpiry=null;controller?.abort();controller=null;busy=false;clearFields();root?.replaceChildren();root?.classList.add('hidden');current=null;}
    function observe(raw,started){const c=descriptor(raw);if(!c||!Number.isFinite(started))return;const deadline=started+c.remainingMs;deadlines.set(c.requestId,Math.min(deadlines.get(c.requestId)??Infinity,deadline));if(current?.requestId===c.requestId)refreshExpiry?.();}
    const text={not_started:'No credential save is recorded.',stored:'Encrypted sandbox credentials are recorded. No token exchange or quote ran.',reconcile_no_replay:'The outcome requires reconciliation. Do not repeat the save.',connection_exists:'A connection already exists; replacement is not permitted.',state_changed:'Saved workspace changed. This permission cannot save credentials.'};
    function mount(node,raw){clear();root=node;current=descriptor(raw);if(!root||!current||!owner())return;
      root.classList.remove('hidden');const generation=epoch,context=getContext().session;
      const active=()=>generation===epoch&&getContext().session===context&&owner();
      const el=(tag,value)=>{const n=document.createElement(tag);if(value)n.textContent=value;return n;};
      root.append(el('h2','Private Parcel2Go sandbox access'),el('p','Account reference: '+current.accountId+'. Sandbox only. This saves access encrypted in Runvara; it does not contact Parcel2Go or run a quote.'));
      root.append(el('p','The public-api scope is broad access, not read-only. No payment or my-profile scope. Authorization privately loads the saved workspace, including any existing order/customer fields; none is sent to Parcel2Go. Claim, audit and normal retention writes may occur. Closing this control does not revoke stored access.'));
      root.append(el('p','Permission ends: '+current.expiresAt));
      for(const [id,label] of [['p2g-client-id','Sandbox client ID'],['p2g-client-secret','Sandbox client secret']]){
        const l=el('label',label),input=el('input');input.id=id;input.type='password';input.autocomplete='off';input.maxLength=4096;input.spellcheck=false;input.setAttribute('aria-label',label);l.append(input);root.append(l);
      }
      const consentLabel=el('label','I approve this one encrypted save for the account above. An uncertain save must not be repeated.'),consent=el('input');consent.type='checkbox';consent.id='p2g-confirm';consentLabel.prepend(consent);root.append(consentLabel);
      const save=el('button','Save sandbox access once');save.type='button';save.id='p2g-save';save.className='primary';
      const check=el('button','Check saved admission');check.type='button';check.id='p2g-status';check.className='secondary';
      const result=el('p');result.id='p2g-entry-result';result.setAttribute('role','status');root.append(save,check,result);
      function update(){const ok=editable();root.querySelectorAll('input').forEach(e=>e.disabled=!ok);save.disabled=!ok||!consent.checked;
        check.disabled=!owner()||busy;result.textContent=message||text[current.outcome];if(left()<=0){clearFields();result.textContent='This entry window has expired. No further save is allowed.';}}
      consent.addEventListener('change',update);
      refreshExpiry=()=>{if(!active())return;clearTimeout(timer);update();timer=setTimeout(()=>{if(active())update();},Math.max(0,left()));};
      refreshExpiry();
      async function call(method,body){
        const pending=new AbortController();controller=pending;const timeout=setTimeout(()=>pending.abort(),20000);
        try{return await request(PATH,{method,body:body?JSON.stringify(body):undefined,signal:pending.signal,isCurrent:active,parcel2goCredentialRequest:true});}
        finally{clearTimeout(timeout);if(controller===pending)controller=null;if(body){body.clientId='';body.clientSecret='';}}
      }
      save.addEventListener('click',async()=>{
        if(!active()||!editable()||!consent.checked)return;
        const client=root.querySelector('#p2g-client-id'),secret=root.querySelector('#p2g-client-secret');
        if(![client.value,secret.value].every(v=>v.length>=8&&v.length<=4096&&!/[\x00-\x20\x7f]/.test(v))){message='Enter valid sandbox values privately. Nothing sent.';update();return;}
        if(!window.confirm('Save these sandbox credentials encrypted in the existing Runvara workspace once? This creates persistent access. No Parcel2Go request, token exchange, quote, order or payment will run. A failed or uncertain save must not be repeated.'))return;
        if(!active()||!editable())return;
        try{sessionStorage.setItem(key(current),'sent');}catch{message='Attempt tracking is unavailable. Nothing sent.';clearFields();update();return;}
        attempts.add(key(current));const body={requestId:current.requestId,expectedRevision:current.expectedRevision,clientId:client.value,clientSecret:secret.value,confirmed:true};
        clearFields();busy=true;message='One encrypted save requested. Do not repeat it.';update();
        try{const response=descriptor(await call('POST',body));if(active()){if(!response||response.requestId!==current.requestId)throw Error('INVALID');current=response;message=text[response.outcome];}}
        catch{if(active())message='Save outcome is unconfirmed or refused. Check saved admission; do not repeat it.';}
        finally{busy=false;if(active())update();}
      });
      check.addEventListener('click',async()=>{
        if(!active()||busy)return;clearFields();busy=true;update();
        try{const response=descriptor(await call('GET'));if(active()){if(!response||response.requestId!==current.requestId)throw Error('INVALID');current=response;message=text[response.outcome];}}
        catch{if(active())message='Saved status is unavailable. Do not repeat the save.';}
        finally{busy=false;if(active())update();}
      });
    }
    return {observe,mount,clear,allowsControl(id){return id==='p2g-status'?Boolean(current&&owner()&&!busy):['p2g-client-id','p2g-client-secret','p2g-confirm','p2g-save'].includes(id)&&editable();}};
  }};
})();
