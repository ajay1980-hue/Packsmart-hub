import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { createAgentOperations } from '../lib/agent-ops.mjs';

async function setup(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-fleet-'));
  const store=createStore({SAAS_STATE_FILE:path.join(dir,'state.json')});
  for (const workspaceId of ['packsmart-solutions','tenant-two']) {
    const state=seedWorkspaceState({}, {workspaceId,email:workspaceId+'@example.test',passwordHash:'fixture'});
    state.subscription={...state.subscription,plan:workspaceId==='packsmart-solutions'?'customer-zero':'growth',status:'active'};
    state.exceptions=[{id:'ex1',status:'open'}];
    state.approvals=[{id:'ap1',status:'pending'}];
    state.integrationStatus={shopify:{status:workspaceId==='tenant-two'?'degraded':'connected'}};
    await store.save(workspaceId,state);
  }
  const locks=new Map();
  async function withWorkspaceLock(workspaceId,callback){
    const previous=locks.get(workspaceId)||Promise.resolve(); let release;
    const current=new Promise(resolve=>{release=resolve;}); const queued=previous.then(()=>current);
    locks.set(workspaceId,queued); await previous;
    try{return await callback();}finally{release();if(locks.get(workspaceId)===queued)locks.delete(workspaceId);}
  }
  const ops=createAgentOperations({store,integrations:{},withWorkspaceLock,enabled:false});
  t.after(async()=>{ops.stop();await fs.rm(dir,{recursive:true,force:true});});
  return {store,ops};
}

test('operator fleet snapshot exposes health metadata but not customer job payloads', async t => {
  const {ops}=await setup(t);
  await ops.enqueue('tenant-two',{type:'agent_command',payload:{command:'private customer instruction'},idempotencyKey:'private-job'},'tenant-owner');
  const fleet=await ops.fleetSnapshot();
  assert.equal(fleet.totals.workspaces,2);
  const tenant=fleet.workspaces.find(item=>item.workspaceId==='tenant-two');
  assert.equal(tenant.unhealthyConnections,1);
  assert.equal(tenant.openExceptions,1);
  assert.equal(tenant.pendingApprovals,1);
  assert.equal(tenant.jobs.length,1);
  assert.equal(Object.hasOwn(tenant.jobs[0],'payload'),false);
  assert.equal(Object.hasOwn(tenant.jobs[0],'result'),false);
  assert.equal(JSON.stringify(fleet).includes('private customer instruction'),false);
});

test('operator controls can pause a selected workspace without changing another tenant', async t => {
  const {ops}=await setup(t);
  const updated=await ops.configureWorkspace('tenant-two',{paused:true,maxConcurrentJobs:4,dailyAiUnitLimit:75},'platform-owner');
  assert.equal(updated.paused,true);
  assert.equal(updated.maxConcurrentJobs,4);
  assert.equal(updated.dailyAiUnitLimit,75);
  const fleet=await ops.fleetSnapshot();
  assert.equal(fleet.workspaces.find(item=>item.workspaceId==='tenant-two').paused,true);
  assert.equal(fleet.workspaces.find(item=>item.workspaceId==='packsmart-solutions').paused,false);
  await assert.rejects(()=>ops.configureWorkspace('missing-workspace',{paused:true},'platform-owner'),error=>error.code==='WORKSPACE_NOT_FOUND');
});
