import test from 'node:test';
import assert from 'node:assert/strict';
import {objectiveContentHarness as harness,deferred,pause,until,POST} from './objective-content-ui-fixture.mjs';

test('owner deliberately selects source, destination and product, reviews exact authored content and submits once',async t=>{
 const h=await harness(t);assert.equal(h.contextReads().length,0);await h.open();assert.ok(h.button);assert.equal(h.contextReads().length,1);assert.equal(h.elc('account').value,'');assert.equal(h.elc('product').value,'');assert.equal(h.elc('title').value,'');assert.equal(h.elc('description').value,'');assert.equal(h.writes().length,0);
 assert.match(h.elc('policy').textContent,/blocked.*zero.*evidence/);assert.match(h.panel.textContent,/import account is unverified/);assert.match(h.panel.textContent,/not independently immutable proof/);assert.match(h.panel.textContent,/not necessarily the same login/);
 h.submit();assert.equal(h.writes().length,0);h.fill();h.change('title','  Revised title  ');assert.equal(h.elc('ack').checked,false);h.submit();assert.equal(h.writes().length,0);h.change('ack',true);h.elc('description').value='Silent substitution';h.submit();assert.equal(h.writes().length,0);h.change('description','Exact description');h.change('ack',true);
 const pending=deferred();h.post=(_route,options)=>{h.body=JSON.parse(options.body);h.save(h.body);return pending.promise;};h.submit();h.submit();await until(()=>h.writes().length===1);assert.equal(h.elc('prepare').disabled,true);assert.equal(h.elc('account').disabled,true);assert.equal(h.body.jobId,h.context.source.jobId);assert.equal(h.body.opportunityId,h.context.source.opportunityId);assert.equal(h.body.sourceRevision,h.context.sourceRevision);assert.equal(Object.hasOwn(h.body,'source'),false);assert.deepEqual(h.body.target,h.context.target);assert.equal(h.body.title,'Revised title');assert.equal(h.body.confirmedDestinationProduct,true);assert.deepEqual(Object.keys(h.body).sort(),['requestId','jobId','opportunityId','sourceRevision','target','productId','title','description','confirmedDestinationProduct'].sort());
 pending.resolve(Response.json(h.history(h.body.requestId)));await h.idle();assert.match(h.elc('status').textContent,/Exact goal-associated request found/);assert.equal(h.writes().length,1);assert.equal(h.elc('approvals').classList.contains('hidden'),false);assert.equal(h.report.commercialReady,false);assert.equal(h.report.proposals.every(row=>row.readyForPreparation===false&&row.externalExecutionAllowed===false),true);
});

test('candidate entry excludes admin, planning-only objectives, stale review and unsupported product issues',async t=>{
 for(const options of [{role:'admin'},{enforce:false},{issue:'Missing product image'}]){const h=await harness(t,options);await h.review();assert.equal(h.d.querySelector(`[data-request-objective-content="${h.candidate.id}"]`),null);assert.equal(h.contextReads().length,0);}
 const h=await harness(t);await h.open();h.elc('cancel').click();h.currentSnapshot.objectives[0].effectiveStatus='paused';h.button.click();assert.equal(h.contextReads().length,1);assert.equal(h.panel.classList.contains('hidden'),true);
});

test('lost POST retains source-specific stable reference; absent check never permits a new request or automatic retry',async t=>{
 const h=await harness(t);await h.open();h.fill();h.post=async()=>{throw new Error('Synthetic response lost before observation');};h.submit();await until(()=>h.writes().length===1);await h.idle();const body=JSON.parse(h.writes()[0].body);assert.match(h.elc('status').textContent,/outcome is unknown/);
 h.elc('check').click();await h.idle();assert.equal(h.checks().length,1);assert.match(h.elc('error').textContent,/No matching request.*could still commit/);assert.equal(h.writes().length,1);h.elc('cancel').click();assert.equal(h.panel.classList.contains('hidden'),true);h.button.click();assert.equal(h.contextReads().length,2);assert.equal(h.elc('exact').textContent.includes(body.requestId),true);h.submit();assert.equal(h.writes().length,1);
 h.save(body);h.records.get(body.requestId).status='executing';h.read=async()=>Response.json(h.history(body.requestId,{status:'changed',code:'SOURCE_CHANGED',message:'Retained source changed; this is saved history only.'}));h.elc('check').click();await h.idle();assert.match(h.elc('status').textContent,/Exact goal-associated request found.*Executing.*Source check: changed/);assert.equal(h.writes().length,1);assert.equal(h.checks().length,2);
});

