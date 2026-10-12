import test from 'node:test';
import assert from 'node:assert/strict';
import {costSourceHarness as harness,pause,until,deferred,GET,selector} from './cost-source-ui-fixture.mjs';
const paused=()=>Response.json({code:'COST_SOURCE_REVIEW_PAUSED',error:'PRIVATE_GATE_CANARY'},{status:503});

test('explicit exact-variant entry and source-only save preserve raw costs and financial holds',async t=>{
 const h=await harness(t);assert.equal(h.sourceReads().length,0);assert.equal(h.d.body.textContent.includes('INV 2026-42'),false);await h.sourceOpen();assert.equal(h.sourceReads().length,1);assert.equal(h.cs('dialog').open,true);assert.match(h.cs('target').textContent,/Product\/10.*\nVariant: gid:\/\/shopify\/ProductVariant\/11/);assert.match(h.cs('fields').textContent,/4.25/);assert.equal(h.component('packing','include').disabled,false);assert.equal(h.component('handling','include').disabled,true);
 const before=structuredClone(h.state.economics[selector.sku]);h.fillSource();h.sourceSubmit();h.sourceSubmit();await h.waitWrite(1);const body=JSON.parse(h.sourceWrites()[0].body);assert.deepEqual(Object.keys(body),['sku','sourceReview']);assert.deepEqual(Object.keys(body.sourceReview).sort(),['productId','variantId','sku','sourceRevision','requestId','basis'].sort());assert.equal(body.sourceReview.basis.currency,null);assert.equal(body.sourceReview.basis.taxBasis,'unknown');assert.match(h.cs('status').textContent,/Exact source annotation found/);assert.equal(h.state.economics[selector.sku].landed,before.landed);assert.equal(h.state.economics[selector.sku].sourceBasis.costs.landed,'4.2500');assert.match(h.cs('history').textContent,/INV 2026-42/);assert.equal(h.cs('correct').classList.contains('hidden'),false);assert.equal(h.currentBootstrap.economics[selector.sku].sourceBasis,undefined);assert.equal(h.state.connectionWrites.length,0);assert.equal(h.state.approvals.length,0);
});

test('unsaved visible or supplier-detail cost changes prevent source fetch and numeric save',async t=>{
 const h=await harness(t);for(const key of ['landed','boxPrice','supplierVatRecoverable','notes']){const field=h.d.querySelector(`.econ-input[data-field="${key}"]`),old=field.value;field.value=key==='supplierVatRecoverable'?'true':'7';await h.sourceOpen();assert.equal(h.sourceReads().length,0);assert.equal(h.sourceWrites().length,0);assert.match(h.el('global-error').textContent,/Save or discard/);field.value=old;}
});

for(const role of ['admin','member','viewer'])test('source entry role: '+role,async t=>{const h=await harness(t,{role});assert.equal(Boolean(h.d.querySelector('.cost-source-open')),role==='admin');if(role==='admin'){await h.sourceOpen();assert.equal(h.sourceReads().length,1);}});

for(const identifier of ['https://example.com/invoice','www.example.com','invoice@example.com','example.com/path','<img src=x>','a'.repeat(81),'   '])test('unsafe identifier cannot be submitted: '+identifier.slice(0,30),async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource(identifier);h.sourceSubmit();await pause();assert.equal(h.sourceWrites().length,0);assert.equal(h.cs('save').disabled,true);
});

test('correction retains prior record, requires explicit reload, and preserves chosen unknowns',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource();h.sourceSubmit();await h.waitWrite(1);const first=h.state.economics[selector.sku].sourceBasis;h.cs('correct').click();await h.sourceIdle();assert.equal(h.cs('ack').checked,false);assert.match(h.cs('history').textContent,/INV 2026-42/);h.fillSource('INV correction 43');h.sourceChange('currency','GBP');h.sourceChange('taxBasis','gross');h.sourceChange('ack',true);h.sourceSubmit();await h.waitWrite(2);assert.equal(h.state.costHistory.length,2);assert.equal(h.state.economics[selector.sku].sourceBasis.previousId,first.id);assert.match(h.cs('history').textContent,/INV correction 43/);assert.match(h.cs('history').textContent,/INV 2026-42/);assert.notEqual(JSON.parse(h.sourceWrites()[0].body).sourceReview.requestId,JSON.parse(h.sourceWrites()[1].body).sourceReview.requestId);
});

