import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
const source=fs.readFileSync(new URL('../../maintenance-creative-ui.js',import.meta.url),'utf8'),turn=()=>new Promise(r=>setImmediate(r));
const memory=()=>{const map=new Map();return{map,getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v)};};
function harness(t,{storage=memory(),session,respond,clock}={}){
 const dom=new JSDOM('<main></main>',{url:'https://synthetic.invalid',runScripts:'outside-only'});t.after(()=>dom.window.close());dom.window.eval(source);
 session||={workspace:{id:'alpha'},user:{id:'owner',role:'owner'},creativePilot:{schema:'runvara-quiet-creative-pilot/v1',campaignId:'campaign',requestId:'request',providerAccountId:'account',priceRevision:'price',inputDigest:'a'.repeat(64),maxCostMicros:600,currency:'USD',expiresAt:new Date(Date.now()+600000).toISOString(),writable:true}};
 let current=true;const calls=[];const ui=dom.window.RunvaraMaintenanceCreative.create({host:dom.window.document.querySelector('main'),session,storage,now:clock||Date.now,isCurrent:()=>current,request:async(path,options)=>{calls.push({path,options,body:options.body&&JSON.parse(options.body)});assert.ok(storage.map?.size??1);return respond?.(path,options);}});
 return{dom,ui,calls,session,storage,button:op=>ui.root.querySelector('[data-creative-pilot="'+op+'"]'),text:()=>ui.root.textContent,lose:()=>{current=false;}};
}
function response(h,{status='pending',row=true,reservationStatus=null,upstreamId=null,writable=true}={}){const d=h.session.creativePilot;return{schema:d.schema,maintenance:true,requestId:d.requestId,expiresAt:d.expiresAt,writable,status:upstreamId?'in_progress':'pending',taskId:upstreamId,allowance:row?{id:'approval',approvalType:'creative_phase/v1',workspaceId:'alpha',campaignId:d.campaignId,requestId:d.requestId,provider:'runway',phase:'generation',inputDigest:d.inputDigest,providerAccountId:d.providerAccountId,priceRevision:d.priceRevision,maxCostMicros:d.maxCostMicros,currency:'USD',expiresAt:d.expiresAt,status,revision:status==='pending'?1:2,reservationStatus,upstreamId,heldCostMicros:reservationStatus?'600':'0',sourcePreview:'{"title":"<img onerror=alert(1)>"}',payloadPreview:'{"duration":10,"ratio":"1280:720","audio":false}'}:null};}

test('maintenance creative UI has no automatic requests and allows exact deliberate review/prepare/approve/submit only once',async t=>{
 let h;h=harness(t,{respond:path=>response(h,{row:!path.endsWith('review'),status:path.endsWith('decide')||path.endsWith('submit')?'approved':'pending',...(path.endsWith('submit')?{reservationStatus:'accepted',upstreamId:'known-task'}:{})})});
 assert.equal(h.calls.length,0);assert.equal(h.button('prepare').disabled,true);h.button('review').click();await turn();h.button('prepare').click();h.button('prepare').click();await turn();
 h.button('approved').click();await turn();h.button('submit').click();h.button('submit').click();await turn();assert.equal(h.calls.length,4);
 assert.equal(h.calls.filter(c=>c.path.endsWith('/submit')).length,1);assert.deepEqual(h.calls[2].body,{requestId:'request',approvalId:'approval',revision:1,decision:'approved'});
 assert.match(h.text(),/known-task/);assert.match(h.text(),/Completion is not billing proof/);assert.equal(h.ui.root.querySelector('img'),null);assert.doesNotMatch(JSON.stringify([...h.storage.map]),/password|csrf|token/);
});

test('unknown response latches all actions except bounded saved review across re-entry',async t=>{
 const storage=memory();let h;h=harness(t,{storage,respond:path=>{if(path.endsWith('submit'))throw Error('lost');return response(h,{status:'approved'});}});
 h.button('review').click();await turn();h.button('submit').click();await turn();assert.match(h.text(),/Outcome unknown/);h.ui.destroy();
 let next;next=harness(t,{storage,session:h.session,respond:()=>response(next,{status:'approved',reservationStatus:'accepted',upstreamId:'known-task'})});assert.equal(next.calls.length,0);
 next.button('review').click();await turn();assert.equal(next.button('submit').disabled,true);assert.equal(next.button('observe').disabled,true);next.button('review').click();await turn();assert.equal(next.button('review').disabled,true);
});

test('interrupted approval and late response retain uncertainty rather than enabling a later submit',async t=>{
 const storage=memory();let finish,h;h=harness(t,{storage,respond:path=>path.endsWith('decide')?new Promise(r=>finish=r):response(h)});
 h.button('review').click();await turn();h.button('approved').click();h.ui.destroy();finish(response(h,{status:'approved'}));await turn();
 let next;next=harness(t,{storage,session:h.session,respond:()=>response(next,{status:'approved'})});next.button('review').click();await turn();assert.equal(next.button('submit').disabled,true);assert.equal(next.calls.length,1);
});

test('known-task reads have a retained cap and never issue a provider submit',async t=>{
 let h;h=harness(t,{respond:()=>response(h,{status:'approved',reservationStatus:'accepted',upstreamId:'known-task'})});h.button('review').click();await turn();
 for(let i=0;i<5;i++){h.button('observe').click();await turn();}assert.equal(h.calls.filter(c=>c.path.endsWith('observe')).length,5);assert.equal(h.button('observe').disabled,true);assert.equal(h.button('submit').disabled,true);
});

test('expiry and closure forbid more actions without mutating frozen session metadata',async t=>{
 let h,clock=Date.now();h=harness(t,{clock:()=>clock,respond:()=>response(h,{writable:false})});Object.freeze(h.session.creativePilot);h.button('review').click();await turn();assert.equal(h.button('prepare').disabled,true);assert.doesNotMatch(h.text(),/Outcome unknown/);
 clock=Date.parse(h.session.creativePilot.expiresAt);h.button('review').click();assert.equal(h.calls.length,1);assert.match(h.text(),/window is closed/);
});

test('wrong response binding and unavailable storage fail closed',async t=>{
 for(const change of [{requestId:'other'},{providerAccountId:'other'},{priceRevision:'other'},{maxCostMicros:0},{workspaceId:'other'}]){
  let h;h=harness(t,{respond:()=>{const r=response(h);Object.assign(r.allowance,change);return r;}});h.button('review').click();await turn();assert.match(h.text(),/Outcome unknown/);assert.equal(h.button('approved').disabled,true);
 }
 const broken=harness(t,{storage:{getItem:()=>null,setItem(){throw Error('denied');}}});broken.button('review').click();await turn();assert.equal(broken.calls.length,0);
});

test('confirmed failed provider task is displayed distinctly from uncertainty and retains exposure warning',async t=>{
 let h;h=harness(t,{respond:path=>({...response(h,{status:'approved',reservationStatus:'accepted',upstreamId:'known-task'}),...(path.endsWith('observe')?{status:'failed',writable:false}:{})})});
 h.button('review').click();await turn();h.button('observe').click();await turn();
 assert.match(h.text(),/task failed/i);assert.match(h.text(),/hold.*retained/i);assert.doesNotMatch(h.text(),/Outcome unknown/);assert.equal(h.button('submit').disabled,true);assert.equal(h.button('observe').disabled,true);
});
