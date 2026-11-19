// Uses the existing disposable PostgreSQL harness and actual production RPCs.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const hash=x=>createHash('sha256').update(x).digest('hex');
export const unknownExposure={status:'unknown',costMicros:null,reconciled:false};
const G='public.runvara_provider_future_allowances';
const R='public.runvara_provider_usage_reservations';
const W='public.runvara_provider_usage_windows';

export async function futureEvidence(api,f,patch={}) {
  const now=Date.now();
  return {version:1,workspaceId:f.workspaceId,grantId:'grant-'+randomUUID(),currency:'USD',scope:'additional_after_cutover',
    historicalExposure:unknownExposure,evidenceHash:hash('SYNTHETIC-NOT-APPROVAL'),verifiedAt:now,approvedAt:now-1000,
    expiresAt:now+300000,legacyDispatchStoppedAt:now-1000,legacyDispatchersRetired:true,inflightDrained:true,
    futureAccountVerified:true,exclusiveDispatchScope:true,
    legacyUsageFingerprint:(await api.admin.query('SELECT public.runvara_legacy_usage_fingerprint($1) AS x',[f.workspaceId])).rows[0].x,
    credentialDigest:hash('synthetic-provider-key-only'),organizationId:'org_synthetic',projectId:'proj_synthetic',
    limits:{maxRequests:3,maxInputTokens:1000,maxOutputTokens:1000,maxTotalTokens:2000,maxCostMicros:30000},...patch};
}
export async function installFuture(api,f,evidence,client=api.admin) {
  return (await client.query('SELECT public.runvara_install_future_provider_allowance($1,$2) AS x',[f.workspaceId,evidence])).rows[0].x;
}
export async function enableFuture(api,f,installed) {
  f.governance.enabled=true; f.governance.accountingStartAt=installed.accountingStartAt;
  f.governance.configuredAt=Date.now(); f.governance.futureAllowance=installed.futureAllowance;
  f.governance.providers.openai.adapters['openai-responses'].atomicUsageCutoverAt=installed.futureAllowance.legacyDispatchStoppedAt;
  await api.saveState(f);
  // Synthetic jobs only: production must enqueue new jobs rather than edit history.
  await api.admin.query('UPDATE public.runvara_agent_jobs SET created_at=clock_timestamp() WHERE workspace_id=$1',[f.workspaceId]);
}
export async function futureFixture(api,options={},patch={}) {
  const f=await api.openingFixture(options);
  const e=await futureEvidence(api,f,patch); const installed=await installFuture(api,f,e);
  await enableFuture(api,f,installed); return {...f,evidence:e,installed};
}
export const futureRequest=(request,f,index=0,patch={})=>request(f,index,{
  futureGrantId:f.governance.futureAllowance.grantId,credentialDigest:f.governance.futureAllowance.credentialDigest,...patch});
export async function reserveFuture(c,r) {
  return (await c.query(`SELECT public.runvara_reserve_provider_usage($1::text,$2::text,$3::text,$4::integer,$5::text,$6::text,
    $7::text,$8::text,$9::text,$10::bigint,$11::bigint,$12::text,$13::timestamptz,$14::text,$15::text) AS x`,
  [r.workspaceId,r.jobId,r.workerId,r.attempt,r.callKey,r.fingerprint,r.provider,r.adapter,r.model,r.input,r.output,r.pricing,r.validUntil,
    r.futureGrantId??null,r.credentialDigest??null])).rows[0].x;
}

