// Imported only by the opted-in disposable PostgreSQL test harness. This
// bounded synthetic PostgREST bridge runs real workspace/receipt transactions,
// while unrelated reporting mirrors, job history and Shopify stay synthetic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore } from '../lib/store.mjs';
import { executeConnectionWrite, proposeConnectionWrite, prepareObjectiveContentRequest } from '../lib/connection-writes.mjs';
import { objectiveContentContext } from '../lib/objective-content-source.mjs';
import { resolveManualContentTarget } from '../lib/manual-content-target.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { CONTENT_EXECUTION_RECEIPT_CONTRACT } from '../lib/content-execution-receipt.mjs';
import { validateReviewedSourceAction } from '../lib/reviewed-action-evidence.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { originalContentPreimages } from './content-jsonb-test-fixture.mjs';
import { objectiveContentSeed, objectiveContentJob, objectiveContentBody, approveObjectiveContent,
  CONTENT_PRODUCT, CONTENT_ACCOUNT } from './objective-content-fixture.mjs';

async function seededRequest(family, workspaceId) {
  const initial = objectiveContentSeed({ workspaceId }), fake = fakeSupabase();
  const seedStore = createStore({ SUPABASE_URL: 'https://receipt-bridge.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' }, { fetchImpl: fake.fetchImpl });
  const state = initial.state;
  if (family === 'manual') state.businessObjectives = [];
  await seedStore.save(workspaceId, state);
  if (family === 'objective') {
    const job = objectiveContentJob(state, initial.objective, { id: `job_${randomUUID()}` });
    fake.tables.set('runvara_agent_jobs', [job]);
    const loadJob = async () => job;
    const context = await objectiveContentContext(state, job.id, 'opportunity-content', initial.session, loadJob);
    await prepareObjectiveContentRequest(state, objectiveContentBody(context, `receipt_bridge_${randomUUID()}`), initial.session,
      { loadJob, persist: options => seedStore.save(workspaceId, state, options) });
  } else {
    proposeConnectionWrite(state, 'shopify', { operation: 'product_content', requestId: `receipt_bridge_${randomUUID()}`,
      productId: CONTENT_PRODUCT, title: 'Synthetic exact title 雪', description: 'Synthetic <approved> text & details.\nSecond line.',
      target: resolveManualContentTarget(state).target }, initial.session.userId);
  }
  approveObjectiveContent(state, state.connectionWrites[0]);
  await seedStore.save(workspaceId, state);
  return { ...initial, state, fake, expected: originalContentPreimages(state, state.connectionWrites[0]) };
}

