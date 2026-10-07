import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AI_MODEL_CATALOG, AI_PRICING_UPDATED_AT, configureAiEconomics, ensureAiEconomics, estimateAiCostUsd, normalizeAiUsage, publicAiSettings, routeAiWork } from '../lib/ai-economics.mjs';
import { createAiProvider } from '../lib/ai-provider.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';

test('public AI settings are a detached allowlist while server configuration stays lossless', () => {
  const governance = { version: 1, enabled: false, providers: { openai: { accountId: 'private-account' } } };
  const state = { aiEconomics: { routingMode: 'quality', monthlyCostLimitUsd: 0, pricingUpdatedAt: '2026-09-27',
    updatedAt: '2026-10-01T12:34:56.789Z', updatedBy: 'platform-owner', governance,
    credentials: { apiKey: 'synthetic-private-key' }, futurePrivateField: ['private-evidence'] } };
  const before = structuredClone(state);
  const projected = publicAiSettings(state.aiEconomics);
  assert.deepEqual(projected, { routingMode: 'quality', monthlyCostLimitUsd: 0, pricingUpdatedAt: '2026-09-27',
    updatedAt: '2026-10-01T12:34:56.789Z', updatedBy: 'platform-owner' });
  assert.deepEqual(state, before, 'the projector never mutates stored settings');
  assert.notEqual(projected, state.aiEconomics);
  projected.routingMode = 'economy'; projected.updatedBy = 'different-actor';
  assert.deepEqual(state, before, 'mutating the DTO cannot edit the server state');
  const retained = ensureAiEconomics(state);
  assert.equal(retained.governance, governance);
  const configured = configureAiEconomics(state, { routingMode: 'economy', monthlyCostLimitUsd: null,
    governance: { enabled: true }, credentials: 'ignored-client-input' }, 'owner');
  assert.equal(configured, state.aiEconomics, 'internal configure contract remains lossless');
  assert.equal(configured.governance, governance);
  assert.deepEqual(configured.credentials, before.aiEconomics.credentials);
  assert.deepEqual(configured.futurePrivateField, before.aiEconomics.futurePrivateField);
  assert.equal(publicAiSettings(configured).monthlyCostLimitUsd, null);
  assert.equal(publicAiSettings(configured).updatedBy, 'owner');
  assert.equal(publicAiSettings(configured).updatedAt, configured.updatedAt);
});

test('public AI settings preserve valid scalar bounds and fail closed for malformed values', () => {
  const defaults = { routingMode: 'balanced', monthlyCostLimitUsd: null, pricingUpdatedAt: AI_PRICING_UPDATED_AT };
  for (const value of [undefined, null, [], false, 0, 'private-string', {}]) assert.deepEqual(publicAiSettings(value), defaults);
  for (const value of [0, 12.5, 1000000, null]) assert.equal(publicAiSettings({ monthlyCostLimitUsd: value }).monthlyCostLimitUsd, value);
  for (const value of [undefined, -1, 1000001, NaN, Infinity, '10', {}, [], true]) {
    assert.equal(publicAiSettings({ monthlyCostLimitUsd: value }).monthlyCostLimitUsd, null);
  }
  for (const value of ['economy', 'balanced', 'quality']) assert.equal(publicAiSettings({ routingMode: value }).routingMode, value);
  for (const value of [null, {}, [], 'QUALITY', 'private-mode']) assert.equal(publicAiSettings({ routingMode: value }).routingMode, 'balanced');
  for (const value of [null, {}, [], 0, false, 'private-date', '2026-02-30', '2026-13-01', '2026-09-27'.repeat(1000)]) {
    assert.equal(publicAiSettings({ pricingUpdatedAt: value }).pricingUpdatedAt, AI_PRICING_UPDATED_AT);
  }
  assert.equal(publicAiSettings({ pricingUpdatedAt: '2024-02-29' }).pricingUpdatedAt, '2024-02-29');
  assert.deepEqual(publicAiSettings({ updatedAt: null, updatedBy: null }), { ...defaults, updatedAt: null, updatedBy: null });
  for (const updatedAt of ['2026-10-01T12:34:56Z', '2026-10-01T12:34:56.789Z']) {
    assert.equal(publicAiSettings({ updatedAt }).updatedAt, updatedAt);
  }
  for (const updatedBy of ['system', 'platform-owner', 'user_123', 'owner@example.test', 'x'.repeat(120)]) {
    assert.equal(publicAiSettings({ updatedBy }).updatedBy, updatedBy);
  }
  const nested = { credentials: { apiKey: 'synthetic-private-value' } };
  for (const value of [undefined, nested, [nested], new Date(), 0, false, '', ' ', 'x'.repeat(121)]) {
    const projected = publicAiSettings({ updatedAt: value, updatedBy: value });
    assert.deepEqual(projected, defaults);
  }
  for (const updatedAt of ['2026-02-30T12:34:56.789Z', '2026-10-01T25:00:00.000Z', '2026-10-01', '2026-10-01T12:34:56Z\n']) {
    assert.equal(Object.hasOwn(publicAiSettings({ updatedAt }), 'updatedAt'), false);
  }
  for (const updatedBy of ['actor\nprivate', 'actor\u0000private', 'actor\u007fprivate']) {
    assert.equal(Object.hasOwn(publicAiSettings({ updatedBy }), 'updatedBy'), false);
  }
});

