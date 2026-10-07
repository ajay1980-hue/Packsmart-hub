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
