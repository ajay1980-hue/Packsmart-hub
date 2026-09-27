import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AI_MODEL_CATALOG, configureAiEconomics, estimateAiCostUsd, normalizeAiUsage, routeAiWork } from '../lib/ai-economics.mjs';
import { createAiProvider } from '../lib/ai-provider.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';

test('AI router respects workload type, operator mode and plan ceilings', () => {
  const starter=seedWorkspaceState({}, {workspaceId:'starter',email:'starter@example.test',plan:'starter'});
  configureAiEconomics(starter,{routingMode:'quality'},'owner');
  assert.equal(routeAiWork(starter,{jobType:'agent_command',payload:{command:'deep strategy audit'}}).model,'gpt-5.6-luna');

  const growth=seedWorkspaceState({}, {workspaceId:'growth',email:'growth@example.test',plan:'growth'});
  configureAiEconomics(growth,{routingMode:'balanced'},'owner');
  assert.equal(routeAiWork(growth,{jobType:'agent_command',payload:{command:'check pricing'}}).model,'gpt-5.6-terra');

  const pro=seedWorkspaceState({}, {workspaceId:'pro',email:'pro@example.test',plan:'pro'});
  configureAiEconomics(pro,{routingMode:'quality'},'owner');
  assert.equal(routeAiWork(pro,{jobType:'agent_command',payload:{command:'check pricing'}}).model,'gpt-5.6-sol');
  assert.equal(routeAiWork(pro,{jobType:'connection_doctor',payload:{}}).model,'deterministic');
});

test('AI token cost accounting handles cache writes and long context', () => {
  assert.equal(estimateAiCostUsd('gpt-5.6-luna',{inputTokens:100_000,outputTokens:100_000}),0.14);
  assert.equal(estimateAiCostUsd('gpt-5.6-terra',{inputTokens:200_000,cachedInputTokens:100_000,cacheWriteTokens:50_000,outputTokens:0}),0.245);
  assert.equal(estimateAiCostUsd('gpt-5.6-sol',{inputTokens:300_000,outputTokens:100_000}),5.4);
  const usage=normalizeAiUsage({workspaceId:'w',taskType:'agent_command',model:'gpt-5.6-luna',inputTokens:100,cachedInputTokens:20,cacheWriteTokens:10,outputTokens:50});
  assert.ok(usage.estimatedCostUsd>0);
  assert.throws(()=>normalizeAiUsage({workspaceId:'w',taskType:'agent_command',model:'gpt-5.6-luna',inputTokens:10,cachedInputTokens:8,cacheWriteTokens:5}),error=>error.code==='AI_USAGE_INVALID');
  assert.equal(AI_MODEL_CATALOG.deterministic.outputPerMillionUsd,0);
});

test('metered provider records measured tokens without storing prompt or response content', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-ai-economics-'));
  const store=createStore({SAAS_STATE_FILE:path.join(dir,'state.json')});
  const state=seedWorkspaceState({}, {workspaceId:'alpha',email:'alpha@example.test',plan:'growth'});
  configureAiEconomics(state,{monthlyCostLimitUsd:10,routingMode:'balanced'},'owner');
  await store.save('alpha',state);
  const calls=[];
  const fetchImpl=async (url,options) => {
    calls.push({url:String(url),body:JSON.parse(options.body)});
    return new Response(JSON.stringify({
      id:'resp_test_metered',
      output:[{type:'message',content:[{type:'output_text',text:'Verified operator brief.'}]}],
      usage:{input_tokens:1000,input_tokens_details:{cached_tokens:100,cache_write_tokens:200},output_tokens:120}
    }),{status:200,headers:{'Content-Type':'application/json'}});
  };
  const provider=createAiProvider({env:{RUNVARA_OPENAI_ENABLED:'true',OPENAI_API_KEY:'test-key-long-enough-for-provider-check'},store,fetchImpl});
  const route=routeAiWork(state,{jobType:'agent_command',payload:{command:'check pricing'}});
  const result=await provider.enhanceCommander({workspaceId:'alpha',jobId:'job1',route,command:'check pricing',state,run:{summary:'Margins checked.',priorities:[],urgentRisks:[],workStatus:'COMPLETED'}});
  assert.equal(result.used,true);
  assert.equal(result.summary,'Verified operator brief.');
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.store,false);
  assert.equal(calls[0].body.model,'gpt-5.6-terra');
  const month=await provider.monthlyUsage('alpha');
  assert.equal(month.totals.requests,1);
  assert.equal(month.totals.inputTokens,1000);
  assert.ok(month.totals.estimatedCostUsd>0);
  assert.equal(JSON.stringify(store.aiUsage).includes('check pricing'),false);
  assert.equal(JSON.stringify(store.aiUsage).includes('Verified operator brief'),false);
  t.after(async()=>fs.rm(dir,{recursive:true,force:true}));
});

test('monthly cost guard skips paid model call before a known limit can be exceeded', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-ai-cap-'));
  const store=createStore({SAAS_STATE_FILE:path.join(dir,'state.json')});
  const state=seedWorkspaceState({}, {workspaceId:'cap',email:'cap@example.test',plan:'pro'});
  configureAiEconomics(state,{monthlyCostLimitUsd:0,routingMode:'quality'},'owner');
  await store.save('cap',state);
  let called=false;
  const provider=createAiProvider({env:{RUNVARA_OPENAI_ENABLED:'true',OPENAI_API_KEY:'test-key-long-enough-for-provider-check'},store,fetchImpl:async()=>{called=true;throw new Error('must not call');}});
  const route=routeAiWork(state,{jobType:'agent_command',payload:{command:'deep strategy'}});
  const result=await provider.enhanceCommander({workspaceId:'cap',jobId:'job-cap',route,command:'deep strategy',state,run:{summary:'Verified findings',priorities:[],urgentRisks:[],workStatus:'COMPLETED'}});
  assert.equal(result.used,false);
  assert.equal(result.reason,'AI_MONTHLY_COST_LIMIT');
  assert.equal(called,false);
  t.after(async()=>fs.rm(dir,{recursive:true,force:true}));
});