test('public AI settings never traverse unknown fields, invoke accessors or inherit values', () => {
  const settings = Object.create({ routingMode: 'quality', monthlyCostLimitUsd: 99, pricingUpdatedAt: '2024-02-29',
    updatedAt: '2026-10-01T12:34:56.789Z', updatedBy: 'inherited-actor' });
  for (const key of ['governance', 'routingMode', 'monthlyCostLimitUsd', 'pricingUpdatedAt', 'updatedAt', 'updatedBy']) {
    Object.defineProperty(settings, key, { enumerable: true, get() { assert.fail('projector must not invoke accessors'); } });
  }
  settings.unknown = settings;
  settings.toJSON = () => assert.fail('projector must not serialize its input');
  assert.deepEqual(publicAiSettings(settings), publicAiSettings({}));
  assert.deepEqual(publicAiSettings(Object.getPrototypeOf(settings)), {
    routingMode: 'quality', monthlyCostLimitUsd: 99, pricingUpdatedAt: '2024-02-29',
    updatedAt: '2026-10-01T12:34:56.789Z', updatedBy: 'inherited-actor'
  });
  assert.deepEqual(publicAiSettings(Object.create(Object.getPrototypeOf(settings))), publicAiSettings({}));
  assert.ok(Buffer.byteLength(JSON.stringify(publicAiSettings({ updatedAt: '2026-10-01T12:34:56.789Z', updatedBy: '💡'.repeat(60) }))) < 1024);
});

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

test('a configured provider cannot bypass atomic admission through the legacy FileStore meter', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-ai-economics-'));
  const store=createStore({SAAS_STATE_FILE:path.join(dir,'state.json')});
  const state=seedWorkspaceState({}, {workspaceId:'alpha',email:'alpha@example.test',plan:'growth'});
  configureAiEconomics(state,{monthlyCostLimitUsd:10,routingMode:'balanced'},'owner');
  await store.save('alpha',state);
  const calls=[];
  const fetchImpl=async (...args) => { calls.push(args); assert.fail('FileStore cannot authorize a paid request'); };
  const provider=createAiProvider({env:{RUNVARA_OPENAI_ENABLED:'true',OPENAI_API_KEY:'test-key-long-enough-for-provider-check'},store,fetchImpl});
  const route=routeAiWork(state,{jobType:'agent_command',payload:{command:'check pricing'}});
  const result=await provider.enhanceCommander({workspaceId:'alpha',jobId:'job1',route,command:'check pricing',state,run:{summary:'Margins checked.',priorities:[],urgentRisks:[],workStatus:'COMPLETED'}});
  assert.equal(result.used,false);
  assert.equal(result.reason,'AI_USAGE_DURABLE_STORE_REQUIRED');
  assert.equal(calls.length,0);
  const month=await provider.monthlyUsage('alpha');
  assert.equal(month.totals.requests,0);
  assert.equal(month.totals.inputTokens,0);
  assert.equal(month.totals.estimatedCostUsd,0);
  assert.equal(JSON.stringify(store.aiUsage).includes('check pricing'),false);
  assert.equal(JSON.stringify(store.aiUsage).includes('Verified operator brief'),false);
  t.after(async()=>fs.rm(dir,{recursive:true,force:true}));
});

test('a zero owner cap remains intact when the durable accounting prerequisite blocks dispatch', async t => {
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
  assert.equal(result.reason,'AI_USAGE_DURABLE_STORE_REQUIRED');
  assert.equal(state.aiEconomics.monthlyCostLimitUsd,0);
  assert.equal(called,false);
  t.after(async()=>fs.rm(dir,{recursive:true,force:true}));
});
