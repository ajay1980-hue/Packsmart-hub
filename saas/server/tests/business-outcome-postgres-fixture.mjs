// Synthetic test-only source builder. Independent of the SQL canonicalizer.
import { createHash, randomUUID } from 'node:crypto';
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
export function sourceMeasurement(workspaceId, experimentId, { revision = 1, amount = '123.456789', currency = 'GBP', actor = 'owner', ...overrides } = {}) {
  const recordedAt = '2026-01-03T00:00:00.000Z';
  const window = { startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-01-02T00:00:00.000Z' };
  const coverage = { status: 'complete', scopeId: 'whole_business_' + hash([workspaceId, 'whole-business']), observedCount: 2, expectedCount: 2 };
  const method = { kind: 'reconciled_manual', definitionVersion: 'incremental-contribution/v1' };
  const observedAt = '2026-01-02T00:00:00.000Z';
  const facts = { metric: 'incrementalContribution', amount, currency, window, coverage, method, observedAt };
  const report = { schema: 'runvara-measurement-report/v1', id: 'measurement_report_' + hash([workspaceId, experimentId, revision]), workspaceId, experimentId,
    measurementRevision: revision, recordedBy: actor, recordedAt, description: 'Synthetic reconciled contribution: all direct costs included. Café 😀', costsComplete: true, facts };
  report.digest = hash(report);
  const measurement = { schema: 'runvara-experiment-measurement/v1', workspaceId, experimentId, revision, recordedBy: actor, recordedAt,
    metric: facts.metric, amount, currency, window, coverage, method,
    provenance: { observationId: 'measurement_observation_' + hash([workspaceId, experimentId]), sourceRefs: [{ type: 'measurement_report', id: report.id, digest: report.digest }], observedAt, aggregation: 'standalone' },
    links: { action: null, opportunity: null, approval: null, objective: null }, report, ...overrides };
  measurement.digest = hash(measurement);
  return measurement;
}
export function resign(measurement) {
  const m = structuredClone(measurement);
  delete m.report.digest; m.report.digest = hash(m.report);
  m.provenance.sourceRefs = [{ type: 'measurement_report', id: m.report.id, digest: m.report.digest }];
  delete m.digest; m.digest = hash(m); return m;
}
export function fixtureData() {
  const workspaceId = 'outcome-pg-' + randomUUID();
  const experimentId = 'experiment-one';
  const source = sourceMeasurement(workspaceId, experimentId);
  const state = { workspace: { id: workspaceId }, _revision: randomUUID(), users: [{ id: 'owner', role: 'owner', active: true, sessionVersion: 1 }],
    revenueEngine: { experiments: [{ id: experimentId, status: 'measured', untouched: 'experiment', outcomeMeasurement: source }, { id: 'other', untouched: true }] },
    sentinel: { secretNeverReturned: 'synthetic-not-a-secret' }, audit: [{ id: 'unchanged' }] };
  return { workspaceId, experimentId, source, state };
}
export const RPC = 'public.runvara_publish_business_outcome';
export const RPC_SIGNATURE = RPC + '(text,text,bigint,text,text,text,text,bigint,text,text,text,text)';
export function request(f, overrides = {}) {
  return { workspaceId: f.workspaceId, actorId: 'owner', sessionVersion: 1, publicationId: randomUUID(), action: 'publish', experimentId: f.experimentId,
    workspaceRevision: f.state._revision, measurementRevision: f.source.revision, measurementDigest: f.source.digest,
    headVersionId: null, headDigest: null, withdrawalReason: null, ...overrides };
}
export const parameters = r => [r.workspaceId, r.actorId, r.sessionVersion, r.publicationId, r.action, r.experimentId, r.workspaceRevision,
  r.measurementRevision, r.measurementDigest, r.headVersionId, r.headDigest, r.withdrawalReason];
export const callSql = `SELECT ${RPC}(${Array.from({ length: 12 }, (_, i) => '$' + (i + 1)).join(',')}) AS receipt`;

// Independent synthetic reviewed-action builder; no provider calls or credentials.
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function actionRequest(input, account, apiVersion = '2026-07') {
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return { provider: 'shopify', phase: 'shopify_mutation', method: 'POST',
    url: `https://${account}/admin/api/${apiVersion}/graphql.json`,
    body: JSON.stringify({ query: 'mutation RunvaraProductContent($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id title } userErrors { field message } } }',
      variables: { product: { id: input.productId, title: input.title, descriptionHtml: `<p>${escape(input.description).replace(/\n/g, '<br>')}</p>` } } }) };
}
export function actionFixture(workspaceId, { policyCount = 0, description = 'Exact text: Café 雪 😀 & < >\n"quoted" \\ backslash', id = 'write-one' } = {}) {
  const input = { productId: 'gid://shopify/Product/123', operation: 'product_content', title: 'Reviewed Café 雪 😀', description };
  const inputDigest = fingerprint(input), account = 'synthetic-review.myshopify.com';
  const policies = Array.from({ length: policyCount }, (_, i) => ({ objectiveId: `objective_00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, revision: i + 1, digest: hash(['synthetic objective', i, 25.5]) }));
  const proposal = policyCount ? { schema: 'runvara-objective-dispatch-proposal/v1', workspaceId, origin: 'owner_manual', writeId: id,
    provider: 'shopify', operation: 'product_content', inputDigest, connectionId: 'connection-one', account, requestedBy: 'owner',
    approvalKind: 'customer_facing_publish', policies, evidenceQualification: 'no_financial_execution_evidence' } : null;
  if (proposal) proposal.digest = hash(proposal);
  const approval = { id: 'approval-one', revision: 1, type: 'customer_facing_publish', status: 'approved', decidedBy: 'owner', decidedAt: '2026-01-01T00:00:00.000Z',
    payload: { connectionWriteId: id, digest: inputDigest, ...(proposal ? { objectivePolicyProposalDigest: proposal.digest } : {}) },
    executionStatus: 'completed', executedExternally: true };
  const decision = { workspaceId, id: approval.id, revision: approval.revision, status: approval.status, decidedBy: approval.decidedBy, decidedAt: approval.decidedAt, payload: structuredClone(approval.payload) };
  decision.digest = hash(decision);
  const completedAt = '2026-01-01T00:00:02.000Z';
  const context = { schema: 'runvara-recorded-action-context/v1', workspaceId, writeId: id, requestId: 'synthetic_request_0001', claimId: 'claim-one', provider: 'shopify', operation: 'product_content',
    connectionId: 'connection-one', account, requestedBy: 'owner', executedBy: 'owner', inputDigest, phase: 'shopify_mutation', apiVersion: '2026-07',
    dispatchRequestDigest: fingerprint(actionRequest(input, account)), resultId: input.productId, completedAt, origin: 'owner_manual', originatingObjective: null,
    approval: decision, proposal, policies };
  const sourceAction = { schema: 'runvara-reviewed-source-action/v1', revision: 1, context, input: structuredClone(input) };
  const identity = { id, requestId: context.requestId, provider: 'shopify', input, digest: inputDigest, connectionId: context.connectionId, account, requestedBy: context.requestedBy,
    requiresApproval: true, approvalId: approval.id, ...(proposal ? { objectivePolicyProposal: proposal } : {}) };
  context.claimIdentity = fingerprint(identity); sourceAction.digest = hash(sourceAction);
  const write = { ...identity, status: 'completed', completedAt, result: { externalId: input.productId }, observationErrorCode: null,
    dispatchClaim: { id: context.claimId, workspaceId, identity: fingerprint(identity), authority: hash(['synthetic authority']),
      phases: { shopify_mutation: { requestDigest: context.dispatchRequestDigest, status: 'dispatching', at: '2026-01-01T00:00:01.000Z' } } },
    recordedActionContext: { ...structuredClone(context), snapshotDigest: sourceAction.digest } };
  return { sourceAction, write, approval, connection: { id: context.connectionId, provider: 'shopify', metadata: { shopDomain: account } } };
}
export function linkedMeasurement(workspaceId, experimentId, sourceAction, { reuseVersionId = null, ...options } = {}) {
  const c = sourceAction.context;
  const intervention = { schema: 'runvara-owner-action-association/v1', relationship: 'owner_associated_recorded_action', comparison: 'not_established',
    action: { workspaceId, id: c.writeId, revision: 1, digest: sourceAction.digest },
    approval: { workspaceId, id: c.approval.id, revision: c.approval.revision, digest: c.approval.digest },
    account: c.account, productId: sourceAction.input.productId, completedAt: c.completedAt, reuseVersionId };
  const source = sourceMeasurement(workspaceId, experimentId, options);
  source.schema = 'runvara-experiment-measurement/v2'; source.report.schema = 'runvara-measurement-report/v2';
  source.intervention = intervention; source.report.facts.intervention = structuredClone(intervention);
  source.links = { action: intervention.action, opportunity: null, approval: intervention.approval, objective: null };
  return resign(source);
}
export function withAction(f, options = {}) {
  const action = actionFixture(f.workspaceId, options);
  f.state.connectionWrites = [action.write]; f.state.approvals = [action.approval]; f.state.connections = [action.connection];
  f.source = linkedMeasurement(f.workspaceId, f.experimentId, action.sourceAction);
  f.state.revenueEngine.experiments[0].outcomeMeasurement = f.source;
  return Object.assign(f, action);
}
