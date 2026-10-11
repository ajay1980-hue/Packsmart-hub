// Actual child process/server/adapter; only provider and disk-retained database
// transport are synthetic. This is not PostgreSQL transaction/receipt proof.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createStore } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { OPERATIONS_CALCULATION_VERSION } from '../lib/operations.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { objectiveContentSeed, objectiveContentJob, CONTENT_PRODUCT } from './objective-content-fixture.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const [diskPath, mode, seed] = process.argv.slice(2);
if (!process.send || !diskPath || !['open', 'closed'].includes(mode)) throw new Error('Use the configuration-pair test runner');
const secret = 'configuration-pair-synthetic-session-secret-at-least-32-characters';
const env = { NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
  APP_PUBLIC_URL: 'https://configuration-pair.example.test', SHOPIFY_PUBLIC_SYNC_ENABLED: 'false',
  SHOPIFY_OAUTH_ENABLED: 'true', SHOPIFY_OAUTH_CLIENT_ID: 'synthetic-client-id', SHOPIFY_OAUTH_CLIENT_SECRET: 'synthetic-client-secret-for-tests-only',
  SUPABASE_URL: 'https://configuration-pair.supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-database-transport-only',
  ...(mode === 'open' ? { GOVERNED_RECORD_PRODUCER_CONTRACT } : {}) };
