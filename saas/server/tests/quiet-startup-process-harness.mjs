import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fakeSupabase } from './fake-supabase.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const exec = promisify(execFile);
const helper = fileURLToPath(new URL('./quiet-startup-process-fixture.mjs', import.meta.url));
export const candidateRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const D32_COMMIT = 'd32da62d0e7935597638266d44d88ae5e066d51f';
export const D32_TREE = 'f58aed9bd9c99e1376b865f85c47097492faec4d';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const claimPhases = state => (state?.connectionWrites || []).flatMap(write => Object.entries(write.dispatchClaim?.phases || {})
  .map(([phase, value]) => [write.id, write.dispatchClaim.id, phase, value]));
const credentials = state => (state?.connections || []).map(row => [row.id, row.encryptedCredentials]);
const ordinaryWorkspace = 'quiet-ordinary';

function initialState(workspaceId) {
  const state = seedWorkspaceState({}, { workspaceId, userId: 'quiet-owner', email: `${workspaceId}@example.test`, passwordHash: 'synthetic-only' });
  state.products = [{ id: 'gid://shopify/Product/71', provider: 'shopify', title: 'Cup', description: 'Small cup.', status: 'active' }];
  state.connections = [{ id: 'quiet-shopify', provider: 'shopify', encryptedCredentials: 'synthetic-marker', metadata: {
    shopDomain: 'quiet-startup.myshopify.com', grantedScopes: ['read_products', 'write_products'] } }];
  state.connectionSettings = { shopify: { permissionMode: 'approval_gated', revision: 1 } };
  state.businessObjectives = []; state.connectionWrites = []; state.approvals = [];
  state.connectionDoctor = { ebay: { leaseUntil: '2099-01-01T00:00:00.000Z', nextRetryAt: '2099-01-02T00:00:00.000Z', attempts: 2,
    pendingReadAttempts: [{ id: 'retained_read_attempt', status: 'uncertain', at: '2026-01-01T00:00:00.000Z' }] } };
  if (workspaceId === 'quiet-retained') {
    state.connectionWrites = [{ id: 'write_retained_uncertain', requestId: 'request_retained_uncertain_001', provider: 'shopify',
      connectionId: 'quiet-shopify', account: 'quiet-startup.myshopify.com', status: 'executing', requestedBy: 'quiet-owner',
      input: { operation: 'product_content', productId: 'gid://shopify/Product/71', title: 'Uncertain original title', description: 'Uncertain original description' },
      digest: 'retained-original-identity', dispatchClaim: { id: 'retained-claim', workspaceId, identity: 'retained-original-identity',
        authority: 'retained-original-authority', phases: { shopify_mutation: { requestDigest: 'retained-original-request', status: 'dispatching', at: '2026-01-01T00:00:00.000Z' } } } }];
    state.automationRuns = [{ id: 'retained-run', ruleId: 'marketRadar', status: 'IN PROGRESS', attempts: 1,
      leaseUntil: '2099-02-01T00:00:00.000Z', nextRetryAt: '2099-02-02T00:00:00.000Z', effects: { uncertainSubmissions: 1, costStatus: 'unknown' } }];
    state.agentOps = { enabled: true, paused: false, dailyAiUnitLimit: 50, concurrencyLimit: 1 };
  }
  return state;
}