for(const mutation of ['manual','source','epoch','input','account','requester','digest','ambiguous'])test('reconciliation rejects '+mutation+' history without replacing the original request',async t=>{
 const h=await harness(t);await h.open();h.fill();h.post=async(_route,options)=>{h.save(JSON.parse(options.body));throw new Error('Synthetic lost response');};h.submit();await until(()=>h.writes().length===1);await h.idle();const body=JSON.parse(h.writes()[0].body);
 h.read=async()=>{const value=structuredClone(h.history(body.requestId)),row=value.request;if(mutation==='manual'){delete row.source;delete row.origin;value.schema='runvara-manual-content-request/v1';delete value.sourceStatus;}if(mutation==='source')row.source.resultDigest='f'.repeat(64);if(mutation==='epoch')row.source.actorSessionVersion++;if(mutation==='input')row.input.title='Wrong';if(mutation==='account')row.account='wrong.myshopify.com';if(mutation==='requester')row.requestedBy='someone-else';if(mutation==='digest')row.digest='f'.repeat(64);if(mutation==='ambiguous')row.other='unsupported';return Response.json(value);};
 h.elc('check').click();await h.idle();assert.match(h.elc('error').textContent,/did not match/);assert.match(h.elc('status').textContent,/outcome is unknown/);assert.ok(h.elc('exact').textContent.includes(body.requestId));assert.equal(h.writes().length,1);
});

test('canonical source property order can differ while exact payload and source remain unchanged',async t=>{
 const h=await harness(t);await h.open();h.fill();h.post=async(_route,options)=>{const body=JSON.parse(options.body),row=h.save(body);row.source=Object.fromEntries(Object.entries(row.source).reverse());return Response.json(h.history(body.requestId));};h.submit();await until(()=>h.writes().length===1);await h.idle();assert.match(h.elc('status').textContent,/Exact goal-associated request found/);
});

for(const kind of ['cancel','navigation','popstate','pagehide','hidden','panel-close','close-reopen','bootstrap'])test('pending POST survives '+kind+' as unknown and a late success cannot resurrect its editor',async t=>{
 const h=await harness(t);await h.open();h.fill();const pending=deferred();h.post=()=>pending.promise;h.submit();await until(()=>h.writes().length===1);const body=JSON.parse(h.writes()[0].body),signal=h.writes()[0].signal;
 if(kind==='cancel')h.elc('cancel').click();if(kind==='navigation')h.controls.setView('overview');if(kind==='popstate')h.w.dispatchEvent(new h.w.Event('popstate'));if(kind==='pagehide')h.w.dispatchEvent(new h.w.Event('pagehide'));if(kind==='hidden'){h.hidden=true;h.d.dispatchEvent(new h.w.Event('visibilitychange'));}if(kind==='panel-close'||kind==='close-reopen'){h.details.open=false;if(kind==='close-reopen')h.details.open=true;await pause();}if(kind==='bootstrap')await h.controls.reload({migrate:false});
 assert.equal(signal.aborted,true);h.save(body);pending.resolve(Response.json(h.history(body.requestId)));await pause();assert.equal(h.panel.classList.contains('hidden'),true);assert.equal(h.writes().length,1);
 h.hidden=false;h.controls.setView('ai-team');h.details.open=true;await pause();h.el('resume-objective-content').click();assert.ok(h.elc('exact').textContent.includes(body.requestId));assert.match(h.elc('status').textContent,/outcome is unknown/);h.elc('check').click();await h.idle();assert.match(h.elc('status').textContent,/Exact goal-associated request found/);assert.equal(h.writes().length,1);
});

