// Real server/store/integration modules in an isolated process. Only the database
// and provider transport are synthetic. No inherited environment or credentials.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';

const [root, transportBase, label, mode] = process.argv.slice(2);
if (!process.send || !root || !['quiet', 'normal', 'legacy'].includes(mode)
  || new URL(transportBase).hostname !== '127.0.0.1') throw new Error('Use the quiet startup process runner');
const load = name => import(pathToFileURL(path.join(root, 'saas/server', name)));
const beforeImports = await sourceManifest();
const [{ createPacksmartServer }, { createStore }, { IntegrationService }, security] = await Promise.all([
  load('server.mjs'), load('lib/store.mjs'), load('lib/integrations.mjs'), load('lib/security.mjs')
]);
const secret = randomBytes(48).toString('hex');
const databaseOrigin = 'https://quiet-startup.supabase.invalid';
const env = { NODE_ENV: 'production', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
  APP_PUBLIC_URL: 'https://quiet-startup.example.test', SHOPIFY_PUBLIC_SYNC_ENABLED: 'false',
  SUPABASE_URL: databaseOrigin, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-database-transport-only',
  ...(mode === 'legacy' ? {} : { RUNVARA_STARTUP_MODE: mode }) };
const counts = { transportReads: 0, transportWrites: 0, saves: 0, jobClaims: 0, dispatchClaims: 0,
  integrityChecks: 0, credentials: 0, providerReads: 0, providerMutations: 0, externalAttempts: 0, intervals: 0 };
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => { counts.externalAttempts++; throw new Error('External network forbidden'); };
const observedClaims = new Set();
const phasesFor = (workspaceId, state) => (state.connectionWrites || []).flatMap(write => Object.keys(write.dispatchClaim?.phases || {})
  .map(phase => `${workspaceId}/${write.id}/${write.dispatchClaim.id}/${phase}`));
const transport = async (url, options = {}) => {
  if (new URL(url).origin !== databaseOrigin) throw new Error('Non-synthetic database route forbidden');
  const read = ['GET', 'HEAD'].includes(options.method || 'GET');
  counts[read ? 'transportReads' : 'transportWrites']++;
  const response = await nativeFetch(transportBase + new URL(url).pathname + new URL(url).search, { ...options, headers: { ...options.headers, 'X-Fixture-Process': label } });
  if (read && options.method !== 'HEAD' && response.ok) {
    for (const row of await response.clone().json()) if (row.state?.workspace?.id) {
      for (const phase of phasesFor(row.state.workspace.id, row.state)) observedClaims.add(phase);
    }
  }
  return response;
};
const store = createStore(env, { fetchImpl: transport });
const save = store.save.bind(store);
store.save = async (workspaceId, state, ...args) => {
  counts.saves++;
  for (const key of phasesFor(workspaceId, state)) {
    if (!observedClaims.has(key)) { observedClaims.add(key); counts.dispatchClaims++; }
  }
  return save(workspaceId, state, ...args);
};
for (const [name, key] of [['claimAgentJobs', 'jobClaims'], ['integrityCheck', 'integrityChecks']]) {
  const original = store[name].bind(store);
  store[name] = (...args) => { counts[key]++; return original(...args); };
}
let holdProvider = false, releaseProvider;
const integrations = new IntegrationService(env, { fetchImpl: async (url, options = {}) => {
  if (new URL(url).hostname !== 'quiet-startup.myshopify.com') { counts.externalAttempts++; throw new Error('Non-synthetic provider forbidden'); }
  const body = JSON.parse(options.body || '{}');
  if (String(body.query).includes('mutation')) {
    counts.providerMutations++;
    if (holdProvider) { process.send({ event: 'provider-submitted' }); await new Promise(resolve => { releaseProvider = resolve; }); }
    return Response.json({ data: { productUpdate: { product: { id: body.variables.product.id, title: body.variables.product.title }, userErrors: [] } } });
  }
  counts.providerReads++;
  throw new Error('Unexpected synthetic provider read');
} });
integrations.shopifyConfig = state => ({ domain: state.connections[0].metadata.shopDomain,
  workspaceId: state.workspace.id, mode: 'oauth', apiVersion: '2026-07', accessToken: 'synthetic-only' });
