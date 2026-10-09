import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM,VirtualConsole } from 'jsdom';
import { recoveryRoute,recoveryChannel,recoveryPreview,recoveryResult,recoveryObservation,originalStartedAt } from './order-recovery-ui-fixture.mjs';

const copy=structuredClone,settle=()=>new Promise(resolve=>setTimeout(resolve,5));
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function until(check){for(let i=0;i<100;i++){if(check())return;await settle();}assert.fail('Recovery UI did not settle');}
async function harness(t,{role='owner',available=true,observation=false}={}){
  const errors=[],calls=[],timers=new Map(),vc=new VirtualConsole();vc.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(await fs.readFile(new URL('../../index.html',import.meta.url),'utf8'),{url:'https://runvara.example.test',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const w=dom.window,d=w.document;w.AbortController=AbortController;w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  let timer=0;w.setInterval=(callback,ms)=>{timers.set(++timer,{callback,ms});return timer;};w.clearInterval=id=>timers.delete(id);
  const user={id:'recovery-owner',role,active:true},workspace={id:'recovery-workspace'};
  const h={w,d,calls,timers,notifications:[],reloads:0,data:{user,workspace,connectionCentre:[recoveryChannel({available,observation}),{...recoveryChannel({available:false}),id:'ebay',name:'eBay'}],connectionWrites:[],products:[],autopilot:{enabled:false}},session:{user:copy(user),workspace:copy(workspace),csrf:'csrf-recovery'},csrf:'csrf-recovery',generation:1,hidden:false,view:'channels'};
  Object.defineProperty(d,'hidden',{configurable:true,get:()=>h.hidden});
  const context=()=>({session:h.session,csrf:h.csrf,sessionCsrf:h.session?.csrf,userId:h.session?.user.id,dataUserId:h.data.user.id,workspaceId:h.session?.workspace.id,dataWorkspaceId:h.data.workspace.id,role:h.session?.user.role,dataRole:h.data.user.role,active:h.session?.user.active,dataActive:h.data.user.active,passwordChangeRequired:h.session?.user.passwordChangeRequired,dataPasswordChangeRequired:h.data.user.passwordChangeRequired,generation:h.generation,bootstrap:h.data,view:h.view});
  h.preview=()=>recoveryPreview(h.data.workspace.id);h.post=async()=>recoveryResult(h.data.workspace.id);
  w.RunvaraUI={logo:()=>'',badge:()=>'',connectionMessage:()=>'',schedule:()=>''};w.eval(await fs.readFile(new URL('../../connections-ui.js',import.meta.url),'utf8'));
  const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  w.RunvaraConnections.init({getContentContext:context,escapeHtml:esc,date:String,notify:(...args)=>h.notifications.push(args),setView:view=>{w.RunvaraConnections.interruptContent('Navigation changed');h.view=view;},
    reload:async()=>{h.reloads++;h.data.connectionCentre[0].orderRecoveryObservation=recoveryObservation();h.generation++;w.RunvaraConnections.render(h.data);},
    request:async(path,options={})=>{calls.push({path,...options});if(path===recoveryRoute)return copy(await h.preview());if(path.startsWith(recoveryRoute+'/'))return h.post(path,options);if(path==='/api/connection-centre')return {channels:copy(h.data.connectionCentre),writes:[],autopilotEnabled:false};return {message:'Synthetic ordinary action'};}});
  h.el=id=>d.getElementById(id);h.render=()=>w.RunvaraConnections.render(h.data);h.render();
  h.open=()=>{h.view='channels';w.RunvaraConnections.open('shopify');};h.close=()=>h.el('connection-close').click();
  h.review=async()=>{h.el('order-recovery-review').click();await h.idle();};
  h.ack=()=>{h.el('order-recovery-ack').checked=true;h.el('order-recovery-ack').dispatchEvent(new w.Event('change',{bubbles:true}));};
  h.submit=()=>h.el('connection-order-recovery-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  h.reads=()=>calls.filter(c=>c.path===recoveryRoute);h.posts=()=>calls.filter(c=>c.path.startsWith(recoveryRoute+'/'));
  h.idle=()=>until(()=>!h.el('connection-order-recovery-form') || h.el('connection-order-recovery-form').getAttribute('aria-busy')==='false');
  h.poll=async()=>{const fn=[...timers.values()].find(timer=>timer.ms===15000)?.callback;assert.ok(fn);fn();await settle();};
  t.after(()=>{w.RunvaraConnections.endSession();w.close();assert.deepEqual(errors,[]);});return h;
}

test('capability advertisement/open/poll never reads recovery; inactive mode remains zero recovery I/O',async t=>{
  for(const available of [true,false]){const h=await harness(t,{available});assert.equal(h.calls.length,0);h.open();await h.poll();assert.equal(h.reads().length,0);assert.equal(h.posts().length,0);assert.equal(Boolean(h.el('connection-order-recovery')),available);}
});
for(const role of ['owner','admin'])test(role+' explicitly reviews original window and performs one consented resume',async t=>{
  const h=await harness(t,{role});h.open();h.submit();assert.equal(h.posts().length,0);await h.review();
  const panel=h.el('connection-order-recovery');assert.ok(panel.textContent.includes(originalStartedAt));assert.match(panel.textContent,/Fixed updated-order window:.*inclusive.*exclusive/s);assert.match(panel.textContent,/Last retained page:.*old/s);assert.match(panel.textContent,/snapshot consistency.*unverified/i);assert.match(panel.textContent,/customer records remain optional/i);
  assert.equal(h.el('order-recovery-ack').checked,false);assert.equal(h.el('order-recovery-resume').disabled,true);h.submit();assert.equal(h.posts().length,0);
  const pending=defer();h.post=()=>pending.promise;h.ack();h.submit();h.submit();assert.equal(h.posts().length,1);
  assert.deepEqual(JSON.parse(h.posts()[0].body),{selection:'synthetic-one-use-selection-0001'});assert.equal(h.posts()[0].method,'POST');assert.equal(h.posts()[0].isCurrent(),true);
  assert.doesNotMatch(panel.outerHTML,/synthetic-one-use-selection|stageId|PRIVATE_CURSOR|PRIVATE_BINDING|PRIVATE_CREDENTIAL|csrf-recovery/);
  pending.resolve(recoveryResult(h.data.workspace.id));await h.idle();assert.equal(h.reloads,1);assert.match(h.el('connection-order-observation').textContent,/earlier observation/);assert.match(h.el('connection-order-observation').textContent,/does not make the original observation newer/);assert.equal(h.posts().length,1);assert.equal(h.reads().length,1);
  assert.equal(h.el('connection-permissions').permissionMode?.value??h.el('connection-permissions').querySelector('select').value,'read_only');assert.match(h.el('connection-permissions').textContent,/Financial, destructive and customer-facing changes still need approval/);
});
test('start selection fixes the displayed original window before consent',async t=>{
  const h=await harness(t);h.preview=()=>recoveryPreview(h.data.workspace.id,{status:null});h.open();await h.review();assert.match(h.el('order-recovery-details').textContent,/No retained pages/);assert.ok(h.el('order-recovery-details').textContent.includes(originalStartedAt));h.ack();h.submit();await h.idle();assert.equal(h.posts()[0].path,recoveryRoute+'/start');
});
for(const role of ['member','viewer'])test(role+' cannot review through forged controls or submit',async t=>{
  const h=await harness(t,{role});h.open();assert.equal(h.el('connection-order-recovery'),null);const form=h.d.createElement('form');form.id='connection-order-recovery-form';form.innerHTML='<button id="order-recovery-review" type="button">Review</button>';h.el('connection-detail').append(form);form.querySelector('button').click();h.submit();await settle();assert.equal(h.reads().length,0);assert.equal(h.posts().length,0);
});
for(const status of ['paused','superseded','unknown','committed'])test(status+' cannot resume even if a malformed server selection claims otherwise',async t=>{
  const h=await harness(t);h.preview=()=>({...recoveryPreview(h.data.workspace.id,{status}),canResume:true});h.open();await h.review();h.ack();h.submit();assert.equal(h.posts().length,0);assert.match(h.el('order-recovery-status').textContent,/on hold/);
});
for(const [status,reason,pattern] of [['paused','ORDER_RECOVERY_PAUSED',/still use capacity.*cannot be resumed/],['superseded','ORDER_RECOVERY_SUPERSEDED',/still use capacity.*cannot be resumed/],['unknown','ORDER_RECOVERY_UNKNOWN',/unknown.*on hold/],['failed','ORDER_RECOVERY_CAPACITY_EXHAUSTED',/storage is full.*completion records/],['failed','ORDER_RECOVERY_AUTH_REFRESH_REQUIRED',/Refresh access or Reconnect.*identity can make retained pages ineligible/]])test(reason+' gives a safe clear hold',async t=>{
  const h=await harness(t);h.preview=()=>recoveryPreview(h.data.workspace.id,{status,reason,action:false});h.open();await h.review();assert.match(h.el('order-recovery-status').textContent,pattern);assert.equal(h.el('order-recovery-ack').disabled,true);assert.equal(h.el('connection-detail').querySelector('[data-connection-action="sync-selected"]').disabled,false);assert.equal(h.posts().length,0);
});
for(const drift of ['role','user','workspace','csrf','session csrf','session object','inactive','password','data role','data user','account','settings','disabled','duplicate','generation','bootstrap'])test(drift+' invalidates reviewed consent and rejects stale dispatch',async t=>{
  const h=await harness(t);h.open();await h.review();h.ack();
  if(drift==='role')h.session.user.role='viewer';if(drift==='user')h.session.user.id='other';if(drift==='workspace')h.session.workspace.id='other';if(drift==='csrf')h.csrf='other';if(drift==='session csrf')h.session.csrf='other';if(drift==='session object')h.session=copy(h.session);if(drift==='inactive')h.session.user.active=false;if(drift==='password')h.session.user.passwordChangeRequired=true;if(drift==='data role')h.data.user.role='admin';if(drift==='data user')h.data.user.id='other';if(drift==='account')h.data.connectionCentre[0].identity='changed.myshopify.com';if(drift==='settings')h.data.connectionCentre[0].settings.revision++;if(drift==='disabled')h.data.connectionCentre[0].orderRecovery.available=false;if(drift==='duplicate')h.data.connectionCentre.push(copy(h.data.connectionCentre[0]));if(drift==='generation')h.generation++;if(drift==='bootstrap')h.data=copy(h.data);
  h.submit();await settle();assert.equal(h.posts().length,0);assert.ok(!h.el('order-recovery-ack') || !h.el('order-recovery-ack').checked);
});
test('expired selections cannot dispatch, unchanged polling preserves acknowledgement without recovery I/O',async t=>{
  const h=await harness(t);const realNow=h.w.Date.now;let now=Date.now();h.w.Date.now=()=>now;h.open();await h.review();h.ack();await h.poll();assert.equal(h.el('order-recovery-ack').checked,true);assert.equal(h.reads().length,1);now+=301000;h.submit();await settle();assert.equal(h.posts().length,0);assert.equal(h.el('order-recovery-ack').checked,false);h.w.Date.now=realNow;
});
for(const action of ['cancel','close','escape','provider','navigation','back','forward','pagehide','hidden'])test('late preview after '+action+' never restores consent, focus or a dismissed review',async t=>{
  const h=await harness(t);h.open();const pending=defer();h.preview=()=>pending.promise;h.el('order-recovery-review').click();const signal=h.reads()[0].signal;
  if(action==='cancel')h.el('order-recovery-cancel').click();if(action==='close')h.close();if(action==='escape')h.el('connection-dialog').dispatchEvent(new h.w.Event('cancel',{cancelable:true}));if(action==='provider')h.w.RunvaraConnections.open('ebay');if(action==='navigation'){h.w.RunvaraConnections.interruptContent('Navigation changed');h.view='overview';}if(['back','forward'].includes(action))h.w.dispatchEvent(new h.w.PopStateEvent('popstate'));if(action==='pagehide')h.w.dispatchEvent(new h.w.Event('pagehide'));if(action==='hidden'){h.hidden=true;h.d.dispatchEvent(new h.w.Event('visibilitychange'));h.hidden=false;}
  assert.equal(signal.aborted,true);const focused=h.d.activeElement;pending.resolve(recoveryPreview(h.data.workspace.id));await settle();assert.equal(h.d.activeElement,focused);h.open();assert.equal(h.el('order-recovery-ack').checked,false);assert.equal(h.el('order-recovery-resume').classList.contains('hidden'),true);assert.equal(h.reads().length,1);assert.equal(h.posts().length,0);
});
test('cancel returns keyboard focus; Enter without checked consent never sends',async t=>{
  const h=await harness(t);h.open();await h.review();h.el('order-recovery-ack').focus();h.submit();assert.equal(h.posts().length,0);h.el('order-recovery-cancel').click();assert.equal(h.d.activeElement,h.el('order-recovery-review'));assert.equal(h.el('order-recovery-ack').checked,false);
});
for(const fault of ['lost','500','conflict','malformed','foreign','original changed','private extra','auth refresh'])test('sent '+fault+' remains held without retry or raw error leakage',async t=>{
  const h=await harness(t);h.open();await h.review();h.post=async()=>{if(['malformed','foreign','original changed','private extra'].includes(fault)){const r=recoveryResult(h.data.workspace.id);if(fault==='malformed')delete r.status;if(fault==='foreign')r.workspaceId='other';if(fault==='original changed')r.originalStartedAt='2026-10-09T10:00:00.000Z';if(fault==='private extra')r.binding='PRIVATE_BINDING';return r;}throw Object.assign(new Error('SECRET_PROVIDER_ERROR <img src=x onerror="window.injected=true">'),fault==='500'?{status:500}:fault==='conflict'?{status:409,code:'STATE_CONFLICT'}:fault==='auth refresh'?{status:409,code:'ORDER_RECOVERY_AUTH_REFRESH_REQUIRED'}:{});};
  h.ack();h.submit();await h.idle();h.submit();await settle();assert.equal(h.posts().length,1);assert.equal(h.reads().length,1);assert.equal(h.el('order-recovery-ack').checked,false);assert.doesNotMatch(h.el('connection-order-recovery').outerHTML,/SECRET_PROVIDER_ERROR|PRIVATE_BINDING|<img|selection-0001/);assert.equal(h.reloads,0);assert.match(h.el('order-recovery-status').textContent,fault==='auth refresh'?/Refresh access or Reconnect/:/unknown/);h.close();h.open();assert.equal(h.posts().length,1);assert.equal(h.reads().length,1);
});
test('late successful send after dismissal stays unknown and cannot unlock a new pending review',async t=>{
  const h=await harness(t);h.open();await h.review();const old=defer();h.post=()=>old.promise;h.ack();h.submit();h.close();assert.equal(h.posts()[0].signal.aborted,true);h.open();assert.match(h.el('order-recovery-status').textContent,/unknown/);const current=defer();h.preview=()=>current.promise;h.el('order-recovery-review').click();old.resolve(recoveryResult(h.data.workspace.id));await settle();assert.equal(h.el('connection-order-recovery-form').getAttribute('aria-busy'),'true');assert.equal(h.reloads,0);current.resolve(recoveryPreview(h.data.workspace.id,{status:'unknown',reason:'ORDER_RECOVERY_UNKNOWN',action:false}));await h.idle();assert.equal(h.posts().length,1);assert.equal(h.el('order-recovery-ack').disabled,true);
});
for(const action of ['escape','navigation','back','hidden','account change','session change','logout'])test('in-flight action interrupted by '+action+' never reloads or replays on late success',async t=>{
  const h=await harness(t);h.open();await h.review();const pending=defer();h.post=()=>pending.promise;h.ack();h.submit();
  if(action==='escape')h.el('connection-dialog').dispatchEvent(new h.w.Event('cancel',{cancelable:true}));if(action==='navigation'){h.w.RunvaraConnections.interruptContent('Navigation changed');h.view='overview';}if(action==='back')h.w.dispatchEvent(new h.w.PopStateEvent('popstate'));if(action==='hidden'){h.hidden=true;h.d.dispatchEvent(new h.w.Event('visibilitychange'));h.hidden=false;}if(action==='account change'){h.data.connectionCentre[0].identity='different.myshopify.com';h.render();}if(action==='session change'){h.session=copy(h.session);h.render();}if(action==='logout')h.w.RunvaraConnections.endSession();
  assert.equal(h.posts()[0].signal.aborted,true);pending.resolve(recoveryResult(h.data.workspace.id));await settle();assert.equal(h.reloads,0);assert.equal(h.posts().length,1);assert.equal(h.reads().length,1);assert.equal(h.notifications.length,0);
});
for(const fault of ['private fields','script time','wrong workspace','wrong bounds','wrong counts','expired','unknown status','malicious reason'])test('public preview rejects '+fault+' without exposing raw data',async t=>{
  const h=await harness(t);h.preview=()=>{const r=recoveryPreview(h.data.workspace.id);if(fault==='private fields')r.stage.cursor='PRIVATE_CURSOR_CANARY';if(fault==='script time')r.stage.lastCapturedAt='<img src=x onerror="window.injected=true">';if(fault==='wrong workspace')r.workspaceId='other';if(fault==='wrong bounds')r.window.requestedUpperBound='2026-10-02T10:00:00.000Z';if(fault==='wrong counts')r.stage.orderCount=501;if(fault==='expired')r.expiresAt='2000-01-01T00:00:00.000Z';if(fault==='unknown status')r.stage.status='complete_snapshot';if(fault==='malicious reason')r.reason='SECRET raw error';return r;};h.open();await h.review();h.ack();h.submit();assert.equal(h.posts().length,0);assert.doesNotMatch(h.el('connection-order-recovery').outerHTML,/PRIVATE_CURSOR_CANARY|SECRET raw error|<img|selection-0001/);assert.equal(h.w.injected,undefined);
});
test('saved earlier observation survives new UI session with recovery disabled and zero recovery reads',async t=>{
  const h=await harness(t,{available:false,observation:true});h.open();assert.equal(h.el('connection-order-recovery'),null);assert.ok(h.el('connection-order-observation').textContent.includes(originalStartedAt));assert.match(h.el('connection-order-observation').textContent,/earlier observation.*unverified/s);assert.equal(h.reads().length,0);assert.equal(h.posts().length,0);
});
test('unavailable saved provenance remains visibly unverified and never leaks malformed source fields',async t=>{
  const h=await harness(t,{available:false,observation:true});h.data.connectionCentre[0].orderRecoveryObservation.window.requestedLowerBound='PRIVATE_WINDOW_CANARY';h.render();h.open();assert.match(h.el('connection-order-observation').textContent,/details are unavailable.*unverified/);assert.doesNotMatch(h.el('connection-order-observation').outerHTML,/PRIVATE_WINDOW_CANARY/);assert.equal(h.reads().length,0);
});