test('first paused save is a known refusal with safe copy and no automatic retry',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource();h.sourcePut=async()=>paused();h.sourceSubmit();await h.waitWrite(1);assert.match(h.cs('status').textContent,/refused/);assert.doesNotMatch(h.cs('error').textContent,/PRIVATE_GATE/);assert.equal(h.cs('check').classList.contains('hidden'),true);h.sourceSubmit();h.cs('close').click();await h.sourceOpen();assert.equal(h.sourceWrites().length,1);
});

test('unknown then paused retry retains byte-identical request and later exact history resolves it',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource();h.sourcePut=async()=>{throw new Error('Lost reply');};h.sourceSubmit();await h.waitWrite(1);const original=h.sourceWrites()[0].body;assert.match(h.cs('status').textContent,/outcome is unknown/);h.cs('check').click();await h.sourceIdle();assert.equal(h.cs('retry').classList.contains('hidden'),false);assert.equal(h.cs('retry').disabled,true);h.sourceChange('ack',true);h.sourcePut=async()=>paused();h.cs('retry').click();await h.waitWrite(2);assert.equal(h.sourceWrites()[1].body,original);assert.match(h.cs('status').textContent,/outcome is unknown/);assert.equal(h.cs('reload').classList.contains('hidden'),true);h.cs('close').click();await h.sourceOpen();assert.match(h.cs('status').textContent,/outcome is unknown/);assert.match(h.cs('request').textContent,new RegExp(JSON.parse(original).sourceReview.requestId));h.saveCost(JSON.parse(original));h.cs('check').click();await h.sourceIdle();assert.match(h.cs('status').textContent,/Exact source annotation found/);assert.equal(h.sourceWrites().length,2);
});

test('late response after close cannot overwrite a newer reconciliation read',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource();const old=deferred();h.sourcePut=()=>old.promise;h.sourceSubmit();await until(()=>h.sourceWrites().length===1);const body=JSON.parse(h.sourceWrites()[0].body);h.cs('close').click();const current=deferred();h.sourceRead=()=>current.promise;h.d.querySelector('.cost-source-open').click();old.resolve(paused());await pause();assert.equal(h.cs('form').getAttribute('aria-busy'),'true');assert.equal(h.cs('request').textContent,'');h.saveCost(body);current.resolve(Response.json(h.contextCost()));await h.sourceIdle();assert.match(h.cs('status').textContent,/Exact source annotation found/);assert.equal(h.sourceWrites().length,1);
});

for(const change of ['navigation','hidden','session','csrf'])test('interrupted '+change+' retains unknown identity without disclosing private form',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource('PRIVATE SOURCE 84');const pending=deferred();h.sourcePut=()=>pending.promise;h.sourceSubmit();await until(()=>h.sourceWrites().length===1);const body=JSON.parse(h.sourceWrites()[0].body);
 if(change==='navigation')h.controls.setView('overview');if(change==='hidden'){h.hidden=true;h.d.dispatchEvent(new h.w.Event('visibilitychange'));}if(change==='session')h.session.user.role='viewer';if(change==='csrf')h.session.csrf='replacement';
 pending.resolve(Response.json(h.saveCost(body)));await pause();assert.equal(h.cs('dialog').open,false);assert.equal(h.cs('fields').textContent,'');assert.equal(h.cs('history').textContent,'');assert.equal(h.sourceWrites().length,1);
 if(change==='hidden')h.hidden=false;if(change==='session')h.session.user.role='owner';if(change==='csrf')h.session.csrf=h.bootstrap.csrf;h.controls.setView('profit');await h.sourceOpen();assert.match(h.cs('status').textContent,/Exact source annotation found/);assert.equal(h.sourceWrites().length,1);
});

test('saved costs changed after preview block a new write before network',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource();h.currentBootstrap.economics[selector.sku].landed='9';h.sourceSubmit();assert.equal(h.sourceWrites().length,0);assert.match(h.cs('error').textContent,/costs changed/);
});

for(const lostReply of [false,true])test('saved annotation message remains truthful after later costs change'+(lostReply?' and exact reconciliation':''),async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource();
 if(lostReply)h.sourcePut=async(_route,options)=>{h.saveCost(JSON.parse(options.body));throw new Error('Lost saved reply');};
 h.sourceSubmit();await h.waitWrite(1);h.cs('close').click();h.state.economics[selector.sku].landed='9';await h.sourceOpen();
 assert.match(h.cs('current').textContent,/attestation is stale: saved costs changed/);
 assert.match(h.cs('status').textContent,/Exact source annotation found in saved history\. This annotation did not change saved costs or remove financial or action holds\./);
 assert.doesNotMatch(h.cs('status').textContent,/Costs and all financial holds are unchanged/);
 assert.equal(h.state.economics[selector.sku].landed,'9');assert.equal(h.state.costHistory.length,1);assert.equal(h.sourceWrites().length,1);assert.equal(h.cs('save').disabled,true);
});