export async function syntheticTransport(t) {
  const database = fakeSupabase({ initialStates: [initialState(ordinaryWorkspace), initialState('quiet-retained')] });
  database.tables.set('runvara_agent_jobs', [
    { id: 'job_retained_uncertain', workspace_id: 'quiet-retained', status: 'running', attempts: 1, worker_id: 'retained-old-worker', lease_until: '2099-03-01T00:00:00.000Z', result: { completion: 'uncertain' } },
    { id: 'job_retained_queued', workspace_id: 'quiet-retained', status: 'queued', attempts: 0, available_at: '2020-01-01T00:00:00.000Z', type: 'connection_sync', provider: 'shopify', payload: { areas: ['products'] } }
  ]);
  const byProcess = new Map(); let tail = Promise.resolve();
  const counters = label => {
    if (!byProcess.has(label)) byProcess.set(label, { reads: 0, writes: 0, claimRequests: 0, dispatchClaimWrites: 0, authMutations: 0, credentialMutations: 0 });
    return byProcess.get(label);
  };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const action = tail.then(async () => {
      const label = req.headers['x-fixture-process']; assert.ok(label, 'Each database request belongs to an actual child process');
      const counts = counters(label), mutation = !['GET', 'HEAD'].includes(req.method);
      counts[mutation ? 'writes' : 'reads']++;
      const url = new URL(req.url, 'http://synthetic.invalid');
      if (url.pathname.endsWith('/runvara_claim_agent_jobs')) { counts.claimRequests++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); return; }
      const before = new Map([...database.states].map(([id, state]) => [id, structuredClone(state)]));
      const response = await database.fetchImpl(url, { method: req.method, headers: req.headers, ...(body ? { body } : {}) });
      if (mutation) for (const [id, state] of database.states) {
        const previous = before.get(id);
        if (digest(state.users) !== digest(previous?.users)) counts.authMutations++;
        if (digest(credentials(state)) !== digest(credentials(previous))) counts.credentialMutations++;
        const previousClaims = new Set(claimPhases(previous).map(digest));
        counts.dispatchClaimWrites += claimPhases(state).filter(claim => !previousClaims.has(digest(claim))).length;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    });
    tail = action.catch(() => {});
    try { await action; } catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'SYNTHETIC_TRANSPORT_FAILURE' })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base, snapshot: async () => { await tail; return structuredClone({ states: [...database.states], tables: [...database.tables] }); },
    counts: label => ({ ...counters(label) }) };
}