export async function runFutureAllowanceCases(t,api) {
  const {admin,using,openingFixture,openingEvidence,installOpening,request,reserve,windows,reservations,saveState,
    legacyRow,measured,finish,receipt,waitUntilBlocked}=api;
  const admit=(f,i=0,patch={})=>using('service_role',c=>reserveFuture(c,futureRequest(request,f,i,patch)));
  const deny=(r,reason)=>{assert.equal(r.dispatch_allowed,false);assert.equal(r.reason,reason);};
  const grant=async f=>(await admin.query(`SELECT * FROM ${G} WHERE workspace_id=$1`,[f.workspaceId])).rows;
  await t.test('admin-only installation preserves unknown historical records, records actual time and stays disabled',async()=>{
    const f=await openingFixture();await legacyRow(f,{cost:1.5});const history=await measured(f);
    const e=await futureEvidence(api,f),start=Date.now(),v=await installFuture(api,f,e);
    assert.ok(v.accountingStartAt>=start && v.accountingStartAt<=Date.now());
    assert.deepEqual(v.futureAllowance.historicalExposure,unknownExposure);assert.deepEqual(await measured(f),history);
    assert.equal(f.governance.enabled,false);assert.deepEqual(await windows(f),[]);assert.deepEqual(await reservations(f),[]);
    deny(await using('service_role',c=>reserve(c,request(f))),'AI_GOVERNANCE_NOT_CONFIGURED');
    assert.equal((await installFuture(api,f,e)).idempotent,true);
    await assert.rejects(installFuture(api,f,{...e,grantId:'different'}),/AI_FUTURE_GRANT_CONFLICT/);
    for(const role of ['service_role','anon','authenticated']) await using(role,async c=>{
      await assert.rejects(installFuture(api,f,e,c),x=>x.code==='42501');
      await assert.rejects(c.query(`DELETE FROM ${G} WHERE workspace_id=$1`,[f.workspaceId]),x=>x.code==='42501');
    });
    await assert.rejects(installOpening(f,await openingEvidence(f,{openai:{requests:2,inputTokens:8,outputTokens:12,totalTokens:20,costMicros:2000000}})),/AI_ACCOUNTING_SCOPE_CONFLICT/);
    await enableFuture(api,f,v);
    assert.equal((await admit(f)).dispatch_allowed,true,'Known legacy rows above the new allowance remain outside its explicit scope');
    assert.deepEqual(await measured(f),history);
    assert.equal((await reservations(f))[0].reserved_cost_micros,'10000');
  });
  await t.test('reject malformed evidence, invented zero/history, absent retirement, future times and unsafe limits atomically',async()=>{
    for(const patch of [{historicalExposure:{...unknownExposure,costMicros:0}},{inflightDrained:false},
      {legacyDispatchersRetired:false},{futureAccountVerified:false},{exclusiveDispatchScope:false},{scope:'whole_month'},
      {organizationId:'org\r\ninjected'},{projectId:null},{credentialDigest:'bad'},
      {verifiedAt:Date.now()+60000},{expiresAt:Date.now()-1},{limits:{maxRequests:1}},
      {limits:{maxRequests:1,maxInputTokens:1,maxOutputTokens:1,maxTotalTokens:1,maxCostMicros:9007199254740992}},
      {unrecognised:true}]) {
      const f=await openingFixture();await assert.rejects(installFuture(api,f,await futureEvidence(api,f,patch)),x=>x.code==='22023');
      assert.deepEqual(await grant(f),[]);assert.deepEqual(await windows(f),[]);assert.deepEqual(await reservations(f),[]);
    }
  });
  await t.test('concurrent exact installation has one effect; lost acknowledgement cannot create a replacement',async()=>{
    const f=await openingFixture(),e=await futureEvidence(api,f);
    const results=await Promise.all(Array.from({length:8},()=>using('postgres',c=>installFuture(api,f,e,c))));
    assert.equal(results.filter(x=>!x.idempotent).length,1);assert.equal((await grant(f)).length,1);
    assert.equal(new Set(results.map(x=>x.accountingStartAt)).size,1);
    assert.equal((await installFuture(api,f,e)).idempotent,true);
    assert.equal((await admin.query('SELECT state#>\'{aiEconomics,governance,enabled}\' AS enabled FROM public.saas_workspace_state WHERE workspace_id=$1',[f.workspaceId])).rows[0].enabled,false);
  });
  await t.test('initial grant cannot replace an existing opening/window/reservation or install under active/absent governance',async()=>{
    for(const mode of ['opening','window','reservation','active','absent']) {
      const f=await openingFixture();
      if(mode==='opening')await installOpening(f,await openingEvidence(f));
      if(mode==='window')await admin.query(`INSERT INTO ${W}(workspace_id,scope_key,window_start) VALUES($1,'tenant',date_trunc('month',now())::date)`,[f.workspaceId]);
      if(mode==='reservation'){f.governance.enabled=true;await saveState(f);await using('service_role',c=>reserve(c,request(f)));f.governance.enabled=false;await saveState(f);}
      if(mode==='active'){f.governance.enabled=true;await saveState(f);}
      if(mode==='absent'){delete f.state.aiEconomics.governance;await saveState(f);}
      await assert.rejects(installFuture(api,f,await futureEvidence(api,f)),x=>x.code==='22023');assert.deepEqual(await grant(f),[]);
    }
  });
  await t.test('competing verified opening and future grant installations cannot both commit',async()=>{
    const f=await openingFixture(),future=await futureEvidence(api,f),opening=await openingEvidence(f);
    const outcomes=await Promise.allSettled([
      using('postgres',c=>installFuture(api,f,future,c)),using('postgres',c=>installOpening(f,opening,c))]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    const openings=(await admin.query('SELECT * FROM public.runvara_provider_usage_openings WHERE workspace_id=$1',[f.workspaceId])).rows;
    assert.equal(openings.length+(await grant(f)).length,1);
    assert.equal((await windows(f)).length,openings.length?2:0);
    assert.deepEqual(await reservations(f),[]);
  });
  await t.test('30 distinct sessions obey one cumulative grant and retain every independent monthly limit',async()=>{
    const f=await futureFixture(api,{count:30});
    const results=await Promise.all(Array.from({length:30},(_,i)=>admit(f,i)));
    assert.equal(results.filter(r=>r.dispatch_allowed).length,3);
    results.filter(r=>!r.dispatch_allowed).forEach(r=>deny(r,'AI_FUTURE_ALLOWANCE_EXHAUSTED'));
    assert.equal((await reservations(f)).length,3);assert.equal((await windows(f)).length,2);
    assert.deepEqual((await grant(f))[0].policy.historicalExposure,unknownExposure);
    const tight=await futureFixture(api,{mutate(g){g.tenantLimits.maxRequests=0;}});
    deny(await admit(tight),'AI_BUDGET_EXCEEDED');
  });
  for(const [key,value] of Object.entries({maxRequests:1,maxInputTokens:4,maxOutputTokens:6,maxTotalTokens:10,maxCostMicros:10000})){
    await t.test('future grant independently enforces '+key,async()=>{
      const f=await futureFixture(api,{}, {limits:{maxRequests:10,maxInputTokens:100,maxOutputTokens:100,maxTotalTokens:200,maxCostMicros:100000,[key]:value}});
      assert.equal((await admit(f)).dispatch_allowed,true);deny(await admit(f,1),'AI_FUTURE_ALLOWANCE_EXHAUSTED');
    });
  }
  await t.test('settled, uncertain and cancelled reservations never replenish or replay the lifetime grant',async()=>{
    for(const outcome of ['complete','uncertain','cancelled_pre_dispatch']){
      const f=await futureFixture(api,{}, {limits:{maxRequests:1,maxInputTokens:100,maxOutputTokens:100,maxTotalTokens:200,maxCostMicros:100000}});
      const r=futureRequest(request,f),a=await admit(f);
      await finish(r,a.reservation_id,outcome,outcome==='complete'?receipt(r):outcome==='uncertain'?{jobId:r.jobId,errorCode:'SYNTHETIC'}:{jobId:r.jobId,dispatchStarted:false,proof:'local_pre_dispatch'});
      deny(await admit(f),'AI_LOGICAL_CALL_EXISTS');deny(await admit(f,1),'AI_FUTURE_ALLOWANCE_EXHAUSTED');
      assert.equal((await reservations(f))[0].reserved_cost_micros,'10000');
    }
  });
  await t.test('old RPC, forged scope/binding, other tenant, changed policy and pre-cutover jobs cannot bypass grant',async()=>{
    const f=await futureFixture(api),other=await futureFixture(api);
    deny(await using('service_role',c=>reserve(c,request(f))),'AI_FUTURE_ALLOWANCE_UNVERIFIED');
    for(const patch of [{futureGrantId:other.installed.futureAllowance.grantId},{credentialDigest:hash('wrong')},{provider:'xai'},
      {validUntil:new Date(f.installed.futureAllowance.expiresAt+1000).toISOString()}])deny(await admit(f,0,patch),'AI_FUTURE_ALLOWANCE_UNVERIFIED');
    deny(await admit(f,0,{jobId:other.jobs[0],callKey:other.jobs[0]+':operator-brief:v1'}),'AI_JOB_LEASE_INVALID');
    f.governance.futureAllowance.limits.maxRequests++;await saveState(f);deny(await admit(f),'AI_FUTURE_ALLOWANCE_UNVERIFIED');
    f.governance.futureAllowance=structuredClone(f.installed.futureAllowance);await saveState(f);
    await admin.query(`UPDATE public.runvara_agent_jobs SET created_at='2000-01-01' WHERE workspace_id=$1`,[f.workspaceId]);
    deny(await admit(f),'AI_FUTURE_ALLOWANCE_UNVERIFIED');assert.deepEqual(await reservations(f),[]);
  });
  await t.test('legacy drift during a real counter wait blocks the same admission',async()=>{
    const f=await futureFixture(api);
    await admin.query(`INSERT INTO ${W}(workspace_id,scope_key,window_start) VALUES($1,'tenant',date_trunc('month',now())::date)`,[f.workspaceId]);
    await using('postgres',async holder=>{await holder.query('BEGIN');try{
      await holder.query(`SELECT * FROM ${W} WHERE workspace_id=$1 FOR UPDATE`,[f.workspaceId]);
      await using('service_role',async c=>{
        const cp=(await c.query('select pg_backend_pid() as p')).rows[0].p,hp=(await holder.query('select pg_backend_pid() as p')).rows[0].p;
        const pending=reserveFuture(c,futureRequest(request,f));await waitUntilBlocked(admin,cp,hp);
        await legacyRow(f);await holder.query('COMMIT');deny(await pending,'AI_FUTURE_ALLOWANCE_UNVERIFIED');
      });
    }finally{await holder.query('ROLLBACK');}});
    assert.deepEqual(await reservations(f),[]);
  });
  await t.test('transaction rollback leaves no grant; failed counters leave no reservation or exposure',async()=>{
    const f=await openingFixture(),e=await futureEvidence(api,f);
    await using('postgres',async c=>{await c.query('BEGIN');await installFuture(api,f,e,c);await c.query('ROLLBACK');});
    assert.deepEqual(await grant(f),[]);
    await enableFuture(api,f,await installFuture(api,f,e));
    await admin.query(`CREATE FUNCTION public.synthetic_future_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.scope_key='provider:openai' THEN RAISE EXCEPTION 'synthetic counter failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_future_failure BEFORE UPDATE ON ${W} FOR EACH ROW EXECUTE FUNCTION public.synthetic_future_failure()`);
    try{await assert.rejects(admit(f),/synthetic counter failure/);assert.deepEqual(await reservations(f),[]);assert.deepEqual(await windows(f),[]);}
    finally{await admin.query(`DROP TRIGGER synthetic_future_failure ON ${W};DROP FUNCTION public.synthetic_future_failure()`);}
  });
  await t.test('absolute grant expiry is checked after a real counter lock wait',async()=>{
    const f=await futureFixture(api,{}, {expiresAt:Date.now()+1000});
    await admin.query(`INSERT INTO ${W}(workspace_id,scope_key,window_start) VALUES($1,'tenant',date_trunc('month',now())::date)`,[f.workspaceId]);
    await using('postgres',async holder=>{await holder.query('BEGIN');try{
      await holder.query(`SELECT * FROM ${W} WHERE workspace_id=$1 FOR UPDATE`,[f.workspaceId]);
      await using('service_role',async c=>{
        const cp=(await c.query('select pg_backend_pid() as p')).rows[0].p,hp=(await holder.query('select pg_backend_pid() as p')).rows[0].p;
        const pending=reserveFuture(c,futureRequest(request,f,0,{validUntil:new Date(f.installed.futureAllowance.expiresAt).toISOString()}));
        await waitUntilBlocked(admin,cp,hp);await delay(Math.max(0,f.installed.futureAllowance.expiresAt-Date.now()+30));
        await holder.query('COMMIT');deny(await pending,'AI_ADMISSION_EVIDENCE_EXPIRED');
      });
    }finally{await holder.query('ROLLBACK');}});
    assert.deepEqual(await reservations(f),[]);
  });
  await t.test('provider overrun freezes further future admissions and retains the original reservation bound',async()=>{
    const f=await futureFixture(api),r=futureRequest(request,f),a=await admit(f);
    await finish(r,a.reservation_id,'complete',receipt(r,{inputTokens:r.input+1,totalTokens:r.input+r.output+1}));
    assert.equal((await reservations(f))[0].status,'overrun');
    deny(await admit(f,1),'AI_PROVIDER_OVERRUN_BLOCKED');
  });
  await t.test('zero is a valid hard stop and prior-month reservations remain consumed',async()=>{
    const z=await futureFixture(api,{}, {limits:{maxRequests:0,maxInputTokens:0,maxOutputTokens:0,maxTotalTokens:0,maxCostMicros:0}});
    deny(await admit(z),'AI_FUTURE_ALLOWANCE_EXHAUSTED');
    const f=await futureFixture(api,{}, {limits:{maxRequests:1,maxInputTokens:100,maxOutputTokens:100,maxTotalTokens:200,maxCostMicros:100000}});
    await admit(f);
    // Local administrator simulation only. Never edit real reservation history.
    await admin.query(`UPDATE ${R} SET window_start=(date_trunc('month',now())-interval '1 month')::date WHERE workspace_id=$1`,[f.workspaceId]);
    deny(await admit(f,1),'AI_FUTURE_ALLOWANCE_EXHAUSTED');
  });
}