const counts = { transportReads: 0, transportWrites: 0, saves: 0, credentials: 0, providerMutations: 0, providerReads: 0 };
const database = fakeSupabase();
async function reload() {
  let data;
  try { data = JSON.parse(await fs.readFile(diskPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; data = { states: [], tables: [] }; }
  database.states.clear(); database.tables.clear();
  for (const [id, value] of data.states) database.states.set(id, value);
  for (const [id, value] of data.tables) database.tables.set(id, value);
}
async function persist() {
  const temp = `${diskPath}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ states: [...database.states], tables: [...database.tables] })); await fs.rename(temp, diskPath);
}
let transportTail = Promise.resolve();
const transport = (url, options = {}) => {
  const operation = transportTail.then(async () => {
    await reload(); const mutation = !['GET', 'HEAD'].includes(options.method || 'GET');
    counts[mutation ? 'transportWrites' : 'transportReads']++;
    const result = await database.fetchImpl(url, options);
    if (mutation) await persist();
    return result;
  });
  transportTail = operation.catch(() => {}); return operation;
};
const store = createStore(env, { fetchImpl: transport });
const save = store.save.bind(store); store.save = async (...args) => { counts.saves++; return save(...args); };
let holdProvider = false, releaseProvider;
const integrations = new IntegrationService(env, { fetchImpl: async (url, options = {}) => {
  if (!new URL(url).hostname.endsWith('.myshopify.com')) throw new Error('Non-synthetic provider route forbidden');
  const body = JSON.parse(options.body || '{}'), query = body.query || '';
  if (query.includes('mutation')) {
    counts.providerMutations++;
    if (holdProvider) { process.send({ event: 'provider-submitted' }); await new Promise(resolve => { releaseProvider = resolve; }); }
    return Response.json({ data: { productUpdate: { product: { id: body.variables.product.id, title: body.variables.product.title }, userErrors: [] } } });
  }
  counts.providerReads++;
  if (query.includes('Products')) return Response.json({ data: { products: { nodes: [{ id: CONTENT_PRODUCT, title: 'Imported synthetic title', status: 'ACTIVE', description: 'Synthetic imported description',
    totalInventory: 3, variants: { nodes: [], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } } });
  if (query.includes('ConnectionIdentity')) return Response.json({ data: { shop: { id: 'gid://shopify/Shop/71', name: 'Synthetic shop', myshopifyDomain: new URL(url).hostname }, currentAppInstallation: { accessScopes: [{ handle: 'read_products' }, { handle: 'write_products' }] } } });
  throw new Error('Unexpected synthetic provider operation');
} });
integrations.shopifyConfig = state => ({ domain: state.connections[0].metadata.shopDomain, workspaceId: state.workspace.id, mode: 'oauth', apiVersion: '2026-07', accessToken: 'synthetic-only' });
integrations.connectorCredentials = async () => { counts.credentials++; return { accessToken: 'synthetic-only' }; };
const server = createPacksmartServer(env, { store, integrations, schedulerEnabled: false, agentOpsEnabled: false,
  fetchImpl: async () => { throw new Error('External network forbidden'); } });
if (seed === 'seed') {
  for (const workspaceId of ['pair-alpha', 'pair-beta', 'pair-ordinary', 'pair-financial']) {
    const initial = objectiveContentSeed({ workspaceId, ...(workspaceId === 'pair-financial' ? { limits: { profitFirst: true, maxMonthlyAdBudget: 0, currency: 'GBP' } } : {}) });
    initial.state.users[0].email = `${workspaceId}@example.test`;
    if (workspaceId === 'pair-ordinary') initial.state.businessObjectives = [];
    initial.state.connectionDoctor = { ebay: { leaseUntil: '2099-01-01T00:00:00.000Z', nextRetryAt: '2099-01-02T00:00:00.000Z', attempts: 2,
      pendingReadAttempts: [{ id: 'retained_read_attempt', status: 'uncertain' }] } };
    initial.state.orders = [{ id: 'retained-order', provider: 'ebay', actualShippingCost: 0, costHistory: [{ amount: '0.0000', currency: 'GBP' }] }];
    await store.save(workspaceId, initial.state);
    if (workspaceId !== 'pair-ordinary') {
      await reload(); const state = database.states.get(workspaceId), jobs = database.tables.get('runvara_agent_jobs') || [];
      jobs.push(objectiveContentJob(state, initial.objective, { id: `job_${workspaceId.replaceAll('-', '_')}` }));
      database.tables.set('runvara_agent_jobs', jobs); await persist();
    }
  }
}
for (const key of Object.keys(counts)) counts[key] = 0;
async function sourceManifest() {
  const root = fileURLToPath(new URL('../', import.meta.url)), entries = [];
  async function walk(directory) { for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name); if (entry.isDirectory()) await walk(target); else if (entry.name.endsWith('.mjs')) entries.push(target);
  } }
  await walk(path.join(root, 'lib')); entries.push(path.join(root, 'server.mjs'), path.resolve(root, '../app.js'));
  const files = [];
  for (const file of entries.sort()) files.push({ path: path.relative(path.resolve(root, '..'), file), sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') });
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
const manifest = await sourceManifest();
server.listen(0, '127.0.0.1'); await once(server, 'listening');
await reload();
const identities = Object.fromEntries([...database.states].map(([id, state]) => {
  const user = state.users[0], token = createSessionToken({ userId: user.id, workspaceId: id, email: user.email, role: user.role, sessionVersion: 1 }, secret);
  return [id, { token, csrf: verifySessionToken(token, secret).csrf }];
}));
process.send({ event: 'ready', base: `http://127.0.0.1:${server.address().port}`, identities, pid: process.pid, node: process.version,
  nodeExecutableSha256: createHash('sha256').update(await fs.readFile(process.execPath)).digest('hex'),
  configuration: env, runtime: manifest, calculationVersion: OPERATIONS_CALCULATION_VERSION });
process.on('message', async ({ id, command }) => {
  try {
    let result;
    if (command === 'snapshot') { await transportTail; await reload(); result = { states: [...database.states], tables: [...database.tables], counts: { ...counts } }; }
    else if (command === 'hold-provider') { holdProvider = true; result = true; }
    else if (command === 'release-provider') { holdProvider = false; releaseProvider?.(); result = true; }
    else if (command === 'mutate-env-closed') { env.GOVERNED_RECORD_PRODUCER_CONTRACT = ''; server.packsmart.env.GOVERNED_RECORD_PRODUCER_CONTRACT = ''; result = true; }
    else if (command === 'drain') { const promise = server.packsmart.drain(); process.send({ event: 'drain-started' }); result = await promise; }
    else if (command === 'close') { releaseProvider?.(); await server.packsmart.drain(); await new Promise(resolve => server.close(resolve)); process.send({ id, result: { counts } }); process.disconnect(); return; }
    else throw new Error('Unknown fixture command');
    process.send({ id, result });
  } catch (error) { process.send({ id, error: { message: error.message, code: error.code, stack: error.stack } }); }
});
