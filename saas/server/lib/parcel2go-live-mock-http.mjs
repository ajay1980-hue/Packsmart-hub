// Local test-only fixed live destination boundary. Not imported by the server. No environment activation, caller URLs,
// redirects, retries, cookies, proxy configuration or pooled request replay.
// No built-in network implementation: this candidate accepts a test double only.
const HOST='www.parcel2go.com';
const fail=()=>Object.assign(new Error('Parcel2Go mock live response unknown; do not retry.'),{code:'PARCEL2GO_PROVIDER_OUTCOME_UNKNOWN',status:409});
const exact=(x,keys)=>x&&Object.getPrototypeOf(x)===Object.prototype&&Object.keys(x).sort().join('|')===keys.split(' ').sort().join('|');
function validate(operation,body,token){
  if(typeof body!=='string'||Buffer.byteLength(body)>32768)throw fail();
  if(operation==='token'){
    const p=new URLSearchParams(body),keys=[...p.keys()].sort().join('|');
    if(keys!=='client_id|client_secret|grant_type|scope'||p.get('grant_type')!=='client_credentials'||p.get('scope')!=='public-api'||token!==undefined)throw fail();
    for(const k of ['client_id','client_secret'])if(!/^[^\x00-\x20\x7f]{8,4096}$/.test(p.get(k)||''))throw fail();
  }else if(operation==='quote'){
    if(typeof token!=='string'||!/^[-A-Za-z0-9._~+/]+=*$/.test(token)||token.length<8||token.length>4096||Buffer.byteLength(body)>4096)throw fail();
    const q=JSON.parse(body);
    // Canonical locally mapped request only; never accept arbitrary JSON keys,
    // addresses, profile/payment/order fields or duplicate JSON members.
    if(JSON.stringify(q)!==body||!exact(q,'CollectionAddress DeliveryAddress Parcels')||!Array.isArray(q.Parcels)||q.Parcels.length!==1)throw fail();
    for(const a of [q.CollectionAddress,q.DeliveryAddress])if(!exact(a,'Country VatStatus Postcode')||a.Country!=='GBR'||typeof a.Postcode!=='string'||!/^(GIR 0AA|[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2})$/.test(a.Postcode)||!['Individual','NotRegistered','Registered'].includes(a.VatStatus))throw fail();
    const p=q.Parcels[0];if(!exact(p,'Weight Length Width Height Value'))throw fail();
    for(const k of ['Weight','Length','Width','Height','Value'])if(typeof p[k]!=='number'||!Number.isFinite(p[k])||Object.is(p[k],-0)||p[k]<(k==='Value'?0:0.01)||p[k]>(k==='Value'?999999.99:1000)||!/^\d+(\.\d{1,2})?$/.test(String(p[k])))throw fail();
  }else throw fail();
}
export function createParcel2GoLiveMockHttp({mode='disabled/v1',mockRequest}={}){
  if(!['disabled/v1','offline-wire-mock/v1'].includes(mode))throw fail();
  const enabled=mode==='offline-wire-mock/v1',requestImpl=mockRequest;
  if(enabled&&typeof requestImpl!=='function')throw fail();
  let phase=0,closed=false,busy=false,abortActive;
  const close=()=>{closed=true;abortActive?.();};
  const send=async args=>{
    if(enabled!==true||closed)throw fail();
    if(busy){close();throw fail();}
    let operation,body,token,timeoutMs;
    try{({operation,body,token,timeoutMs}=args);validate(operation,body,token);
      if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000||typeof requestImpl!=='function'||operation!==(phase===0?'token':phase===1?'quote':null))throw fail();
    }catch{close();throw fail();}
    phase++;busy=true; // An attempted request consumes this phase even if no bytes arrive.
    const isToken=operation==='token',limit=isToken?16384:262144;
    return new Promise((resolve,reject)=>{
      const deadline=performance.now()+timeoutMs;
      let req,res,timer,settled=false,bytes=0,count=0,expected=null,chunks=[];
      const overdue=()=>closed||performance.now()>=deadline;
      const finish=(error,value)=>{if(settled)return;error=error||overdue();settled=true;busy=false;clearTimeout(timer);abortActive=undefined;
        if(error){closed=true;req?.destroy();res?.destroy();chunks=[];reject(fail());}else{resolve(value);chunks=[];}};
      abortActive=()=>finish(true);
      timer=setTimeout(()=>finish(true),timeoutMs);
      try{
        req=requestImpl(new URL('https://'+HOST+(isToken?'/auth/connect/token':'/api/quotes')),
          {method:'POST',agent:false,maxHeaderSize:8192,headers:{Accept:'application/json','Accept-Encoding':'identity','Content-Type':isToken?'application/x-www-form-urlencoded':'application/json','Content-Length':Buffer.byteLength(body),...(isToken?{}:{Authorization:'Bearer '+token})}},incoming=>{
            res=incoming;if(settled){res.destroy();return;}
            res.on('error',()=>finish(true));res.on('aborted',()=>finish(true));
            if(overdue()){finish(true);return;}
            const headers=res.headers||{},length=headers['content-length'];
            if(res.statusCode!==200||headers['content-encoding']&&headers['content-encoding']!=='identity'||typeof headers['content-type']!=='string'||!/^application\/json(?:\s*;|$)/i.test(headers['content-type'])
              ||length!==undefined&&(typeof length!=='string'||!/^\d{1,8}$/.test(length)||Number(length)>limit)){finish(true);return;}
            if(length!==undefined)expected=Number(length);
            res.on('data',chunk=>{if(settled)return;if(overdue()||!(chunk instanceof Uint8Array)||!chunk.byteLength||++count>limit||(bytes+=chunk.byteLength)>limit){finish(true);return;}chunks.push(Buffer.from(chunk));});
            res.on('end',()=>{if(!res.complete||expected!==null&&expected!==bytes){finish(true);return;}finish(false,Buffer.concat(chunks,bytes));});
            res.on('close',()=>{if(!settled)finish(true);});
          });
        req.on('error',()=>finish(true));if(settled)req.destroy();else if(overdue())finish(true);else req.end(body);
      }catch{finish(true);}
    });
  };
  return Object.freeze({send,close});
}