test('delayed context after close cannot open or fill a replacement draft',async t=>{
 const h=await harness(t);await h.review();const pending=deferred();h.readContext=()=>pending.promise;h.d.querySelector(`[data-request-objective-content="${h.candidate.id}"]`).click();assert.equal(h.contextReads().length,1);h.elc('cancel').click();pending.resolve(Response.json(h.context));await pause();assert.equal(h.panel.classList.contains('hidden'),true);assert.equal(h.elc('title').value,'');assert.equal(h.writes().length,0);
});

for(const kind of ['objective','product','account','opportunity'])test('in-place '+kind+' change during a POST prevents late acknowledgement and preserves the source-bound request',async t=>{
 const h=await harness(t);await h.open();h.fill();const pending=deferred();h.post=()=>pending.promise;h.submit();await until(()=>h.writes().length===1);const body=JSON.parse(h.writes()[0].body);
 if(kind==='objective')h.currentSnapshot.objectives[0].revision++;if(kind==='product')h.currentBootstrap.products[0].title='Replaced';if(kind==='account')h.currentBootstrap.connections[0].metadata.shopDomain='other.myshopify.com';if(kind==='opportunity')h.currentBootstrap.opportunities.find(row=>row.id===h.candidate.id).status='dismissed';
 h.save(body);pending.resolve(Response.json(h.history(body.requestId)));await pause();await h.idle();assert.match(h.elc('status').textContent,/outcome is unknown/);assert.equal(h.writes().length,1);assert.ok(h.elc('exact').textContent.includes(body.requestId));
});

test('late old-session 401 and history callbacks cannot sign out or reveal content to a replacement login',async t=>{
 const h=await harness(t);await h.open();h.fill();const pending=deferred();h.post=()=>pending.promise;h.submit();await until(()=>h.writes().length===1);h.elc('cancel').click();await h.login();pending.resolve(Response.json({error:'Old session expired',code:'SESSION_INVALID'},{status:401}));await pause();assert.equal(h.el('app-shell').classList.contains('hidden'),false);assert.equal(h.elc('title').value,'');assert.equal(h.elc('exact').textContent,'');assert.equal(h.el('resume-objective-content').classList.contains('hidden'),true);assert.equal(h.writes().length,1);
});

test('failed password change preserves unknown source-bound request; successful replacement clears it',async t=>{
 const h=await harness(t);await h.open();h.fill();h.post=async(_route,options)=>{h.save(JSON.parse(options.body));throw new Error('Lost response');};h.submit();await until(()=>h.writes().length===1);await h.idle();const requestId=JSON.parse(h.writes()[0].body).requestId;h.passwordSubmit();await until(()=>h.el('account-password-form').querySelector('.form-error').textContent.includes('Synthetic wrong'));h.el('resume-objective-content').click();assert.ok(h.elc('exact').textContent.includes(requestId));h.elc('check').click();await h.idle();assert.match(h.elc('status').textContent,/Exact goal-associated request found/);
 h.password=async()=>Response.json({csrf:'replacement-csrf'});h.passwordSubmit();await until(()=>h.el('global-success').textContent.includes('Password updated'));assert.equal(h.elc('title').value,'');assert.equal(h.elc('exact').textContent,'');assert.equal(h.writes().length,1);
});

test('full app consumes actual server report/context, saves exact v2 request, and reconciles a lost real acknowledgement',async t=>{
 const h=await harness(t,{realBackend:true});await h.open();assert.equal(h.context.source.inputFingerprint.length,32);assert.equal(h.context.sourceRevision.length,64);assert.equal(h.elc('account').value,'');assert.equal(h.elc('product').value,'');h.fill();
 let committed;h.post=async(route,options)=>{const response=await h.realRequest(route,options);assert.equal(response.status,200,JSON.stringify(await response.clone().json()));committed=await response.json();throw new Error('Synthetic lost actual server acknowledgement');};h.submit();await until(()=>h.writes().length===1);await h.idle();assert.match(h.elc('status').textContent,/outcome is unknown/);assert.equal(committed.request.source.resultDigest,h.context.source.resultDigest);
 const stored=await h.server.packsmart.store.get(h.state.workspace.id);assert.equal(stored.connectionWrites.length,1);assert.equal(stored.approvals.length,1);assert.equal(stored.connectionWrites[0].objectivePolicyProposal.origin,'owner_objective_content');assert.equal(stored.approvals[0].type,'customer_facing_publish');assert.equal(stored.approvals[0].status,'pending');
 h.elc('check').click();await h.idle();assert.match(h.elc('status').textContent,/Exact goal-associated request found.*Source check: current/);assert.equal(h.writes().length,1);assert.equal(h.checks().length,1);
});

