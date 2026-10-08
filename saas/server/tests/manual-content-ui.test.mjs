import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';

const POST='/api/connections/shopify/writes', GET='/api/connections/shopify/content-requests/';
const target=()=>({schema:'runvara-manual-content-target/v1',connectionId:'connection_exact_b',account:'exact-b.myshopify.com',settingsRevision:7});
const product='gid://shopify/Product/12345';
const copy=value=>structuredClone(value);
const defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until(check){for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Content UI did not settle');}
function channel(id='shopify'){return {id,name:id==='shopify'?'Shopify':'Other channel',identity:'display-a.myshopify.com',configured:true,status:'connected',oauthReady:true,areas:['products'],writes:['product_content','internal_note','product_tags_add','product_tags_remove'],settings:{revision:7,permissionMode:'approval_gated',areas:['products'],autoSync:false,frequencyMinutes:60},counts:{products:1},history:[],grantedScopes:[],writeAccessGranted:false,health:{status:'Healthy',message:'Synthetic'},contentPreparation:{available:true,target:target()}};}
async function harness(t,{role='owner'}={}){
  const errors=[],calls=[],notifications=[],timers=new Map(),console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(await fs.readFile(new URL('../../index.html',import.meta.url),'utf8'),{url:'http://127.0.0.1:18878',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console});
  const w=dom.window,d=w.document;
  Object.defineProperty(w,'crypto',{value:crypto.webcrypto});w.TextEncoder=TextEncoder;w.AbortController=AbortController;
  w.HTMLElement.prototype.scrollIntoView=()=>{};w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  let timer=1;w.setInterval=(callback,ms)=>{const id=timer++;timers.set(id,{callback,ms});return id;};w.clearInterval=id=>timers.delete(id);
  const user={id:'content-owner',role,active:true},workspace={id:'content-workspace'};
  const state={user,workspace,products:[{id:product,provider:'shopify',title:'Retained <img src=x onerror="window.injected=true"> product'}],connectionCentre:[channel(),channel('ebay')],connectionWrites:[],autopilot:{enabled:false}};
  const session={user:copy(user),workspace:copy(workspace),csrf:'csrf-content'};
  const h={w,d,calls,notifications,timers,data:state,session,csrf:'csrf-content',generation:1,view:'channels',hidden:false,records:new Map()};
  Object.defineProperty(d,'hidden',{configurable:true,get:()=>h.hidden});
  const context=()=>({session:h.session,csrf:h.csrf,sessionCsrf:h.session?.csrf,userId:h.session?.user.id,dataUserId:h.data.user.id,workspaceId:h.session?.workspace.id,dataWorkspaceId:h.data.workspace.id,role:h.session?.user.role,dataRole:h.data.user.role,active:h.session?.user.active,dataActive:h.data.user.active,passwordChangeRequired:h.session?.user.passwordChangeRequired,dataPasswordChangeRequired:h.data.user.passwordChangeRequired,generation:h.generation,bootstrap:h.data,view:h.view});
  h.response=body=>{const input={productId:body.productId,operation:'product_content',title:body.title.trim(),description:body.description};const write={id:'write_'+body.requestId,requestId:body.requestId,provider:'shopify',input,digest:crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'),connectionId:body.target.connectionId,account:body.target.account,requestedBy:h.session.user.id,status:'pending_approval',approvalId:'approval_'+body.requestId,requiresApproval:true};h.records.set(body.requestId,write);return {write};};
  h.post=async(_path,options)=>h.response(JSON.parse(options.body));
  h.read=async path=>{const requestId=path.slice(GET.length),row=h.records.get(requestId);const request=row?Object.fromEntries(['id','requestId','provider','input','digest','connectionId','account','requestedBy','status','approvalId'].map(key=>[key,row[key]])):null;return {schema:'runvara-manual-content-request/v1',workspaceId:h.data.workspace.id,requestId,requestedBy:h.session.user.id,found:Boolean(row),request};};
  h.centre=async()=>({channels:copy(h.data.connectionCentre),writes:[],autopilotEnabled:false});
  w.RunvaraUI={logo:()=>'',badge:()=>'',connectionMessage:()=>'',schedule:()=>''};
  w.eval(await fs.readFile(new URL('../../connections-ui.js',import.meta.url),'utf8'));
  const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  w.RunvaraConnections.init({getContentContext:context,request:async(path,options={})=>{calls.push({path,...options});if(path===POST)return h.post(path,options);if(path.startsWith(GET))return h.read(path,options);if(path==='/api/connection-centre')return h.centre(path,options);throw new Error('Unexpected fixture route '+path);},reload:async()=>{h.generation++;w.RunvaraConnections.render(h.data);},notify:(...args)=>notifications.push(args),setView:view=>{w.RunvaraConnections.interruptContent('Navigation changed');h.view=view;},escapeHtml:esc,date:String});
  w.RunvaraConnections.render(h.data);
  t.after(()=>{w.RunvaraConnections.endSession();w.close();assert.deepEqual(errors,[]);});
  h.el=id=>d.getElementById(id);h.open=()=>{h.view='channels';w.RunvaraConnections.open('shopify');};h.close=()=>h.el('connection-close').click();
  h.change=(id,value)=>{const node=h.el(id);if(node.type==='checkbox')node.checked=value;else node.value=value;node.dispatchEvent(new w.Event('change',{bubbles:true}));};
  h.fill=(title='  Exact proposed title  ',description='Exact description\nSecond line <b>literal</b>')=>{h.change('content-account',target().connectionId);h.change('content-product',product);h.change('content-title',title);h.change('content-description',description);h.change('content-ack',true);};
  h.submit=()=>h.el('connection-content-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  h.writes=()=>calls.filter(call=>call.path===POST);h.checks=()=>calls.filter(call=>call.path.startsWith(GET));h.id=()=>JSON.parse(h.writes()[0].body).requestId;
  h.idle=()=>until(()=>h.el('connection-content-form')?.getAttribute('aria-busy')==='false');
  h.poll=async()=>{const fn=[...timers.values()].find(timer=>timer.ms===15000)?.callback;assert.ok(fn);fn();await settle();};
  h.render=()=>w.RunvaraConnections.render(h.data);
  return h;
}

test('content uses exact target B independently of display A with empty choices and explicit review',async t=>{
 const h=await harness(t);assert.equal(h.calls.length,0);h.open();assert.equal(h.calls.length,0);
 assert.equal(h.el('content-account').value,'');assert.equal(h.el('content-product').value,'');assert.equal(h.el('content-ack').checked,false);assert.equal(h.el('connection-write-form'),null,'legacy A has no write access but exact content B is available');
 h.submit();await settle();assert.equal(h.writes().length,0);h.fill();h.change('content-title','Changed');assert.equal(h.el('content-ack').checked,false);h.submit();await settle();assert.equal(h.writes().length,0);
 h.fill();const pending=defer();h.post=()=>pending.promise;h.submit();h.submit();await until(()=>h.writes().length===1);
 const body=JSON.parse(h.writes()[0].body);assert.deepEqual(Object.keys(body).sort(),['operation','requestId','productId','title','description','target'].sort());assert.deepEqual(body.target,target());assert.equal(body.title,'Exact proposed title');assert.equal(body.description,'Exact description\nSecond line <b>literal</b>');
 assert.equal(h.el('content-title').disabled,true);assert.equal(h.el('content-ack').checked,true);pending.resolve(h.response(body));await h.idle();assert.match(h.el('content-status').textContent,/Exact request found/);assert.equal(h.writes().length,1);assert.equal(h.checks().length,0);assert.equal(h.notifications.length,0);
 assert.equal(h.el('content-exact').querySelector('b,img,script'),null);assert.ok(h.el('content-exact').textContent.includes('<b>literal</b>'));assert.equal(h.w.injected,undefined);
 assert.equal(h.calls.some(call=>/execute|approval|sync|oauth/.test(call.path)),false);
});

test('owner-only handlers reject forged submits and current-session identity/role drift',async t=>{
 for(const role of ['admin','member','viewer']){const h=await harness(t,{role});h.open();assert.equal(h.el('connection-content-form'),null);const form=h.d.createElement('form');form.id='connection-content-form';h.el('connection-detail').append(form);form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.equal(h.writes().length,0);}
 for(const drift of ['role','user','workspace','csrf','session','password']){const h=await harness(t);h.open();h.fill();if(drift==='role')h.session.user.role='admin';if(drift==='user')h.session.user.id='other';if(drift==='workspace')h.session.workspace.id='other';if(drift==='csrf')h.csrf='other';if(drift==='session')h.session=copy(h.session);if(drift==='password')h.session.user.passwordChangeRequired=true;h.submit();await settle();assert.equal(h.writes().length,0);assert.equal(h.el('content-title'),null);}
});

test('polling and explicit status refresh preserve draft nodes while changed targets stale acknowledgement',async t=>{
 const h=await harness(t);h.open();h.fill();const title=h.el('content-title');await h.poll();assert.equal(h.el('content-title'),title);assert.equal(title.value,'  Exact proposed title  ');assert.equal(h.el('content-ack').checked,true);
 h.el('connection-refresh').click();await settle();assert.equal(h.el('content-title'),title);assert.equal(title.value,'  Exact proposed title  ');
 h.data.connectionCentre[0].contentPreparation.target.settingsRevision++;await h.poll();assert.equal(h.el('content-ack').checked,false);assert.equal(h.el('content-prepare').disabled,true);assert.match(h.el('content-status').textContent,/changed/);h.submit();await settle();assert.equal(h.writes().length,0);
 h.el('content-reload').click();await h.idle();assert.equal(h.el('content-account').value,'');assert.equal(h.el('content-product').value,'');assert.equal(h.el('content-title').value,'');assert.equal(h.el('content-ack').checked,false);
});

test('lost response is reconciled by exact request even outside every top-N list, without another POST',async t=>{
 const h=await harness(t);h.open();h.fill();h.post=async(_path,options)=>{h.response(JSON.parse(options.body));throw Object.assign(new Error('Lost response'),{code:'REQUEST_UNAVAILABLE'});};h.submit();await until(()=>h.writes().length===1);await h.idle();assert.match(h.el('content-status').textContent,/outcome is unknown/);const id=h.id();
 h.close();h.open();assert.equal(h.el('content-title').value,'Exact proposed title');assert.ok(h.el('content-exact').textContent.includes(id));assert.equal(h.checks().length,0);h.el('content-check').click();h.el('content-check').click();await h.idle();
 assert.equal(h.checks().length,1);assert.equal(h.checks()[0].path,GET+id);assert.match(h.el('content-status').textContent,/Exact request found/);assert.equal(h.writes().length,1);
});

test('snapshot absence allows only deliberate same-ID same-intent retry, never a substituted visible intent',async t=>{
 const h=await harness(t);h.open();h.fill();h.post=async()=>{throw new Error('Disconnected');};h.submit();await until(()=>h.writes().length===1);await h.idle();const original=JSON.parse(h.writes()[0].body);
 h.el('content-check').click();await h.idle();assert.equal(h.checks().length,1);assert.equal(h.writes().length,1);assert.match(h.el('content-status').textContent,/earlier request could still commit/);assert.equal(h.el('content-ack').checked,false);h.el('content-retry').click();await settle();assert.equal(h.writes().length,1);
 h.el('content-title').value='Silently replaced';h.change('content-ack',true);h.el('content-retry').click();await settle();assert.equal(h.writes().length,1);assert.equal(h.el('content-ack').checked,false);
 h.close();h.open();assert.equal(h.el('content-title').value,original.title);h.el('content-check').click();await h.idle();h.change('content-ack',true);h.post=async(_path,options)=>h.response(JSON.parse(options.body));h.el('content-retry').click();await until(()=>h.writes().length===2);await h.idle();assert.deepEqual(JSON.parse(h.writes()[1].body),original);
});

for(const fault of ['foreign workspace','other requester','wrong request ID','wrong digest','wrong input','wrong account','extra fields','missing fields'])test('exact reconciliation rejects '+fault,async t=>{
 const h=await harness(t);h.open();h.fill();h.post=async(_path,options)=>{h.response(JSON.parse(options.body));throw new Error('Lost');};h.submit();await until(()=>h.writes().length===1);await h.idle();const valid=h.read;
 h.read=async path=>{const r=await valid(path);if(fault==='foreign workspace')r.workspaceId='other';if(fault==='other requester')r.requestedBy='other';if(fault==='wrong request ID')r.requestId='other';if(fault==='wrong digest')r.request.digest='0'.repeat(64);if(fault==='wrong input')r.request.input.title='other';if(fault==='wrong account')r.request.account='other.myshopify.com';if(fault==='extra fields')r.request.extra='not allowed';if(fault==='missing fields')delete r.request.approvalId;return r;};h.el('content-check').click();await h.idle();assert.match(h.el('content-status').textContent,/unknown/);assert.equal(h.el('content-retry').classList.contains('hidden'),true);assert.equal(h.writes().length,1);
});

for(const action of ['close','escape','provider','navigation','hidden','bootstrap'])test('late POST after '+action+' stays unknown and cannot restore a dismissed/current draft',async t=>{
 const h=await harness(t);h.open();h.fill();const pending=defer();h.post=()=>pending.promise;h.submit();await until(()=>h.writes().length===1);const body=JSON.parse(h.writes()[0].body),signal=h.writes()[0].signal;
 if(action==='close')h.close();if(action==='escape'){h.el('connection-dialog').dispatchEvent(new h.w.Event('cancel',{cancelable:true}));}if(action==='provider')h.w.RunvaraConnections.open('ebay');if(action==='navigation'){h.w.RunvaraConnections.interruptContent('Navigation changed');h.view='overview';}if(action==='hidden'){h.hidden=true;h.d.dispatchEvent(new h.w.Event('visibilitychange'));h.hidden=false;h.d.dispatchEvent(new h.w.Event('visibilitychange'));}if(action==='bootstrap'){h.w.RunvaraConnections.interruptContent('Workspace refresh started');h.generation++;h.data={...h.data};h.render();}
 assert.equal(signal.aborted,true);pending.resolve(h.response(body));await settle();assert.equal(h.notifications.length,0);h.open();assert.match(h.el('content-status').textContent,/unknown/);assert.equal(h.checks().length,0);assert.equal(h.writes().length,1);assert.ok(h.el('content-exact').textContent.includes(body.requestId));
});

for(const action of ['logout','new session','role loss','password'])test(action+' clears private content and late reads cannot cross into a new owner context',async t=>{
 const h=await harness(t);h.open();h.fill();h.post=async()=>{throw new Error('Lost');};h.submit();await until(()=>h.writes().length===1);await h.idle();const pending=defer();h.read=()=>pending.promise;h.el('content-check').click();
 if(action==='logout')h.w.RunvaraConnections.endSession();if(action==='new session'){h.session=copy(h.session);h.render();}if(action==='role loss'){h.session.user.role='admin';h.data.user.role='admin';h.render();}if(action==='password')h.w.RunvaraConnections.interruptContent('Password change started',true);
 pending.resolve({schema:'runvara-manual-content-request/v1',workspaceId:'wrong',requestId:'wrong',requestedBy:'wrong',found:false,request:null});await settle();assert.ok(!h.el('content-title') || h.el('content-title').value==='');assert.equal(h.notifications.length,0);assert.equal(h.writes().length,1);
});

test('changed target after absence never rebinds a retained attempt; malformed POST success remains unknown',async t=>{
 const h=await harness(t);h.open();h.fill();h.post=async()=>({write:{id:'write_wrong'}});h.submit();await until(()=>h.writes().length===1);await h.idle();const original=h.id();h.data.connectionCentre[0].contentPreparation.target.connectionId='replacement';h.el('content-check').click();await h.idle();assert.equal(h.el('content-retry').classList.contains('hidden'),true);assert.ok(h.el('content-exact').textContent.includes(target().connectionId));assert.ok(h.el('content-exact').textContent.includes(original));assert.equal(h.writes().length,1);
});

test('definitive refusal permits explicit reload and fresh review; a resolved saved intent cannot get a new duplicate ID',async t=>{
 const h=await harness(t);h.open();h.fill();h.post=async()=>{throw Object.assign(new Error('Target changed'),{status:409,code:'WRITE_TARGET_CHANGED'});};h.submit();await until(()=>h.writes().length===1);await h.idle();const id=h.id();assert.match(h.el('content-status').textContent,/refused/);h.el('content-reload').click();await h.idle();h.fill();h.post=async(_path,options)=>h.response(JSON.parse(options.body));h.submit();await until(()=>h.writes().length===2);await h.idle();assert.equal(JSON.parse(h.writes()[1].body).requestId,id);
 h.el('content-new').click();await h.idle();h.fill();h.submit();await settle();assert.equal(h.writes().length,2);assert.match(h.el('content-error').textContent,/already prepared/);
});

test('executing is exact saved history and never a new apply permission',async t=>{
 const h=await harness(t);h.open();h.fill();h.post=async(_path,options)=>{const result=h.response(JSON.parse(options.body));result.write.status='executing';throw new Error('Lost');};h.submit();await until(()=>h.writes().length===1);await h.idle();h.el('content-check').click();await h.idle();assert.match(h.el('content-status').textContent,/Exact request found.*executing.*not permission to apply/);assert.equal(h.writes().length,1);assert.equal(h.el('connection-content-editor').querySelector('[data-connection-action=execute]'),null);
});

test('a dismissed old response cannot unlock a newer exact reconciliation or trigger new work',async t=>{
 const h=await harness(t);h.open();h.fill();const old=defer();h.post=()=>old.promise;h.submit();await until(()=>h.writes().length===1);h.close();h.open();const check=defer();h.read=()=>check.promise;h.el('content-check').click();old.reject(Object.assign(new Error('Late auth'),{status:401,code:'AUTH_REQUIRED'}));await settle();assert.equal(h.el('connection-content-form').getAttribute('aria-busy'),'true');assert.equal(h.el('content-check').disabled,true);assert.equal(h.writes().length,1);assert.equal(h.checks().length,1);
 const id=h.id();check.resolve({schema:'runvara-manual-content-request/v1',workspaceId:h.data.workspace.id,requestId:id,requestedBy:h.session.user.id,found:false,request:null});await h.idle();assert.equal(h.el('content-ack').checked,false);
});

test('same-session failed password attempts retain the frozen unknown request',async t=>{
 const h=await harness(t);h.open();h.fill();h.post=async()=>{throw new Error('Lost');};h.submit();await until(()=>h.writes().length===1);await h.idle();const id=h.id();
 h.w.RunvaraConnections.interruptContent('Password change started');h.close();h.open();assert.match(h.el('content-status').textContent,/unknown/);assert.ok(h.el('content-exact').textContent.includes(id));h.submit();await settle();assert.equal(h.writes().length,1);
});

for(const code of ['WRITE_NOT_AUTHORISED','OWNER_APPROVAL_REQUIRED'])test('same-session permission refusal '+code+' cannot discard an unknown request',async t=>{
 const h=await harness(t);h.open();h.fill();h.post=async()=>{throw new Error('Lost');};h.submit();await until(()=>h.writes().length===1);await h.idle();const original=JSON.parse(h.writes()[0].body);h.el('content-check').click();await h.idle();h.change('content-ack',true);h.post=async()=>{throw Object.assign(new Error('Permission changed'),{status:403,code});};h.el('content-retry').click();await until(()=>h.writes().length===2);await h.idle();assert.match(h.el('content-status').textContent,/unknown/);assert.ok(h.el('content-exact').textContent.includes(original.requestId));assert.deepEqual(JSON.parse(h.writes()[1].body),original);h.close();h.open();h.submit();await settle();assert.equal(h.writes().length,2);assert.ok(h.el('content-exact').textContent.includes(original.requestId));
});

for(const code of ['STATE_CONFLICT','REQUEST_UNAVAILABLE','INTERNAL_ERROR'])test(code+' retains one frozen request without an automatic retry',async t=>{
 const h=await harness(t);h.open();h.fill();h.post=async()=>{throw Object.assign(new Error(code),{code,status:code==='STATE_CONFLICT'?409:500});};h.submit();await until(()=>h.writes().length===1);await h.idle();h.submit();await settle();assert.equal(h.writes().length,1);assert.match(h.el('content-status').textContent,/unknown/);assert.equal(h.checks().length,0);
});

test('unavailable/malformed targets and duplicate or foreign products cannot be implicitly selected',async t=>{
 for(const change of [data=>{data.connectionCentre[0].contentPreparation={available:false,code:'WRITE_TARGET_UNAVAILABLE',message:'No unique target'};},data=>{data.connectionCentre[0].contentPreparation.target.account='https://bad.myshopify.com';},data=>{data.connectionCentre[0].contentPreparation.target.settingsRevision=-1;},data=>{data.connectionCentre.push(copy(data.connectionCentre[0]));}]){
  const h=await harness(t);change(h.data);h.render();h.open();assert.equal(h.el('content-account').options.length,1);assert.equal(h.el('content-account').value,'');h.fill();h.submit();await settle();assert.equal(h.writes().length,0);
 }
 const h=await harness(t);h.data.products.push(copy(h.data.products[0]),{id:'gid://shopify/Product/99',provider:'shopify',title:'Foreign',workspace:'other'});h.render();h.open();assert.equal(h.el('content-product').options.length,1);assert.equal(h.writes().length,0);
});

test('saved content review cards keep target B visible beneath legacy channel label A',async t=>{
 const h=await harness(t);const body={operation:'product_content',requestId:'history-content-reference-1234',productId:product,title:'Saved exact content',description:'Reviewed text',target:target()};h.data.connectionWrites=[h.response(body).write];h.render();h.open();const card=h.d.querySelector('.connection-write');assert.match(card.textContent,/Saved Shopify account/);assert.ok(card.textContent.includes(target().account));assert.ok(card.textContent.includes(target().connectionId));assert.ok(h.el('connection-detail').textContent.includes('display-a.myshopify.com'));assert.equal(h.calls.length,0);
});
