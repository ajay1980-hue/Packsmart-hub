import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
const source = fs.readFileSync(new URL('../../maintenance-approval-ui.js', import.meta.url), 'utf8');
const turn = () => new Promise(r => setImmediate(r));
const memory = () => { const map = new Map(); return { map, getItem: k => map.get(k) || null, setItem: (k,v) => map.set(k,v) }; };
function harness(t, { storage = memory(), session, respond, clock } = {}) {
  const dom = new JSDOM('<main></main>', { url: 'https://synthetic.example.test', runScripts: 'outside-only' }); t.after(() => dom.window.close());
  dom.window.eval(source); let current = true; const calls = [];
  session ||= { workspace: { id: 'alpha' }, user: { id: 'owner', role: 'owner' }, approvalPilot: { schema: 'runvara-quiet-approval-pilot/v1', requestId: randomUUID(), expiresAt: new Date(Date.now()+600000).toISOString(), writable: true } };
  const ui = dom.window.RunvaraMaintenanceApproval.create({ host: dom.window.document.querySelector('main'), session, storage,
    now: clock || Date.now, isCurrent: () => current, request: async (path, options) => { calls.push({path,body:JSON.parse(options.body),options});assert.ok(storage.map?.size ?? 1);return respond?.(path,JSON.parse(options.body),options); } });
  const buttons = ui?.root.querySelectorAll('button');
  return { dom, session, ui, calls, storage, create: buttons?.[0], reject: buttons?.[1], check: buttons?.[2], text: () => ui.root.textContent, loseSession: () => {current=false;} };
}
const response = (body, status = 'pending', id = 'approval_synthetic') => ({schema:'runvara-quiet-approval-pilot/v1',requestId:body.requestId,found:true,approval:{id,revision:1,status},executedExternally:false,maintenance:true});

test('pilot UI makes no automatic request, stores intent before one create and permits only exact rejection', async t => {
  const h=harness(t,{respond:(path,body)=>response(body,path.endsWith('/reject')?'rejected':'pending')}); assert.equal(h.calls.length,0);assert.equal(h.reject.disabled,true);
  h.create.click();h.create.click();await turn();assert.equal(h.calls.length,1);assert.equal(h.reject.disabled,false);assert.equal(h.create.disabled,true);
  h.reject.click();h.reject.click();await turn();assert.equal(h.calls.length,2);assert.deepEqual(h.calls[1].body,{requestId:h.session.approvalPilot.requestId,approvalId:'approval_synthetic',revision:1,decision:'rejected'});
  assert.equal(h.reject.disabled,true);assert.match(h.text(),/rejection confirmed/);assert.doesNotMatch(JSON.stringify([...h.storage.map]),/csrf|password|token/);
});
test('unknown create closes mutations; absence or a later pending result cannot authorize a retry or rejection', async t => {
  let count=0;const h=harness(t,{respond:(path,body)=>{if(++count===1)throw Error('lost response');return count===2?{...response(body),found:false,approval:null}:response(body);}});
  h.create.click();await turn();assert.match(h.text(),/Outcome unknown/);assert.equal(h.create.disabled,true);assert.equal(h.reject.disabled,true);
  h.check.click();await turn();assert.match(h.text(),/outcome remains unknown/);h.check.click();await turn();assert.match(h.text(),/Further changes remain stopped/);assert.equal(h.check.disabled,true);assert.equal(h.reject.disabled,true);assert.equal(h.calls.length,3);
});
test('refresh/re-entry requires explicit reconciliation and retains the same identity and read budget', async t => {
  const storage=memory(),first=harness(t,{storage,respond:(_,b)=>response(b)});first.create.click();await turn();first.ui.destroy();
  const next=harness(t,{storage,session:first.session,respond:(_,b)=>response(b)});assert.equal(next.calls.length,0);assert.equal(next.reject.disabled,true);next.check.click();await turn();assert.equal(next.reject.disabled,false);assert.equal(next.calls[0].body.requestId,first.session.approvalPilot.requestId);
  next.ui.destroy();const last=harness(t,{storage,session:first.session,respond:(_,b)=>response(b)});last.check.click();await turn();assert.equal(last.check.disabled,true);assert.equal(last.calls.length,1);
});
test('interruption and late responses do not mutate a replaced session; unfinished intent survives re-entry', async t => {
  let finish;const storage=memory(),first=harness(t,{storage,respond:()=>new Promise(r=>finish=r)});first.create.click();first.ui.destroy();finish(response(first.calls[0].body));await turn();
  const next=harness(t,{storage,session:first.session});assert.equal(next.calls.length,0);assert.equal(next.create.disabled,true);assert.equal(next.reject.disabled,true);assert.match(next.text(),/Previous test retained/);
  let finish2;const changed=harness(t,{respond:()=>new Promise(r=>finish2=r)});changed.create.click();changed.loseSession();finish2(response(changed.calls[0].body));await turn();assert.equal(changed.reject.disabled,true);
});
test('expiry, closed capability and storage failures prohibit submissions', async t => {
  let clock=Date.now();const expired=harness(t,{clock:()=>clock});clock=Date.parse(expired.session.approvalPilot.expiresAt)+1;expired.create.click();assert.equal(expired.calls.length,0);assert.match(expired.text(),/window is closed/);
  const closed=harness(t,{session:{workspace:{id:'a'},user:{id:'o',role:'owner'},approvalPilot:{schema:'runvara-quiet-approval-pilot/v1',requestId:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString(),writable:false}}});closed.create.click();assert.equal(closed.calls.length,0);
  const broken=harness(t,{storage:{getItem(){return null;},setItem(){throw Error('blocked');}}});broken.create.click();assert.equal(broken.calls.length,0);assert.match(broken.text(),/Nothing new was submitted/);
  const corrupt=harness(t,{storage:{getItem(){return '{broken';},setItem(){}}});corrupt.create.click();assert.equal(corrupt.calls.length,0);
});
test('wrong identity or response cannot present success or enable rejection', async t => {
  for(const mode of ['request','approval','execution','decision']){
    const h=harness(t,{respond:(_,b)=>({...response(b),...(mode==='request'?{requestId:randomUUID()}:mode==='approval'?{approval:{id:'x',revision:2,status:'pending'}}:mode==='execution'?{executedExternally:true}:{approval:{id:'x',revision:1,status:'approved'}})})});h.create.click();await turn();assert.match(h.text(),/Outcome unknown/);assert.equal(h.reject.disabled,true);
  }
  const missing=harness(t,{session:{workspace:{id:'alpha'},user:{id:'viewer',role:'viewer'},approvalPilot:{schema:'runvara-quiet-approval-pilot/v1'}}});assert.equal(missing.ui,null);assert.equal(missing.calls.length,0);
});