test('real backend changed retained product makes the reviewed preview stale without saving an approval or write',async t=>{
 const h=await harness(t,{realBackend:true});await h.open();h.fill();const stored=await h.server.packsmart.store.get(h.state.workspace.id);stored.products[0].title='New';await h.server.packsmart.store.save(h.state.workspace.id,stored);h.submit();await until(()=>h.writes().length===1);await h.idle();assert.match(h.elc('status').textContent,/Preparation was refused/);const after=await h.server.packsmart.store.get(h.state.workspace.id);assert.equal(after.connectionWrites.length,0);assert.equal(after.approvals.length,0);assert.equal(h.elc('ack').checked,false);
});

for(const field of ['workspaceId','requestedBy','sourceRevision','source','target'])test('context rejects mismatched '+field+' before any request can be prepared',async t=>{
 const h=await harness(t);if(field==='workspaceId')h.context.workspaceId='foreign';if(field==='requestedBy')h.context.requestedBy='foreign';if(field==='sourceRevision')h.context.sourceRevision='invalid';if(field==='source')h.context.source.actorId='foreign';if(field==='target')h.context.target.account='https://not-a-shop.example';await h.open();assert.match(h.elc('error').textContent,/did not match/);h.fill();h.submit();assert.equal(h.writes().length,0);
});

for(const action of ['role','password','session','csrf'])test('current '+action+' loss blocks event-time authority and clears private content',async t=>{
 const h=await harness(t);await h.open();h.fill();if(action==='role')h.session.user.role='admin';if(action==='password')h.currentBootstrap.user.passwordChangeRequired=true;if(action==='session')h.session.workspace.id='foreign';if(action==='csrf')h.session.csrf='changed';h.submit();await pause();assert.equal(h.writes().length,0);assert.equal(h.panel.classList.contains('hidden'),true);assert.equal(h.elc('title').value,'');assert.equal(h.elc('exact').textContent,'');
});

for(const kind of ['role','password','csrf'])test('pending response after '+kind+' loss clears private draft instead of rendering late history',async t=>{
 const h=await harness(t);await h.open();h.fill();const pending=deferred();h.post=()=>pending.promise;h.submit();await until(()=>h.writes().length===1);const body=JSON.parse(h.writes()[0].body);if(kind==='role')h.currentBootstrap.user.role='admin';if(kind==='password')h.session.user.passwordChangeRequired=true;if(kind==='csrf')h.session.csrf='replacement';h.save(body);pending.resolve(Response.json(h.history(body.requestId)));await pause();assert.equal(h.panel.classList.contains('hidden'),true);assert.equal(h.elc('title').value,'');assert.equal(h.elc('exact').textContent,'');assert.equal(h.el('resume-objective-content').classList.contains('hidden'),true);
});

test('a late history read cannot complete after closing and must be explicitly checked again',async t=>{
 const h=await harness(t);await h.open();h.fill();h.post=async(_route,options)=>{h.save(JSON.parse(options.body));throw new Error('Lost reply');};h.submit();await until(()=>h.writes().length===1);await h.idle();const body=JSON.parse(h.writes()[0].body),pending=deferred();h.read=()=>pending.promise;h.elc('check').click();assert.equal(h.checks().length,1);h.elc('cancel').click();pending.resolve(Response.json(h.history(body.requestId)));await pause();assert.equal(h.panel.classList.contains('hidden'),true);h.el('resume-objective-content').click();assert.match(h.elc('status').textContent,/outcome is unknown/);assert.equal(h.checks().length,1);assert.equal(h.writes().length,1);
});