export async function runContentReceiptDispatcherPgTests({ admin, withService }) {
  assert.equal((await admin.query('SELECT mode FROM public.runvara_content_receipt_control WHERE id')).rows[0].mode, 'enforced');
  const summaries = [];
  for (const family of ['manual','objective']) for (const mode of ['normal','lost-reserve','lost-reserve-newer','lost-final','lost-final-newer',
    'quota-refused','paused-refused','missing-rpc','unknown-reserve-absent','unknown-reserve-committed','unknown-reserve-denied','unknown-reserve-cancelled']) {
    const workspaceId = `receipt-dispatch-${randomUUID()}`, f = await seededRequest(family, workspaceId);
    await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [workspaceId]);
    await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [workspaceId, f.state]);
    if (mode === 'quota-refused') {
      // Synthetic administrator fixture: this tenant's prior capacity is full.
      // No existing counter is reset, decreased, or reused.
      await admin.query("INSERT INTO public.runvara_content_receipt_quotas(scope_key,workspace_id,quota) VALUES('tenant:'||$1,$1,jsonb_build_object('schema','runvara-content-receipt-quota/v1','attempts',256,'reservedBytes',256*40960))", [workspaceId]);
    }
    const trace = [], counters = { provider: 0, reserve: 0, finalize: 0, lookup: 0, fresh: 0, reporting: 0, generic: 0 };
    let dropped = false, newerRevision = null, receiptSource = null;
    const currentState = async () => (await withService(c => c.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [workspaceId]))).rows[0].state;
    const syncFake = async () => { const current = await currentState(); assert.ok(Buffer.byteLength(JSON.stringify(current)) < 2097152); f.fake.states.set(workspaceId, current); return current; };
    const fetchImpl = async (input, options = {}) => {
      const url = new URL(input), name = url.pathname.split('/').pop(), method = options.method || 'GET';
      assert.equal(url.origin, 'https://receipt-bridge.invalid');
      assert.ok(!options.body || Buffer.byteLength(options.body) <= 4325440);
      const body = options.body ? JSON.parse(options.body) : null;
      if (name === 'runvara_reserve_content_receipt' || name === 'runvara_finalize_content_receipt') {
        assert.equal(method, 'POST'); const kind = name.includes('_reserve_') ? 'reserve' : 'finalize';
        counters[kind]++; trace.push(kind);
        if (kind === 'reserve') {
          if (mode === 'missing-rpc') return Response.json({ code: 'PGRST202', message: 'Synthetic missing RPC' }, { status: 404 });
          if (mode === 'unknown-reserve-absent') throw new Error('Synthetic request transport unavailable');
          if (counters.reserve === 2 && mode === 'unknown-reserve-denied') return Response.json({ code: '42501' }, { status: 403 });
          if (counters.reserve === 2 && mode === 'unknown-reserve-cancelled') return Response.json({ code: '57014' }, { status: 500 });
        }
        let ack;
        try { ack = (await withService(c => c.query(`SELECT public.runvara_${kind}_content_receipt($1::text) ack`, [body.p_request_json]))).rows[0].ack; }
        catch (error) { return Response.json({ code: error.code, message: error.message }, { status: 409 }); }
        await syncFake();
        if (kind === 'reserve' && mode.startsWith('unknown-reserve')) return Response.json(null);
        const shouldDrop = !dropped && (kind === 'reserve' && mode.startsWith('lost-reserve') || kind === 'finalize' && mode.startsWith('lost-final'));
        if (shouldDrop) {
          dropped = true;
          if (mode.endsWith('-newer')) {
            const current = await currentState(); newerRevision = randomUUID();
            const newer = { ...current, _revision: newerRevision, unrelatedNewerState: `${family}:${mode}` };
            await withService(c => c.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1 AND state->>\'_revision\'=$3', [workspaceId, newer, current._revision]));
            await syncFake();
          }
          throw new Error('Synthetic acknowledgement loss after real PostgreSQL commit');
        }
        return Response.json(ack);
      }
      if (name === 'runvara_read_content_receipt') {
        counters.lookup++; trace.push('lookup'); assert.equal(method, 'POST');
        assert.ok(Buffer.byteLength(options.body) <= 4096);
        assert.ok(!options.body.includes('Synthetic <approved>') && !options.body.includes('sourceTemplate'));
        if (mode === 'unknown-reserve-committed') throw new Error('Synthetic exact lookup unavailable');
        if (['unknown-reserve-denied','unknown-reserve-cancelled'].includes(mode)) {
          if (counters.lookup === 1) return Response.json(null);
          throw new Error('Synthetic final exact lookup unavailable');
        }
        const ack = (await withService(c => c.query('SELECT public.runvara_read_content_receipt($1,$2,$3,$4,$5,$6::bigint) ack',
          [body.p_workspace_id, body.p_attempt_id, body.p_kind, body.p_request_fingerprint, body.p_actor_id, body.p_actor_session_version]))).rows[0].ack;
        return Response.json(ack);
      }
      if (name === 'runvara_commit_reporting_status') {
        counters.reporting++; trace.push('reporting');
        try {
          const rows = (await withService(c => c.query('SELECT * FROM public.runvara_commit_reporting_status($1,$2,$3,$4::jsonb,$5::timestamptz)',
            [body.p_workspace_id, body.p_expected_revision, body.p_next_revision, body.p_report, body.p_updated_at]))).rows;
          await syncFake(); return Response.json(rows);
        } catch (error) { return Response.json({ code: error.code, message: error.message }, { status: 409 }); }
      }
      if (name === 'saas_workspace_state') {
        assert.equal(url.searchParams.get('workspace_id'), `eq.${workspaceId}`);
        if (method === 'PATCH') {
          counters.generic++; trace.push('generic');
          const fence = url.searchParams.get('state->>_revision'); assert.ok(fence.startsWith('eq.'));
          try {
            const rows = (await withService(c => c.query('UPDATE public.saas_workspace_state SET state=$2,updated_at=$3 WHERE workspace_id=$1 AND state->>\'_revision\'=$4 RETURNING workspace_id',
              [workspaceId, body.state, body.updated_at, fence.slice(3)]))).rows;
            await syncFake(); return Response.json(rows);
          } catch (error) { return Response.json({ code: error.code, message: error.message }, { status: 409 }); }
        }
        assert.equal(method, 'GET');
        await syncFake();
        if (url.searchParams.get('select')?.includes('revision:state->>_revision')) { counters.fresh++; trace.push('fresh'); }
      }
      return f.fake.fetchImpl(input, options);
    };
    const store = createStore({ SUPABASE_URL: 'https://receipt-bridge.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only', CONTENT_EXECUTION_RECEIPT_CONTRACT }, { fetchImpl });
    const state = await store.get(workspaceId), write = state.connectionWrites[0];
    assert.deepEqual(write.input, f.state.connectionWrites[0].input);
    assert.notDeepEqual(Object.keys(write.input), Object.keys(f.state.connectionWrites[0].input), 'Actual PostgreSQL JSONB must reorder producer input');
    const provider = new IntegrationService({}, { fetchImpl: async (input, options) => {
      counters.provider++; trace.push('provider');
      assert.equal(input, f.expected.request.url); assert.equal(options.body, f.expected.request.body);
      return Response.json({ data: { productUpdate: { product: { id: CONTENT_PRODUCT, title: write.input.title }, userErrors: [] } } });
    } });
    provider.shopifyConfig = snapshot => ({ domain: snapshot.connections[0].metadata.shopDomain, workspaceId, mode: 'oauth', apiVersion: '2026-07', accessToken: 'synthetic-only' });
    provider.connectorCredentials = async () => ({ accessToken: 'synthetic-only' });
    const run = () => executeConnectionWrite(state, write.id, f.session.userId, provider, options => store.save(workspaceId, state, options), {
      durableStore: true, actorSession: f.session, protectedContentReceipts: store.contentExecutionReceiptCapability,
      loadObjectiveJob: id => store.getAgentJob(workspaceId, id, { includeReport: true }),
      loadFreshState: request => store.getConnectionWriteContext(workspaceId, request) });
    const quotaBefore = (await admin.query("SELECT quota FROM public.runvara_content_receipt_quotas WHERE scope_key='global'")).rows[0].quota;
    let result;
    if (mode === 'paused-refused') await admin.query("UPDATE public.runvara_content_receipt_control SET mode='paused' WHERE id");
    try { result = await run().catch(error => error); }
    finally { if (mode === 'paused-refused') await admin.query("UPDATE public.runvara_content_receipt_control SET mode='enforced' WHERE id"); }
    const persisted = await currentState();
    const rows = (await admin.query('SELECT (SELECT count(*)::int FROM public.runvara_content_admissions WHERE workspace_id=$1) admissions,(SELECT count(*)::int FROM public.runvara_content_receipts WHERE workspace_id=$1) receipts', [workspaceId])).rows[0];
    const unknownReserve = mode.startsWith('unknown-reserve');
    const reserveStopped = unknownReserve || ['quota-refused','paused-refused','missing-rpc'].includes(mode);
    assert.equal(counters.reserve, unknownReserve ? 2 : 1, `${family}:${mode}: bounded original-identity reservation attempts`);
    assert.equal(counters.lookup, unknownReserve ? 2 : reserveStopped || mode === 'normal' ? 0 : 1);
    assert.equal(counters.fresh, reserveStopped ? 1 : 2);
    if (reserveStopped) {
      const expectedCode = mode === 'quota-refused' ? 'CONTENT_RECEIPT_CAPACITY_EXHAUSTED'
        : unknownReserve ? 'CONTENT_RECEIPT_COMMIT_UNCONFIRMED' : 'CONTENT_RECEIPT_UNAVAILABLE';
      assert.ok(result instanceof Error); assert.equal(result.code, expectedCode, `${family}:${mode}: original persistence outcome survives`);
      const admitted = unknownReserve && mode !== 'unknown-reserve-absent';
      assert.equal(counters.provider, 0); assert.equal(counters.finalize, 0); assert.equal(counters.generic, 1);
      assert.deepEqual(rows, { admissions: admitted ? 1 : 0, receipts: 0 });
      assert.equal(persisted.connectionWrites[0].status, 'executing', 'Only the initial executing request is retained on proven refusal');
      assert.equal(Boolean(persisted.connectionWrites[0].dispatchClaim.phases.shopify_mutation), admitted);
      assert.equal(write.status, 'executing'); assert.equal(write.errorCode, undefined);
      const quotaAfter = (await admin.query("SELECT quota FROM public.runvara_content_receipt_quotas WHERE scope_key='global'")).rows[0].quota;
      assert.equal(quotaAfter.attempts - quotaBefore.attempts, admitted ? 1 : 0);
      assert.equal(quotaAfter.reservedBytes - quotaBefore.reservedBytes, admitted ? 40960 : 0);
      const beforeRepeat = { ...counters }; await assert.rejects(run, { code: 'WRITE_ALREADY_ATTEMPTED' });
      await assert.rejects(() => executeConnectionWrite(persisted, write.id, f.session.userId, provider,
        () => assert.fail('A restarted executing request must never save'), { durableStore: true, actorSession: f.session,
          protectedContentReceipts: store.contentExecutionReceiptCapability, loadFreshState: () => assert.fail('No replay fresh read') }), { code: 'WRITE_ALREADY_ATTEMPTED' });
      assert.deepEqual(counters, beforeRepeat);
    } else if (mode === 'lost-reserve-newer') {
      assert.ok(result instanceof Error, result.errorCode); assert.equal(result.code, 'STATE_CONFLICT');
      assert.equal(counters.provider, 0); assert.equal(counters.finalize, 0);
      assert.deepEqual(rows, { admissions: 1, receipts: 0 });
      assert.equal(persisted._revision, newerRevision);
      assert.equal(persisted.connectionWrites[0].status, 'executing');
    } else {
      assert.equal(result.status, 'completed', `${family}:${mode}: ${result.code || result.errorCode || result.message}`);
      assert.equal(counters.provider, 1); assert.equal(counters.finalize, 1);
      assert.deepEqual(rows, { admissions: 1, receipts: 1 });
      const stored = (await admin.query('SELECT receipt FROM public.runvara_content_receipts WHERE workspace_id=$1', [workspaceId])).rows[0].receipt;
      receiptSource = validateReviewedSourceAction(stored.source, { workspaceId });
      assert.equal(receiptSource.context.origin, family === 'objective' ? 'owner_objective_content' : 'owner_manual');
      assert.equal(receiptSource.context.claimIdentity, f.expected.identity);
      assert.equal(receiptSource.context.dispatchRequestDigest, f.expected.requestDigest);
      assert.deepEqual(receiptSource.input, f.state.connectionWrites[0].input);
      if (mode.endsWith('-newer')) {
        assert.equal(persisted._revision, newerRevision);
        assert.equal(persisted.unrelatedNewerState, `${family}:${mode}`);
      }
      const beforeRepeat = { ...counters }; await run(); assert.deepEqual(counters, beforeRepeat);
    }
    assert.equal(counters.reporting, mode === 'normal' ? 3 : reserveStopped || mode === 'lost-reserve-newer' ? 1 : 2);
    if (mode === 'normal') assert.deepEqual(trace, ['generic','reporting','fresh','reserve','reporting','fresh','provider','finalize','reporting']);
    if (mode.startsWith('lost-final')) assert.deepEqual(trace.slice(-2), ['finalize','lookup'], 'Recovered finalization must not mirror/report or replay afterward');
    summaries.push({ family, mode, ...counters, ...rows, exactOriginalSource: Boolean(receiptSource), provider: 'synthetic-only' });
  }
  return summaries;
}
