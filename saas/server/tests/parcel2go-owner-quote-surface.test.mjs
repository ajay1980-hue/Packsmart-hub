import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PassThrough} from 'node:stream';
import {KEY,CLIENT,SECRET_VALUE,TOKEN} from './parcel2go-sandbox-fixture.mjs';
import {surfaceFixture,flush} from './parcel2go-owner-surface-fixture.mjs';
import {createParcel2GoOwnerQuoteSurface} from '../lib/parcel2go-owner-quote-surface.mjs';
const posts=c=>c.requests.filter(r=>r.opts.method==='POST');
const state=c=>c.f.fake.states.get(c.workspaceId);
const redacted=value=>{for(const secret of [KEY,CLIENT,SECRET_VALUE,TOKEN])assert.equal(value.includes(secret),false);};

test('surface defaults disabled and its assets are absent from the public static map',async t=>{
 const c=await surfaceFixture(t),surface=createParcel2GoOwnerQuoteSurface({get admission(){assert.fail('Disabled admission read');}});
 for(const path of [c.page,c.script,c.api])assert.equal((await c.send(path,{},surface)).status,404);
 assert.equal(c.network.length,0);assert.equal(c.f.calls.length,0);
 const server=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
 const staticMap=server.slice(server.indexOf('const STATIC_FILES'),server.indexOf('function matchesStaticEtag'));
 assert.doesNotMatch(staticMap,/parcel2go-owner-quote\.html|parcel2go-exact-owner-ui\.js/);
});

test('authenticated page and script stay private and contain no admitted credentials',async t=>{
 const c=await surfaceFixture(t);
 for(const path of [c.page,c.script]){const response=await c.send(path);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);redacted(await response.text());}
 assert.equal(c.network.length,0);assert.equal(state(c).approvals.length,0);
});

for(const bad of ['cookie','tenant','origin','csrf','large_body','unknown_path','absolute_url']){
 test(`Node adapter refuses ${bad} without provider or durable writes`,async t=>{
  const c=await surfaceFixture(t),headers={'content-type':'application/json','x-csrf-token':c.f.session.csrf};let path=c.api,body=JSON.stringify({action:'prepare',requestId:c.options.requestId,declaration:{}});
  if(bad==='cookie')headers.cookie='invalid';if(bad==='tenant')state(c).users[0].workspaceId='synthetic-other-tenant';if(bad==='origin')headers.origin='https://synthetic-other.example.test';if(bad==='csrf')headers['x-csrf-token']='invalid';
  if(bad==='large_body')body=' '.repeat(2049);if(bad==='unknown_path')path=c.page+'&extra=1';if(bad==='absolute_url')path='https://synthetic-other.example.test'+c.api;
  const out=await c.send(path,{method:'POST',headers,body});assert.ok([403,404,409].includes(out.status));assert.equal(c.network.length,0);assert.equal(state(c).approvals.length,0);
  if(bad==='cookie')assert.equal(c.last.reads,0,'unauthenticated body not consumed');
 });
}