test('empty description explicitly reviews clearing the field and sends the empty value unchanged',async t=>{
 const h=await harness(t);await h.open();h.fill();h.change('description','');assert.equal(h.elc('ack').checked,false);assert.match(h.elc('exact').textContent,/Empty description: this clears the Shopify description/);h.change('ack',true);h.submit();await until(()=>h.writes().length===1);await h.idle();assert.equal(JSON.parse(h.writes()[0].body).description,'');assert.match(h.elc('status').textContent,/Exact goal-associated request found/);
});

test('explicit retry requires absent lookup, matching current source/target and renewed exact acknowledgement, then reuses the entire frozen request',async t=>{
 const h=await harness(t,{realBackend:true});await h.open();h.fill();h.post=async()=>{throw new Error('Synthetic request never reached the server');};h.submit();await until(()=>h.writes().length===1);await h.idle();const body=JSON.parse(h.writes()[0].body);h.elc('check').click();await h.idle();assert.equal(h.elc('retry').classList.contains('hidden'),false);assert.equal(h.elc('retry').disabled,true);assert.equal(h.elc('ack').checked,false);h.elc('retry').click();assert.equal(h.writes().length,1);
 h.elc('title').value='Silent new text';h.change('ack',true);h.elc('retry').click();await h.idle();assert.equal(h.writes().length,1);assert.match(h.elc('error').textContent,/exact reviewed source or fields changed/);assert.match(h.elc('status').textContent,/outcome is unknown/);
 h.elc('title').value=body.title;h.elc('check').click();await h.idle();h.change('ack',true);h.post=h.realRequest;h.elc('retry').click();h.elc('retry').click();await until(()=>h.writes().length===2);await h.idle();assert.deepEqual(JSON.parse(h.writes()[1].body),body);assert.match(h.elc('status').textContent,/Exact goal-associated request found/);const stored=await h.server.packsmart.store.get(h.state.workspace.id);assert.equal(stored.connectionWrites.length,1);assert.equal(stored.approvals.length,1);
});

test('a late original commit after absence makes fresh context stale and history remains checkable without retry',async t=>{
 const h=await harness(t,{realBackend:true});await h.open();h.fill();h.post=async()=>{throw new Error('Synthetic response unknown');};h.submit();await until(()=>h.writes().length===1);await h.idle();const body=JSON.parse(h.writes()[0].body);
 h.read=async(route,options)=>{const absent=await h.realRequest(route,options);assert.equal((await absent.clone().json()).found,false);const saved=await h.realRequest(POST,{method:'POST',body:JSON.stringify(body)});assert.equal(saved.status,200);return absent;};
 h.elc('check').click();await h.idle();assert.equal(h.elc('retry').classList.contains('hidden'),true);assert.match(h.elc('status').textContent,/outcome is unknown/);assert.ok(h.elc('exact').textContent.includes(body.requestId));h.read=h.realRequest;h.elc('check').click();await h.idle();assert.match(h.elc('status').textContent,/Exact goal-associated request found/);assert.equal(h.writes().length,1);
});

test('a late original commit after fresh matching context coalesces with an explicitly acknowledged same-ID retry',async t=>{
 const h=await harness(t,{realBackend:true});await h.open();h.fill();h.post=async()=>{throw new Error('Unknown initial response');};h.submit();await until(()=>h.writes().length===1);await h.idle();const body=JSON.parse(h.writes()[0].body);h.elc('check').click();await h.idle();assert.equal(h.elc('retry').classList.contains('hidden'),false);
 const saved=await h.realRequest(POST,{method:'POST',body:JSON.stringify(body)});assert.equal(saved.status,200);h.post=h.realRequest;h.change('ack',true);h.elc('retry').click();await until(()=>h.writes().length===2);await h.idle();assert.deepEqual(JSON.parse(h.writes()[1].body),body);assert.match(h.elc('status').textContent,/Exact goal-associated request found/);const stored=await h.server.packsmart.store.get(h.state.workspace.id);assert.equal(stored.connectionWrites.length,1);assert.equal(stored.approvals.length,1);
});