export async function startProcess(t, transport, { label, mode, root = candidateRoot }) {
  const child = fork(helper, [root, transport.base, label, mode], {
    execPath: process.execPath, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH }
  });
  const pending = new Map(), backlog = new Map(), events = new Map(); let next = 0, log = '', exited;
  child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
  child.on('message', message => {
    if (message.id) {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (!waiter) return;
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
    } else {
      const waiter = events.get(message.event);
      if (waiter) { events.delete(message.event); waiter.resolve(message); } else backlog.set(message.event, message);
    }
  });
  const exitPromise = new Promise(resolve => child.once('exit', (code, signal) => {
    exited = { code, signal }; resolve(exited);
    for (const waiter of [...pending.values(), ...events.values()]) waiter.reject(new Error(`Child ${label} exited ${code}/${signal}: ${log}`));
  }));
  const event = name => {
    if (backlog.has(name)) { const value = backlog.get(name); backlog.delete(name); return Promise.resolve(value); }
    if (exited) return Promise.reject(new Error(`Child ${label} already exited: ${log}`));
    return new Promise((resolve, reject) => events.set(name, { resolve, reject }));
  };
  const command = command => new Promise((resolve, reject) => {
    if (exited) { reject(new Error(`Child ${label} already exited`)); return; }
    const id = ++next; pending.set(id, { resolve, reject }); child.send({ id, command });
  });
  t.after(async () => { if (!exited) { child.kill('SIGKILL'); await exitPromise; } });
  const ready = await event('ready');
  assert.match(ready.node, /^v22\./, 'Qualification requires the supported Node 22 major');
  const request = async (route, { method = 'GET', body, workspace = ordinaryWorkspace, headers: extraHeaders = {} } = {}) => {
    const identity = ready.identities[workspace];
    const headers = { Cookie: `__Host-packsmart_session=${identity.token}`, 'X-CSRF-Token': identity.csrf, ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(ready.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await response.text(); let result; try { result = JSON.parse(text); } catch { result = text; }
    return { status: response.status, body: result, headers: response.headers };
  };
  return { ready, command, event, request, isAlive: () => !exited, logs: () => log,
    close: async () => { if (!exited) await command('close'); const result = await exitPromise; assert.deepEqual(result, { code: 0, signal: null }); return result; } };
}

export const good = value => { assert.equal(value.status, 200, JSON.stringify(value.body)); return value.body; };
export const paused = value => { assert.equal(value.status, 503, JSON.stringify(value.body)); assert.equal(value.body.code, 'STARTUP_QUIET_MODE'); };
export async function prepareOrdinary(process, suffix) {
  const body = { operation: 'product_content', requestId: `request_quiet_process_${suffix}`, productId: 'gid://shopify/Product/71',
    title: `Owner reviewed title ${suffix}`, description: 'Owner reviewed description',
    target: { schema: 'runvara-manual-content-target/v1', connectionId: 'quiet-shopify', account: 'quiet-startup.myshopify.com', settingsRevision: 1 } };
  const write = good(await process.request('/api/connections/shopify/writes', { method: 'POST', body })).write;
  good(await process.request(`/api/approvals/${write.approvalId}/decision`, { method: 'POST', body: { decision: 'approved', revision: 1 } }));
  return { body, write };
}
export const execute = (process, value) => process.request(`/api/connection-writes/${value.write.id}/execute`, { method: 'POST', body: {} });
export const stateFor = (snapshot, workspace = ordinaryWorkspace) => new Map(snapshot.states).get(workspace);
export function assertQuietCounts(status, transportCounts) {
  for (const key of ['transportWrites', 'saves', 'jobClaims', 'dispatchClaims', 'integrityChecks', 'credentials', 'providerReads', 'providerMutations', 'externalAttempts', 'intervals']) {
    assert.equal(status.counts[key], 0, `Quiet process ${key}`);
  }
  for (const key of ['writes', 'claimRequests', 'dispatchClaimWrites', 'authMutations', 'credentialMutations']) assert.equal(transportCounts[key], 0, `Quiet transport ${key}`);
  assert.equal(status.scheduler.lastTickAt, null); assert.equal(status.agentOps.lastTickAt, null);
}

export async function probeQuiet(process, transport, label, existingWrite) {
  const retained = await transport.snapshot(), before = (await process.command('status')).counts;
  const health = good(await process.request('/api/health')); assert.equal(health.startupMode, 'quiet'); assert.equal(health.productionReady, false);
  good(await process.request('/api/health', { method: 'HEAD' }));
  good(await process.request('/api/auth/session'));
  good(await process.request('/app.js')); good(await process.request('/app.js', { method: 'HEAD' }));
  const reads = await process.command('status');
  assert.ok(reads.counts.transportReads > before.transportReads, 'Permitted health/session checks have real synthetic database reads');
  const routes = [
    ['GET', '/api/bootstrap'], ['GET', '/api/brief'], ['GET', '/api/marketing/providers/canva/templates'],
    ['GET', '/api/integrations/shopify/oauth/callback?code=synthetic'], ['GET', '/api/auth/session/'],
    ['HEAD', '/api/auth/session'], ['OPTIONS', '/api/health'], ['POST', '/api/health'], ['POST', '/app.js'],
    ['GET', '/arbitrary.js'], ['POST', '/api/auth/logout'], ['POST', '/api/auth/login'],
    ['POST', '/api/auth/change-password'], ['POST', '/api/integrations/shopify/oauth/start'],
    ['POST', '/api/connections/shopify/refresh'], ['POST', '/api/connections/shopify/sync'],
    ['POST', '/api/connections/shopify/writes'], ['POST', '/api/webhooks/stripe'],
    ['POST', '/api/agent-ops/jobs'], ['POST', '/api/autopilot/run'],
    ['POST', `/api/connection-writes/${existingWrite.write.id}/execute`],
    ['POST', '/api/connection-writes/write_retained_uncertain/execute']
  ];
  for (const [method, route] of routes) {
    const response = await process.request(route, { method, ...(method === 'POST' ? { body: {} } : {}) });
    if (method === 'HEAD') { assert.equal(response.status, 503, route); assert.equal(response.body, ''); }
    else paused(response);
  }
  await process.command('mutate-env-normal');
  paused(await process.request('/api/bootstrap', { headers: { RUNVARA_STARTUP_MODE: 'normal', 'X-Runvara-Startup-Mode': 'normal' } }));
  assert.equal(good(await process.request('/api/health')).startupMode, 'quiet');
  await process.command('probe-workers');
  const status = await process.command('status');
  assert.equal(status.counts.transportReads, reads.counts.transportReads, 'Denied routes and worker probes never reach the database');
  assertQuietCounts(status, transport.counts(label));
  assert.deepEqual(await transport.snapshot(), retained, 'Quiet reads and denials preserve all retained rows exactly');
  return status;
}

export async function evidence(name, value) {
  const directory = process.env.RUNVARA_QUIET_PROCESS_EVIDENCE_DIR;
  if (!directory) return;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, name + '.json'), JSON.stringify(value, null, 2) + '\n');
}
export const processEvidence = p => ({ pid: p.ready.pid, mode: p.ready.mode, node: p.ready.node,
  nodeExecutableSha256: p.ready.nodeExecutableSha256, configuration: p.ready.configuration, runtime: p.ready.runtime });