test('browser → Node adapter → exact review → durable native quote completes with no real network',async t=>{
 const c=await surfaceFixture(t),ui=await c.boot();await flush(()=>!!ui.root.querySelector('form'));
 assert.equal(posts(c).length,0);assert.equal(ui.root.querySelector('button').disabled,true);
 for(const n of ui.root.querySelectorAll('input:not([type="checkbox"]),select'))assert.equal(n.value,'');
 await c.approve(ui);assert.equal(c.network.length,0);assert.equal(posts(c).length,2);
 assert.match(ui.root.textContent,/Owner-authorised estimate, not measured/);assert.match(ui.root.textContent,/owner declaration/);
 c.check(ui,'sendConfirmed');c.click(ui,'Request one quote comparison');c.click(ui,'Request one quote comparison');
 await flush(()=>ui.root.textContent.includes('Comparison received.'));
 assert.equal(posts(c).length,3);assert.equal(c.network.length,2);assert.equal(ui.root.querySelectorAll('button').length,0);
 assert.match(ui.root.textContent,/12\.66/);assert.match(ui.root.textContent,/not guaranteed/);assert.match(ui.root.textContent,/No booking/);redacted(ui.root.textContent);
 const actions=posts(c).map(x=>JSON.parse(x.opts.body));assert.deepEqual(actions.map(x=>x.action),['prepare','decide','execute']);
 assert.equal(actions[0].declaration.parcel.scope,'whole_package');assert.equal(actions[0].declaration.parcel.includesOuter,true);
 assert.equal(actions[2].confirmation.operationHash,actions[1].confirmation.operationHash);assert.equal(actions[2].input,undefined);
 for(const x of posts(c)){assert.equal(x.opts.credentials,'same-origin');assert.equal(x.opts.cache,'no-store');assert.equal(x.opts.redirect,'error');}
 const receipt=state(c).parcel2goLiveQuoteRuns.find(r=>r.requestId===c.options.requestId);assert.equal(receipt.status,'completed');
 assert.equal(JSON.stringify(receipt).includes('12.66'),false);for(const name of ['orders','products','connections','users'])assert.deepEqual(state(c)[name],c.state[name]);
 for(let i=0;i<ui.w.sessionStorage.length;i++)assert.equal(ui.w.sessionStorage.getItem(ui.w.sessionStorage.key(i)),'attempted');
 // A new controller and empty browser storage still see the durable attempt.
 const reload=await c.boot({surface:c.make()});await flush(()=>reload.root.textContent.includes('do not repeat'));assert.equal(reload.root.querySelector('button'),null);assert.equal(c.network.length,2);
});

test('pagehide during the token response aborts the adapter and leaves the attempt spent',async t=>{
 const c=await surfaceFixture(t,(operation,c)=>{if(operation==='token')c.ui.w.dispatchEvent(new c.ui.w.Event('pagehide'));}),ui=await c.boot();await c.approve(ui);
 c.check(ui,'sendConfirmed');c.click(ui,'Request one quote comparison');await flush(()=>c.network.length===1&&ui.root.textContent==='');
 await new Promise(r=>setImmediate(r));assert.equal(c.network.length,1);assert.equal(state(c).parcel2goLiveQuoteRuns.find(r=>r.requestId===c.options.requestId).status,'reserved');
 const reload=await c.boot({surface:c.make()});await flush(()=>reload.root.textContent.includes('do not repeat'));assert.equal(reload.root.querySelector('button'),null);
});

for(const change of ['close','disconnect','expiry']){
 test(`unfinished Node body releases listeners on ${change} without persistence`,async t=>{
  const c=await surfaceFixture(t),stream=new PassThrough(),controller=new AbortController();
  const pending=c.send(c.api,{method:'POST',stream,signal:controller.signal,headers:{'content-type':'application/json','x-csrf-token':c.f.session.csrf}});
  const outcome=pending.catch(()=>null);await flush(()=>stream.listenerCount('readable')>0);
  if(change==='close')c.surface.close();if(change==='disconnect')controller.abort();if(change==='expiry'){c.f.advance(300000);stream.end('{}');}
  const response=await outcome;assert.equal(response?.status??null,change==='disconnect'?null:change==='close'?404:409);
  assert.equal(stream.listenerCount('readable'),0);assert.equal(stream.listenerCount('end'),0);assert.equal(stream.listenerCount('error'),0);
  assert.equal(state(c).approvals.length,0);assert.equal(c.network.length,0);
 });
}

test('host closure during final response conversion suppresses the prepared body',async t=>{
 const c=await surfaceFixture(t),read=Response.prototype.arrayBuffer;
 t.mock.method(Response.prototype,'arrayBuffer',async function(){const bytes=await read.call(this);c.surface.close();return bytes;});
 const response=await c.send(c.api);assert.equal(response.status,404);assert.deepEqual(await response.json(),{error:'Unavailable'});
 assert.equal(c.network.length,0);assert.equal(state(c).approvals.length,0);
});
