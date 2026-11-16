import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {surfaceFixture,flush} from './parcel2go-owner-surface-fixture.mjs';
const script=await readFile(new URL('../../parcel2go-exact-owner-ui.js',import.meta.url),'utf8');
const posts=c=>c.requests.filter(r=>r.opts.method==='POST');
const markers=ui=>{const map=new Map();for(let i=0;i<ui.w.sessionStorage.length;i++){const key=ui.w.sessionStorage.key(i);map.set(key,ui.w.sessionStorage.getItem(key));}
 return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value))};};

test('owner UI defaults disabled without reading transport configuration',async t=>{
 const dom=new JSDOM('<main></main>',{url:'https://synthetic.example.test/',runScripts:'outside-only'});t.after(()=>dom.window.close());dom.window.eval(script);
 const ui=dom.window.RunvaraExactOwnerUI.createOwnerInput({get fetch(){assert.fail('Disabled transport read');}}),root=dom.window.document.querySelector('main');
 await ui.mount(root);assert.match(root.textContent,/disabled/);assert.equal(root.querySelector('button'),null);
});

test('owner can correct invalid local values without spending a preparation attempt',async t=>{
 const c=await surfaceFixture(t),ui=await c.boot();await flush(()=>!!ui.root.querySelector('form'));c.fill(ui);
 const weight=ui.root.querySelector('[name="weightGrams"]');weight.value='5000.001';weight.dispatchEvent(new ui.w.Event('input',{bubbles:true}));
 assert.equal(ui.root.querySelector('button').disabled,true);c.click(ui,'Prepare exact review');assert.equal(posts(c).length,0);
 weight.value='5000';weight.dispatchEvent(new ui.w.Event('input',{bubbles:true}));c.click(ui,'Prepare exact review');await flush(()=>!!ui.root.querySelector('[name="reviewed"]'));assert.equal(posts(c).length,1);
});

test('reported measurements are labelled as owner claims and rejection never quotes',async t=>{
 const c=await surfaceFixture(t),ui=await c.boot();await flush(()=>!!ui.root.querySelector('form'));c.fill(ui);ui.root.querySelector('[name="basis"]').value='measured';
 c.click(ui,'Prepare exact review');await flush(()=>!!ui.root.querySelector('[name="reviewed"]'));
 assert.match(ui.root.textContent,/Owner-reported whole-package measurement/);assert.match(ui.root.textContent,/not independently verified/);
 c.click(ui,'Reject');await flush(()=>ui.root.textContent.includes('Review rejected'));assert.equal(posts(c).length,2);assert.equal(c.network.length,0);assert.equal(ui.root.querySelector('button'),null);
});

for(const bad of ['verification','allowance','expiry','operation_hash']){
 test(`UI refuses a ${bad} descriptor before showing approval controls`,async t=>{
  const c=await surfaceFixture(t);c.transform=async(path,opts,response)=>{
   if(path!==c.api||opts.method!=='POST')return response;
   const v=await response.json();if(bad==='verification')v.sourceVerified=true;if(bad==='allowance')v.maxSpendMinor=100;if(bad==='expiry')v.remainingMs=300001;if(bad==='operation_hash')v.operationHash='invalid';return Response.json(v);
  };
  const ui=await c.boot();await flush(()=>!!ui.root.querySelector('form'));c.fill(ui);c.click(ui,'Prepare exact review');await flush(()=>ui.root.textContent.includes('unconfirmed'));
  assert.equal(ui.root.querySelector('[name="reviewed"]'),null);assert.equal(posts(c).length,1);assert.equal(c.network.length,0);
 });
}

test('review values are rendered as text and never interpreted as HTML',async t=>{
 const c=await surfaceFixture(t);c.transform=async(path,opts,response)=>{if(path!==c.api||opts.method!=='POST')return response;const v=await response.json();v.reviewSummary.parcel='<img src=x onerror="alert(1)">';return Response.json(v);};
 const ui=await c.boot();await c.prepare(ui);assert.match(ui.root.textContent,/<img src=x/);assert.equal(ui.root.querySelector('img'),null);assert.equal(c.network.length,0);
});