test('blank and populated native dates keep their values when source review becomes read-only',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource();
 const dateFields=()=>[h.cs('effectiveFrom'),h.cs('effectiveUntil'),h.component('landed','issuedOn')];
 for(const field of dateFields()){assert.equal(field.type,'date');assert.equal(field.disabled,false);assert.equal(field.value,'');}
 h.sourceSubmit();await h.waitWrite(1);
 for(const field of dateFields()){assert.equal(field.disabled,true);assert.equal(field.value,'');}
 h.cs('correct').click();await h.sourceIdle();
 for(const field of dateFields()){assert.equal(field.disabled,false);h.sourceChange(field,'2026-09-17');}
 h.sourceChange('ack',true);h.sourceSubmit();await h.waitWrite(2);
 for(const field of dateFields()){assert.equal(field.type,'date');assert.equal(field.disabled,true);assert.equal(field.value,'2026-09-17');}
 const saved=h.state.economics[selector.sku].sourceBasis.basis;assert.equal(saved.effectiveFrom,'2026-09-17');assert.equal(saved.effectiveUntil,'2026-09-17');assert.equal(saved.sources[0].issuedOn,'2026-09-17');
});

test('unknown request cannot be rebased when saved costs or saved account change',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource();h.sourcePut=async()=>{throw new Error('unknown');};h.sourceSubmit();await h.waitWrite(1);const original=h.sourceWrites()[0].body;h.state.economics[selector.sku].landed='9';h.cs('check').click();await h.sourceIdle();assert.match(h.cs('status').textContent,/outcome is unknown/);assert.equal(h.cs('retry').classList.contains('hidden'),true);assert.match(h.cs('request').textContent,new RegExp(JSON.parse(original).sourceReview.requestId));h.cs('reload').click();h.sourceSubmit();assert.equal(h.sourceWrites().length,1);
});

test('read-only unavailable historical target shows retained identifiers and never enables save',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource();h.sourceSubmit();await h.waitWrite(1);h.cs('close').click();h.state.connections=[];await h.sourceOpen();assert.match(h.cs('current').textContent,/target unavailable/);assert.match(h.cs('history').textContent,/INV 2026-42/);assert.equal(h.cs('save').disabled,true);assert.equal(h.cs('correct').disabled,true);
});

test('context rejects mismatched target and unrecognized fields before copying source identifiers',async t=>{
 const h=await harness(t);const value=h.contextCost();value.target.variantId='gid://shopify/ProductVariant/999';h.sourceRead=async()=>Response.json(value);await h.sourceOpen();assert.match(h.cs('error').textContent,/did not match/);assert.equal(h.cs('fields').textContent,'');assert.equal(h.cs('save').disabled,true);assert.equal(h.sourceWrites().length,0);
});

test('owner objective context renders per-variant attestation without changing source bytes or policy',async t=>{
 const {productCostSourceReviews}=await import('../lib/cost-source-review.mjs');const h=await harness(t);await h.sourceOpen();h.fillSource('REVIEW 71');h.sourceSubmit();await h.waitWrite(1);h.cs('close').click();h.context.costSources=productCostSourceReviews(h.state,selector.productId,h.actor);const sourceBefore=JSON.stringify(h.context.source),revision=h.context.sourceRevision;await h.open();const panel=h.el('objective-content-cost-sources');assert.match(panel.textContent,/SOURCE-SKU.*Matches saved costs and target/);assert.match(panel.textContent,/REVIEW 71/);assert.match(panel.textContent,/Currency: Unknown/);assert.match(panel.textContent,/Tax basis: Unknown/);assert.match(panel.textContent,/Unknown start.*Unknown end/);assert.match(panel.textContent,/Financial qualification remains unavailable for this variant/);assert.match(panel.textContent,/do not establish evidence freshness/);assert.equal(JSON.stringify(h.context.source),sourceBefore);assert.equal(h.context.sourceRevision,revision);assert.equal(h.context.policy.allowed,false);assert.equal(h.elc('error').textContent,'');h.session.user.role='admin';h.submit();assert.equal(panel.textContent,'');assert.equal(h.writes().length,0);
});