export async function qualifyCutover(t, baseline) {
  const transport = await syntheticTransport(t);
  const initial = await transport.snapshot();
  const old = await startProcess(t, transport, { label: 'predecessor', mode: baseline ? 'legacy' : 'normal', root: baseline?.directory || candidateRoot });
  if (baseline) assert.deepEqual(old.ready.runtime, baseline.runtime, 'Child attests the exact extracted public d32 runtime bytes');
  const work = await prepareOrdinary(old, 'predecessor_001');
  await old.command('hold-provider');
  const submitted = old.event('provider-submitted'), execution = execute(old, work);
  // Cleanup can interrupt the outstanding HTTP request after an assertion fails.
  // Its result is still awaited below on the successful path.
  execution.catch(() => {});
  await submitted;
  const admitted = await transport.snapshot(), pendingWrite = stateFor(admitted).connectionWrites.find(row => row.id === work.write.id);
  assert.equal(pendingWrite.status, 'executing'); assert.ok(pendingWrite.dispatchClaim.phases.shopify_mutation);
  const oldAdmitted = await old.command('status');
  assert.equal(oldAdmitted.counts.providerMutations, 1); assert.equal(oldAdmitted.counts.credentials, 1);
  assert.equal(transport.counts('predecessor').dispatchClaimWrites, 1, 'Real predecessor persists its bounded synthetic dispatch claim');

  const quiet = await startProcess(t, transport, { label: 'quiet', mode: 'quiet' });
  assert.notEqual(quiet.ready.pid, old.ready.pid); assert.equal(old.isAlive(), true);
  if (!baseline) assert.deepEqual(quiet.ready.runtime, old.ready.runtime);
  else assert.notEqual(quiet.ready.runtime.sha256, old.ready.runtime.sha256, 'This is an actual old-binary overlap, not two candidate processes');
  assert.deepEqual(await transport.snapshot(), admitted, 'Quiet startup itself leaves all retained rows untouched');
  await probeQuiet(quiet, transport, 'quiet', work);
  const drainStarted = old.event('drain-started'); let drainFinished = false;
  const draining = old.command('drain').then(value => { drainFinished = true; return value; });
  await drainStarted;
  if (!baseline) {
    const stopped = await old.request('/api/auth/session'); assert.equal(stopped.status, 503); assert.equal(stopped.body.code, 'SERVER_DRAINING');
  }
  await quiet.command('status'); assert.equal(drainFinished, false, 'Admitted work is still held at the synthetic provider boundary');
  await old.command('release-provider'); good(await execution);
  const drained = await draining;
  if (!baseline) assert.equal(drained.settled, true);
  const completed = await transport.snapshot(), completedWrite = stateFor(completed).connectionWrites.find(row => row.id === work.write.id);
  assert.equal(completedWrite.status, 'completed');
  assert.deepEqual(completedWrite.dispatchClaim, pendingWrite.dispatchClaim, 'Drain bookkeeping retains the original claim and submission identity');
  assert.equal(stateFor(completed).approvals.find(row => row.id === work.write.approvalId).executionStatus, 'completed');
  assert.deepEqual(stateFor(completed, 'quiet-retained'), stateFor(initial, 'quiet-retained'));
  assert.deepEqual(completed.tables.find(([name]) => name === 'runvara_agent_jobs'), initial.tables.find(([name]) => name === 'runvara_agent_jobs'));
  const oldFinal = await old.command('status');
  assert.equal(oldFinal.counts.providerMutations, 1); assert.ok(oldFinal.counts.saves > oldAdmitted.counts.saves, 'Existing admitted work finishes durable synthetic bookkeeping during drain');
  assertQuietCounts(await quiet.command('status'), transport.counts('quiet'));
  const oldExit = await old.close();
  assert.equal(old.isAlive(), false); assert.equal(quiet.isAlive(), true, 'The quiet process remains running after actual predecessor process exit');
  const afterExit = await transport.snapshot();
  good(await quiet.request('/api/auth/session')); paused(await execute(quiet, work));
  assert.deepEqual(await transport.snapshot(), afterExit);

  const normal = await startProcess(t, transport, { label: 'successor', mode: 'normal' });
  assert.notEqual(normal.ready.pid, quiet.ready.pid); assert.notEqual(normal.ready.pid, old.ready.pid);
  assert.deepEqual(normal.ready.runtime, quiet.ready.runtime, 'Quiet and normal successor run identical source bytes');
  assert.equal(normal.ready.nodeExecutableSha256, quiet.ready.nodeExecutableSha256);
  assert.equal(normal.ready.configuration.governedProducerContract, null);
  assert.equal(normal.ready.configuration.receiptContract, null); assert.equal(normal.ready.configuration.recoveryContract, null);
  assert.equal(good(await normal.request('/api/health')).startupMode, 'normal');
  assert.deepEqual(await transport.snapshot(), afterExit, 'Starting normal does not replay retained requests or reset claims/deadlines');
  const beforeReplay = await normal.command('status');
  good(await execute(normal, work));
  const uncertain = await normal.request('/api/connection-writes/write_retained_uncertain/execute', { method: 'POST', body: {}, workspace: 'quiet-retained' });
  assert.equal(uncertain.status, 409); assert.equal(uncertain.body.code, 'WRITE_ALREADY_ATTEMPTED');
  const afterReplay = await normal.command('status');
  assert.equal(afterReplay.counts.providerMutations, beforeReplay.counts.providerMutations); assert.equal(afterReplay.counts.credentials, beforeReplay.counts.credentials);
  assert.equal(afterReplay.counts.saves, beforeReplay.counts.saves); assert.deepEqual(await transport.snapshot(), afterExit);
  const ordinary = await prepareOrdinary(normal, 'successor_002'); good(await execute(normal, ordinary));
  const final = await transport.snapshot(), ordinaryWrite = stateFor(final).connectionWrites.find(row => row.id === ordinary.write.id);
  assert.equal(ordinaryWrite.status, 'completed'); assert.equal(Object.hasOwn(ordinaryWrite, 'recordedActionContext'), false);
  assert.equal(Object.hasOwn(ordinaryWrite, 'recordedActionUnavailable'), false);
  assert.deepEqual(stateFor(final).connectionWrites.find(row => row.id === work.write.id), completedWrite);
  assert.deepEqual(stateFor(final, 'quiet-retained'), stateFor(initial, 'quiet-retained'));
  assert.deepEqual(final.tables.find(([name]) => name === 'runvara_agent_jobs'), initial.tables.find(([name]) => name === 'runvara_agent_jobs'));
  const normalFinal = await normal.command('status'), quietFinal = await quiet.command('status');
  assert.equal(normalFinal.counts.providerMutations, 1); assert.equal(normalFinal.counts.credentials, 1);
  assertQuietCounts(quietFinal, transport.counts('quiet'));
  assert.ok(transport.counts('quiet').reads > 0, 'Zero durable effects is not a claim of zero database traffic');
  for (const p of [old, quiet, normal]) {
    for (const identity of Object.values(p.ready.identities)) assert.ok(!p.logs().includes(identity.token), 'Ephemeral session tokens are never logged');
  }
  await normal.close(); await quiet.close();
  return { outcome: 'passed', baseline: baseline ? { commit: baseline.commit, tree: baseline.tree, sourceBytes: baseline.sourceBytes } : 'same-candidate-artifact',
    processes: [old, quiet, normal].map(processEvidence), predecessorExit: oldExit,
    retainedWorkspaceSha256: digest(stateFor(initial, 'quiet-retained')), finalRetainedWorkspaceSha256: digest(stateFor(final, 'quiet-retained')),
    admittedClaimSha256: digest(pendingWrite.dispatchClaim), finalClaimSha256: digest(completedWrite.dispatchClaim),
    counts: { predecessor: oldFinal.counts, quiet: quietFinal.counts, successor: normalFinal.counts },
    transport: Object.fromEntries(['predecessor', 'quiet', 'successor'].map(label => [label, transport.counts(label)])),
    limits: ['Local process and synthetic shared transport proof only; not real deployment termination, PostgreSQL concurrency, or provider durability proof',
      'Normal workers are explicitly disabled to bound this scenario; quiet is tested with worker options explicitly enabled and manual worker probes',
      'The d32 drain, when selected, is exercised for one admitted locked request only; no claim of late-claim, integrity, or whole-fleet settlement',
      'Retained uncertain requests remain unresolved; no claim reset, retry, reconciliation, or automatic provider replay is performed'] };
}