test('an uncertain preparation marker prevents repeat submission after a page and host reload',async t=>{
 const c=await surfaceFixture(t),ui=await c.boot();await flush(()=>!!ui.root.querySelector('form'));c.fill(ui);
 c.f.store.save=async()=>{throw Error('Synthetic uncertain persistence');};c.click(ui,'Prepare exact review');await flush(()=>ui.root.textContent.includes('unconfirmed'));
 assert.equal(posts(c).length,1);assert.equal(c.f.fake.states.get(c.workspaceId).approvals.length,0);
 const next=await c.boot({storage:markers(ui),surface:c.make()});await flush(()=>next.root.textContent.includes('Preparation may already'));
 assert.equal(next.root.querySelector('button'),null);assert.equal(posts(c).length,1);assert.equal(c.network.length,0);
});

test('lost decision response requires a fresh saved-status read before execution controls appear',async t=>{
 const c=await surfaceFixture(t),ui=await c.boot();await c.prepare(ui);
 c.transform=async(path,opts,response)=>{if(path===c.api&&opts.method==='POST'&&JSON.parse(opts.body).action==='decide')throw Error('Synthetic response lost');return response;};
 c.check(ui,'reviewed');c.click(ui,'Approve exact review');await flush(()=>ui.root.textContent.includes('unconfirmed'));
 assert.equal(ui.root.querySelector('[name="sendConfirmed"]'),null);assert.equal(c.network.length,0);
 c.transform=null;const next=await c.boot({storage:markers(ui)});await flush(()=>!!next.root.querySelector('[name="sendConfirmed"]'));assert.equal(posts(c).length,2);assert.equal(c.network.length,0);
});

test('lost provider response shows uncertainty and cannot be retried after reload',async t=>{
 const c=await surfaceFixture(t,op=>op==='quote'?{reset:true}:{}),ui=await c.boot();await c.approve(ui);
 c.check(ui,'sendConfirmed');c.click(ui,'Request one quote comparison');await flush(()=>ui.root.textContent.includes('unconfirmed'));c.click(ui,'Request one quote comparison');
 assert.equal(posts(c).length,3);assert.equal(c.network.length,2);
 const next=await c.boot({storage:markers(ui),surface:c.make()});await flush(()=>next.root.textContent.includes('do not repeat'));assert.equal(next.root.querySelector('button'),null);assert.equal(c.network.length,2);
});

test('a response claiming verification cannot be presented as a successful comparison',async t=>{
 const c=await surfaceFixture(t),ui=await c.boot();await c.approve(ui);
 c.transform=async(path,opts,response)=>{if(path===c.api&&opts.method==='POST'&&JSON.parse(opts.body).action==='execute'){const v=await response.json();v.sourceVerified=true;return Response.json(v);}return response;};
 c.check(ui,'sendConfirmed');c.click(ui,'Request one quote comparison');await flush(()=>ui.root.textContent.includes('unconfirmed'));
 assert.doesNotMatch(ui.root.textContent,/Comparison received|12\.66/);assert.equal(c.network.length,2);assert.equal(posts(c).length,3);
});

test('unavailable one-use browser storage prevents input submission',async t=>{
 const c=await surfaceFixture(t),ui=await c.boot({storage:{getItem(){throw Error('Synthetic blocked storage');}}});
 await flush(()=>ui.root.textContent.includes('Review unavailable'));assert.equal(ui.root.querySelector('form'),null);assert.equal(posts(c).length,0);
});

test('a preparation response after the original deadline is suppressed',async t=>{
 const c=await surfaceFixture(t),ui=await c.boot();await flush(()=>!!ui.root.querySelector('form'));c.fill(ui);
 c.transform=async(path,opts,response)=>{if(path===c.api&&opts.method==='POST')Object.defineProperty(ui.w.performance,'now',{value:()=>1000000});return response;};
 c.click(ui,'Prepare exact review');await flush(()=>ui.root.textContent.includes('expired'));
 assert.equal(ui.root.querySelector('[name="reviewed"]'),null);assert.equal(posts(c).length,1);assert.equal(c.network.length,0);assert.equal(posts(c)[0].opts.signal.aborted,true);
});
