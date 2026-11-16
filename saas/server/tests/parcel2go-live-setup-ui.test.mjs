import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {JSDOM} from 'jsdom';const html=readFileSync(new URL('../../parcel2go-live-setup.html',import.meta.url),'utf8'),js=readFileSync(new URL('../../parcel2go-live-setup-ui.js',import.meta.url),'utf8');const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r))};
function fixture(t,ok=true){const dom=new JSDOM(html,{url:'https://runvara.example/parcel2go-live-setup.html',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,calls=[];w.fetch=async(url,opts)=>{calls.push({url,opts});return {ok,json:async()=>url==='/api/auth/session'?{csrf:'synthetic-csrf-long'}:{status:'prepared',entryPath:'/parcel2go-live-entry.html',providerCallsAllowed:false,savePerformed:false}}};w.eval(js);return{w,calls,$:id=>w.document.getElementById(id)}}
test('explicit click only opens fixed review link without credentials',async t=>{const f=fixture(t);assert.equal(f.calls.length,0);f.$('prepare').click();await flush();assert.equal(f.calls.length,2);assert.equal(f.calls[1].opts.body,undefined);assert.equal(f.$('entry').hidden,false);assert.equal(f.$('entry').getAttribute('href'),'/parcel2go-live-entry.html')});
test('failure exposes no review link',async t=>{const f=fixture(t,false);f.$('prepare').click();await flush();assert.equal(f.$('entry').hidden,true);assert.match(f.$('status').textContent,/unavailable/)});
test('pagehide prevents further action and hides link',async t=>{const f=fixture(t);f.$('prepare').click();await flush();f.w.dispatchEvent(new f.w.Event('pagehide'));f.$('prepare').click();await flush();assert.equal(f.calls.length,2);assert.equal(f.$('entry').hidden,true)});

const PRIVATE='synthetic-private-error-token-client-account@example.test';
const response=(body,ok=true,status=ok?200:409)=>({ok,status,json:async()=>body});
const session=()=>response({csrf:'synthetic-private-csrf-long'});
const ready=()=>response({status:'prepared',entryPath:'/parcel2go-live-entry.html',providerCallsAllowed:false,savePerformed:false});
const unavailable=diagnostic=>response({status:'unavailable',savePerformed:false,providerCallsAllowed:false,diagnostic,message:PRIVATE,code:PRIVATE,account:PRIVATE},false,409);
const diagnostic=(stage,cause='unavailable',durationMs=25)=>({schema:'parcel2go-setup-diagnostic/v1',stage,cause,durationMs});
function noLeak(f){assert.equal(f.$('entry').hidden,true);assert.equal(f.w.document.body.textContent.includes(PRIVATE),false);assert.equal(f.w.document.querySelector('img'),null);}
function clock(f){let now=0,timer;f.w.performance.now=()=>now;f.w.setTimeout=(fn,ms)=>{assert.equal(ms,5000);timer=fn;return 1;};f.w.clearTimeout=()=>{timer=null;};return ms=>{now+=ms;if(now>=5000&&timer){const fn=timer;timer=null;fn();}};}
for(const kind of ['network','http','json','csrf'])test('session-fetch '+kind+' is locally identified without posting or leaking',async t=>{
 const f=fixture(t);let calls=0;f.w.fetch=async()=>{calls++;if(kind==='network')throw Object.assign(Error(PRIVATE),{code:PRIVATE});if(kind==='http')return response({message:PRIVATE},false,401);if(kind==='json')return {ok:true,status:200,json:async()=>{throw Error(PRIVATE)}};return response({csrf:PRIVATE.slice(0,3),session:PRIVATE});};
 f.$('prepare').click();await flush();assert.equal(calls,1);assert.match(f.$('status').textContent,/Check: session request/);if(kind==='http')assert.match(f.$('status').textContent,/HTTP 401/);noLeak(f);
});
for(const [stage,label] of [['window','setup window'],['request','request admission'],['origin','origin admission'],['owner_auth','owner authentication'],['csrf','CSRF check'],['workspace_lock','workspace lock wait'],['fresh_owner_auth','fresh owner authentication'],['account_revision','account/revision checks']])test('UI renders only the fixed '+stage+' diagnostic label',async t=>{
 const f=fixture(t);f.w.fetch=async url=>url==='/api/auth/session'?session():unavailable(diagnostic(stage,stage==='workspace_lock'?'deadline':'unavailable'));
 f.$('prepare').click();await flush();const text=f.$('status').textContent;assert.ok(text.includes('Check: '+label+'.'));assert.match(text,/Server elapsed: 25 ms \(capped at 2000 ms\)/);assert.match(text,/HTTP 409/);noLeak(f);
});
for(const kind of ['stage','cause','schema','negative','oversize','float','string','extra','array','prototype'])test('untrusted diagnostic '+kind+' falls back to fixed local text',async t=>{
 const f=fixture(t),d=diagnostic('owner_auth');if(kind==='stage')d.stage='<img src=x onerror='+PRIVATE+'>';if(kind==='cause')d.cause=PRIVATE;if(kind==='schema')d.schema=PRIVATE;
 if(kind==='negative')d.durationMs=-1;if(kind==='oversize')d.durationMs=2001;if(kind==='float')d.durationMs=1.5;if(kind==='string')d.durationMs=PRIVATE;if(kind==='extra')d.account=PRIVATE;if(kind==='prototype')d.stage='__proto__';
 f.w.fetch=async url=>url==='/api/auth/session'?session():unavailable(kind==='array'?[d]:d);
 f.$('prepare').click();await flush();assert.match(f.$('status').textContent,/Check: setup request\. Reason: response refused/);assert.doesNotMatch(f.$('status').textContent,/Server elapsed:/);noLeak(f);
});
test('setup network failure and disabled route retain fixed HTTP/request diagnostics',async t=>{
 for(const kind of ['network','disabled','json']){const f=fixture(t);f.w.fetch=async url=>{if(url==='/api/auth/session')return session();if(kind==='network')throw Error(PRIVATE);if(kind==='json')return {ok:false,status:503,json:async()=>{throw Error(PRIVATE)}};return response({error:PRIVATE},false,503);};
  f.$('prepare').click();await flush();assert.match(f.$('status').textContent,/Check: setup request/);if(kind!=='network')assert.match(f.$('status').textContent,/HTTP 503/);noLeak(f);
 }
});
for(const phase of ['session','setup'])test('5s browser deadline is identified during '+phase+' fetch',async t=>{
 const f=fixture(t),advance=clock(f);let signal,calls=0;
 f.w.fetch=async(url,opts)=>{calls++;if(phase==='setup'&&url==='/api/auth/session')return session();signal=opts.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error(PRIVATE)),{once:true}));};
 f.$('prepare').click();await flush();advance(4999);await flush();assert.equal(signal.aborted,false);advance(1);await flush();assert.equal(signal.aborted,true);
 assert.ok(f.$('status').textContent.includes('Check: '+phase+' request. Reason: browser deadline reached.'));assert.match(f.$('status').textContent,/Browser elapsed: 5000 ms \(capped at 5000 ms\)/);assert.equal(calls,phase==='session'?1:2);noLeak(f);
});
for(const phase of ['session','setup'])test('late '+phase+' response after 5s cannot open entry or send another request',async t=>{
 const f=fixture(t),advance=clock(f);let release,calls=0;f.w.fetch=async url=>{calls++;if(phase==='setup'&&url==='/api/auth/session')return session();return new Promise(r=>release=r);};
 f.$('prepare').click();await flush();advance(6000);release(phase==='session'?session():ready());await flush();
 assert.match(f.$('status').textContent,/browser deadline reached/);assert.match(f.$('status').textContent,/Browser elapsed: 5000 ms/);assert.equal(calls,phase==='session'?1:2);noLeak(f);
});
test('pagehide during session fetch prevents a late setup POST',async t=>{
 const f=fixture(t);let release,calls=0;f.w.fetch=async()=>{calls++;return new Promise(r=>release=r);};f.$('prepare').click();await flush();
 f.w.dispatchEvent(new f.w.Event('pagehide'));release(session());await flush();assert.equal(calls,1);assert.equal(f.$('prepare').disabled,true);noLeak(f);
});
