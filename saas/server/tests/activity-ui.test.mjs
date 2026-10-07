import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createActivityMeter } from '../lib/activity-meter.mjs';
const html = await fs.readFile(new URL('../../index.html',import.meta.url),'utf8');
const script = await fs.readFile(new URL('../../activity-ui.js',import.meta.url),'utf8');
const workspaceId = 'activity-ui';
function fixture({ unavailable = false }={}) {
  let time = Date.parse('2026-10-07T00:00:00Z');
  const meter = createActivityMeter({now:()=>time,instanceId:'activity-fixture-one',dbAvailable:!unavailable});
  if (unavailable) { meter.observeJob(workspaceId,'blocked'); return meter.snapshot(workspaceId); }
  for(let i=0;i<12;i++) { const token=meter.beginDbAttempt({workspaceId,operation:'state_read',method:'GET',requestBodyBytes:0,retryKind:i<6?'upsert_network':null}); meter.finishDbAttempt(token,{outcome:i<6?'http_error':'succeeded',responseBodyBytes:i<6?null:100}); }
  meter.observeHotState(workspaceId,{kind:'attempted',bytes:2000}); meter.observeHotState(workspaceId,{kind:'attempted',bytes:3000});
  meter.observeHotState(workspaceId,{kind:'confirmed',bytes:1000}); meter.observeHotState(workspaceId,{kind:'confirmed',bytes:0});
  meter.observeHotState(workspaceId,{kind:'integrity_read',bytes:1500}); meter.observeJob(workspaceId,'succeeded'); meter.observeJob(workspaceId,'rescheduled');
  time+=300000; return meter.snapshot(workspaceId);
}
const deferred=()=>{let resolve,reject;const promise=new Promise((y,n)=>{resolve=y;reject=n;});return{promise,resolve,reject};};
async function until(fn){for(let n=0;n<200;n++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Activity UI did not settle');}
async function harness(t,{role='owner',snapshot=fixture()}={}) {
  const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(html,{url:'https://runvara.example.test',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console});
  const w=dom.window,d=w.document;w.AbortController=AbortController;
  const h={w,d,calls:[],context:{workspaceId,role,session:{},view:'audit'},snapshot};
  h.handler=async()=>structuredClone(h.snapshot);
  w.eval(script);w.RunvaraActivity.init({getContext:()=>h.context,request:(path,config)=>{h.calls.push({path,...config});return h.handler(path,config);}});
  h.$=id=>d.getElementById(id);h.panel=h.$('workspace-activity-panel');h.root=h.$('workspace-activity-result');h.button=h.$('workspace-activity-refresh');
  h.open=async()=>{h.panel.open=true;await until(()=>h.calls.length>0);await until(()=>!h.button.disabled);};
  h.refresh=async()=>{h.button.click();await until(()=>!h.button.disabled);};
  h.section=title=>[...h.root.querySelectorAll('section')].find(node=>node.querySelector('h3')?.textContent===title);
  h.value=(root,label)=>[...root.querySelectorAll('dt')].find(node=>node.textContent===label)?.nextElementSibling.textContent;
  t.after(async()=>{await new Promise(r=>setTimeout(r,5));dom.window.close();assert.deepEqual(errors,[]);});
  return h;
}

test('activity is collapsed, owner/admin scoped, on demand, coalesced and never fetches a selected fleet tenant',async t=>{
  const h=await harness(t);assert.equal(h.panel.open,false);assert.equal(h.calls.length,0);
  assert.equal(h.panel.closest('section').id,'view-audit');
  const hold=deferred();h.handler=()=>hold.promise;h.panel.open=true;await until(()=>h.calls.length===1);
  h.button.click();h.button.dispatchEvent(new h.w.MouseEvent('click',{bubbles:true}));assert.equal(h.calls.length,1);assert.equal(h.root.getAttribute('aria-busy'),'true');
  hold.resolve(fixture());await until(()=>!h.button.disabled);
  assert.equal(h.calls[0].path,'/api/activity');assert.equal(h.calls[0].body,undefined);assert.equal(h.calls[0].method,undefined);
  h.panel.open=false;await new Promise(r=>setTimeout(r,10));h.panel.open=true;await new Promise(r=>setTimeout(r,10));assert.equal(h.calls.length,1);
  h.context.view='fleet';h.w.RunvaraActivity.pause();h.button.click();assert.equal(h.calls.length,1);
  assert.match(h.root.textContent,/^$/);assert.equal(h.panel.open,false);
  for(const role of ['member','viewer','operator',null]){const denied=await harness(t,{role});denied.panel.open=true;denied.button.dispatchEvent(new denied.w.MouseEvent('click',{bubbles:true}));await new Promise(r=>setTimeout(r,10));assert.equal(denied.calls.length,0);assert.equal(denied.panel.classList.contains('hidden'),true);}
  const admin=await harness(t,{role:'admin'});await admin.open();assert.equal(admin.calls.length,1);
});

test('measured zeros, unknown sizes, attempted and confirmed snapshots remain distinct',async t=>{
  const h=await harness(t);await h.open();
  assert.equal(h.value(h.section('Database activity'),'Requests started'),'12');assert.equal(h.value(h.section('Database activity'),'Failed'),'6');
  const body=h.section('Recorded data sizes');assert.match(body.textContent,/0 bytes/);assert.match(body.textContent,/600 bytes/);assert.match(body.textContent,/Only measured content is included/);
  const cards=h.section('Workspace snapshot sizes').querySelectorAll('article');
  assert.equal(h.value(cards[0],'Recorded size'),'3,000 bytes');assert.equal(h.value(cards[1],'Recorded size'),'0 bytes');assert.equal(h.value(cards[2],'Recorded size'),'1,500 bytes');
  assert.equal(h.value(cards[1],'Change from previous'),'−1,000 bytes');assert.equal(h.value(cards[2],'Previous size'),'Unknown');
  assert.match(h.section('Workspace snapshot sizes').textContent,/save attempt is not proof that data was saved/);
  assert.match(h.section('Job events').textContent,/not unique jobs/);assert.equal(h.value(h.section('Job events'),'Blocked'),'0');
  assert.match(h.section('Activity notices').textContent,/6 of 12 completed requests failed/);assert.match(h.section('Activity notices').textContent,/6 of 12 completed requests were retries/);
  assert.match(h.panel.textContent,/not provider charges, physical storage totals or network bills/);assert.equal(h.root.textContent.includes(h.snapshot.instanceId),false);
});

test('unobserved and unavailable database accounting is never shown as zero',async t=>{
  const meter=createActivityMeter({instanceId:'empty',now:()=>Date.parse('2026-10-07T00:00:00Z')});
  for(const snapshot of [meter.snapshot(workspaceId),fixture({unavailable:true})]){
    const h=await harness(t,{snapshot});await h.open();assert.equal(h.value(h.section('Database activity'),'Requests started'),'Unknown');assert.equal(h.value(h.section('Recorded data sizes'),'Known size total'),'Unknown');
    assert.match(h.section('Coverage of this check').textContent,/unavailable|No activity has been observed/);assert.doesNotMatch(h.section('Activity notices').textContent,/6 of 12/);
  }
});

test('partial counters and restart changes are explicit; overflow running counts stay unknown',async t=>{
  const h=await harness(t);await h.open();
  h.snapshot.coverage={...h.snapshot.coverage,status:'partial',omittedObservations:2,counterOverflow:true,inflightReason:'inflight_token_overflow',inflightOverflow:1};h.snapshot.db.inflight=null;
  h.snapshot.rateWindow={...h.snapshot.rateWindow,eligible:false,reason:'counter_overflow'};h.snapshot.instanceId='activity-fixture-two';
  await h.refresh();assert.match(h.root.textContent,/server has changed or restarted/);assert.match(h.root.textContent,/Some activity was not recorded/);assert.match(h.root.textContent,/minimums, not exact totals/);
  assert.equal(h.value(h.section('Database activity'),'Requests started'),'At least 12');assert.equal(h.value(h.section('Database activity'),'Still running'),'Unknown');assert.match(h.root.textContent,/number still running is unknown/);assert.doesNotMatch(h.section('Activity notices').textContent,/6 of 12/);
});

test('failure and retry anomalies stay withheld for every ineligible completion window',async t=>{
  const h=await harness(t);await h.open();
  for(const reason of ['not_observed','database_unavailable','clock_unreliable','counter_overflow','awaiting_complete_window','incomplete_observations','inflight_token_overflow','pending_completions','insufficient_completions']){
    h.snapshot.rateWindow={...h.snapshot.rateWindow,eligible:false,reason};await h.refresh();
    assert.doesNotMatch(h.section('Activity notices').textContent,/6 of 12/);assert.match(h.section('Recent completion window').textContent,/unavailable|not enough|Waiting|still running|No database activity/);
    assert.equal(h.section('Recent completion window').textContent.includes(reason),false);
  }
});

test('size alerts use fixed kind labels and remain distinct from rate eligibility',async t=>{
  const h=await harness(t);h.snapshot.rateWindow.eligible=false;h.snapshot.rateWindow.reason='pending_completions';
  h.snapshot.anomalies.unshift({code:'hot_state_near_limit',kind:'attempted',bytes:1572864,limitBytes:2097152},{code:'hot_state_limit_exceeded',kind:'confirmed',bytes:2097152,limitBytes:2097152});
  await h.open();assert.match(h.section('Activity notices').textContent,/Latest save attempt is close to/);assert.match(h.section('Activity notices').textContent,/Latest confirmed save is at or above/);assert.doesNotMatch(h.section('Activity notices').textContent,/6 of 12/);
});

test('rendering is bounded to fixed counters and five notices; injected labels and arbitrary keys never become markup',async t=>{
  const h=await harness(t);const hostile='<img src=x onerror="window.activityInjected=true">';
  h.snapshot.db.operations[hostile]=999;h.snapshot.jobs[hostile]=888;h.snapshot.coverage.detail=hostile;h.snapshot.snapshotAt=hostile;
  h.snapshot.anomalies=Array.from({length:10000},()=>({code:'hot_state_near_limit',kind:'attempted',bytes:1600000,limitBytes:2097152,detail:hostile}));
  await h.open();assert.equal(h.root.querySelectorAll('.activity-notice').length,5);assert.ok(h.root.querySelectorAll('dd').length<100);
  assert.equal(h.root.querySelector('img,script,[onerror]'),null);assert.equal(h.w.activityInjected,undefined);assert.equal(h.root.textContent.includes(hostile),false);assert.match(h.root.textContent,/Checked atUnknown/);
});

test('foreign, malformed and wrong-version responses are rejected without retaining previous figures',async t=>{
  const h=await harness(t);await h.open();
  for(const patch of [{workspaceId:'foreign'},{schema:'runvara-activity/v2'},{coverage:{scope:'global',status:'observed'}},{instanceId:'<script>'},{db:null}]){
    h.snapshot={...fixture(),...patch};await h.refresh();assert.equal(h.root.textContent,'');assert.match(h.$('workspace-activity-status').textContent,/could not be checked/);
  }
});

test('errors and rate limiting require explicit retry and never display server error text',async t=>{
  const h=await harness(t);await h.open();
  for(const status of [429,403,500]){
    h.handler=async()=>{throw Object.assign(new Error('<img private-server-error>'),{status});};const before=h.calls.length;await h.refresh();await new Promise(r=>setTimeout(r,15));assert.equal(h.calls.length,before+1);assert.equal(h.root.textContent,'');assert.equal(h.panel.textContent.includes('private-server-error'),false);
    assert.match(h.$('workspace-activity-status').textContent,status===429?/Wait a minute/:status===403?/owner or an admin/:/could not be checked/);
  }
});

test('close and navigation abort reads and late results cannot replace a later check',async t=>{
  const h=await harness(t);await h.open();const hold=deferred();h.handler=()=>hold.promise;h.button.click();const old=h.calls.at(-1);
  h.panel.open=false;await until(()=>old.signal.aborted);h.handler=async()=>fixture();h.panel.open=true;await until(()=>!h.button.disabled && h.root.textContent.length>0);const fresh=h.root.textContent;
  hold.resolve({...fixture(),instanceId:'stale',db:{...fixture().db,attempted:999}});await new Promise(r=>setTimeout(r,10));assert.equal(h.root.textContent,fresh);
  const nav=deferred();h.handler=()=>nav.promise;h.button.click();const navCall=h.calls.at(-1);h.context.view='overview';h.w.RunvaraActivity.pause();assert.equal(navCall.signal.aborted,true);
  nav.resolve(fixture());await new Promise(r=>setTimeout(r,10));assert.equal(h.root.textContent,'');
});

test('session/workspace reset clears prior activity and rejects the old request callback',async t=>{
  const h=await harness(t);await h.open();const hold=deferred();h.handler=()=>hold.promise;h.button.click();const old=h.calls.at(-1);
  h.context={...h.context,workspaceId:'another-workspace',session:{}};h.w.RunvaraActivity.reset();assert.equal(old.signal.aborted,true);assert.equal(old.isCurrent(),false);assert.equal(h.root.textContent,'');assert.equal(h.panel.open,false);
  hold.resolve(fixture());await new Promise(r=>setTimeout(r,10));assert.equal(h.root.textContent,'');
});

test('real app aborts on close/logout and ignores stale 401 while retaining current-session authentication',async t=>{
  const {createPacksmartServer}=await import('../server.mjs'); const {seedWorkspaceState}=await import('../lib/store.mjs'); const {createSessionToken}=await import('../lib/security.mjs');
  const {once}=await import('node:events');const {default:os}=await import('node:os');const {default:path}=await import('node:path');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-activity-ui-'));const secret='synthetic-activity-ui-more-than-thirty-two-characters';
  const server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,CREDENTIALS_KEY:secret,SAAS_STATE_FILE:path.join(directory,'state.json'),SHOPIFY_PUBLIC_SYNC_ENABLED:'false'});
  const state=seedWorkspaceState({}, {workspaceId,email:'activity@example.test',passwordHash:'fixture-only'});state.products=[];
  await server.packsmart.store.save(workspaceId,state);server.listen(0,'127.0.0.1');await once(server,'listening');
  const token=createSessionToken({userId:state.users[0].id,workspaceId,email:state.users[0].email,role:'owner',sessionVersion:1},secret);
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/bootstrap`,{headers:{Cookie:`packsmart_session=${token}`}});assert.equal(response.status,200);const bootstrap=await response.json();await new Promise(r=>server.close(r));
  const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));const dom=new JSDOM(html,{url:'https://activity.example.test',runScripts:'outside-only',virtualConsole:console,pretendToBeVisual:true});
  const w=dom.window,d=w.document,calls=[];w.Headers=Headers;w.AbortController=AbortController;w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  t.after(async()=>{await new Promise(r=>setTimeout(r,10));dom.window.close();await fs.rm(directory,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  let activity=null,logout=null;
  w.fetch=async(route,config={})=>{calls.push({route,config});
    if(route==='/api/bootstrap')return Response.json(bootstrap);
    if(route==='/api/auth/session'||route==='/api/auth/login')return Response.json({user:bootstrap.user,workspace:bootstrap.workspace,csrf:bootstrap.csrf});
    if(route==='/api/auth/signup-options')return Response.json({enabled:false});
    if(route==='/api/auth/logout')return logout?logout.promise:Response.json({ok:true});
    if(route==='/api/billing')return Response.json({});if(String(route).startsWith('/api/audit?'))return Response.json({events:[]});
    if(route==='/api/activity')return activity?activity.promise:Response.json(fixture());
    throw new Error('Unexpected fixture route '+route);
  };
  for(const file of ['presentation.js','control-ui.js','activity-ui.js','app.js'])w.eval(await fs.readFile(new URL('../../'+file,import.meta.url),'utf8'));
  const $=id=>d.getElementById(id),panel=$('workspace-activity-panel'),button=$('workspace-activity-refresh'),root=$('workspace-activity-result');
  await until(()=>!$('app-shell').classList.contains('hidden'));assert.equal(calls.some(c=>c.route==='/api/activity'),false);
  d.querySelector('#main-nav [data-view="audit"]').click();await new Promise(r=>setTimeout(r,10));assert.equal(calls.some(c=>c.route==='/api/activity'),false);
  panel.open=true;await until(()=>root.textContent.length>0);
  // Close and settle the old HTTP response in the same task, before the native
  // details-toggle listener has had a chance to abort its signal.
  activity=deferred();button.click();const closeRequest=calls.at(-1),oldClose=activity;panel.open=false;oldClose.resolve(Response.json({code:'AUTH_REQUIRED'},{status:401}));
  await new Promise(r=>setTimeout(r,10));assert.equal($('app-shell').classList.contains('hidden'),false);assert.equal(closeRequest.config.isCurrent(),false,'closed request cannot clear auth even before its abort listener runs');
  activity=null;panel.open=true;await until(()=>root.textContent.length>0 && !button.disabled);
  activity=deferred();button.click();const oldNavigation=activity;d.querySelector('#main-nav [data-view="overview"]').click();activity=null;d.querySelector('#main-nav [data-view="audit"]').click();panel.open=true;await until(()=>root.textContent.length>0 && !button.disabled);
  const fresh=root.textContent;oldNavigation.resolve(Response.json({code:'AUTH_REQUIRED'},{status:401}));await new Promise(r=>setTimeout(r,10));assert.equal(root.textContent,fresh);assert.equal($('app-shell').classList.contains('hidden'),false);
  activity=deferred();button.click();const oldSession=activity,oldSessionRequest=calls.at(-1);logout=deferred();$('logout').click();assert.equal(oldSessionRequest.config.signal.aborted,true,'logout invalidates before awaiting transport');
  logout.resolve(Response.json({ok:true}));await until(()=>$('app-shell').classList.contains('hidden'));activity=null;logout=null;
  const form=$('login-form');Object.defineProperty(form,'email',{value:form.elements.email});Object.defineProperty(form,'password',{value:form.elements.password});form.elements.email.value='activity@example.test';form.elements.password.value='fixture';form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>!$('app-shell').classList.contains('hidden'));
  panel.open=true;await until(()=>root.textContent.length>0 && !button.disabled);oldSession.resolve(Response.json({code:'AUTH_REQUIRED'},{status:401}));await new Promise(r=>setTimeout(r,10));assert.equal($('app-shell').classList.contains('hidden'),false);assert.match(root.textContent,/Requests started12/);
  assert.equal(calls.filter(c=>c.route==='/api/bootstrap').length,2,'activity reads never download a bootstrap; only initial and new session do');
  assert.ok(calls.filter(c=>c.route.startsWith('/api/activity')).every(c=>c.route==='/api/activity'&&!c.config.body&&!c.config.method));
  activity=deferred();button.click();activity.resolve(Response.json({code:'AUTH_REQUIRED'},{status:401}));await until(()=>$('app-shell').classList.contains('hidden'));assert.equal(root.textContent,'');assert.equal(panel.open,false);
});
