import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./governed-stage-process-fixture.mjs', import.meta.url));
const contract = 'runvara-governed-record-producers/v1';
const POST = '/api/objective-content/requests';
const good = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
const code = (result, status, expected) => { assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.code, expected); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const states = snapshot => new Map(snapshot.states);
const protectedState = state => ({ businessObjectives: state.businessObjectives, connectionWrites: state.connectionWrites,
  approvals: state.approvals, connectionDispatchAdmissions: state.connectionDispatchAdmissions, connectionDoctor: state.connectionDoctor, orders: state.orders });

async function start(t, disk, mode, seed = false) {
  const child = fork(helper, [disk, mode, ...(seed ? ['seed'] : [])], { execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH } });
  const pending = new Map(), backlog = new Map(), events = new Map(); let next = 0, log = '', closed = false;
  child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
  child.on('message', message => {
    if (message.id) { const waiter = pending.get(message.id); pending.delete(message.id); if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result); }
    else { const waiter = events.get(message.event); if (waiter) { events.delete(message.event); waiter.resolve(message); } else backlog.set(message.event, message); }
  });
  child.on('exit', (status, signal) => { for (const waiter of [...pending.values(), ...events.values()]) waiter.reject(new Error(`Child exited ${status}/${signal}: ${log}`)); });
  const event = name => backlog.has(name) ? Promise.resolve(backlog.get(name)) : new Promise((resolve, reject) => events.set(name, { resolve, reject }));
  const command = command => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); child.send({ id, command }); });
  const close = async () => { if (closed || child.exitCode !== null) return; closed = true; const exit = once(child, 'exit'); await command('close'); await exit; };
  t.after(async () => { if (!closed && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit.catch(() => {}); } });
  const ready = await event('ready');
  assert.match(ready.node, /^v22\./, 'Acceptance requires the supported Node 22 major');
  const request = async (route, { workspace = 'pair-alpha', method = 'GET', body, extraHeaders = {} } = {}) => {
    const identity = ready.identities[workspace], headers = { Cookie: `__Host-packsmart_session=${identity.token}`, 'X-CSRF-Token': identity.csrf, ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(ready.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch { value = raw; }
    return { status: response.status, body: value };
  };
  return { ready, command, event, request, close, logs: () => log };
}
async function objective(f, workspace = 'pair-alpha') {
  const jobId = `job_${workspace.replaceAll('-', '_')}`;
  const review = good(await f.request(`/api/objective-content/context?jobId=${jobId}&opportunityId=opportunity-content`, { workspace }));
  const body = { requestId: `request_objective_${workspace}_001`, jobId, opportunityId: 'opportunity-content', sourceRevision: review.sourceRevision,
    target: review.target, productId: review.product.id, title: 'Owner’s exact title ☕', description: 'Owner reviewed <description>\nSecond line.', confirmedDestinationProduct: true };
  const created = good(await f.request(POST, { workspace, method: 'POST', body }));
  return { body, write: created.request };
}
async function manual(f, workspace = 'pair-ordinary', suffix = '001') {
  const state = states(await f.command('snapshot')).get(workspace), connection = state.connections[0];
  const body = { operation: 'product_content', requestId: `request_manual_${workspace}_${suffix}`, productId: state.products[0].id,
    title: `Manual reviewed title ${suffix}`, description: 'Manual owner-reviewed description',
    target: { schema: 'runvara-manual-content-target/v1', connectionId: connection.id, account: connection.metadata.shopDomain, settingsRevision: state.connectionSettings.shopify.revision } };
  const created = good(await f.request('/api/connections/shopify/writes', { workspace, method: 'POST', body }));
  return { body, write: created.write };
}
const approve = (f, value, workspace = 'pair-alpha') => f.request(`/api/approvals/${value.write.approvalId}/decision`, { workspace, method: 'POST', body: { decision: 'approved', revision: 1 } });
const execute = (f, value, workspace = 'pair-alpha') => f.request(`/api/connection-writes/${value.write.id}/execute`, { workspace, method: 'POST', body: {} });
async function evidence(name, value) {
  const directory = process.env.RUNVARA_GOVERNED_PAIR_EVIDENCE_DIR;
  if (!directory) return;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n');
}

test('actual cold open→closed→open configuration pair preserves governed records, reads and independent ordinary controls', { timeout: 45000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-governed-process-pair-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); const disk = path.join(directory, 'synthetic-database.json');
  const forward = await start(t, disk, 'open', true);
  const alpha = await objective(forward), beta = await objective(forward, 'pair-beta');
  good(await approve(forward, alpha)); good(await execute(forward, alpha));
  const ordinary = await manual(forward); good(await approve(forward, ordinary, 'pair-ordinary')); good(await execute(forward, ordinary, 'pair-ordinary'));
  const financial = await manual(forward, 'pair-financial'); good(await approve(forward, financial, 'pair-financial'));
  const beforeFinancial = (await forward.command('snapshot')).counts;
  code(await execute(forward, financial, 'pair-financial'), 409, 'WRITE_POLICY_EVIDENCE_REQUIRED');
  const retained = await forward.command('snapshot');
  assert.equal(retained.counts.credentials, beforeFinancial.credentials); assert.equal(retained.counts.providerMutations, 2);
  const baseline = states(retained), alphaProtected = protectedState(baseline.get('pair-alpha'));
  assert.equal(baseline.get('pair-alpha').connectionWrites[0].recordedActionContext.schema, 'runvara-recorded-action-context/v2');
  assert.equal(baseline.get('pair-ordinary').connectionWrites[0].recordedActionContext.schema, 'runvara-recorded-action-context/v1');
  await forward.close();
  const rollback = await start(t, disk, 'closed');
  assert.notEqual(rollback.ready.pid, forward.ready.pid); assert.deepEqual(rollback.ready.runtime, forward.ready.runtime);
  assert.equal(rollback.ready.node, forward.ready.node); assert.equal(rollback.ready.nodeExecutableSha256, forward.ready.nodeExecutableSha256);
  assert.equal(rollback.ready.calculationVersion, 'catalogue-margin-thresholds/v2');
  const config = { ...forward.ready.configuration }; delete config.GOVERNED_RECORD_PRODUCER_CONTRACT;
  assert.deepEqual(rollback.ready.configuration, config, 'Only producer admission changes; receipt/recovery capability settings are unchanged');
  assert.deepEqual(states(await rollback.command('snapshot')), baseline, 'Cold successor sees original retained bytes');
  for (const [workspace, value] of [['pair-alpha', alpha], ['pair-beta', beta]]) {
    assert.equal(good(await rollback.request(`${POST}/${value.body.requestId}`, { workspace })).request.id, value.write.id);
    good(await rollback.request(POST, { workspace, method: 'POST', body: value.body }));
    code(await rollback.request(POST, { workspace, method: 'POST', body: { ...value.body, title: 'Changed intent' } }), 409, 'WRITE_CONFLICT');
    code(await rollback.request(POST, { workspace, method: 'POST', body: { ...value.body, requestId: `${value.body.requestId}_new` }, extraHeaders: { 'GOVERNED_RECORD_PRODUCER_CONTRACT': contract } }), 503, 'GOVERNED_RECORDS_PAUSED');
  }
  good(await execute(rollback, alpha));
  code(await approve(rollback, beta, 'pair-beta'), 503, 'GOVERNED_RECORDS_PAUSED');
  code(await execute(rollback, beta, 'pair-beta'), 409, 'APPROVAL_REQUIRED');
  code(await execute(rollback, financial, 'pair-financial'), 503, 'GOVERNED_RECORDS_PAUSED');
  const held = await rollback.command('snapshot');
  assert.equal(held.counts.saves, 0); assert.equal(held.counts.transportWrites, 0); assert.equal(held.counts.credentials, 0); assert.equal(held.counts.providerMutations, 0);
  assert.deepEqual(states(held), baseline);
  const unrelated = await rollback.request('/api/decision-memory', { method: 'POST', body: { key: 'rollback-review', category: 'goal', title: 'Unrelated retained note', content: 'Synthetic test only', source: 'Owner' } });
  assert.equal(unrelated.status, 201, JSON.stringify(unrelated.body));
  assert.deepEqual(protectedState(states(await rollback.command('snapshot')).get('pair-alpha')), alphaProtected);
  const closedOrdinary = await manual(rollback, 'pair-ordinary', '002'); good(await approve(rollback, closedOrdinary, 'pair-ordinary'));
  const beforeExecute = (await rollback.command('snapshot')).counts; good(await execute(rollback, closedOrdinary, 'pair-ordinary'));
  const afterExecute = await rollback.command('snapshot'), ordinaryState = states(afterExecute).get('pair-ordinary');
  assert.equal(afterExecute.counts.providerMutations - beforeExecute.providerMutations, 1); assert.equal(afterExecute.counts.saves - beforeExecute.saves, 3);
  const newWrite = ordinaryState.connectionWrites.find(row => row.id === closedOrdinary.write.id);
  assert.equal(Object.hasOwn(newWrite, 'recordedActionContext'), false); assert.equal(Object.hasOwn(newWrite, 'recordedActionUnavailable'), false);
  assert.deepEqual(ordinaryState.connectionWrites.find(row => row.id === ordinary.write.id), baseline.get('pair-ordinary').connectionWrites[0]);
  const beforeImport = (await rollback.command('snapshot')).counts;
  good(await rollback.request('/api/connections/shopify/sync', { workspace: 'pair-ordinary', method: 'POST', body: { areas: ['products'] } }));
  const imported = await rollback.command('snapshot');
  assert.equal(imported.counts.providerReads - beforeImport.providerReads, 1); assert.equal(imported.counts.providerMutations, afterExecute.counts.providerMutations);
  const beforeOauth = imported.counts;
  const oauth = good(await rollback.request('/api/integrations/shopify/oauth/start', { workspace: 'pair-ordinary', method: 'POST', body: { storeDomain: 'objective-content-fixture.myshopify.com' } }));
  assert.equal(new URL(oauth.authorizationUrl).hostname, 'objective-content-fixture.myshopify.com'); assert.equal(oauth.readOnly, true);
  const afterOauth = await rollback.command('snapshot'); assert.equal(afterOauth.counts.providerReads, beforeOauth.providerReads); assert.equal(afterOauth.counts.credentials, beforeOauth.credentials);
  assert.equal(afterOauth.counts.saves - beforeOauth.saves, 1, 'OAuth challenge start retains its existing one-save behavior; token exchange/persistence is not claimed');
  for (const [id, state] of states(afterOauth)) { assert.deepEqual(state.connectionDoctor.ebay, baseline.get(id).connectionDoctor.ebay); assert.deepEqual(state.orders, baseline.get(id).orders); }
  const app = await rollback.request('/app.js'); assert.equal(app.status, 200); assert.match(app.body, /Retry check/); assert.match(app.body, /completion is uncertain/);
  await rollback.close();
  const reopened = await start(t, disk, 'open');
  assert.deepEqual(reopened.ready.runtime, forward.ready.runtime); assert.deepEqual(reopened.ready.configuration, forward.ready.configuration);
  assert.equal(reopened.ready.node, forward.ready.node); assert.equal(reopened.ready.nodeExecutableSha256, forward.ready.nodeExecutableSha256);
  assert.deepEqual(states(await reopened.command('snapshot')), states(afterOauth));
  good(await reopened.request(`${POST}/${alpha.body.requestId}`)); good(await execute(reopened, alpha));
  good(await approve(reopened, beta, 'pair-beta')); good(await execute(reopened, beta, 'pair-beta'));
  const beforeReopenedFinancial = (await reopened.command('snapshot')).counts;
  code(await execute(reopened, financial, 'pair-financial'), 409, 'WRITE_POLICY_EVIDENCE_REQUIRED');
  const final = await reopened.command('snapshot'); assert.equal(final.counts.providerMutations, 1);
  assert.equal(final.counts.credentials, beforeReopenedFinancial.credentials); assert.equal(final.counts.saves, beforeReopenedFinancial.saves);
  assert.deepEqual(protectedState(states(final).get('pair-alpha')), alphaProtected);
  assert.equal(states(final).get('pair-financial').businessObjectives[0].limits.maxMonthlyAdBudget, 0);
  await reopened.close();
  await evidence('configuration-pair', { outcome: 'passed', node: process.version, runtime: forward.ready.runtime,
    processes: [forward, rollback, reopened].map(f => ({ pid: f.ready.pid, node: f.ready.node, nodeExecutableSha256: f.ready.nodeExecutableSha256, configuration: f.ready.configuration })),
    retainedAlphaSha256: digest(alphaProtected), finalAlphaSha256: digest(protectedState(states(final).get('pair-alpha'))),
    counts: { forward: retained.counts, closed: afterOauth.counts, reopened: final.counts },
    limits: ['Synthetic database/provider transports, not PostgreSQL receipt or durability proof', 'OAuth start only; no token exchange or credential persistence proof', 'Same immutable runtime configuration rollback; not recovery from a binary defect', 'Receipt/recovery capability settings remain absent in all three processes'] });
});

