// Independent existing synthetic receipt fixtures, factored for the staged-reader SQL gate.
import { createHash, randomUUID } from 'node:crypto';
import { hash, actionFixture } from './business-outcome-postgres-fixture.mjs';
const CONTRACT = 'runvara-content-execution-receipts/v1';
const RESERVED_BYTES = 40960;
const withoutDigest = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'digest'));
const sign = value => ({ ...withoutDigest(value), digest: hash(withoutDigest(value)) });
export function stagedReceiptFixtures(admin) {
function action(workspaceId, options = {}) {
  const f = actionFixture(workspaceId, { description: 'Synthetic exact Café 雪 😀 & < >\n"quoted" \\ bytes', ...options });
  const claimId = 'write_claim_' + randomUUID();
  f.write.dispatchClaim.id = claimId;
  f.sourceAction.context.claimId = claimId;
  f.sourceAction = sign(f.sourceAction);
  f.write.recordedActionContext = { ...structuredClone(f.sourceAction.context), snapshotDigest: f.sourceAction.digest };
  return f;
}
function descriptor(f) {
  const sourceTemplate = structuredClone(f.sourceAction);
  sourceTemplate.context.completedAt = f.write.dispatchClaim.phases.shopify_mutation.at;
  const signedTemplate = sign(sourceTemplate), c = signedTemplate.context;
  const intent = { ...withoutDigest(signedTemplate), context: { ...c, completedAt: null } };
  const admission = sign({ schema: 'runvara-content-execution-admission/v1', workspaceId: f.workspaceId,
    attemptId: 'content_attempt_' + hash([f.workspaceId, c.claimId, 'shopify_mutation']),
    writeId: c.writeId, requestId: c.requestId, claimId: c.claimId, claimIdentity: c.claimIdentity,
    authorityDigest: f.write.dispatchClaim.authority, actorId: c.executedBy, actorSessionVersion: 1,
    phase: 'shopify_mutation', dispatchRequestDigest: c.dispatchRequestDigest,
    intentDigest: hash(intent), admittedAt: c.completedAt, reservedBytes: RESERVED_BYTES });
  const receipt = sign({ schema: 'runvara-content-execution-receipt/v1', workspaceId: f.workspaceId,
    attemptId: admission.attemptId, admissionDigest: admission.digest, intentDigest: admission.intentDigest,
    observation: 'provider_confirmed', source: structuredClone(f.sourceAction) });
  return { admission, sourceTemplate: signedTemplate, receipt };
}
async function fixture(options = {}) {
  const workspaceId = options.workspaceId || 'receipt-pg-' + randomUUID();
  const f = { workspaceId, ...action(workspaceId, options) };
  options.transform?.(f);
  const beforeWrite = structuredClone(f.write);
  beforeWrite.status = 'executing';
  delete beforeWrite.completedAt; delete beforeWrite.result; delete beforeWrite.recordedActionContext;
  beforeWrite.dispatchClaim.phases = {};
  const beforeApproval = { ...structuredClone(f.approval), executionStatus: 'approved', executedExternally: false };
  f.state = { workspace: { id: workspaceId }, _revision: randomUUID(),
    users: [{ id: 'owner', role: 'owner', active: true, sessionVersion: 1 }],
    connectionWrites: [beforeWrite], approvals: [beforeApproval], connections: [f.connection],
    integrationStatus: { reporting: { status: 'degraded' }, shopify: { sentinel: 'preserve' } },
    ordinaryDecimals: { revenue: 25.5, ratio: 0.125, tiny: 1e-9 },
    sentinel: { secretNeverReturned: 'synthetic-not-a-secret' }, audit: [{ id: 'unchanged' }] };
  f.experimentId = 'experiment-one';
  f.state.revenueEngine = { experiments: [{ id: f.experimentId, title: 'Synthetic receipt experiment', status: 'measured' }] };
  Object.assign(f, descriptor(f));
  await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [workspaceId]);
  await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [workspaceId, f.state]);
  return f;
}
function reserveRequest(f, { state: s = f.state, expectedRevision = s._revision, nextRevision = randomUUID() } = {}) {
  const next = structuredClone(s), w = next.connectionWrites.find(w => w.id === f.write.id);
  w.dispatchClaim.phases.shopify_mutation = structuredClone(f.write.dispatchClaim.phases.shopify_mutation);
  next._revision = nextRevision;
  return { contract: CONTRACT, kind: 'reserve', workspaceId: f.workspaceId, expectedRevision, nextRevision,
    state: next, admission: structuredClone(f.admission), sourceTemplate: structuredClone(f.sourceTemplate) };
}
function finalizeRequest(f, reserve, { state: s = reserve.state, expectedRevision = s._revision, nextRevision = randomUUID() } = {}) {
  const next = structuredClone(s);
  const index = next.connectionWrites.findIndex(w => w.id === f.write.id);
  next.connectionWrites[index] = structuredClone(f.write);
  next.approvals[next.approvals.findIndex(a => a.id === f.approval.id)] = structuredClone(f.approval);
  next._revision = nextRevision;
  return { contract: CONTRACT, kind: 'finalize', workspaceId: f.workspaceId, expectedRevision, nextRevision,
    state: next, admission: structuredClone(f.admission), receipt: structuredClone(f.receipt) };
}
return { fixture, reserveRequest, finalizeRequest };
}
