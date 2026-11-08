import test from 'node:test';
import assert from 'node:assert/strict';
import {compactStateBytes,planCatalogueSaveCapacity,isCatalogueCapacityRejection,retainedConnectionSyncs,legacyBriefProjection,saveBookkeeping} from '../lib/catalogue-save-capacity.mjs';
import {planAutomationRetention,applyAutomationRetention} from '../lib/automation-retention.mjs';
import {BRIEF_HISTORY_CONTRACT} from '../lib/brief-history.mjs';
import {fixture,catalogueState,ID,product,page,response} from './shopify-catalogue-import-fixture.mjs';
const limits={audit:300,workRecords:100,connectionSyncs:100,agentRuns:1,dailyBriefs:30,hard:2097152},at='2026-11-08T14:00:00.000Z';
const options=s=>({currentBytes:compactStateBytes(s),existing:true,limits,at});
function minimal(){return {workspace:{id:ID},_revision:'00000000-0000-4000-8000-000000000001',storageReady:true,integrationStatus:{},audit:[],workRecords:[],connectionSyncs:[],agentRuns:[],dailyBriefs:[]};}
test('exact compact UTF-8 bytes include Unicode, escaped values, numeric serialization and bookkeeping without mutating input',()=>{
  const s=minimal();s.values=['é','😀','\n','"',1e21,1e-7,-0,123.45,null];const before=structuredClone(s),expected=structuredClone(s);saveBookkeeping(expected,at);
  const result=planCatalogueSaveCapacity(s,options(s));assert.equal(result.currentBytes,Buffer.byteLength(JSON.stringify(s)));assert.equal(result.candidateBytes,Buffer.byteLength(JSON.stringify(expected)));assert.equal(result.maximumCandidateBytes,result.candidateBytes);assert.deepEqual(s,before);
  assert.deepEqual(Object.keys(result),['currentBytes','candidateBytes','maximumCandidateBytes','hardBytes']);assert.ok(Object.isFrozen(result));
});
for(const difference of [-1,0,1])test('candidate relative to hard limit '+difference+' uses strict less-than',()=>{
  const s=minimal(),size=planCatalogueSaveCapacity(s,options(s)).candidateBytes,args={...options(s),limits:{...limits,hard:size-difference}};
  if(difference<0)assert.doesNotThrow(()=>planCatalogueSaveCapacity(s,args));else assert.throws(()=>planCatalogueSaveCapacity(s,args),error=>isCatalogueCapacityRejection(error)&&error.code==='SHOPIFY_CATALOGUE_CAPACITY_REVIEW_REQUIRED');
});
test('required history retention projects exactly while preserving pending recovery inside the same limit',()=>{
  const s=minimal();s.audit=Array.from({length:302},(_,id)=>({id}));s.workRecords=Array.from({length:101},(_,id)=>({id}));s.agentRuns=[{id:1},{id:2}];s.dailyBriefs=Array.from({length:31},(_,id)=>({id}));s.connectionSyncs=Array.from({length:102},(_,id)=>({id}));s.integrationStatus.shopify={orderRecovery:{status:'reserved',runId:101}};
  const before=structuredClone(s),expected=structuredClone(s);expected.audit.length=300;expected.workRecords.length=100;expected.agentRuns.length=1;expected.dailyBriefs.length=30;expected.connectionSyncs=[...s.connectionSyncs.slice(0,99),s.connectionSyncs[101]];saveBookkeeping(expected,at);
  assert.equal(planCatalogueSaveCapacity(s,options(s)).candidateBytes,compactStateBytes(expected));assert.deepEqual(retainedConnectionSyncs(s,100).kept,expected.connectionSyncs);assert.deepEqual(s,before);
});
test('optional retention maximum covers independent success/fallback mixtures, including mandatory large-brief stub',()=>{
  const s=minimal();s.dailyBriefs=[{id:'large',summary:'x'.repeat(70000)},{id:'small',summary:'x'.repeat(2000)}];
  const mandatory=legacyBriefProjection(s.dailyBriefs[0]);const candidates=[{index:0,stub:{id:'large',summary:'large stub'.repeat(1000)}},{index:1,stub:{id:'small',summary:'tiny'}}];
  const result=planCatalogueSaveCapacity(s,{...options(s),briefPlan:{candidates}});
  for(let mask=0;mask<4;mask++){const final=structuredClone(s);final.dailyBriefs=[mandatory,s.dailyBriefs[1]].map((b,i)=>mask&(1<<i)?candidates[i].stub:b);saveBookkeeping(final,at);assert.ok(compactStateBytes(final)<=result.maximumCandidateBytes);}
  const all=structuredClone(s);all.dailyBriefs=candidates.map(c=>c.stub);saveBookkeeping(all,at);assert.equal(result.candidateBytes,compactStateBytes(all));
});
test('optional fallback cannot rely on smaller successful archives to fit',()=>{
  const s=minimal();s.dailyBriefs=[{id:'brief',summary:'x'.repeat(60000)}];const briefPlan={candidates:[{index:0,stub:{id:'brief'}}]};
  assert.throws(()=>planCatalogueSaveCapacity(s,{...options(s),briefPlan,limits:{...limits,hard:5000}}),isCatalogueCapacityRejection);
});
test('automation plan is pure and success projection never mutates or acknowledges source state',()=>{
  const s=catalogueState();s._revision='before';s.automationRuns=Array.from({length:27},(_,i)=>({id:'old-'+i,ruleId:'profitGuard',status:'COMPLETED',startedAt:'2020-01-01T00:00:00.000Z',completedAt:'2020-01-01T00:00:01.000Z',evidence:[{detail:'x'.repeat(10000)}]}));const before=structuredClone(s),p=planAutomationRetention(s),runs=applyAutomationRetention(p,{acknowledgedArchives:p.archiveCandidates.map(c=>({...c.reference,confirmed:true}))}).automationRuns;
  assert.ok(p.archiveCandidates.length);const r=planCatalogueSaveCapacity(s,{...options(s),retainedAutomationRuns:runs});assert.ok(r.candidateBytes<r.currentBytes);assert.deepEqual(s,before);assert.equal(applyAutomationRetention(p).pendingArchives,p.archiveCandidates.length);
});
test('real store blocks oversized reservation before any audit archive, primary write or source request',async t=>{
  const state=catalogueState();state.padding='x'.repeat(2097152);state.audit=Array.from({length:301},(_,i)=>({id:'a'+i,type:'synthetic',createdAt:at}));const f=await fixture(t,{state});const r=await f.submit();
  assert.equal(r.payload.code,'SHOPIFY_CATALOGUE_CAPACITY_REVIEW_REQUIRED');assert.equal(f.calls.filter(c=>c.method!=='GET').length,0);assert.equal(f.reads.length,0);assert.deepEqual(f.fake.states.get(ID).audit,state.audit);assert.equal(f.fake.states.get(ID).shopifyCatalogueImports,undefined);
});
test('real store permits mandatory normal retention to bring a large snapshot below the cap',async t=>{
  const state=catalogueState();state.audit=Array.from({length:302},(_,i)=>({id:'a'+i,type:'synthetic',createdAt:at,detail:{fixture:i>299?'x'.repeat(900000):''}}));const f=await fixture(t,{state});const r=await f.submit();
  assert.equal(r.status,200,JSON.stringify(r.payload));assert.ok(f.calls.some(c=>c.url.pathname.endsWith('/audit_events')&&c.method==='POST'));assert.equal(f.fake.states.get(ID).audit.length,300);assert.ok(compactStateBytes(f.fake.states.get(ID))<2097152);
});
for(const mode of ['success','refused','unknown'])test('real store optional brief compaction '+mode+' uses safe retained fallback and preserves other data',async t=>{
  t.mock.method(console,'warn',()=>{});const state=catalogueState();state.dailyBriefs=[{id:'today',generatedAt:new Date().toISOString(),summary:'current'},
    {id:'old',generatedAt:'2020-01-01T00:00:00.000Z',summary:'old',logic:'deterministic-v2',rows:[{description:'x'.repeat(2000)}]}];
  const f=await fixture(t,{state,env:{BRIEF_HISTORY_COMPACTION_CONTRACT:BRIEF_HISTORY_CONTRACT},intercept:async({url,options,proceed})=>{
    if(url.pathname.endsWith('/operations_briefs') && mode!=='success') {
      if(mode==='unknown' && options.method==='POST'){await proceed();throw Error('synthetic lost optional acknowledgement');}
      return Response.json({code:'synthetic refusal'},{status:503});
    }return proceed();
  }});const r=await f.submit();assert.equal(r.status,200,JSON.stringify(r.payload));const saved=f.fake.states.get(ID);
  if(mode==='success')assert.ok(saved.dailyBriefs[1].archive);else assert.deepEqual(saved.dailyBriefs,state.dailyBriefs);
  for(const key of ['economics','users','orders','connections','settings'])assert.deepEqual(saved[key],state[key],key);
  assert.ok(compactStateBytes(saved)<2097152);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
});
test('real store mandatory large-brief and automation archives match planned size without bypassing acknowledgement',async t=>{
  const state=catalogueState();state.dailyBriefs=[{id:'large',generatedAt:at,summary:'original',rows:[{description:'x'.repeat(70000)}]}];
  state.automationRuns=Array.from({length:27},(_,i)=>({id:'old-'+i,ruleId:'profitGuard',status:'COMPLETED',startedAt:'2020-01-01T00:00:00.000Z',completedAt:'2020-01-01T00:00:01.000Z',evidence:[{detail:'x'.repeat(10000)}]}));
  const f=await fixture(t,{state}),r=await f.submit();assert.equal(r.status,200,JSON.stringify(r.payload));const saved=f.fake.states.get(ID);
  assert.ok(saved.dailyBriefs[0].archive);assert.equal(saved.automationRuns.length,25);assert.ok(f.calls.some(c=>c.method==='POST'&&c.url.pathname.endsWith('/runvara_history')));assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
});
test('final projected size failure leaves admitted claim but writes no replacement or final archives',async t=>{
  const state=catalogueState();state.padding='x'.repeat(1950000);const f=await fixture(t,{state,providerFetch:()=>response(page([product(1,{description:'x'.repeat(150000)})]))});
  const r=await f.submit();assert.equal(r.payload.code,'SHOPIFY_CATALOGUE_CAPACITY_REVIEW_REQUIRED');assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);assert.equal(f.fake.states.get(ID).shopifyCatalogueImports[0].status,'reserved');assert.deepEqual(f.fake.states.get(ID).products,state.products);const n=f.reads.length;await f.submit();assert.equal(f.reads.length,n);
});
test('uncertain required archive never becomes an acknowledgement or issues source reads',async t=>{
  const state=catalogueState();state.audit=Array.from({length:301},(_,i)=>({id:'a'+i,type:'synthetic',createdAt:at}));let attempts=0;
  const f=await fixture(t,{state,intercept:async({url,options,proceed})=>{if(url.pathname.endsWith('/audit_events')&&options.method==='POST'){attempts++;await proceed();throw Error('synthetic unknown archive');}return proceed();}});
  assert.equal((await f.submit()).payload.code,'SHOPIFY_CATALOGUE_COMMIT_UNCERTAIN');const count=attempts;assert.equal((await f.submit()).payload.code,'SHOPIFY_CATALOGUE_COMMIT_UNCERTAIN');assert.equal(attempts,count);assert.equal(f.reads.length,0);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0);assert.deepEqual(f.fake.states.get(ID).audit,state.audit);
});
