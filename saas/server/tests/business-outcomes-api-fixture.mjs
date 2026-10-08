/** HTTP/auth/DTO regression tests. The synthetic transport below uses the real
 * preparation and publication validators. It is not evidence of database
 * durability; the separate actual-PostgreSQL gate covers transactions/locks.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState, createStore } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { createBusinessOutcomePersistence } from '../lib/business-outcome-store.mjs';
import { prepareExperimentOutcomeMeasurement, validateExperimentOutcomeMeasurement, assessExperimentOutcomeMeasurement, digestMeasurementValue } from '../lib/experiment-measurements.mjs';
import { createBusinessOutcomeCandidate, correctBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
import { reviewedActionFixture } from './reviewed-action-test-fixture.mjs';
import { resolveRecordedActionEvidence, REVIEWED_ACTION_CONTRACT } from '../lib/reviewed-action-evidence.mjs';
import { evidenceInWorkspace } from '../lib/business-evidence-scope.mjs';

export const BASE = '/api/business-outcomes', EXPERIMENT = 'experiment_alpha';
export const REVIEW = `${BASE}/experiments/${EXPERIMENT}`, MEASURE = `${REVIEW}/measurement`;
export const SECRET = 'business-outcomes-http-test-secret-more-than-thirty-two-characters';
export const sqlError = databaseCode => Object.assign(new Error('private synthetic database detail must not leak'), { databaseCode });
export function measurementInput(expectedRevision = 0) {
  const end = new Date(Date.now() - 86400000), start = new Date(end - 86400000);
  return { expectedRevision, amount: '10.250000', currency: 'GBP', window: { startsAt: start.toISOString(), endsAt: end.toISOString() },
    coverage: { status: 'complete', observedCount: 2, expectedCount: 2 }, method: { kind: 'reconciled_manual' }, observedAt: end.toISOString(),
    report: { description: 'Synthetic retained revenue less all recorded variable costs.', costsComplete: true } };
}
function recordInput(measurement, verification) {
  return { source: { type: 'experiment_measurement', experimentId: measurement.experimentId, measurementRevision: measurement.revision, measurementDigest: measurement.digest },
    ...Object.fromEntries(['metric','amount','currency','window','coverage','method','provenance','links'].map(k => [k, measurement[k]])), verification };
}
function publicationRow(workspaceId, version, publicationId, commitRevision, at, measurement) {
  const head = { schema: 'runvara-outcome-head/v1', workspaceId, outcomeId: version.outcomeId, revision: version.revision,
    versionId: version.versionId, digest: version.digest, status: version.status === 'withdrawn' ? 'withdrawn' : 'published', publicationId, committedAt: at, commitRevision };
  const row = { workspace_id: workspaceId, outcome_id: version.outcomeId, revision: version.revision, version_id: version.versionId,
    digest: version.digest, status: version.status, payload: version, publication_id: publicationId,
    intent_digest: digestMeasurementValue([workspaceId,publicationId]), committed_at: at, commit_revision: commitRevision, source_measurement: structuredClone(measurement) };
  return { row, receipt: { publication: { head, version }, replayed: false, isCurrent: true } };
}
const joinedRow = row => { const { source_measurement, source_action, ...compact } = row; return { workspace_id: row.workspace_id, outcome_id: row.outcome_id, version_id: row.version_id, version: compact }; };

export async function fixture(t, { measured = true, published = false, env = {}, linkedContract = false, primaryState = null } = {}) {
  const primaryWorkspace = primaryState?.workspace.id || 'outcome-alpha';
  const states = new Map(), rows = new Map(), receipts = new Map(), calls = [], invalidations = [];
  const counts = { identities: 0, gets: 0, saves: 0, providerCalls: 0 };
  const hooks = { afterIdentity: null, transport: null };
  for (const workspaceId of [primaryWorkspace,'outcome-beta']) {
    const s = workspaceId === primaryWorkspace && primaryState ? structuredClone(primaryState) : seedWorkspaceState({}, { workspaceId, email: `${workspaceId}@example.test`, passwordHash: 'synthetic-only' });
    s._revision = randomUUID(); s.users[0].passwordChangeRequired = false;
    for (const role of ['admin','member','viewer']) s.users.push({ ...s.users[0], id: `${workspaceId}-${role}`, email: `${role}-${workspaceId}@example.test`, role });
    s.revenueEngine.experiments = [{ id: EXPERIMENT, title: 'Retained contribution review', status: 'measured',
      impact: { verified: true, status: 'verified', incrementalContribution: 987, method: 'legacy interpretation remains unqualified' } }];
    s.privateSentinel = 'never-download-the-whole-workspace';
    if (measured) s.revenueEngine.experiments[0].outcomeMeasurement = prepareExperimentOutcomeMeasurement(measurementInput(), {
      workspaceId, experimentId: EXPERIMENT, actorId: s.users[0].id, now: new Date(), previousMeasurement: null });
    states.set(workspaceId, s);
  }
  const getExperiment = s => s.revenueEngine.experiments.find(x => x.id === EXPERIMENT);
  function seedPublication(workspaceId = primaryWorkspace) {
    const s = states.get(workspaceId), measurement = getExperiment(s).outcomeMeasurement, at = new Date().toISOString();
    const version = createBusinessOutcomeCandidate(recordInput(measurement, { kind: 'owner_attestation', actorId: s.users[0].id, verifiedAt: at, measurementDigest: measurement.digest }), { workspaceId, now: at });
    const value = publicationRow(workspaceId, version, randomUUID(), randomUUID(), at, measurement);
    rows.set(version.versionId, value.row); s._revision = value.receipt.publication.head.commitRevision;
    getExperiment(s).currentOutcome = value.receipt.publication.head;
    return value.receipt;
  }
  const initialPublication = published ? seedPublication() : null;
  const store = {
    provider: 'synthetic-test',
    async getIdentity(id) { counts.identities++; const s = states.get(id); const result = s ? structuredClone({ workspace: s.workspace, users: s.users }) : null; await hooks.afterIdentity?.(id); return result; },
    async get(id) { counts.gets++; return structuredClone(states.get(id) ?? null); },
    async save(id, state) { counts.saves++; assert.equal(state.workspace.id, id); if (state._revision !== states.get(id)._revision) throw Object.assign(new Error('Synthetic CAS conflict'), { status: 409, code: 'STATE_CONFLICT' }); state._revision = randomUUID(); states.set(id, structuredClone(state)); return state; }
  };
  const persistence = createBusinessOutcomePersistence({ invalidate: id => invalidations.push(id), request: async (path, options = {}) => {
    calls.push({ path, options: structuredClone(options) });
    if (hooks.transport) return hooks.transport(path, options);
    if (path === 'rpc/runvara_read_business_outcome_review') {
      const { p_workspace_id: id, p_experiment_id: experimentId } = JSON.parse(options.body), s = states.get(id);
      const matches = s?.revenueEngine?.experiments?.filter(x => x?.id === experimentId) || [];
      if (matches.length !== 1) throw sqlError('P0O09');
      const e = matches[0], current = [...rows.values()].filter(x => x.workspace_id === id && x.payload.source.experimentId === experimentId).sort((a,b) => b.revision-a.revision)[0];
      return structuredClone({ workspaceId: id, workspaceRevision: s._revision, experiment: { id: e.id, title: e.title ?? null, status: e.status ?? null }, measurement: e.outcomeMeasurement ?? null, current: current ? joinedRow(current) : null,
        ...(linkedContract ? { actionLinkContract: linkedContract === true ? REVIEWED_ACTION_CONTRACT : linkedContract, currentActionAssociation: current?.source_measurement?.intervention ?? null,
          actionChoices: (s.connectionWrites || []).filter(w=>w.recordedActionContext && (![true, REVIEWED_ACTION_CONTRACT].includes(linkedContract) || w.recordedActionContext.origin !== 'owner_objective_content')).map(w=>({ id:w.id, account:w.account, productId:w.input.productId, title:w.input.title, completedAt:w.completedAt, digest:w.recordedActionContext.snapshotDigest, ...(w.recordedActionContext.origin === 'owner_objective_content' ? { origin: 'owner_objective_content', originatingObjective: w.recordedActionContext.originatingObjective } : {}) })) } : {}) });
    }
    if (path === 'rpc/runvara_publish_business_outcome') {
      const p = JSON.parse(options.body), s = states.get(p.p_workspace_id), actors = s?.users?.filter(x => x.id === p.p_actor_id) || [];
      const actor = actors[0];
      if (actors.length !== 1 || actor.role !== 'owner' || actor.active === false || actor.passwordChangeRequired || (actor.sessionVersion ?? 1) !== p.p_actor_session_version) throw sqlError('P0O03');
      if (receipts.has(p.p_publication_id)) return { ...structuredClone(receipts.get(p.p_publication_id)), replayed: true };
      if (s._revision !== p.p_expected_workspace_revision) throw sqlError('P0O04');
      const e = s.revenueEngine.experiments.find(x => x.id === p.p_experiment_id);
      if (!e || !evidenceInWorkspace(e, p.p_workspace_id)) throw sqlError('P0O09');
      const previous = [...rows.values()].filter(x => x.workspace_id === p.p_workspace_id && x.payload.source.experimentId === p.p_experiment_id).sort((a,b) => b.revision-a.revision)[0];
      if ((previous?.version_id ?? null) !== p.p_expected_head_version_id || (previous?.digest ?? null) !== p.p_expected_head_digest) throw sqlError('P0O05');
      const source = p.p_action === 'withdraw' ? previous.source_measurement : e.outcomeMeasurement;
      const measurement = validateExperimentOutcomeMeasurement(source, { workspaceId: p.p_workspace_id, experimentId: p.p_experiment_id, now: new Date() });
      if (measurement.revision !== p.p_expected_measurement_revision || measurement.digest !== p.p_expected_measurement_digest) throw sqlError('P0O07');
      if (!assessExperimentOutcomeMeasurement(measurement, { workspaceId: p.p_workspace_id, experimentId: p.p_experiment_id, now: new Date() }).measurementComplete) throw sqlError('P0O02');
      const at = new Date().toISOString(), verification = { kind: 'owner_attestation', actorId: actor.id, verifiedAt: at, measurementDigest: measurement.digest };
      const context = { workspaceId: p.p_workspace_id, now: at };
      const version = p.p_action === 'withdraw' ? withdrawBusinessOutcomeCandidate(previous.payload, { reason: p.p_withdrawal_reason, verification }, context)
        : p.p_action === 'correct' ? correctBusinessOutcomeCandidate(previous.payload, recordInput(measurement, verification), context)
        : createBusinessOutcomeCandidate(recordInput(measurement, verification), context);
      const value = publicationRow(p.p_workspace_id, version, p.p_publication_id, randomUUID(), at, measurement);
      if (measurement.intervention) {
        value.row.source_action = p.p_action === 'withdraw' ? previous.source_action
          : measurement.intervention.reuseVersionId ? rows.get(measurement.intervention.reuseVersionId)?.source_action : resolveRecordedActionEvidence(s, measurement.intervention.action.id);
      } else value.row.source_action = null;
      rows.set(version.versionId, value.row); receipts.set(p.p_publication_id, value.receipt);
      s._revision = value.receipt.publication.head.commitRevision; e.currentOutcome = value.receipt.publication.head;
      return structuredClone(value.receipt);
    }
    const url = new URL(path, 'https://synthetic.invalid/'), workspaceId = url.searchParams.get('workspace_id')?.slice(3);
    assert.ok(states.has(workspaceId), 'The adapter must bind an explicit authenticated tenant');
    if (url.pathname === '/runvara_business_outcome_heads') {
      const byOutcome = new Map();
      for (const row of rows.values()) if (row.workspace_id === workspaceId && (!byOutcome.has(row.outcome_id) || byOutcome.get(row.outcome_id).revision < row.revision)) byOutcome.set(row.outcome_id, row);
      const data = [...byOutcome.values()].map(joinedRow);
      return { data, contentRange: data.length ? `0-${data.length-1}/${data.length}` : '*/0' };
    }
    if (url.pathname === '/runvara_business_outcome_versions') {
      const id = url.searchParams.get('version_id')?.slice(3), row = rows.get(id);
      return row?.workspace_id === workspaceId ? [structuredClone(row)] : [];
    }
    assert.fail('Unexpected synthetic database path: ' + path);
  } });
  store.businessOutcomeSummary = workspace => persistence.current(workspace);
  store.getBusinessOutcomeReview = (workspace,id) => persistence.review(workspace,id);
  store.getBusinessOutcomeEvidence = (workspace,id) => persistence.evidence(workspace,id);
  store.publishBusinessOutcome = (workspace,actor,input) => persistence.publish(workspace,actor,input);
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: SECRET, CREDENTIALS_KEY: SECRET, SHOPIFY_PUBLIC_SYNC_ENABLED: 'false', ...env }, {
    store, schedulerEnabled: false, agentOpsEnabled: false,
    fetchImpl: async () => { counts.providerCalls++; assert.fail('Outcome routes must not call providers or remote networks'); },
    aiProvider: { enhanceCommander: async () => { counts.providerCalls++; assert.fail('Outcome routes must not invoke a model'); } }
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async () => { await server.packsmart.drain(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  function auth(workspace = primaryWorkspace, role = 'owner') {
    const user = states.get(workspace).users.find(x => x.role === role);
    const token = createSessionToken({ userId: user.id, workspaceId: workspace, email: user.email, role, sessionVersion: user.sessionVersion ?? 1 }, SECRET);
    return { token, csrf: verifySessionToken(token, SECRET).csrf };
  }
  async function request(route, { method = 'GET', body, rawBody, identity = auth(), csrf = true, origin } = {}) {
    const headers = {};
    if (identity) { headers.Cookie = `packsmart_session=${identity.token}`; if (csrf) headers['X-CSRF-Token'] = identity.csrf; }
    if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = 'application/json';
    if (origin) headers.Origin = origin;
    const response = await fetch(base + route, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, body: data, bytes: Buffer.byteLength(text), headers: response.headers };
  }
  function publicationInput(workspace = primaryWorkspace) {
    const s = states.get(workspace), m = getExperiment(s).outcomeMeasurement;
    return { publicationId: randomUUID(), action: 'publish', experimentId: EXPERIMENT, expectedWorkspaceRevision: s._revision,
      expectedMeasurementRevision: m.revision, expectedMeasurementDigest: m.digest, expectedHeadVersionId: null, expectedHeadDigest: null, withdrawalReason: null };
  }
  return { states, store, server, hooks, calls, counts, invalidations, rows, primaryWorkspace, request, auth, publicationInput, initialPublication, seedPublication };
}

