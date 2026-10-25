import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
const source=fs.readFileSync(new URL('../../creative-allowance-ui.js',import.meta.url),'utf8');
const turn=()=>new Promise(r=>setImmediate(r));
const budget=()=>({limitMicros:'1000000',reservedMicros:'600000',heldMicros:'600000',spentMicros:'0',releasedMicros:'0',uncertainMicros:'600000',overrunMicros:'0',availableMicros:'400000',overrunBlocked:false});
const row=(extra={})=>({id:'approval',approvalType:'creative_phase/v1',workspaceId:'alpha',campaignId:'campaign',requestId:'creative',provider:'canva',phase:'asset_upload',status:'pending',revision:1,currency:'USD',maxCostMicros:600000,expiresAt:new Date(Date.now()+60000).toISOString(),providerAccountId:'canonical-account',accountBinding:'a'.repeat(64),inputDigest:'b'.repeat(64),priceRevision:'verified-price-1',sourcePreview:'{"headline":"Exact creative"}',payloadPreview:'{"imageSha256":"abc"}',tenantBudget:budget(),accountBudget:budget(),reservationStatus:null,accountingStatus:null,accountedCostMicros:null,heldCostMicros:'0',upstreamId:null,...extra});
function memory(){const map=new Map();return{map,getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v)};}
function harness(t,{storage=memory(),respond,stage,role='owner'}={}){
 const dom=new JSDOM('<main></main>',{url:'https://synthetic.example.test',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;w.eval(source);
 const container=w.document.querySelector('main'),who={workspaceId:'alpha',userId:'owner',role:'owner',session:'one'},calls=[];let identity=who;
 const campaign={id:'campaign',creativeRequests:[{id:'creative',provider:'canva',status:'pending',stage}]};container.innerHTML=w.RunvaraCreativeAllowances.entries(campaign,role);
 w.RunvaraCreativeAllowances.install(container,{storage,uuid:randomUUID,context:()=>identity,isCurrent:c=>c===identity&&identity.role==='owner',request:async(route,options={})=>{calls.push({route,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});return respond?.(calls.at(-1),calls.length);}});
 return{w,container,calls,storage,change:next=>{identity=next;},click:selector=>container.querySelector(selector)?.click(),text:()=>container.textContent,ui:w.RunvaraCreativeAllowances};
}
test('owner-only UI exposes exact creative account price expiry and both budgets without a request on mount',async t=>{
 const h=harness(t,{respond:()=>({allowance:[row()]})});assert.equal(h.calls.length,0);h.click('[data-creative-review]');await turn();assert.equal(h.calls.length,1);
 for(const value of ['Exact creative','canonical-account','verified-price-1','Business budget','Provider account budget','USD 0.600000','Approval revision 1'])assert.ok(h.text().includes(value),value);
 assert.equal(h.ui.entries({id:'campaign',creativeRequests:[{id:'creative',provider:'canva'}]},'admin'),'');
});
test('prepare persists phase identity before its one POST and double-click cannot duplicate it',async t=>{
 let resolve;const h=harness(t,{respond:(call)=>call.method==='GET'?{allowance:[]}:new Promise(r=>{assert.equal(h.storage.map.size,1);resolve=r;})});h.click('[data-creative-review]');await turn();h.click('[data-creative-prepare]');h.click('[data-creative-prepare]');assert.equal(h.calls.length,2);resolve({allowance:row()});await turn();assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
});
test('unknown preparation survives refresh and re-entry without automatic retry',async t=>{
 const storage=memory(),first=harness(t,{storage,respond:c=>{if(c.method==='POST')throw Error('Unknown outcome');return{allowance:[]};}});first.click('[data-creative-review]');await turn();first.click('[data-creative-prepare]');await turn();assert.match(first.text(),/No automatic retry/);
 const second=harness(t,{storage,respond:()=>({allowance:[]})});assert.equal(second.calls.length,0);second.click('[data-creative-review]');await turn();assert.match(second.text(),/outcome remains unknown/);assert.equal(second.container.querySelector('[data-creative-prepare]'),null);assert.equal(second.calls.filter(c=>c.method==='POST').length,0);
});
test('saved original task is recovered after re-entry with uncertain exposure and no dispatch',async t=>{
 const h=harness(t,{respond:()=>({allowance:[row({status:'approved',reservationStatus:'uncertain',accountingStatus:'uncertain',heldCostMicros:'600000',upstreamId:'original-task'})]})});h.click('[data-creative-review]');await turn();assert.match(h.text(),/original-task/);assert.match(h.text(),/Actual charge remains unverified/);assert.match(h.text(),/Held exposure: USD 0.600000/);assert.deepEqual(h.calls.map(c=>c.method),['GET']);
});
test('three Canva phases have independent preparations while preserving earlier history',async t=>{
 const storage=memory();for(const [stage,phase,prior] of [[undefined,'asset_upload',[]],['autofill_ready','autofill',[row({status:'approved'})]],['export_ready','export',[row({status:'approved'}),row({id:'second',phase:'autofill',status:'approved'})]]]){
  const h=harness(t,{storage,stage,respond:c=>({allowance:c.method==='GET'?prior:row({phase})})});h.click('[data-creative-review]');await turn();assert.ok(h.container.querySelector('[data-creative-prepare]'));h.click('[data-creative-prepare]');await turn();assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
 }assert.equal(storage.map.size,3);
});
test('decision uncertainty removes actionable decision and offers saved read only',async t=>{
 const h=harness(t,{respond:c=>{if(c.method==='POST')throw Error('Lost decision acknowledgement');return{allowance:[row()]};}});h.click('[data-creative-review]');await turn();h.click('[data-creative-decision="approved"]');await turn();assert.equal(h.container.querySelector('[data-creative-decision]'),null);assert.equal(h.calls.length,2);assert.match(h.text(),/No automatic retry/);
});
test('cross-tenant response and generic/publication authority never render an approve button',async t=>{
 for(const patch of [{workspaceId:'other'},{campaignId:'other'},{requestId:'other'},{approvalType:'publication/v1'},{maxCostMicros:Infinity}]){const h=harness(t,{respond:()=>({allowance:[row(patch)]})});h.click('[data-creative-review]');await turn();assert.equal(h.container.querySelector('[data-creative-decision]'),null);assert.match(h.text(),/unavailable/);}
});
test('expiry blocks approval while revocation remains available and large integer costs remain exact',async t=>{
 const h=harness(t);const expired=row({expiresAt:'2020-01-01T00:00:00Z'});assert.ok(!h.ui.detail(expired,'alpha','creative','campaign').includes('data-creative-decision'));
 const html=h.ui.detail(row({status:'approved',reservationStatus:'completed',accountingStatus:'overrun',accountedCostMicros:'9007199254740993',heldCostMicros:'0',expiresAt:'2020-01-01T00:00:00Z'}),'alpha','creative','campaign');assert.ok(html.includes('9007199254.740993'));assert.ok(html.includes('data-creative-decision="revoked"'));
});
test('logout or tenant change during response cannot expose previous owner data or issue another call',async t=>{
 let resolve;const h=harness(t,{respond:()=>new Promise(r=>{resolve=r;})});h.click('[data-creative-review]');h.change({workspaceId:'beta',userId:'other',role:'owner'});resolve({allowance:[row()]});await turn();assert.ok(!h.text().includes('Exact creative'));assert.equal(h.calls.length,1);
});
test('untrusted preview markup is rendered as text only',async t=>{
 const h=harness(t,{respond:()=>({allowance:[row({sourcePreview:'<img src=x onerror="window.hacked=true">',payloadPreview:'<script>window.hacked=true</script>'})]})});h.click('[data-creative-review]');await turn();assert.equal(h.container.querySelector('img,script'),null);assert.equal(h.w.hacked,undefined);
});
test('storage failure blocks a new preparation before transport',async t=>{
 const h=harness(t,{storage:{getItem:()=>null,setItem:()=>{throw Error('Storage unavailable');}},respond:()=>({allowance:[]})});h.click('[data-creative-review]');await turn();h.click('[data-creative-prepare]');await turn();assert.equal(h.calls.length,1);assert.match(h.text(),/Storage unavailable/);
});
test('unavailable browser storage cannot break installation or trigger requests',t=>{
 const h=harness(t);Object.defineProperty(h.w,'sessionStorage',{get(){throw Error('Storage denied');}});
 assert.doesNotThrow(()=>h.ui.install(h.w.document.createElement('div'),{request:()=>assert.fail('No request'),context:()=>({}),isCurrent:()=>false}));
 assert.equal(h.calls.length,0);
});
