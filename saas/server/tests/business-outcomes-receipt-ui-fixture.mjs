// Shared synthetic protected-source transport for browser/JSDOM presentation.
// Production measurement, receipt, display and outcome validators build every DTO.
// It does not exercise SQL authority or call a provider.
import assert from 'node:assert/strict';
import { actionUiFixture } from './business-outcomes-action-ui-fixture.mjs';
import { protectedReceiptFixture } from './protected-receipt-source-fixture.mjs';
import { digestReviewedActionValue } from '../lib/reviewed-action-evidence.mjs';
import { publicProtectedReceiptSource, resolveProtectedReceiptEvidence } from '../lib/protected-receipt-source.mjs';
import { prepareExperimentOutcomeMeasurement, assessExperimentOutcomeMeasurement } from '../lib/experiment-measurements.mjs';
import { createBusinessOutcomeCandidate, correctBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
export const RECEIPT_UI_NOW = '2026-10-08T12:00:00.000Z';
export const RECEIPT_UI_EXPERIMENT = 'experiment_receipt_ui';
const clone = structuredClone;
export function receiptUiFixture({ workspaceId = 'receipt-ui', sourceFixture = null, count = 22 } = {}) {
  const now = sourceFixture ? new Date(Math.max(Date.parse(RECEIPT_UI_NOW), Date.parse(sourceFixture.source.context.completedAt) + 1000)).toISOString() : RECEIPT_UI_NOW, experimentId = RECEIPT_UI_EXPERIMENT, experiment = { id: experimentId, title: 'Protected completion outcome review', status: 'measured' };
  const sources = Array.from({ length: sourceFixture ? 1 : count }, (_, index) => {
    let fixture = sourceFixture;
    if (!fixture) {
      const action = actionUiFixture(workspaceId, { id: 'write_receipt_' + index, title: 'Recorded <img src=x onerror="window.receiptInjected=true"> product ' + index,
        description: 'Exact protected description <script>window.receiptInjected=true</script>\n' + 'Source content '.repeat(15) + 'END OF RECEIPT ' + index });
      const source = clone(action.source); source.context.claimId = 'claim_receipt_' + index;
      const { digest, ...body } = source; source.digest = digestReviewedActionValue(body);
      fixture = { source };
    }
    const receipt = protectedReceiptFixture({ fixture }), resolved = resolveProtectedReceiptEvidence(receipt.evidence, { workspaceId });
    const display = publicProtectedReceiptSource(resolved.source, { workspaceId, receiptSource: resolved.receiptSource });
    return { ...receipt, ...resolved, display, choice: { receiptSource: resolved.receiptSource, actionId: display.action.id, account: display.account,
      productId: display.productId, title: display.input.title, completedAt: display.completedAt, origin: display.origin, originatingObjective: display.originatingObjective } };
  }).sort((a, b) => a.selector.attemptId.localeCompare(b.selector.attemptId));
  const input = { expectedRevision: 0, amount: '12.5', currency: 'GBP', window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-07T00:00:00.000Z' },
    coverage: { status: 'complete', observedCount: 2, expectedCount: 2 }, method: { kind: 'reconciled_manual' }, observedAt: '2026-10-07T12:00:00.000Z',
    report: { description: 'Synthetic complete measured costs. No causal benefit is established by this association.', costsComplete: true } };
  const h = { workspaceId, experimentId, experiment, now, input, sources, versions: new Map(), publications: new Map(), workspaceRevision: 'receipt_ui_revision_1', publication: null,
    measurement: prepareExperimentOutcomeMeasurement(input, { workspaceId, experimentId, actorId: 'owner_one', now }), source: null };
  h.summary = () => ({ workspaceId, current: h.publication ? [clone(h.publication)] : [], summary: { groups: [], coverage: { complete: true }, exclusions: [] } });
  h.detail = ({ receipt = null, afterAttemptId = null, omitSavedPreview = false } = {}) => {
    const available = sources.filter(s => !afterAttemptId || s.selector.attemptId > afterAttemptId), page = available.slice(0, 20);
    const chosen = receipt ? sources.find(s => ['attemptId', 'receiptDigest', 'sourceDigest'].every(k => receipt[k] === s.selector[k])) : null;
    if (receipt) assert.ok(chosen, 'exact synthetic receipt must exist');
    const saved = h.measurement?.receiptSource && !h.measurement.intervention.reuseVersionId && !omitSavedPreview ? h.source?.display : null;
    return clone({ workspaceId, workspaceRevision: h.workspaceRevision, experiment, measurement: h.measurement,
      assessment: assessExperimentOutcomeMeasurement(h.measurement, { workspaceId, experimentId, now }), currentPublication: h.publication,
      actionLinkContract: 'runvara-reviewed-action/v2', actionChoices: [], currentActionAssociation: h.publication ? h.versions.get(h.publication.head.versionId).sourceMeasurement.intervention ?? null : null,
      receiptLinkContract: 'runvara-protected-content-source/v1', receiptChoices: page.map(s => s.choice), nextReceiptCursor: available.length > 20 ? page.at(-1).selector.attemptId : null,
      hasMoreReceipts: available.length > 20, selectedReceiptSource: chosen?.display ?? saved });
  };
  h.save = body => {
    const selection = body.actionSelection;
    let options = {};
    if (selection?.receipt) {
      h.source = sources.find(s => ['attemptId', 'receiptDigest', 'sourceDigest'].every(k => selection.receipt[k] === s.selector[k])); assert.ok(h.source);
      options = { receiptEvidence: h.source.evidence };
    } else if (selection?.reuseVersionId) {
      const retained = h.versions.get(selection.reuseVersionId); assert.ok(retained);
      h.source = retained.fixtureSource;
      options = { actionEvidence: h.source.source, reuseVersionId: selection.reuseVersionId, reuseSourceMeasurement: retained.sourceMeasurement };
    } else { assert.equal(selection ?? null, null); h.source = null; }
    h.measurement = prepareExperimentOutcomeMeasurement(body, { workspaceId, experimentId, actorId: 'owner_one', now, previousMeasurement: h.measurement, ...options });
    h.workspaceRevision = 'receipt_ui_draft_' + h.measurement.revision;
    return h.detail();
  };
  h.publish = body => {
    if (h.publications.has(body.publicationId)) { const old = h.publications.get(body.publicationId); assert.deepEqual(body, old.body); return clone({ ...old.result, replayed: true }); }
    const retained = body.action === 'withdraw' ? h.versions.get(h.publication.head.versionId) : null, m = retained?.sourceMeasurement ?? h.measurement;
    assert.equal(body.expectedWorkspaceRevision, h.workspaceRevision); assert.equal(body.expectedMeasurementDigest, m.digest); assert.equal(body.expectedMeasurementRevision, m.revision);
    assert.equal(body.expectedHeadVersionId, h.publication?.head.versionId ?? null); assert.equal(body.expectedHeadDigest, h.publication?.head.digest ?? null);
    const verification = { kind: 'owner_attestation', actorId: 'owner_one', verifiedAt: now, measurementDigest: m.digest };
    const record = { source: { type: 'experiment_measurement', experimentId, measurementRevision: m.revision, measurementDigest: m.digest },
      ...Object.fromEntries(['metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'links'].map(k => [k, m[k]])), verification };
    const version = body.action === 'withdraw' ? withdrawBusinessOutcomeCandidate(h.publication.version, { reason: body.withdrawalReason, verification }, { workspaceId, now })
      : body.action === 'correct' ? correctBusinessOutcomeCandidate(h.publication.version, record, { workspaceId, now }) : createBusinessOutcomeCandidate(record, { workspaceId, now });
    h.workspaceRevision = 'receipt_ui_publication_' + version.revision;
    h.publication = { head: { schema: 'runvara-outcome-head/v1', workspaceId, outcomeId: version.outcomeId, revision: version.revision, versionId: version.versionId, digest: version.digest,
      status: version.status === 'withdrawn' ? 'withdrawn' : 'published', publicationId: body.publicationId, committedAt: now, commitRevision: h.workspaceRevision }, version };
    h.versions.set(version.versionId, clone({ publication: h.publication, sourceMeasurement: m, sourceAction: retained?.sourceAction ?? h.source?.display ?? null, fixtureSource: retained?.fixtureSource ?? h.source }));
    const result = { workspaceId, publication: h.publication, replayed: false, isCurrent: true }; h.publications.set(body.publicationId, clone({ body, result })); return clone(result);
  };
  h.request = async (path, config = {}) => {
    if (path === '/api/business-outcomes') return h.summary();
    if (path.endsWith('/measurement')) return h.save(JSON.parse(config.body));
    if (path.endsWith('/content-sources')) return h.detail({ ...JSON.parse(config.body), omitSavedPreview: !JSON.parse(config.body).receipt });
    if (path.endsWith('/publish')) return h.publish(JSON.parse(config.body));
    if (path.includes('/versions/')) { const { fixtureSource, ...stored } = h.versions.get(path.split('/').at(-1)); return clone({ ...stored, currentStatus: 'not_checked', source: 'immutable_business_outcome_version' }); }
    return h.detail();
  };
  h.publicationInput = (action = 'publish') => { const m = action === 'withdraw' ? h.versions.get(h.publication.head.versionId).sourceMeasurement : h.measurement;
    return { publicationId: 'receipt_ui_publication_' + (h.publications.size + 1), action, experimentId, expectedWorkspaceRevision: h.workspaceRevision,
      expectedMeasurementRevision: m.revision, expectedMeasurementDigest: m.digest, expectedHeadVersionId: h.publication?.head.versionId ?? null,
      expectedHeadDigest: h.publication?.head.digest ?? null, withdrawalReason: action === 'withdraw' ? 'incorrect_measurement' : null }; };
  return h;
}
