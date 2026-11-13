// Offline fixture UI only; not included by the application HTML.
(()=>{'use strict';const PATH='/api/offline/parcel2go-quote-review';
window.RunvaraOfflineQuoteReview={create({request,csrf}){let node,current,deadline=0,spent=false,busy=false,epoch=0,timer,controller;
 const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
 const valid=x=>x&&x.schema==='runvara-offline-quote-review/v1'&&x.fixture===true&&x.liveReady===false&&x.purchaseAllowed===false&&typeof x.requestId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x.requestId)&&Number.isSafeInteger(x.remainingMs)&&x.remainingMs>=0&&x.remainingMs<=300000&&x.parcel?.currency==='GBP'&&typeof x.canSubmit==='boolean'&&['not_started','completed','reconcile_no_replay','state_changed'].includes(x.outcome);
 const key=()=> 'runvara-offline-quote:'+current.requestId;
 function clear(){epoch++;clearTimeout(timer);controller?.abort();node?.replaceChildren();current=null;}
 function mount(root,data){clear();node=root;busy=false;if(!valid(data)){node.textContent='Offline review unavailable.';return;}current=data;deadline=performance.now()+data.remainingMs;const generation=epoch;
 try{spent=sessionStorage.getItem(key())==='sent';}catch{spent=true;}
 const title=el('h2','Offline Parcel2Go quote review'),notice=el('p','Synthetic fixture only. These are not real courier prices. No bookings, payments or labels.'),parcel=el('p',(data.parcel.estimate?'Estimated':'Measured')+' parcel: '+data.parcel.weightGrams+' g; '+data.parcel.lengthMm+' × '+data.parcel.widthMm+' × '+data.parcel.heightMm+' mm. GBP '+data.parcel.declaredValueDecimal+' declared value.');
 const confirm=el('input','');confirm.type='checkbox';confirm.id='offline-quote-confirm';const label=el('label','Run one offline simulation only.');label.prepend(confirm);const button=el('button','Run offline simulation once');button.id='offline-quote-run';const status=el('p','');status.id='offline-quote-status';status.setAttribute('role','status');const prices=el('div','');prices.id='offline-quote-prices';node.append(title,notice,parcel,label,button,status,prices);
 const active=()=>generation===epoch&&performance.now()<deadline;
 function update(){const can=active()&&!spent&&!busy&&current.canSubmit;confirm.disabled=!can;button.disabled=!can||!confirm.checked;if(!active()){confirm.checked=false;controller?.abort();prices.replaceChildren();status.textContent='Offline window expired. Do not retry.';}}
 confirm.addEventListener('change',update);update();const expire=()=>{update();if(active())timer=setTimeout(expire,Math.max(1,Math.ceil(deadline-performance.now())));};timer=setTimeout(expire,Math.max(1,Math.ceil(deadline-performance.now())));
 button.addEventListener('click',async()=>{if(!active()||spent||busy||!confirm.checked||!current.canSubmit)return;try{sessionStorage.setItem(key(),'sent');}catch{spent=true;status.textContent='Attempt tracking unavailable. Nothing sent.';update();return;}spent=true;busy=true;update();status.textContent='Offline simulation running. Do not repeat.';controller=new AbortController();
 try{const value=await request(PATH,{method:'POST',headers:{'Content-Type':'application/json','x-csrf-token':csrf},body:JSON.stringify({confirmed:true,requestId:current.requestId,expectedRevision:current.expectedRevision}),signal:controller.signal});if(!active())return;if(!valid(value)||value.requestId!==current.requestId||value.outcome!=='completed'||value.canSubmit!==false)throw Error();
 const q=value.quote;if(q!==null&&(!q||q.requestId!==current.requestId||q.fixture!==true||q.synthetic!==true||q.responseSource!=='fixture'||q.purchaseAllowed!==false||q.liveReady!==false||!Array.isArray(q.quotes)||q.quotes.length>50))throw Error();
 prices.replaceChildren();if(q)for(const row of q.quotes){if(typeof row.serviceCode!=='string'||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(row.serviceCode)||row.currency!=='GBP'||!/^\d{1,6}\.\d{2}$/.test(row.totalDecimal)||row.purchaseAllowed!==false)throw Error();prices.append(el('p',row.serviceCode+': GBP '+row.totalDecimal+' (synthetic result)'));}status.textContent='Offline receipt saved. Not a live quote or booking.';
 }catch{if(generation===epoch){prices.replaceChildren();status.textContent='Offline result unconfirmed. Reconcile; do not retry.';}}finally{if(generation===epoch){busy=false;update();}}});
 }
 return {mount,clear};}};
})();
