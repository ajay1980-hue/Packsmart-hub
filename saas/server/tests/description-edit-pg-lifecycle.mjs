// Runs only inside the opted-in harness's proven disposable database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { linkedMeasurement, resign, request, parameters, callSql } from './business-outcome-postgres-fixture.mjs';
import { runContentReceiptDispatcherPgTests } from './content-execution-receipt-pg-dispatch.mjs';
import { createBusinessOutcomePersistence } from '../lib/business-outcome-store.mjs';

export async function runDescriptionLifecyclePgProof({ admin, withService }) {
  assert.ok(process.env.RUNVARA_OLD_READER_ROOT, 'Exact baseline reader snapshot required');
  const oldReader = await import(pathToFileURL(path.join(process.env.RUNVARA_OLD_READER_ROOT, 'saas/server/lib/business-outcome-store.mjs')));
  const summaries = [];
  await runContentReceiptDispatcherPgTests({ admin, withService, families: ['manual','manual-v1-policy','objective','description'], modes: ['normal'],
    onCompleted: async ({ family, workspaceId, session, source }) => {
      const experimentId = 'description-lifecycle';
      const row = (await admin.query('SELECT a.admission,r.receipt,r.commit_revision FROM public.runvara_content_admissions a JOIN public.runvara_content_receipts r USING(workspace_id,attempt_id) WHERE a.workspace_id=$1', [workspaceId])).rows[0];
      const reference = { schema: 'runvara-protected-content-source/v1', workspaceId, attemptId: row.admission.attemptId,
        receiptDigest: row.receipt.digest, sourceDigest: source.digest, commitRevision: row.commit_revision };
      const selector = { attemptId: reference.attemptId, receiptDigest: reference.receiptDigest, sourceDigest: reference.sourceDigest };
      const actor = { id: session.userId, sessionVersion: session.sessionVersion };
      const current = async () => (await admin.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [workspaceId])).rows[0].state;
      const save = async measurement => {
        const state = await current(), previous = state._revision; state._revision = randomUUID();
        state.revenueEngine.experiments = [{ id: experimentId, title: 'Synthetic publication lifecycle', status: 'measured', ...(measurement ? { outcomeMeasurement: measurement } : {}) }];
        // Immutable ledger evidence must remain sufficient after optional history is removed.
        state.approvals = []; state.connections = []; delete state.connectionWrites[0].recordedActionContext;
        const result = await withService(c => c.query("UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1 AND state->>'_revision'=$3", [workspaceId, state, previous]));
        assert.equal(result.rowCount, 1); return state;
      };
      const read = async options => (await withService(c => c.query('SELECT public.runvara_read_outcome_content_sources($1,$2,$3,$4::bigint,$5::jsonb,$6,$7::boolean) result',
        [workspaceId, experimentId, actor.id, actor.sessionVersion, options?.selector ?? null, null, true]))).rows[0].result;
      const transport = async (url, options) => {
        assert.equal(url, 'rpc/runvara_read_outcome_content_sources');
        const body = JSON.parse(options.body); assert.equal(body.p_workspace_id, workspaceId);
        return read({ selector: body.p_receipt_selector });
      };
      const reader = createBusinessOutcomePersistence({ request: transport });
      const legacyReader = oldReader.createBusinessOutcomePersistence({ request: transport });
      const f = { workspaceId, experimentId, sourceAction: source, state: await save() };
      const envelope = await read({ selector });
      assert.equal(envelope.review.actionLinkContract, 'runvara-reviewed-action/v3');
      assert.deepEqual(envelope.selectedEvidence, { schema: 'runvara-outcome-content-source-private/v1', admission: row.admission, receipt: row.receipt, commitRevision: row.commit_revision });
      assert.equal(envelope.receiptChoices.length, 1);
      assert.equal(envelope.receiptChoices[0].title, family === 'description' ? 'Shopify description change' : source.input.title);
      const parsed = await reader.review(workspaceId, experimentId, actor, { receipt: selector, requireReceiptContract: true });
      assert.deepEqual(parsed.selectedReceiptSource.receiptSource, reference);
      await assert.rejects(() => legacyReader.review(workspaceId, experimentId, actor, { receipt: selector, requireReceiptContract: true }), { code: 'OUTCOME_REVIEW_INVALID' });
      const measurement = (options = {}) => {
        const m = linkedMeasurement(workspaceId, experimentId, source, { actor: actor.id, ...options });
        m.schema = 'runvara-experiment-measurement/v4'; m.report.schema = 'runvara-measurement-report/v4';
        m.recordedAt = m.report.recordedAt = new Date().toISOString();
        if (family === 'objective') m.intervention = { ...m.intervention, schema: 'runvara-owner-action-association/v2', origin: 'owner_objective_content', originatingObjective: structuredClone(source.context.originatingObjective) };
        m.report.facts.intervention = structuredClone(m.intervention);
        m.receiptSource = structuredClone(reference); m.report.facts.receiptSource = structuredClone(reference);
        return resign(m);
      };
      const publish = async input => (await withService(c => c.query(callSql, parameters(input)))).rows[0].receipt;
      const version = async id => (await admin.query('SELECT source_action,source_measurement FROM public.runvara_business_outcome_versions WHERE workspace_id=$1 AND version_id=$2', [workspaceId, id])).rows[0];
      f.source = measurement(); f.state = await save(f.source);
      assert.deepEqual((await reader.review(workspaceId, experimentId, actor, { requireReceiptContract: true })).selectedReceiptSource.receiptSource, reference);
      const firstRequest = request(f, { actorId: actor.id, sessionVersion: actor.sessionVersion });
      const first = await publish(firstRequest), original = await version(first.publication.head.versionId);
      assert.deepEqual(original, { source_action: source, source_measurement: f.source });
      assert.equal((await publish(firstRequest)).replayed, true);
      f.source = measurement({ revision: 2, amount: '5', reuseVersionId: first.publication.head.versionId }); f.state = await save(f.source);
      const correction = request(f, { actorId: actor.id, sessionVersion: actor.sessionVersion, action: 'correct', headVersionId: first.publication.head.versionId, headDigest: first.publication.head.digest });
      const second = await publish(correction), corrected = await version(second.publication.head.versionId);
      assert.deepEqual(corrected.source_action, original.source_action);
      assert.deepEqual(corrected.source_measurement.receiptSource, reference);
      assert.equal((await publish(correction)).replayed, true);
      const withdrawal = request(f, { actorId: actor.id, sessionVersion: actor.sessionVersion, action: 'withdraw', workspaceRevision: second.publication.head.commitRevision,
        headVersionId: second.publication.head.versionId, headDigest: second.publication.head.digest, withdrawalReason: 'evidence_retracted' });
      const third = await publish(withdrawal);
      assert.deepEqual(await version(third.publication.head.versionId), corrected);
      assert.equal(third.publication.head.status, 'withdrawn');
      assert.equal((await publish(withdrawal)).replayed, true);
      const finalReview = await reader.review(workspaceId, experimentId, actor, { requireReceiptContract: true });
      assert.equal(finalReview.currentPublication.head.status, 'withdrawn');
      assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_business_outcome_versions WHERE workspace_id=$1', [workspaceId])).rows[0].n, 3);
      summaries.push({ family, sourceSchema: source.schema, policies: source.context.policies.length, newReader: 'accepted', oldReaderUnderV3: 'rejected', publishCorrectWithdraw: true, exactSnapshots: true });
    } });
  console.log('DESCRIPTION_LIFECYCLE_PG_PROOF=' + JSON.stringify(summaries));
}