test('invalid diagnostic sidecar is rejected without exposing source identifiers',async t=>{
 const {productCostSourceReviews}=await import('../lib/cost-source-review.mjs');const h=await harness(t);await h.sourceOpen();h.fillSource('PRIVATE SOURCE 91');h.sourceSubmit();await h.waitWrite(1);h.cs('close').click();h.context.costSources=productCostSourceReviews(h.state,selector.productId,h.actor);h.context.costSources.reviews[0].reviewer.workspaceId='foreign';await h.open();assert.match(h.elc('error').textContent,/did not match/);assert.equal(h.el('objective-content-cost-sources').textContent,'');assert.equal(h.writes().length,0);
});

test('unrecorded second variant never inherits a reviewed sibling source',async t=>{
 const {productCostSourceReviews}=await import('../lib/cost-source-review.mjs');const h=await harness(t);await h.sourceOpen();h.fillSource();h.sourceSubmit();await h.waitWrite(1);h.cs('close').click();h.state.products[0].variants.push({id:'gid://shopify/ProductVariant/12',sku:'SECOND-SKU'});h.state.economics['SECOND-SKU']={landed:0};h.context.costSources=productCostSourceReviews(h.state,selector.productId,h.actor);await h.open();const rows=h.el('objective-content-cost-sources').querySelectorAll(':scope > ul > li');assert.equal(rows.length,2);assert.match(rows[0].textContent,/INV 2026-42/);assert.match(rows[1].textContent,/No saved attestation/);assert.doesNotMatch(rows[1].textContent,/INV 2026-42/);
});

test('unchanged correction cannot create a new unrecorded id for identical saved basis',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource();h.sourceSubmit();await h.waitWrite(1);h.cs('correct').click();await h.sourceIdle();assert.match(h.cs('status').textContent,/Change at least one source detail/);assert.equal(h.cs('save').disabled,true);h.sourceChange('ack',true);h.sourceSubmit();assert.equal(h.sourceWrites().length,1);assert.equal(h.state.costHistory.length,1);
});

test('producer-closed reads keep historical reviews inspectable without source writes',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource();h.sourceSubmit();await h.waitWrite(1);h.cs('close').click();h.sourceEnabled=false;await h.sourceOpen();assert.match(h.cs('history').textContent,/INV 2026-42/);h.cs('correct').click();await h.sourceIdle();assert.match(h.cs('status').textContent,/paused/);assert.equal(h.cs('save').disabled,true);h.sourceSubmit();assert.equal(h.sourceWrites().length,1);
});

test('missing original variant row still permits exact unknown-request reconciliation',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource('PRIVATE historical source');h.sourcePut=async()=>{throw new Error('Lost before acknowledgement');};h.sourceSubmit();await h.waitWrite(1);const body=JSON.parse(h.sourceWrites()[0].body);h.cs('close').click();h.saveCost(body);h.state.products=[];h.bootstrap.products=[];h.bootstrap.dashboard.productRows=[];await h.controls.reload({migrate:false});assert.equal(h.d.querySelector('.cost-source-open'),null);assert.equal(h.cs('resume').classList.contains('hidden'),false);assert.equal(h.cs('fields').textContent,'');h.cs('resume').click();await h.sourceIdle();assert.match(h.cs('status').textContent,/Exact source annotation found/);assert.match(h.cs('history').textContent,/PRIVATE historical source/);assert.equal(h.sourceWrites().length,1);assert.equal(h.cs('save').disabled,true);assert.equal(h.cs('resume').classList.contains('hidden'),true);
});

test('changed numeric costs in a syntactically valid save acknowledgement remain unknown',async t=>{
 const h=await harness(t);await h.sourceOpen();h.fillSource();h.sourcePut=async(_route,options)=>{const result=h.saveCost(JSON.parse(options.body));result.record.costs.landed='999';return Response.json(result);};h.sourceSubmit();await h.waitWrite(1);assert.match(h.cs('status').textContent,/outcome is unknown/);assert.match(h.cs('error').textContent,/did not confirm/);h.cs('check').click();await h.sourceIdle();assert.match(h.cs('status').textContent,/Exact source annotation found/);assert.equal(h.sourceWrites().length,1);
});

test('same numeric value with changed raw spelling in an acknowledgement remains unknown',async t=>{
 const h=await harness(t);await h.sourceOpen();assert.match(h.cs('fields').textContent,/4\.2500/);h.fillSource();h.sourcePut=async(_route,options)=>{const result=h.saveCost(JSON.parse(options.body));result.record.costs.landed='4.25';return Response.json(result);};h.sourceSubmit();await h.waitWrite(1);assert.match(h.cs('status').textContent,/outcome is unknown/);h.cs('check').click();await h.sourceIdle();assert.match(h.cs('status').textContent,/Exact source annotation found/);assert.equal(h.sourceWrites().length,1);
});
