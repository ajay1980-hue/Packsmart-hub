// Independent real app.js + connections-ui.js checks. All transports are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { publicConnectionWrite } from '../lib/action-display.mjs';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, encryptCredentials } from '../lib/security.mjs';
const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const POST = '/api/connections/shopify/writes', GET = '/api/connections/shopify/content-requests/';
const PRODUCT = 'gid://shopify/Product/10';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await pause(); } assert.fail('Independent full-app harness did not settle'); }
async function harness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'independent-content-app-'));
  const secret = 'synthetic-independent-content-app-more-than-thirty-two-characters';
  const server = createPacksmartServer({ NODE_ENV:'test', SESSION_SECRET:secret, CREDENTIALS_KEY:secret, SAAS_STATE_FILE:path.join(directory,'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED:'false' }, { fetchImpl:() => assert.fail('Provider transport forbidden') });
  const state = seedWorkspaceState({}, { workspaceId:'independent-app', userId:'review-owner', email:'app-review@example.test', passwordHash:'synthetic' });
  state.products = [{ id:PRODUCT, provider:'shopify', title:'Original title', variants:[] }];
  state.connections = [{ id:'review-exact', provider:'shopify', encryptedCredentials:encryptCredentials({ storeDomain:'review.myshopify.com', mode:'oauth', accessToken:'synthetic-token' },secret), metadata:{ shopDomain:'review.myshopify.com', grantedScopes:['read_products','write_products'] } }];
  state.connectionSettings = { shopify:{ permissionMode:'approval_gated', revision:7 } };
  await server.packsmart.store.save(state.workspace.id,state);
  const token = createSessionToken({ userId:state.users[0].id, workspaceId:state.workspace.id, email:state.users[0].email, role:'owner', sessionVersion:1 },secret);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base+'/api/bootstrap',{ headers:{Cookie:`packsmart_session=${token}`} });
  assert.equal(response.status,200); const bootstrap = await response.json();
  await new Promise(resolve => server.close(resolve)); await server.packsmart.drain();
  const errors=[], calls=[], vc=new VirtualConsole(); vc.on('jsdomError',error=>errors.push(error.message));
  const dom = new JSDOM(await fs.readFile(ROOT+'/index.html','utf8'),{url:base,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const w=dom.window,d=w.document,h={w,d,calls,bootstrap,errors,records:new Map()};
  w.Headers=Headers; w.AbortController=AbortController; w.TextEncoder=TextEncoder; Object.defineProperty(w,'crypto',{value:crypto.webcrypto});
  w.scrollTo=()=>{}; w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;}; w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  const session=()=>({user:structuredClone(bootstrap.user),workspace:structuredClone(bootstrap.workspace),csrf:bootstrap.csrf});
  h.record=body=>{
    const input={productId:body.productId,operation:'product_content',title:body.title.trim(),description:body.description};
    const row={id:'write_'+body.requestId,requestId:body.requestId,provider:'shopify',input,digest:crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'),connectionId:body.target.connectionId,account:body.target.account,requestedBy:bootstrap.user.id,status:'pending_approval',approvalId:'approval_'+body.requestId,requiresApproval:true};h.records.set(body.requestId,row);return row;
  };
  h.post=async(_path,options)=>Response.json({write:publicConnectionWrite(h.record(JSON.parse(options.body)))});
  h.read=async route=>{const requestId=route.slice(GET.length),row=h.records.get(requestId);return Response.json({schema:'runvara-manual-content-request/v1',workspaceId:bootstrap.workspace.id,requestId,requestedBy:bootstrap.user.id,found:Boolean(row),request:row?Object.fromEntries(['id','requestId','provider','input','digest','connectionId','account','requestedBy','status','approvalId'].map(key=>[key,row[key]])):null});};
  h.password=async()=>Response.json({error:'Synthetic wrong current password',code:'PASSWORD_INVALID'},{status:400});
  w.fetch=async(route,options={})=>{calls.push({route,...options});if(route===POST)return h.post(route,options);if(route.startsWith(GET))return h.read(route,options);if(route==='/api/auth/change-password')return h.password(route,options);if(route==='/api/bootstrap')return Response.json(bootstrap);if(route==='/api/auth/session'||route==='/api/auth/login')return Response.json(session());if(route==='/api/auth/logout')return Response.json({ok:true});if(route==='/api/auth/signup-options')return Response.json({enabled:false});if(route==='/api/connection-centre')return Response.json({channels:bootstrap.connectionCentre,writes:[],autopilotEnabled:false});throw new Error('Unexpected synthetic route '+route);};
  for(const file of ['presentation.js','control-ui.js','connections-ui.js'])w.eval(await fs.readFile(ROOT+'/'+file,'utf8'));
  const init=w.RunvaraControl.init;w.RunvaraControl.init=api=>{h.controls=api;init(api);};
  w.eval(await fs.readFile(ROOT+'/app.js','utf8'));
  await until(()=>!d.getElementById('app-shell').classList.contains('hidden'));
  h.el=id=>d.getElementById(id); h.open=()=>{h.controls.setView('channels');w.RunvaraConnections.open('shopify');};
  h.change=(id,value)=>{const element=h.el(id);if(element.type==='checkbox')element.checked=value;else element.value=value;element.dispatchEvent(new w.Event('change',{bubbles:true}));};
  h.fill=()=>{h.change('content-account','review-exact');h.change('content-product',PRODUCT);h.change('content-title','Reviewed exact title');h.change('content-description','Reviewed exact description\nTwo');h.change('content-ack',true);};
  h.submit=()=>h.el('connection-content-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  h.writes=()=>calls.filter(call=>call.route===POST);h.checks=()=>calls.filter(call=>call.route.startsWith(GET));
  h.idle=()=>until(()=>h.el('connection-content-form')?.getAttribute('aria-busy')==='false');
  h.passwordSubmit=()=>{const form=h.el('account-password-form');for(const name of ['currentPassword','newPassword']){if(!Object.hasOwn(form,name))Object.defineProperty(form,name,{value:form.elements[name]});form.elements[name].value='synthetic-password';}form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));};
  t.after(async()=>{w.RunvaraConnections.endSession();w.close();await fs.rm(directory,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  return h;
}
test('real app lifecycle: failed password change preserves unknown request and successful change clears private content',async t=>{
 const h=await harness(t);h.open();h.fill();h.post=async(_route,options)=>{h.record(JSON.parse(options.body));throw new Error('Synthetic lost POST response');};h.submit();await until(()=>h.writes().length===1);await h.idle();const requestId=JSON.parse(h.writes()[0].body).requestId;
 const invalidForm=h.el('account-password-form');invalidForm.elements.currentPassword.value='';invalidForm.elements.newPassword.value='';assert.equal(invalidForm.checkValidity(),false);invalidForm.requestSubmit();await pause();assert.equal(h.calls.filter(call=>call.route==='/api/auth/change-password').length,0,'native invalid form validation sends no request');assert.ok(h.el('content-exact').textContent.includes(requestId));
 h.passwordSubmit();await until(()=>h.el('account-password-form').querySelector('.form-error').textContent.includes('Synthetic wrong'));
 h.el('connection-close').click();h.open();assert.ok(h.el('content-exact').textContent.includes(requestId));assert.match(h.el('content-status').textContent,/unknown/);assert.equal(h.writes().length,1);
 h.el('content-check').click();await h.idle();assert.match(h.el('content-status').textContent,/Exact request found/);assert.equal(h.checks().length,1);assert.equal(h.writes().length,1);
 h.password=async()=>Response.json({csrf:'replacement-csrf'});h.passwordSubmit();await until(()=>h.el('global-success').textContent.includes('Password updated'));assert.equal(h.el('content-title'),null);
});
test('real app lifecycle: a dismissed POST returning 401 cannot sign out replacement session',async t=>{
 const h=await harness(t);h.open();h.fill();const pending=deferred();h.post=()=>pending.promise;h.submit();await until(()=>h.writes().length===1);h.el('connection-close').click();
 const login=h.el('login-form');for(const name of ['email','password'])if(!Object.hasOwn(login,name))Object.defineProperty(login,name,{value:login.elements[name]});login.elements.email.value='app-review@example.test';login.elements.password.value='synthetic';login.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>h.calls.filter(call=>call.route==='/api/bootstrap').length===2);await pause();
 pending.resolve(Response.json({error:'Previous session expired',code:'SESSION_INVALID'},{status:401}));await pause();await pause();assert.equal(h.el('app-shell').classList.contains('hidden'),false);assert.equal(h.el('login-screen').classList.contains('hidden'),true);assert.equal(h.writes().length,1);h.open();assert.equal(h.el('content-title').value,'');assert.equal(h.el('content-account').value,'');assert.equal(h.el('content-product').value,'');assert.equal(h.el('content-description').value,'');assert.equal(h.el('content-ack').checked,false);assert.equal(h.el('content-exact').textContent.includes(JSON.parse(h.writes()[0].body).requestId),false);assert.equal(h.el('content-exact').textContent.includes('Reviewed exact'),false);
});
test('real app lifecycle: exact executing request is recognized after response loss',async t=>{
 const h=await harness(t);h.open();h.fill();h.post=async(_route,options)=>{h.record(JSON.parse(options.body)).status='executing';throw new Error('Synthetic loss');};h.submit();await until(()=>h.writes().length===1);await h.idle();h.el('content-check').click();await h.idle();assert.match(h.el('content-status').textContent,/Exact request found.*executing/);assert.equal(h.writes().length,1);assert.equal(h.calls.some(call=>/\/execute$/.test(call.route)),false);
});
