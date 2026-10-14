import { assessBusinessOutcomeCandidate, validateBusinessOutcomePublication } from './business-outcomes.mjs';
import { assessExperimentOutcomeMeasurement, digestMeasurementValue, validateExperimentOutcomeMeasurement } from './experiment-measurements.mjs';
import { resolveProtectedReceiptEvidence, validateProtectedReceiptSelector } from './protected-receipt-source.mjs';
import { actionIntervention } from './reviewed-action-evidence.mjs';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^outcome_version_[a-f0-9]{64}$/;
const FACTS = ['metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'links'];
const failure = (code, status = 409) => Object.assign(new Error(code), { code, status });
function exact(value, keys) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })) throw failure('FINANCIAL_EVIDENCE_REQUEST_INVALID', 400);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const same = (left, right) => digestMeasurementValue(left) === digestMeasurementValue(right);

/** Internal adapter factory, never a request-body proof constructor.
 * read must be the authenticated, bounded, combined review RPC adapter. A
 * caller supplies only expected identities; every financial fact is read anew.
 * The result proves source consistency at that snapshot, not economic truth,
 * provider authentication, causation, future profitability or permission.
 */
export function createHistoricalFinancialEvidenceReader({ read, now }) {
  if (typeof read !== 'function' || typeof now !== 'function') throw failure('FINANCIAL_EVIDENCE_READER_REQUIRED', 500);
  return async function financialEvidence(workspaceId, experimentId, actor, input) {
    exact(input, ['expectedWorkspaceRevision', 'expectedVersionId', 'expectedVersionDigest', 'receipt']);
    exact(actor, ['id', 'sessionVersion']);
    if (typeof input.expectedWorkspaceRevision !== 'string' || !ID.test(input.expectedWorkspaceRevision)
      || typeof input.expectedVersionId !== 'string' || !VERSION.test(input.expectedVersionId)
      || typeof input.expectedVersionDigest !== 'string' || !HASH.test(input.expectedVersionDigest)
      || typeof actor.id !== 'string' || !ID.test(actor.id) || !Number.isSafeInteger(actor.sessionVersion) || actor.sessionVersion < 1) {
      throw failure('FINANCIAL_EVIDENCE_REQUEST_INVALID', 400);
    }
    // Capture before the await: changing the request while the read is pending
    // must not change the expected workspace, publication or operation.
    const expected = freeze({ ...input, receipt: validateProtectedReceiptSelector(input.receipt) });
    const identity = Object.freeze({ id: actor.id, sessionVersion: actor.sessionVersion });
    const { review, receiptEvidence } = await read(workspaceId, experimentId, identity, expected.receipt);
    const at = new Date(now()).toISOString();
    if (review.workspaceId !== workspaceId || review.experiment.id !== experimentId) throw failure('FINANCIAL_EVIDENCE_SCOPE_MISMATCH');
    if (review.workspaceRevision !== expected.expectedWorkspaceRevision) throw failure('FINANCIAL_EVIDENCE_WORKSPACE_CHANGED');
    if (!review.currentPublication || !review.measurement || !receiptEvidence) throw failure('FINANCIAL_EVIDENCE_SOURCE_REQUIRED');
    const publication = validateBusinessOutcomePublication(review.currentPublication, { workspaceId, now: at });
    const { head, version } = publication;
    if (head.versionId !== expected.expectedVersionId || head.digest !== expected.expectedVersionDigest) throw failure('FINANCIAL_EVIDENCE_PUBLICATION_CHANGED');
    if (head.status !== 'published' || version.status !== 'recorded') throw failure('FINANCIAL_EVIDENCE_WITHDRAWN');
    const measurement = validateExperimentOutcomeMeasurement(review.measurement, { workspaceId, experimentId, now: at });
    if (measurement.schema !== 'runvara-experiment-measurement/v4' || measurement.intervention.reuseVersionId !== null) throw failure('FINANCIAL_EVIDENCE_PROTECTED_SOURCE_REQUIRED');
    if (version.source.experimentId !== experimentId || version.source.measurementRevision !== measurement.revision
      || version.source.measurementDigest !== measurement.digest) throw failure('FINANCIAL_EVIDENCE_MEASUREMENT_CHANGED');
    if (!FACTS.every(key => same(version[key], measurement[key]))) throw failure('FINANCIAL_EVIDENCE_FACTS_MISMATCH');
    if (!assessBusinessOutcomeCandidate(version, { workspaceId, now: at }).measurementComplete
      || !assessExperimentOutcomeMeasurement(measurement, { workspaceId, experimentId, now: at }).measurementComplete) {
      throw failure('FINANCIAL_EVIDENCE_MEASUREMENT_INCOMPLETE');
    }
    const resolved = resolveProtectedReceiptEvidence(receiptEvidence, { workspaceId, selector: expected.receipt });
    if (!same(resolved.receiptSource, measurement.receiptSource)
      || !same(actionIntervention(resolved.source), measurement.intervention)
      || !same(review.currentActionAssociation, measurement.intervention)) throw failure('FINANCIAL_EVIDENCE_OPERATION_MISMATCH');
    const body = {
      schema: 'runvara-historical-financial-evidence/v1', workspaceId, workspaceRevision: review.workspaceRevision,
      experimentId, readCompletedAt: at, basis: 'published_owner_attestation',
      financial: { ...Object.fromEntries(FACTS.slice(0, 6).map(key => [key, measurement[key]])), costsComplete: true },
      source: {
        publication: { outcomeId: head.outcomeId, versionId: head.versionId, digest: head.digest, revision: head.revision,
          publicationId: head.publicationId, committedAt: head.committedAt, commitRevision: head.commitRevision },
        measurement: { revision: measurement.revision, digest: measurement.digest, reportId: measurement.report.id, reportDigest: measurement.report.digest },
        provenance: measurement.provenance, verification: version.verification, receipt: resolved.receiptSource,
        operation: { provider: 'shopify', operation: 'product_content', action: measurement.links.action, approval: measurement.links.approval,
          account: resolved.source.context.account, productId: resolved.source.input.productId, completedAt: resolved.source.context.completedAt }
      },
      safeguards: { independentFinancialVerification: false, invoiceVerification: false, providerAuthentication: false,
        causalAttribution: false, forecastingAuthorized: false, learningAuthorized: false, executionAuthorized: false, allowanceIssued: false }
    };
    const result = { ...body, digest: digestMeasurementValue(body) };
    if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024) throw failure('FINANCIAL_EVIDENCE_TOO_LARGE', 413);
    return freeze(structuredClone(result));
  };
}