for(const field of ['source','target'])test('absent history with changed '+field+' cannot rebase or unlock a retry',async t=>{
 const h=await harness(t);await h.open();h.fill();h.post=async()=>{throw new Error('Unknown');};h.submit();await until(()=>h.writes().length===1);await h.idle();const body=JSON.parse(h.writes()[0].body);if(field==='source')h.context.source.approvalSourceDigest='b'.repeat(64);else h.context.target.settingsRevision++;h.elc('check').click();await h.idle();assert.match(h.elc('error').textContent,/no longer matches/);assert.equal(h.elc('retry').classList.contains('hidden'),true);assert.ok(h.elc('exact').textContent.includes(body.requestId));assert.equal(h.writes().length,1);
});

test('explicit Approval Centre handoff loads actual saved approval and complete goal/content without approving or applying',async t=>{
 const h=await harness(t,{realBackend:true});await h.open();h.fill();h.change('description','');h.change('ack',true);h.submit();await until(()=>h.writes().length===1);await h.idle();h.bootstrapRead=h.realRequest;h.elc('approvals').click();await until(()=>h.el('approval-list').textContent.includes('Review full goal-associated content'));const text=h.el('approval-list').textContent;assert.ok(text.includes(h.context.source.reportId));assert.ok(text.includes(h.context.source.opportunityId));assert.match(text,/Empty description: this clears the Shopify description/);assert.match(text,/Commercial readiness and objective progress remain unverified/);assert.equal(h.d.querySelector('.view.active').id,'view-approvals');const stored=await h.server.packsmart.store.get(h.state.workspace.id);assert.equal(stored.approvals[0].status,'pending');assert.equal(stored.connectionWrites[0].status,'pending_approval');
});

for(const response of ['saved','401'])test('late Approval Centre '+response+' snapshot cannot change a replacement session',async t=>{
 const h=await harness(t);await h.open();h.fill();h.submit();await until(()=>h.writes().length===1);await h.idle();const pending=deferred();h.bootstrapRead=()=>pending.promise;h.elc('approvals').click();await until(()=>h.calls.filter(call=>call.route==='/api/bootstrap').length===2);const old=h.calls.filter(call=>call.route==='/api/bootstrap')[1];h.controls.setView('overview');assert.equal(old.signal.aborted,true);h.bootstrapRead=null;await h.login();
 pending.resolve(response==='401'?Response.json({error:'Expired old session',code:'SESSION_INVALID'},{status:401}):Response.json({...h.bootstrap,approvals:[{id:'foreign-old-approval',status:'pending',action:'Obsolete private action'}],connectionWrites:[]}));await pause();assert.equal(h.el('app-shell').classList.contains('hidden'),false);assert.equal(h.el('approval-list').textContent.includes('Obsolete private action'),false);assert.equal(h.elc('title').value,'');
});

for(const flag of ['active','passwordChangeRequired','csrf'])test('Approval Centre refresh rejects explicit '+flag+' revocation without copying private history',async t=>{
 const h=await harness(t);await h.open();h.fill();h.submit();await until(()=>h.writes().length===1);await h.idle();h.bootstrapRead=async()=>{const snapshot=structuredClone(h.bootstrap);if(flag==='active')snapshot.user.active=false;if(flag==='passwordChangeRequired')snapshot.user.passwordChangeRequired=true;if(flag==='csrf')snapshot.csrf='different';snapshot.approvals=[{id:'revoked',status:'pending',action:'Do not copy revoked history'}];snapshot.connectionWrites=[];return Response.json(snapshot);};h.elc('approvals').click();await until(()=>h.el('global-error').textContent.includes('matching saved approval'));assert.equal(h.el('approval-list').textContent.includes('Do not copy revoked history'),false);
});