// Pin a public Git object and verify every extracted byte. The fixture contains
// only runtime public source, never .env files, Git config, hooks or credentials.
export async function extractD32(t, repository) {
  assert.ok(repository, 'RUNVARA_D32_SOURCE_DIR must point to a repository containing the pinned public d32 object');
  const git = (...args) => exec('git', ['-C', repository, ...args], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 });
  assert.equal((await git('rev-parse', `${D32_COMMIT}^{commit}`)).stdout.toString().trim(), D32_COMMIT);
  assert.equal((await git('rev-parse', `${D32_COMMIT}^{tree}`)).stdout.toString().trim(), D32_TREE);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-quiet-d32-source-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const entries = (await git('ls-tree', '-rz', '--full-tree', D32_COMMIT, '--', 'saas')).stdout.toString().split('\0').filter(Boolean)
    .map(line => { const match = /^(\d+) blob ([a-f0-9]+)\t(.+)$/.exec(line); return match && { mode: match[1], oid: match[2], path: match[3] }; })
    .filter(entry => entry && (entry.path === 'saas/server/server.mjs' || /^saas\/server\/lib\/[^\0]+\.mjs$/.test(entry.path) || /^saas\/[^/]+\.(?:js|html|css|svg)$/.test(entry.path)));
  const files = [];
  for (const entry of entries) {
    assert.equal(entry.mode, '100644'); assert.ok(!entry.path.split('/').includes('..'));
    const bytes = (await git('cat-file', 'blob', entry.oid)).stdout;
    assert.equal(createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), entry.oid);
    const target = path.join(directory, entry.path); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
    files.push({ path: entry.path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  }
  assert.ok(files.some(file => file.path === 'saas/server/server.mjs'));
  const runtimeFiles = files.filter(file => file.path.endsWith('.mjs') || file.path === 'saas/app.js')
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(({ path, sha256 }) => ({ path, sha256 }));
  return { directory, commit: D32_COMMIT, tree: D32_TREE, sourceBytes: files.reduce((n, file) => n + file.bytes, 0),
    files, runtime: { files: runtimeFiles, sha256: digest(runtimeFiles) } };
}