test('open predecessor drains admitted work while a cold closed successor cannot initiate another send', { timeout: 45000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-governed-overlap-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true })); const disk = path.join(directory, 'synthetic-database.json');
  const forward = await start(t, disk, 'open', true), alpha = await objective(forward), beta = await objective(forward, 'pair-beta');
  good(await approve(forward, alpha)); good(await approve(forward, beta, 'pair-beta'));
  await forward.command('hold-provider');
  const submitted = forward.event('provider-submitted'), execution = execute(forward, alpha); await submitted;
  const admitted = await forward.command('snapshot'), admittedAlpha = states(admitted).get('pair-alpha');
  assert.equal(admittedAlpha.connectionWrites[0].status, 'executing'); assert.ok(admittedAlpha.connectionWrites[0].dispatchClaim.phases.shopify_mutation);
  await forward.command('mutate-env-closed');
  const rollback = await start(t, disk, 'closed'); assert.deepEqual(rollback.ready.runtime, forward.ready.runtime);
  assert.equal(rollback.ready.node, forward.ready.node); assert.equal(rollback.ready.nodeExecutableSha256, forward.ready.nodeExecutableSha256);
  code(await execute(rollback, beta, 'pair-beta'), 503, 'GOVERNED_RECORDS_PAUSED');
  code(await execute(rollback, alpha), 409, 'WRITE_ALREADY_ATTEMPTED');
  const held = await rollback.command('snapshot'); assert.equal(held.counts.saves, 0); assert.equal(held.counts.credentials, 0); assert.equal(held.counts.providerMutations, 0);
  assert.deepEqual(states(held), states(admitted));
  const drainStarted = forward.event('drain-started'), draining = forward.command('drain'); await drainStarted;
  code(await forward.request('/api/auth/session'), 503, 'SERVER_DRAINING');
  await forward.command('release-provider'); good(await execution); assert.equal((await draining).settled, true);
  const completed = await rollback.command('snapshot'), result = states(completed).get('pair-alpha').connectionWrites[0];
  assert.equal(result.status, 'completed'); assert.equal(result.recordedActionContext.schema, 'runvara-recorded-action-context/v2', 'Open process snapshot stays admitted despite mutation of its environment object');
  assert.deepEqual(result.dispatchClaim, admittedAlpha.connectionWrites[0].dispatchClaim);
  assert.deepEqual(states(completed).get('pair-alpha').connectionDoctor, admittedAlpha.connectionDoctor);
  good(await execute(rollback, alpha));
  const finalOpen = await forward.command('snapshot'); assert.equal(finalOpen.counts.providerMutations, 1);
  assert.equal((await rollback.command('snapshot')).counts.providerMutations, 0);
  await forward.close(); await rollback.close();
  await evidence('overlap-drain', { outcome: 'passed', node: process.version, runtime: forward.ready.runtime,
    processes: [forward, rollback].map(f => ({ pid: f.ready.pid, node: f.ready.node, nodeExecutableSha256: f.ready.nodeExecutableSha256, configuration: f.ready.configuration })), claimSha256: digest(result.dispatchClaim),
    admittedClaimSha256: digest(admittedAlpha.connectionWrites[0].dispatchClaim), openCounts: finalOpen.counts, closedCounts: completed.counts,
    limits: ['Synthetic transport overlap, not PostgreSQL lock/concurrency proof', 'Closure requires draining every open predecessor; startup setting is not a live fleet latch'] });
});