for(const [status,code] of [[409,'OBJECTIVE_CONTENT_SOURCE_CHANGED'],[409,'WRITE_TARGET_CHANGED'],[403,'WRITE_NOT_AUTHORISED'],[403,'ORIGIN_DENIED']])test('retry '+status+' '+code+' after unknown preserves the frozen reference and exact reconciliation',async t=>{
 const h=await harness(t);await h.open();h.fill();h.post=async()=>{throw new Error('Original response remains unknown');};h.submit();await until(()=>h.writes().length===1);await h.idle();const original=JSON.parse(h.writes()[0].body);h.elc('check').click();await h.idle();assert.equal(h.elc('retry').classList.contains('hidden'),false);
 h.post=async()=>Response.json({error:'Later source or target refusal',code},{status});h.change('ack',true);h.elc('retry').click();await until(()=>h.writes().length===2);await h.idle();assert.deepEqual(JSON.parse(h.writes()[1].body),original);assert.equal(h.panel.classList.contains('hidden'),false);assert.match(h.elc('status').textContent,/outcome is unknown/);assert.ok(h.elc('exact').textContent.includes(original.requestId));assert.equal(h.elc('check').classList.contains('hidden'),false);assert.equal(h.elc('reload').classList.contains('hidden'),true);
 h.save(original);h.elc('check').click();await h.idle();assert.match(h.elc('status').textContent,/Exact goal-associated request found/);assert.equal(h.writes().length,2);
});

test('actual late original commit then read-only target403 remains exactly reconcilable without another save',async t=>{
 const h=await harness(t,{realBackend:true});await h.open();h.fill();h.post=async()=>{throw new Error('Original response unknown before arrival');};h.submit();await until(()=>h.writes().length===1);await h.idle();const original=JSON.parse(h.writes()[0].body);h.elc('check').click();await h.idle();assert.equal(h.elc('retry').classList.contains('hidden'),false);
 const late=await h.realRequest(POST,{method:'POST',body:JSON.stringify(original)});assert.equal(late.status,200);const state=await h.server.packsmart.store.get(h.state.workspace.id);state.connectionSettings.shopify.permissionMode='read_only';await h.server.packsmart.store.save(h.state.workspace.id,state);
 h.post=h.realRequest;h.change('ack',true);h.elc('retry').click();await until(()=>h.writes().length===2);await h.idle();assert.deepEqual(JSON.parse(h.writes()[1].body),original);assert.equal(h.panel.classList.contains('hidden'),false);assert.match(h.elc('status').textContent,/outcome is unknown/);assert.ok(h.elc('exact').textContent.includes(original.requestId));h.elc('check').click();await h.idle();assert.match(h.elc('status').textContent,/Exact goal-associated request found.*Source check: changed/);assert.equal(h.writes().length,2);
 const final=await h.server.packsmart.store.get(h.state.workspace.id);assert.equal(final.connectionWrites.length,1);assert.equal(final.approvals.length,1);
});

for(const during of ['exact lookup','fresh context'])test('non-identity403 during '+during+' retains unknown source and history controls',async t=>{
 const h=await harness(t);await h.open();h.fill();h.post=async()=>{throw new Error('Unknown');};h.submit();await until(()=>h.writes().length===1);await h.idle();const original=JSON.parse(h.writes()[0].body);
 if(during==='exact lookup')h.read=async()=>Response.json({code:'WRITE_NOT_AUTHORISED',error:'Read-only target'},{status:403});else h.readContext=async()=>Response.json({code:'WRITE_NOT_AUTHORISED',error:'Read-only target'},{status:403});
 h.elc('check').click();await h.idle();assert.equal(h.panel.classList.contains('hidden'),false);assert.match(h.elc('status').textContent,/outcome is unknown/);assert.ok(h.elc('exact').textContent.includes(original.requestId));assert.equal(h.elc('check').classList.contains('hidden'),false);assert.equal(h.elc('retry').classList.contains('hidden'),true);assert.equal(h.writes().length,1);
});

for(const code of ['WRITE_ACTOR_CHANGED','OWNER_APPROVAL_REQUIRED','ROLE_DENIED','PASSWORD_CHANGE_REQUIRED','CSRF_INVALID'])test('verified403 '+code+' clears private unknown content while permission-only errors preserve it',async t=>{
 const h=await harness(t);await h.open();h.fill();h.post=async()=>{throw new Error('Unknown');};h.submit();await until(()=>h.writes().length===1);await h.idle();h.read=async()=>Response.json({code,error:'Current identity or request security changed'},{status:403});h.elc('check').click();await until(()=>h.panel.classList.contains('hidden'));assert.equal(h.elc('title').value,'');assert.equal(h.elc('exact').textContent,'');assert.equal(h.el('resume-objective-content').classList.contains('hidden'),true);assert.equal(h.writes().length,1);
});