integrations.connectorCredentials = async () => { counts.credentials++; return { accessToken: 'synthetic-only' }; };
const nativeInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => { counts.intervals++; return nativeInterval(...args); };
const server = createPacksmartServer(env, { store, integrations,
  schedulerEnabled: mode === 'quiet', agentOpsEnabled: mode === 'quiet',
  fetchImpl: async () => { counts.externalAttempts++; throw new Error('External network forbidden'); } });

async function sourceManifest() {
  const entries = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith('.mjs')) entries.push(target);
    }
  }
  await walk(path.join(root, 'saas/server/lib'));
  entries.push(path.join(root, 'saas/server/server.mjs'), path.join(root, 'saas/app.js'));
  const files = [];
  for (const file of entries) files.push({ path: path.relative(root, file).split(path.sep).join('/'), sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') });
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
const runtime = await sourceManifest();
if (runtime.sha256 !== beforeImports.sha256) throw new Error('Runtime source changed during module loading');
const identities = {};
for (const workspaceId of ['quiet-ordinary', 'quiet-retained']) {
  const token = security.createSessionToken({ userId: 'quiet-owner', workspaceId, email: `${workspaceId}@example.test`, role: 'owner', sessionVersion: 1 }, secret);
  identities[workspaceId] = { token, csrf: security.verifySessionToken(token, secret).csrf };
}
server.listen(0, '127.0.0.1'); await once(server, 'listening');
process.send({ event: 'ready', base: `http://127.0.0.1:${server.address().port}`, identities, pid: process.pid,
  node: process.version, nodeExecutableSha256: createHash('sha256').update(await fs.readFile(process.execPath)).digest('hex'),
  mode: server.packsmart.startupMode || 'legacy', runtime,
  configuration: { startupMode: env.RUNVARA_STARTUP_MODE ?? null, nodeEnv: env.NODE_ENV,
    requestedWorkersEnabled: mode === 'quiet', governedProducerContract: env.GOVERNED_RECORD_PRODUCER_CONTRACT ?? null,
    receiptContract: env.CONTENT_EXECUTION_RECEIPT_CONTRACT ?? null, recoveryContract: env.SHOPIFY_ORDER_RECOVERY_CONTRACT ?? null } });
process.on('message', async ({ id, command }) => {
  try {
    let result;
    if (command === 'status') result = { counts: { ...counts }, scheduler: server.packsmart.scheduler.status, agentOps: server.packsmart.agentOps.status };
    else if (command === 'hold-provider') { holdProvider = true; result = true; }
    else if (command === 'release-provider') { holdProvider = false; releaseProvider?.(); result = true; }
    else if (command === 'probe-workers') {
      server.packsmart.scheduler.start(); server.packsmart.agentOps.start();
      result = await Promise.all([server.packsmart.scheduler.tick(), server.packsmart.scheduler.runWorkspace('quiet-retained', { manual: true }), server.packsmart.agentOps.tick()]);
    } else if (command === 'mutate-env-normal') {
      env.RUNVARA_STARTUP_MODE = 'normal'; server.packsmart.env.RUNVARA_STARTUP_MODE = 'normal'; result = true;
    } else if (command === 'drain') {
      const draining = server.packsmart.drain(); process.send({ event: 'drain-started' }); result = await draining;
    } else if (command === 'close') {
      releaseProvider?.(); await server.packsmart.drain();
      await new Promise(resolve => server.close(resolve));
      process.send({ id, result: { counts: { ...counts } } }); process.disconnect(); return;
    } else throw new Error('Unknown fixture command');
    process.send({ id, result: result ?? null });
  } catch (error) { process.send({ id, error: { message: error.message, code: error.code } }); }
});
