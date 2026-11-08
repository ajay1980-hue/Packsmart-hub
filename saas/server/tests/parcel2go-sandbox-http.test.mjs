import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createServer,request as localRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createParcel2GoSandboxHttp} from '../lib/parcel2go-sandbox-http.mjs';
import {createParcel2GoSandboxCandidate,createParcel2GoSandboxPolicy} from '../lib/parcel2go-sandbox.mjs';
import {fixture,ID,KEY,CLIENT,SECRET_VALUE,TOKEN,binding,digest,quoteBody} from './parcel2go-sandbox-fixture.mjs';
const tokenBody=()=>({access_token:TOKEN,token_type:'Bearer',expires_in:3600,scope:'public-api'});
const form=()=>new URLSearchParams({grant_type:'client_credentials',client_id:CLIENT,client_secret:SECRET_VALUE,scope:'public-api'}).toString();
const body=()=>JSON.stringify({CollectionAddress:{Country:'GBR',VatStatus:'NotRegistered'},DeliveryAddress:{Country:'GBR',VatStatus:'NotRegistered'},Parcels:[{Weight:0.25,Length:20,Width:10,Height:5,Value:12.3}]});
const safeReject=async(p,code)=>assert.rejects(p,e=>{assert.doesNotMatch(String(e)+' '+e.stack,new RegExp([TOKEN,SECRET_VALUE,KEY].join('|')));return !code||e.code===code;});
function wireMock(handler){
 const calls=[];
 const request=(url,options,callback)=>{
   assert.equal(url.origin,'https://sandbox.parcel2go.com');
   const req=new EventEmitter(),call={url:String(url),options,destroyed:false};calls.push(call);
   req.destroy=()=>{call.destroyed=true;};
   req.end=payload=>{call.body=payload;queueMicrotask(()=>{
     const reply=({data=JSON.stringify(url.pathname.endsWith('/token')?tokenBody():quoteBody()),status=200,headers={},complete=true,hang=false}={})=>{
       const res=new PassThrough();res.statusCode=status;res.headers={'content-type':'application/json',...headers};res.complete=complete;
       call.response=res;callback(res);if(!hang&&!res.destroyed)res.end(data);
     };
     try{if(handler)handler(call,reply,req);else reply();}catch(e){req.emit('error',e);}
   });};return req;
 };return {request,calls};
}
function networkFixture(options={}){
 const f=fixture(options),wire=wireMock(options.networkHandler);
 f.intent.parcel.provenance='synthetic_fixture';
 Object.assign(f.config,{mode:'sandbox-quote/v1',network:'sandbox-only/v1',quotePurpose:'synthetic-sandbox/v1',scopePolicy:'public-api-only/no-openid-fallback/v1',inputHash:digest(f.intent)},options.networkConfig);
 let revoked=false;
 const make=extra=>f.make({fixtureTransport:undefined,sandboxRequest:wire.request,assertCurrent:()=>{if(revoked)throw Error(SECRET_VALUE);},...extra});
 const candidate=make();return {...f,wire,make,candidate,run:()=>candidate.run(f.args),revoke:()=>{revoked=true;}};
}
const writes=f=>f.calls.filter(c=>c.settings.method==='PATCH');
test('HTTP boundary default OFF does not inspect arguments or open sockets',async()=>{
 const h=createParcel2GoSandboxHttp({requestImpl:()=>assert.fail()});await safeReject(h.send({get operation(){assert.fail();}}));
});
for(const stage of ['headers','chunk','end'])test('overdue event-loop callback cannot accept '+stage+' ahead of timeout callback',async()=>{
 const block=()=>{const end=performance.now()+35;while(performance.now()<end){};};
 const wire=wireMock((call,reply)=>{
   if(stage==='headers'){block();reply();return;}
   reply({hang:true});if(stage==='end')call.response.write(JSON.stringify(tokenBody()));
   block();if(stage==='chunk')call.response.write(JSON.stringify(tokenBody()));call.response.end();
 });
 const h=createParcel2GoSandboxHttp({enabled:true,requestImpl:wire.request});await safeReject(h.send({operation:'token',body:form(),timeoutMs:5}));
 assert.equal(wire.calls.length,1);assert.equal(wire.calls[0].destroyed,true);
 await safeReject(h.send({operation:'quote',body:body(),token:TOKEN,timeoutMs:100}));assert.equal(wire.calls.length,1);
});
test('concurrent primitive call fails closed and aborts the sole in-flight request',async()=>{
 let deliver;const wire=wireMock((_call,reply)=>{deliver=reply;}),h=createParcel2GoSandboxHttp({enabled:true,requestImpl:wire.request});
 const first=h.send({operation:'token',body:form(),timeoutMs:1000});await Promise.resolve();
 const second=h.send({operation:'quote',body:body(),token:TOKEN,timeoutMs:1000});const outcomes=Promise.allSettled([first,second]);
 deliver();assert.deepEqual((await outcomes).map(x=>x.status),['rejected','rejected']);assert.equal(wire.calls.length,1);assert.equal(wire.calls[0].destroyed,true);
});
test('explicit close prevents a late success callback even before timeout',async()=>{
 let deliver;const wire=wireMock((_call,reply)=>{deliver=reply;}),h=createParcel2GoSandboxHttp({enabled:true,requestImpl:wire.request});
 const pending=h.send({operation:'token',body:form(),timeoutMs:1000});await Promise.resolve();h.close();deliver();await safeReject(pending);assert.equal(wire.calls[0].destroyed,true);
});
test('real boundary issues only two fixed POSTs after acknowledged reservation, persists no token and preserves unrelated state',async()=>{
 const f=networkFixture({networkHandler:(call,reply)=>{assert.equal(f.fake.states.get(ID).parcel2goSandboxRuns.at(-1).status,'reserved');reply();}}),before=structuredClone(f.state);
 const r=await f.run(),saved=f.fake.states.get(ID);
 assert.equal(writes(f).length,2);assert.equal(f.wire.calls.length,2);
 assert.deepEqual(f.wire.calls.map(c=>c.url),['https://sandbox.parcel2go.com/auth/connect/token','https://sandbox.parcel2go.com/api/quotes']);
 assert.equal(f.wire.calls[0].body,form());assert.equal(f.wire.calls[1].body,body());
 for(const c of f.wire.calls){assert.equal(c.options.method,'POST');assert.equal(c.options.agent,false);assert.equal(c.options.maxHeaderSize,8192);assert.equal(c.options.headers['Accept-Encoding'],'identity');assert.equal(c.options.headers['Content-Length'],Buffer.byteLength(c.body));assert.ok(!('Cookie' in c.options.headers));}
 for(const k of ['connections','products','orders','economics','users','autopilot'])assert.deepEqual(saved[k],before[k]);
 assert.equal(r.synthetic,false);assert.equal(r.quote.synthetic,false);assert.equal(r.quote.syntheticParcel,true);assert.equal(r.quote.responseSource,'sandbox-http');assert.equal(r.quote.accountVerified,false);assert.equal(r.quote.purchaseAllowed,false);
 assert.equal(saved.parcel2goSandboxRuns.at(-1).projectionHash,digest(r.quote));
 for(const v of [saved,r,f.candidate.status()])assert.doesNotMatch(JSON.stringify(v),new RegExp([TOKEN,SECRET_VALUE,KEY].join('|')));
 await safeReject(f.make().run(f.args));assert.equal(f.wire.calls.length,2);
});
for(const field of ['network','quotePurpose','scopePolicy'])test('explicit network policy missing '+field,()=>{
 assert.throws(()=>networkFixture({networkConfig:{[field]:undefined}}));
});
for(const change of ['operation','environment','startup','origin override','fixture conflict','no closure hook','real parcel','input drift'])test('reject unapproved configuration '+change,async()=>{
 const f=networkFixture();
 if(change==='operation')f.config.operation='admit_credentials';if(change==='environment')f.config.binding={...binding,environment:'live'};if(change==='startup')f.config.startupMode='normal';
 if(change==='origin override')f.config.network='https://www.parcel2go.com';if(change==='real parcel'){f.intent.parcel.provenance='measured_packed_parcel';f.config.inputHash=digest(f.intent);}if(change==='input drift')f.intent.parcel.declaredValueDecimal='13.00';
 await safeReject(Promise.resolve().then(()=>f.make(change==='fixture conflict'?{fixtureTransport:()=>assert.fail()}:change==='no closure hook'?{assertCurrent:undefined}:{}).run(f.args)));
 assert.equal(writes(f).length,0);assert.equal(f.wire.calls.length,0);
});
for(const operation of ['order','payment','profile','label','webhook','https://www.parcel2go.com/api/quotes'])test('transport rejects operation '+operation,async()=>{
 const wire=wireMock(),h=createParcel2GoSandboxHttp({enabled:true,requestImpl:wire.request});await safeReject(h.send({operation,body:body(),timeoutMs:100}));assert.equal(wire.calls.length,0);
});
for(const scope of ['public-api openid','public-api payment','my-profile','openid',''])test('transport rejects scope '+scope,async()=>{
 const wire=wireMock(),h=createParcel2GoSandboxHttp({enabled:true,requestImpl:wire.request});const p=new URLSearchParams(form());p.set('scope',scope);
 await safeReject(h.send({operation:'token',body:p.toString(),timeoutMs:100}));assert.equal(wire.calls.length,0);
});
for(const kind of ['401','302','500','html','gzip','oversize','length mismatch','incomplete','bad json','duplicate key','extra scope','missing ttl','bad bearer','empty','too many quotes','vat mismatch','wrong currency','request error'])test('wire '+kind+' stops durably without retry or unsafe receipt',async()=>{
 const quoteOnly=['too many quotes','vat mismatch','wrong currency'].includes(kind);
 const f=networkFixture({networkHandler:(call,reply,req)=>{
   if(quoteOnly&&call.url.endsWith('/token')){reply();return;}
   if(kind==='request error'){req.emit('error',Error(SECRET_VALUE));return;}
   const o={};if(['401','302','500'].includes(kind))o.status=Number(kind);
   if(kind==='html')o.headers={'content-type':'text/html'};if(kind==='gzip')o.headers={'content-encoding':'gzip'};
   if(kind==='oversize')o.data='x'.repeat(16385);if(kind==='length mismatch')o.headers={'content-length':'1'};if(kind==='incomplete')o.complete=false;
   if(kind==='bad json')o.data='{';if(kind==='duplicate key')o.data='{"access_token":"one","access_token":"two"}';if(kind==='empty')o.data='';
   if(['extra scope','missing ttl','bad bearer'].includes(kind)){const t=tokenBody();if(kind==='extra scope')t.scope='public-api openid';if(kind==='missing ttl')delete t.expires_in;if(kind==='bad bearer')t.access_token='bad token with spaces';o.data=JSON.stringify(t);}
   if(quoteOnly){const q=quoteBody();if(kind==='too many quotes')q.Quotes=Array(51).fill(q.Quotes[0]);if(kind==='vat mismatch')q.Quotes[0].TotalVat=0;if(kind==='wrong currency')q.Quotes[0].CurrencyCode='USD';o.data=JSON.stringify(q);}
   reply(o);
 }});await safeReject(f.run());assert.equal(f.wire.calls.length,quoteOnly?2:1);assert.equal(writes(f).length,1);assert.equal(f.fake.states.get(ID).parcel2goSandboxRuns.at(-1).status,'reserved');
 await safeReject(f.make().run(f.args));assert.equal(f.wire.calls.length,quoteOnly?2:1);
});
for(const where of ['before claim','after token','during quote'])test('closure '+where+' prevents further effects',async()=>{
 let f;f=networkFixture({networkHandler:(call,reply)=>{if(where==='after token'&&call.url.endsWith('/token')||where==='during quote'&&call.url.endsWith('/quotes'))f.candidate.close();reply();}});
 if(where==='before claim')f.candidate.close();await safeReject(f.run());assert.equal(writes(f).length,where==='before claim'?0:1);assert.equal(f.wire.calls.length,where==='before claim'?0:where==='after token'?1:2);
});
for(const drift of ['owner','session','tenant','binding','revision','business','expiry','wall rollback','monotonic expiry','closure hook'])test('post-token '+drift+' refuses quote and commit',async()=>{
 let f;f=networkFixture({networkHandler:(_c,reply)=>{const s=f.fake.states.get(ID);
   if(drift==='owner')s.users[0].role='admin';if(drift==='session')s.users[0].sessionVersion++;if(drift==='tenant')s.workspace.id='other';if(drift==='binding')s.connections[0].metadata.account='wrong';if(drift==='revision')s._revision=randomUUID();if(drift==='business')s.economics.synthetic='changed';if(drift==='expiry')f.advance(300000);if(drift==='wall rollback')f.advance(-1);if(drift==='monotonic expiry')f.setMono(301001);if(drift==='closure hook')f.revoke();reply();}});
 await safeReject(f.run());assert.equal(f.wire.calls.length,1);assert.equal(writes(f).length,1);
});
test('frozen wall clock cannot outlive short expires_in',async()=>{
 let f;f=networkFixture({networkHandler:(_c,reply)=>{f.setMono(2001);reply({data:JSON.stringify({...tokenBody(),expires_in:1})});}});
 await safeReject(f.run(),'PARCEL2GO_TOKEN_EXPIRED');assert.equal(f.wire.calls.length,1);
});
for(const secret of [TOKEN,CLIENT,SECRET_VALUE])test('provider cannot echo private material through valid-looking service slug '+secret.slice(0,9),async()=>{
 const f=networkFixture({networkHandler:(call,reply)=>{if(call.url.endsWith('/token'))reply();else{const q=quoteBody();q.Quotes[0].Service.Slug=secret;reply({data:JSON.stringify(q)});}}});
 await safeReject(f.run(),'PARCEL2GO_QUOTE_INVALID');assert.equal(writes(f).length,1);assert.equal(f.wire.calls.length,2);
});
test('token expiry during quote with frozen wall time refuses final receipt',async()=>{
 let f;f=networkFixture({networkHandler:(call,reply)=>{if(call.url.endsWith('/token'))reply({data:JSON.stringify({...tokenBody(),expires_in:1})});else{f.setMono(2001);reply();}}});
 await safeReject(f.run(),'PARCEL2GO_TOKEN_EXPIRED');assert.equal(writes(f).length,1);
});
for(const changed of ['csrf','owner','expired session','wrong tenant','wrong account','wrong ciphertext','missing receipt','wrong revision'])test('network mode rejects '+changed+' before any reservation/socket',async()=>{
 const f=networkFixture(),s=f.fake.states.get(ID);
 if(changed==='csrf')f.args.csrf='wrong';if(changed==='owner')s.users[0].role='admin';if(changed==='expired session')f.args.session.exp=1;if(changed==='wrong tenant')f.args.session.workspaceId='other';if(changed==='wrong account')s.connections[0].metadata.account='other';if(changed==='wrong ciphertext')s.connections[0].encryptedCredentials='wrong';if(changed==='missing receipt')s.parcel2goSandboxRuns=[];if(changed==='wrong revision')s._revision=randomUUID();
 await safeReject(f.run());assert.equal(writes(f).length,0);assert.equal(f.wire.calls.length,0);
});
test('returned TTL clips a stalled quote socket to one second',async()=>{
 const f=networkFixture({networkHandler:(call,reply)=>{if(call.url.endsWith('/token'))reply({data:JSON.stringify({...tokenBody(),expires_in:1})});}});
 const start=performance.now();await safeReject(f.run());assert.ok(performance.now()-start<2500);assert.equal(f.wire.calls.at(-1).destroyed,true);assert.equal(writes(f).length,1);
});
for(const timeoutMs of [0,5001,Infinity,NaN,1.5])test('transport rejects unbounded/invalid timeout '+timeoutMs,async()=>{
 const wire=wireMock(),h=createParcel2GoSandboxHttp({enabled:true,requestImpl:wire.request});await safeReject(h.send({operation:'token',body:form(),timeoutMs}));assert.equal(wire.calls.length,0);
});
for(const mutation of ['payment','customer','postcode','extra parcel','foreign country','rounding'])test('transport rejects extra or unsupported quote fields '+mutation,async()=>{
 const wire=wireMock(),h=createParcel2GoSandboxHttp({enabled:true,requestImpl:wire.request});await h.send({operation:'token',body:form(),timeoutMs:100});const q=JSON.parse(body());
 if(mutation==='payment')q.Payment={};if(mutation==='customer')q.CollectionAddress.Name='synthetic';if(mutation==='postcode')q.CollectionAddress.Postcode='synthetic';if(mutation==='extra parcel')q.Parcels.push({...q.Parcels[0]});if(mutation==='foreign country')q.DeliveryAddress.Country='USA';if(mutation==='rounding')q.Parcels[0].Weight=0.001;
 await safeReject(h.send({operation:'quote',body:JSON.stringify(q),token:TOKEN,timeoutMs:100}));assert.equal(wire.calls.length,1);
});
for(const phase of ['token','quote'])test('request timeout '+phase+' is clipped to finite window and destroys socket, no replay',async()=>{
 const f=networkFixture({networkHandler:(call,reply)=>{if(phase==='quote'&&call.url.endsWith('/token'))reply();}});
 f.config.expiresAt=new Date(f.getTime()+100).toISOString();const c=f.make();await safeReject(c.run(f.args));assert.equal(f.wire.calls.length,phase==='token'?1:2);assert.equal(f.wire.calls.at(-1).destroyed,true);
 await safeReject(f.make().run(f.args));assert.equal(writes(f).length,1);
});
test('two independent runners compete through durable CAS, only one network pair',async()=>{
 const f=networkFixture();const r=await Promise.allSettled([f.run(),f.make().run(f.args)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.wire.calls.length,2);
});
for(const stage of [1,2])test('unknown primary acknowledgement '+stage+' stays spent without replay',async()=>{
 let patches=0,lost=false;const f=networkFixture({intercept:async(_u,s,proceed)=>{if(lost)throw Error(SECRET_VALUE);const r=await proceed();if(s.method==='PATCH'&&++patches===stage){lost=true;throw Error(SECRET_VALUE);}return r;}});
 await safeReject(f.run(),'PARCEL2GO_SAVE_OUTCOME_UNKNOWN');assert.equal(f.wire.calls.length,stage===1?0:2);assert.equal(f.fake.states.get(ID).parcel2goSandboxRuns.at(-1).status,stage===1?'reserved':'completed');await safeReject(f.make().run(f.args));assert.equal(f.wire.calls.length,stage===1?0:2);
});
test('local real socket path uses same HTTP reader, never follows a redirect or makes a third request',async()=>{
 const seen=[];const server=createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;seen.push({path:req.url,method:req.method,headers:req.headers,body:b});res.writeHead(req.url.endsWith('/token')?200:302,{'Content-Type':'application/json',Location:'http://127.0.0.1/forbidden'});res.end(JSON.stringify(tokenBody()));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const requestImpl=(url,opts,cb)=>{assert.equal(url.origin,'https://sandbox.parcel2go.com');return localRequest({hostname:'127.0.0.1',port:server.address().port,path:url.pathname,...opts},cb);};
   const h=createParcel2GoSandboxHttp({enabled:true,requestImpl});assert.ok((await h.send({operation:'token',body:form(),timeoutMs:1000})).length);
   await safeReject(h.send({operation:'quote',body:body(),token:TOKEN,timeoutMs:1000}));await safeReject(h.send({operation:'quote',body:body(),token:TOKEN,timeoutMs:1000}));
   assert.equal(seen.length,2);assert.deepEqual(seen.map(x=>x.method),['POST','POST']);assert.equal(seen[1].headers.authorization,'Bearer '+TOKEN);
 }finally{await new Promise(r=>server.close(r));}
});
