import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { createAgentOperations, configureAgentOps } from '../lib/agent-ops.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-agent-ops-'));
  const store = createStore({ SAAS_STATE_FILE:path.join(dir,'state.json') });
  for (const workspaceId of ['alpha','beta']) {
    const state = seedWorkspaceState({}, { workspaceId, email:`${workspaceId}@example.test`, passwordHash:'fixture' });
    state.subscription.plan = 'pro';
    await store.save(workspaceId, state);
  }
  const locks = new Map();
  async function withWorkspaceLock(workspaceId, callback) {
    const previous = locks.get(workspaceId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release=resolve; });
    const queued = previous.then(()=>current);
    locks.set(workspaceId,queued);
    await previous;
    try { return await callback(); }
    finally { release(); if (locks.get(workspaceId) === queued) locks.delete(workspaceId); }
  }
  const ops = createAgentOperations({ store, integrations:{}, withWorkspaceLock, enabled:false });
  t.after(async()=>{ ops.stop(); await fs.rm(dir,{recursive:true,force:true}); });
  return { store, ops };
}

test('agent operations queue is tenant scoped, idempotent and rejects unsafe job types', async t => {
  const {store,ops}=await fixture(t);
  const first=await ops.enqueue('alpha',{type:'agent_command',payload:{command:'check everything'},idempotencyKey:'same-key'},'alpha-owner');
  const duplicate=await ops.enqueue('alpha',{type:'agent_command',payload:{command:'check everything'},idempotencyKey:'same-key'},'alpha-owner');
  const other=await ops.enqueue('beta',{type:'agent_command',payload:{command:'check everything'},idempotencyKey:'same-key'},'beta-owner');
  assert.equal(first.id,duplicate.id);
  assert.notEqual(first.id,other.id);
  assert.equal((await ops.workspaceSnapshot('alpha')).jobs.some(job=>job.workspace_id==='beta'),false);
  await assert.rejects(()=>ops.enqueue('alpha',{type:'refund',payload:{}},'alpha-owner'),error=>error.code==='AGENT_JOB_TYPE_INVALID');

  const a2=await ops.enqueue('alpha',{type:'marketing_plan',idempotencyKey:'alpha-second'},'alpha-owner');
  const claimed=await store.claimAgentJobs('worker-test',8,300);
  assert.equal(claimed.filter(job=>job.workspace_id==='alpha').length,1,'one job per workspace is claimed per pass for fair tenant scheduling');
  assert.equal(claimed.filter(job=>job.workspace_id==='beta').length,1);
  assert.ok([first.id,a2.id].includes(claimed.find(job=>job.workspace_id==='alpha').id));
});

test('agent worker executes safe analysis with no external writes and records bounded usage', async t => {
  const {store,ops}=await fixture(t);
  const alpha=await store.get('alpha');
  configureAgentOps(alpha,{dailyAiUnitLimit:2,maxConcurrentJobs:2},'owner');
  await store.save('alpha',alpha);
  await ops.enqueue('alpha',{type:'agent_command',payload:{command:'check business health'},idempotencyKey:'health-1'},'owner');
  await ops.tick();
  const snapshot=await ops.workspaceSnapshot('alpha');
  assert.equal(snapshot.counts.succeeded,1);
  const completed=snapshot.jobs.find(job=>job.idempotency_key==='health-1');
  assert.equal(completed.result.externalWrites,false);
  assert.equal(snapshot.usage.aiUnitsToday,1);
  await ops.enqueue('alpha',{type:'marketing_plan',idempotencyKey:'marketing-1'},'owner');
  await assert.rejects(()=>ops.enqueue('alpha',{type:'agent_command',payload:{command:'another analysis'},idempotencyKey:'health-2'},'owner'),error=>error.code==='AI_BUDGET_REACHED');
});

test('dead-letter retry cannot cross tenants and returns the same durable job to the queue', async t => {
  const {store,ops}=await fixture(t);
  const job=await ops.enqueue('alpha',{type:'agent_command',payload:{command:'stock check'},idempotencyKey:'retry-me'},'owner');
  const [claimed]=await store.claimAgentJobs('worker-retry',1,300);
  assert.equal(claimed.id,job.id);
  await store.finishAgentJob(claimed,{status:'dead_letter',errorCode:'TEST_FAILURE',completedAt:new Date().toISOString()});
  await assert.rejects(()=>ops.retry('beta',job.id,'beta-owner'),error=>error.code==='AGENT_JOB_NOT_FOUND');
  const retried=await ops.retry('alpha',job.id,'alpha-owner');
  assert.equal(retried.id,job.id);
  assert.equal(retried.status,'queued');
  assert.equal(retried.attempts,0);
});

test('expired worker leases are recovered without claiming two jobs from one tenant in a pass', async t => {
  const {store,ops}=await fixture(t);
  const one=await ops.enqueue('alpha',{type:'agent_command',payload:{command:'health'},idempotencyKey:'lease-1'},'owner');
  await ops.enqueue('alpha',{type:'agent_command',payload:{command:'stock'},idempotencyKey:'lease-2'},'owner');
  const [claimed]=await store.claimAgentJobs('worker-old',8,0);
  assert.equal(claimed.id,one.id);
  claimed.lease_until=new Date(Date.now()-1000).toISOString();
  const stored=store.agentJobs.find(item=>item.id===claimed.id);stored.lease_until=claimed.lease_until;
  const recovered=await store.claimAgentJobs('worker-new',8,300);
  assert.equal(recovered.filter(job=>job.workspace_id==='alpha').length,1);
  assert.ok(recovered.some(job=>job.id===one.id || job.idempotency_key==='lease-2'));
});
