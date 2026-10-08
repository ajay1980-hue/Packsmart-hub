// Real app.js and HTML. Browser-facing transport uses isolated synthetic rows;
// production bridge API/dispatch tests cover the separate trusted source checks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { upsertBusinessObjective, businessObjectivesSnapshot } from '../lib/business-objectives.mjs';
import { buildObjectiveReview } from '../lib/objective-review.mjs';
import { detectOpportunities } from '../lib/control.mjs';
export const POST='/api/objective-content/requests', CONTEXT='/api/objective-content/context?', REVIEW='/api/business-objectives/reviews';
export const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {resolve,reject,promise};};
export const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
export async function until(check,detail=()=> '') {for(let i=0;i<250;i++){if(check())return;await pause();}assert.fail('Objective content UI did not settle: '+detail());}
export async function objectiveContentHarness(t,{role='owner',enforce=true,issue='Thin product title',realBackend=false}={}) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'objective-content-ui-')), secret='objective-content-fixture-only-over-thirty-two-characters';
 let providerRequests=0;
 const server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,CREDENTIALS_KEY:secret,SAAS_STATE_FILE:path.join(directory,'state.json'),SHOPIFY_PUBLIC_SYNC_ENABLED:'false'},{schedulerEnabled:false,agentOpsEnabled:false,fetchImpl:()=>{providerRequests++;assert.fail('Provider transport forbidden');}});
 const state=seedWorkspaceState({}, {workspaceId:'objective-content-ui',userId:'content-owner',name:'Synthetic goal request workspace',email:'objective-content@example.test',passwordHash:'synthetic'});
 state.settings={...state.settings,growthCapacityHours:4,maxConcurrentGrowthExperiments:2};
 state.products=[{id:'gid://shopify/Product/10',provider:'shopify',title:'Box',description:'',status:'active',variants:[]}];
 state.connections=[{id:'exact-shop',provider:'shopify',encryptedCredentials:'synthetic-opaque-marker',metadata:{shopDomain:'exact.myshopify.com',grantedScopes:['read_products','write_products']}}];
 state.connectionSettings={shopify:{permissionMode:'approval_gated',revision:7}};state.opportunities=[];state.approvals=[];state.decisions=[];state.exceptions=[];state.connectionWrites=[];
 detectOpportunities(state);for(const row of state.opportunities){row.executionCost=0;row.effortHours=1;}
 const now=new Date().toISOString();
 const objective=upsertBusinessObjective(state,{title:'Improve recorded contribution',metric:'contribution_profit',baseline:null,target:100,direction:'increase',startsAt:new Date(Date.now()-86400000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),
 limits:{currency:'GBP',profitFirst:true,minGrossMarginPercent:0,maxMonthlyAdBudget:0,minStockCoverDays:0},...(enforce?{executionPolicy:{schema:'runvara-objective-execution-policy/v1',mode:'enforce',scope:{provider:'shopify',operation:'product_content',connectionId:'exact-shop',account:'exact.myshopify.com'}}}:{})},{workspaceId:state.workspace.id,actorId:state.users[0].id,now});
 let report=buildObjectiveReview(state,{objectiveId:objective.id,objectiveRevision:objective.revision,jobId:'job_content_ui'},{workspaceId:state.workspace.id,now});
 const candidate=state.opportunities.find(row=>row.evidence.some(item=>item.type==='product'&&item.detail===issue));assert.ok(candidate,'canonical fixture issue exists');
 assert.ok(report.proposals.some(row=>row.opportunityId===candidate.id));
 await server.packsmart.store.save(state.workspace.id,state);server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const token=createSessionToken({userId:state.users[0].id,workspaceId:state.workspace.id,email:state.users[0].email,role:'owner',sessionVersion:1},secret);
 const response=await fetch(base+'/api/bootstrap',{headers:{Cookie:`packsmart_session=${token}`}});assert.equal(response.status,200);const bootstrap=await response.json();bootstrap.user.role=role;bootstrap.opportunities=state.opportunities;
 const realRequest=(route,options={})=>{const headers=new Headers(options.headers);headers.set('Cookie',`packsmart_session=${token}`);headers.set('X-CSRF-Token',verifySessionToken(token,secret).csrf);if(options.body)headers.set('Content-Type','application/json');return fetch(base+route,{...options,headers});};
 if(realBackend){const queued=await realRequest(REVIEW,{method:'POST',body:JSON.stringify({objectiveId:objective.id,objectiveRevision:objective.revision})});assert.equal(queued.status,202);const {job}=await queued.json();await server.packsmart.agentOps.tick();const result=await realRequest(REVIEW+'/'+job.id+'?report=true');assert.equal(result.status,200);report=(await result.json()).report;assert.ok(report);}
 else {await new Promise(resolve=>server.close(resolve));await server.packsmart.drain();}
 const vc=new VirtualConsole(),errors=[],calls=[];vc.on('jsdomError',error=>errors.push(error.message));
 const dom=new JSDOM(await fs.readFile(new URL('../../index.html',import.meta.url),'utf8'),{url:base,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});const w=dom.window,d=w.document;
 const h={w,d,calls,errors,bootstrap,state,objective,report,candidate,server,realRequest,hidden:false,records:new Map(),snapshot:businessObjectivesSnapshot(state,{workspaceId:state.workspace.id,now})};
 Object.defineProperty(d,'hidden',{get:()=>h.hidden});w.Headers=Headers;w.AbortController=AbortController;w.TextEncoder=TextEncoder;Object.defineProperty(w,'crypto',{value:crypto.webcrypto});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 const job={id:report.jobId,type:'objective_prepare',status:'succeeded',objectiveId:objective.id,objectiveRevision:objective.revision,attempts:1,maxAttempts:3,reportAvailable:true,completedAt:now};
 h.context={schema:'runvara-objective-content-context/v1',workspaceId:state.workspace.id,requestedBy:state.users[0].id,
 source:{schema:'runvara-objective-content-source/v1',objectiveId:objective.id,objectiveRevision:objective.revision,objectiveDigest:'1'.repeat(64),jobId:job.id,reportId:report.id,payloadDigest:'2'.repeat(64),resultDigest:'3'.repeat(64),jobIdentityDigest:'4'.repeat(64),actorId:state.users[0].id,actorSessionVersion:1,inputFingerprint:'5'.repeat(32),opportunityId:candidate.id,opportunityDigest:'6'.repeat(64),productId:state.products[0].id,productDigest:'7'.repeat(64),approvalSourceDigest:'9'.repeat(64)},
 sourceRevision:'8'.repeat(64),target:{schema:'runvara-manual-content-target/v1',connectionId:'exact-shop',account:'exact.myshopify.com',settingsRevision:7},objective:{id:objective.id,revision:objective.revision,title:objective.title},candidate:{opportunityId:candidate.id,issue},product:{id:state.products[0].id,title:'Box',description:'',provenance:'unverified'},policy:{allowed:false,blockers:[{code:'FINANCIAL_EVIDENCE_REQUIRED',message:'Profit-first and saved zero financial/stock conditions lack qualified evidence.'}]},notice:'Owner-requested content only; no verified goal benefit.'};
 h.context.sourceRevision=crypto.createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(h.context.source).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
 h.save=body=>{const input={productId:body.productId,operation:'product_content',title:body.title.trim(),description:body.description};const row={id:'write_'+body.requestId,requestId:body.requestId,provider:'shopify',input,digest:crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'),connectionId:body.target.connectionId,account:body.target.account,requestedBy:state.users[0].id,status:'pending_approval',approvalId:'approval_'+body.requestId,source:structuredClone(h.context.source),origin:'owner_objective_content'};h.records.set(body.requestId,row);return row;};
 h.history=(requestId,sourceStatus={status:'current'})=>{const row=h.records.get(requestId);return {schema:'runvara-objective-content-request/v1',workspaceId:state.workspace.id,requestId,requestedBy:state.users[0].id,found:Boolean(row),request:row||null,sourceStatus:row?sourceStatus:null};};
 h.readContext=async()=>Response.json(h.context);h.post=async(_route,options)=>{const body=JSON.parse(options.body);h.save(body);return Response.json(h.history(body.requestId));};h.read=async route=>Response.json(h.history(route.slice(POST.length+1)));
 if(realBackend){const contextResponse=await realRequest(CONTEXT+'jobId='+report.jobId+'&opportunityId='+candidate.id);assert.equal(contextResponse.status,200,JSON.stringify(await contextResponse.clone().json()));h.context=await contextResponse.json();h.readContext=realRequest;h.post=realRequest;h.read=realRequest;}
 h.password=async()=>Response.json({error:'Synthetic wrong password',code:'PASSWORD_INVALID'},{status:400});
 w.fetch=async(route,options={})=>{calls.push({route,method:options.method||'GET',...options});if(route.startsWith(CONTEXT))return h.readContext(route,options);if(route===POST)return h.post(route,options);if(route.startsWith(POST+'/'))return h.read(route,options);
 if(route.startsWith(REVIEW))return Response.json({job,stale:false,staleReason:null,...(route.includes('?report=true')?{report:h.report}:{})});
 if(route==='/api/business-objectives'){const data=structuredClone(h.snapshot);h.currentSnapshot=data;return {ok:true,status:200,json:async()=>data};}
 if(route==='/api/auth/session'||route==='/api/auth/login'){h.session=structuredClone({user:bootstrap.user,workspace:bootstrap.workspace,csrf:bootstrap.csrf});return {ok:true,status:200,json:async()=>h.session};}
 if(route==='/api/bootstrap'){if(h.bootstrapRead)return h.bootstrapRead(route,options);h.currentBootstrap=structuredClone(bootstrap);return {ok:true,status:200,json:async()=>h.currentBootstrap};}
 if(route==='/api/auth/logout')return Response.json({ok:true});if(route==='/api/auth/signup-options')return Response.json({enabled:false});if(route==='/api/auth/change-password')return h.password(route,options);
 throw new Error('Unexpected synthetic route '+route);};
 for(const file of ['presentation.js','control-ui.js','connections-ui.js'])w.eval(await fs.readFile(new URL('../../'+file,import.meta.url),'utf8'));
 const init=w.RunvaraControl.init;w.RunvaraControl.init=api=>{h.controls=api;init(api);};w.eval(await fs.readFile(new URL('../../app.js',import.meta.url),'utf8'));await until(()=>!d.querySelector('#app-shell').classList.contains('hidden'));
 h.el=id=>d.getElementById(id);h.form=h.el('objective-content-form');h.panel=h.el('objective-content-editor');h.details=d.querySelector('.business-objectives-panel');h.elc=id=>h.el('objective-content-'+id);
 h.change=(id,value)=>{const element=h.elc(id);if(element.type==='checkbox')element.checked=value;else element.value=value;element.dispatchEvent(new w.Event('change',{bubbles:true}));};
 h.fill=()=>{h.change('account',h.context.target.connectionId);h.change('product',h.context.product.id);h.change('title','Exact reviewed title');h.change('description','Exact description\nSecond line');h.change('ack',true);};
 h.submit=()=>h.form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));h.writes=()=>calls.filter(call=>call.route===POST);h.checks=()=>calls.filter(call=>call.route.startsWith(POST+'/'));h.contextReads=()=>calls.filter(call=>call.route.startsWith(CONTEXT));h.idle=()=>until(()=>h.form.getAttribute('aria-busy')==='false',()=>h.elc('status').textContent+' '+h.elc('error').textContent);
 h.review=async()=>{h.controls.setView('ai-team');h.details.open=true;h.el('load-business-objectives').click();await until(()=>!h.el('load-business-objectives').disabled);d.querySelector('[data-prepare-objective-review]')?.click();await until(()=>d.querySelector('#business-objective-review-result').textContent.length>0);};
 h.open=async()=>{await h.review();h.button=d.querySelector(`[data-request-objective-content="${candidate.id}"]`);h.button?.click();await h.idle();};
 h.login=async()=>{const form=h.el('login-form');for(const name of ['email','password'])if(!Object.hasOwn(form,name))Object.defineProperty(form,name,{value:form.elements[name]});form.elements.email.value='objective-content@example.test';form.elements.password.value='synthetic';const before=calls.filter(call=>call.route==='/api/bootstrap').length;form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await until(()=>calls.filter(call=>call.route==='/api/bootstrap').length>before);await pause();};
 h.passwordSubmit=()=>{const form=h.el('account-password-form');for(const name of ['currentPassword','newPassword']){if(!Object.hasOwn(form,name))Object.defineProperty(form,name,{value:form.elements[name]});form.elements[name].value='synthetic-password';}form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));};
 t.after(async()=>{w.RunvaraConnections.endSession();w.close();if(server.listening){await new Promise(resolve=>server.close(resolve));await server.packsmart.drain();}await fs.rm(directory,{recursive:true,force:true});assert.deepEqual(errors,[]);assert.equal(providerRequests,0);assert.equal(calls.some(call=>/\/execute$|\/approvals|\/connection-centre|\/ai\//.test(call.route)),false,'no implicit provider, approval, apply, model or polling Connection Centre requests');});return h;
}
