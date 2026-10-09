import assert from 'node:assert/strict';
import { mock } from 'node:test';
import fs from 'node:fs/promises';
import { recoveryFixture } from './shopify-order-recovery-fixture.mjs';
import { beginConnectionSync } from '../lib/connection-centre.mjs';
import { monitoredSync } from '../lib/scheduler.mjs';

mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-09T05:00:00.000Z')});
async function ordinary(interrupted) {
  const f=recoveryFixture({count:500});if(interrupted)f.controls.providerFailureAt=9;
  for(let pass=0;pass<(interrupted?2:1);pass++) {
    const state=await f.get(),run=beginConnectionSync(state,'shopify',{areas:['orders'],actor:f.actor.id});await f.store.save(state.workspace.id,state);
    try { await monitoredSync(state,f.integrations,'shopify',{areas:['orders'],run,retry:false}); } catch {assert.equal(pass,0);}
    await f.store.save(state.workspace.id,state);if(interrupted && pass===0)mock.timers.tick(600001);
  }
  assert.equal(f.snapshot().orders.length,500);return f.metrics;
}
async function recovery(interrupted) {
  const f=recoveryFixture({count:500});if(interrupted)f.controls.providerFailureAt=9;
  let firstStartedAt;
  for(let pass=0;pass<(interrupted?2:1);pass++) {
    const state=await f.get(),preview=await f.runner.preview(state,f.actor);firstStartedAt ||= preview.originalStartedAt;assert.equal(preview.originalStartedAt,firstStartedAt);
    const result=await f.runner.run(state,f.actor,pass?'resume':'start',{selection:preview.selection});assert.equal(result.status,interrupted&&pass===0?'interrupted':'committed',JSON.stringify(result));
    if(interrupted&&pass===0)mock.timers.tick(600001);
  }
  assert.equal(f.snapshot().orders.length,500);assert.equal(f.snapshot().integrationStatus.shopify.lastSyncAt,firstStartedAt);
  assert.equal(f.metrics.stage_mutation.calls,interrupted?13:12);return f.metrics;
}
const totals=metrics=>Object.values(metrics).reduce((sum,row)=>({calls:sum.calls+row.calls,requestBytes:sum.requestBytes+row.requestBytes,responseBytes:sum.responseBytes+row.responseBytes}),{calls:0,requestBytes:0,responseBytes:0});
const cases={ordinaryNormal:await ordinary(false),recoveryNormal:await recovery(false),ordinaryInterrupted:await ordinary(true),recoveryInterrupted:await recovery(true)};
const report={schema:'runvara-order-recovery-byte-evidence/v1',fixture:{orders:500,pages:10,linesPerOrder:1,ordinaryRetryPolicy:'One bounded read per pass (retry:false); interrupted second pass replays the ordinary window from page one',interruption:'Ninth provider response fails after eight retained complete pages',transport:'Actual Supabase store/IntegrationService JSON bodies through synthetic PostgREST/provider responses; not network packet or monetary measurements'},cases:Object.fromEntries(Object.entries(cases).map(([name,metrics])=>[name,{categories:metrics,totals:totals(metrics)}]))};
report.interruptedDifference={providerRequests:cases.recoveryInterrupted.provider.calls-cases.ordinaryInterrupted.provider.calls,totalBodyBytes:totals(cases.recoveryInterrupted).requestBytes+totals(cases.recoveryInterrupted).responseBytes-totals(cases.ordinaryInterrupted).requestBytes-totals(cases.ordinaryInterrupted).responseBytes};
assert.equal(report.interruptedDifference.providerRequests,-8);
report.limitations=['Request/decoded JSON body bytes only; excludes headers,TLS,physical PostgreSQL rows/indexes/WAL/backups and provider snapshot guarantees.','Completion receipts retain logical quota indefinitely; no bandwidth,cost or monetary saving is claimed.','Every explicit review/hydration/current authority/primary/reporting/mirror body is counted; stage mutation ceiling is not total requests.'];
if(process.env.ORDER_RECOVERY_BUDGET_OUTPUT)await fs.writeFile(process.env.ORDER_RECOVERY_BUDGET_OUTPUT,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));mock.timers.reset();
