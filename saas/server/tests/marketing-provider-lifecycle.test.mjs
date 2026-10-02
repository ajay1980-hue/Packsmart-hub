import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken, verifySessionToken, decryptCredentials } from '../lib/security.mjs';
import { saveCanvaApplication, storeCanvaTokens, refreshCanvaCredentials, readCanvaCredentials, CANVA_SCOPES } from '../lib/marketing-oauth.mjs';
import { ensureMarketing, marketingProviderStatus, marketingRuntimeEnv, disconnectMarketingProvider, testStoredMarketingProvider, marketingCreativeCycle, saveMarketingProvider } from '../lib/marketing.mjs';
import { testMarketingProvider, advanceCampaignCreatives } from '../lib/marketing-providers.mjs';

const KEY = 'test-only-marketing-key-longer-than-32-characters';
const SECRET = 'test-only-marketing-session-longer-than-32-characters';
const env = { CREDENTIALS_KEY: KEY, SESSION_SECRET: SECRET, APP_PUBLIC_URL: 'https://runvara.example.test' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const state = id => { const s = seedWorkspaceState({}, { workspaceId: id, email: `owner@${id}.test`, passwordHash: 'test-only' }); ensureMarketing(s); return s; };
const application = s => saveCanvaApplication(s, { clientId: 'test-app-id', clientSecret: 'test-only-canva-secret-32-characters' }, env, s.users[0].id);

test('Canva tokens rotate once, persist before API work and never appear in public status', async () => {
  const s = state('alpha'); application(s);
  storeCanvaTokens(s, env, { accessToken: 'test-access-old', refreshToken: 'test-refresh-old', expiresAt: Date.now() - 1000, mode: 'oauth' });
  let calls = 0, persisted = false;
  const options = { fetchImpl: async (url, options) => { calls++; assert.equal(url, 'https://api.canva.com/rest/v1/oauth/token'); assert.equal(new URLSearchParams(options.body).get('refresh_token'), 'test-refresh-old'); return json({ access_token: 'test-access-new', refresh_token: 'test-refresh-new', expires_in: 14400 }); }, persist: async () => { persisted = true; assert.equal(readCanvaCredentials(s, env).refreshToken, 'test-refresh-new'); } };
  await refreshCanvaCredentials(s, env, options);
  await refreshCanvaCredentials(s, env, options);
  assert.equal(calls, 1); assert.equal(persisted, true);
  const publicJson = JSON.stringify(marketingProviderStatus(s, env));
  assert.ok(!publicJson.includes('test-access') && !publicJson.includes('test-refresh') && !publicJson.includes('test-only-canva-secret'));
  assert.equal(marketingProviderStatus(s, env).canva.refreshSupported, true);
});

test('environment user credentials stay in customer-zero and disconnect suppresses fallback', () => {
  const config = { ...env, CANVA_ACCESS_TOKEN: 'test-only-token', CANVA_BRAND_TEMPLATE_ID: 'template', RUNWAY_API_KEY: 'test-only-key' };
  const zero = state('packsmart-solutions'), other = state('other');
  assert.equal(marketingRuntimeEnv(zero, config).RUNWAY_API_KEY, 'test-only-key');
  assert.equal(marketingRuntimeEnv(other, config).RUNWAY_API_KEY, undefined);
  disconnectMarketingProvider(zero, 'runway', 'owner', config);
  assert.equal(marketingRuntimeEnv(zero, config).RUNWAY_API_KEY, undefined);
  assert.equal(marketingProviderStatus(zero, config).runway.status, 'disconnected');
});

test('Runway authentication requires successful project response; empty balance is a separate limitation', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, method: options.method || 'GET' }); return json({ creditBalance: 0, tier: { models: { product_ad: { maxConcurrentGenerations: 1, maxDailyGenerations: 50 } } } }); };
  const result = await testMarketingProvider('runway', { RUNWAY_API_KEY: 'test-only-key' });
  assert.equal(result.ok, true); assert.equal(result.canSubmit, false); assert.equal(result.limitation, 'RUNWAY_API_CREDITS_REQUIRED');
  assert.deepEqual(calls, [{ url: 'https://api.dev.runwayml.com/v1/organization', method: 'GET' }]);
  for (const status of [400, 404, 422, 401]) {
    globalThis.fetch = async () => json({ error: 'test-only-secret-should-not-reflect' }, status);
    await assert.rejects(testMarketingProvider('runway', { RUNWAY_API_KEY: 'test-only-key' }), error => error.code === `RUNWAY_HTTP_${status}` && !error.message.includes('test-only-secret'));
  }
});

test('provider failure is durable and does not leak upstream errors; empty Canva datasets fail', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const s = state('alpha'); saveMarketingProvider(s, 'runway', { apiKey: 'test-only-key-longer-than-20-characters' }, env);
  globalThis.fetch = async () => json({ message: 'test-only-secret-echo' }, 401);
  const result = await testStoredMarketingProvider(s, 'runway', env);
  assert.equal(result.ok, false); assert.equal(marketingProviderStatus(s, env).runway.status, 'action_required');
  assert.ok(!JSON.stringify(result).includes('secret-echo'));
  globalThis.fetch = async () => json({ dataset: {} });
  await assert.rejects(testMarketingProvider('canva', { CANVA_ACCESS_TOKEN: 'test-token', CANVA_BRAND_TEMPLATE_ID: 'template' }), error => error.code === 'CANVA_TEMPLATE_FIELDS_REQUIRED');
});

test('creative worker leaves unfunded Runway jobs pending without generating', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const s = state('alpha'); saveMarketingProvider(s, 'runway', { apiKey: 'test-only-key-longer-than-20-characters' }, env);
  s.marketing.campaigns = [{ status: 'draft', creativeRequests: [{ provider: 'runway', status: 'pending' }], publish: { approvalRequired: true } }];
  globalThis.fetch = async url => { assert.equal(url, 'https://api.dev.runwayml.com/v1/organization'); return json({ creditBalance: 0, tier: { models: { product_ad: { maxConcurrentGenerations: 1 } } } }); };
  assert.equal((await marketingCreativeCycle(s, { env })).advanced, 0);
  assert.equal(s.marketing.campaigns[0].creativeRequests[0].status, 'pending');
  assert.equal(s.marketing.campaigns[0].publish.approvalRequired, true);
});

test('Canva OAuth callback enforces CSRF, owner, tenant, cookie, session revocation and one-time use', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'marketing-oauth-'));
  let tokenRequests = 0;
  const server = createPacksmartServer({ ...env, NODE_ENV: 'test', SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, { fetchImpl: async () => { tokenRequests++; return json({ access_token: 'test-only-oauth-access', refresh_token: 'test-only-oauth-refresh', expires_in: 14400 }); } });
  const a = state('alpha'), b = state('beta'); application(a);
  a.users.push({ id: 'admin', role: 'admin', active: true, sessionVersion: 1 });
  await server.packsmart.store.save('alpha', a); await server.packsmart.store.save('beta', b);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  function session(s, user = s.users[0]) { const token = createSessionToken({ userId: user.id, workspaceId: s.workspace.id, email: user.email || 'admin@example.test', role: user.role, sessionVersion: 1 }, SECRET); return { token, csrf: verifySessionToken(token, SECRET).csrf }; }
  const owner = session(a), beta = session(b), admin = session(a, a.users[1]);
  async function start(who, csrf = who.csrf) { return fetch(base + '/api/marketing/providers/canva/oauth/start', { method: 'POST', headers: { Cookie: `__Host-packsmart_session=${who.token}`, 'X-CSRF-Token': csrf, Origin: env.APP_PUBLIC_URL, 'Content-Type': 'application/json' }, body: '{}' }); }
  assert.equal((await start(owner, '')).status, 403); assert.equal((await start(admin)).status, 403);
  const response = await start(owner); assert.equal(response.status, 200);
  const authUrl = new URL((await response.json()).authorizationUrl);
  assert.equal(authUrl.origin, 'https://www.canva.com'); assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(authUrl.searchParams.get('scope').split(' '), CANVA_SCOPES);
  const stored = await server.packsmart.store.get('alpha');
  assert.ok(!authUrl.toString().includes(stored.oauthChallenges[0].verifier));
  const callback = '/api/marketing/providers/canva/oauth/callback?state=' + encodeURIComponent(authUrl.searchParams.get('state')) + '&code=test-only-code';
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const complete = (who, extra = cookie) => fetch(base + callback, { redirect: 'manual', headers: { Cookie: `__Host-packsmart_session=${who.token}; ${extra}` } });
  assert.equal((await complete(beta)).status, 400); assert.equal((await complete(owner, '')).status, 400); assert.equal(tokenRequests, 0);
  const connected = await fetch(base + callback, { redirect: 'manual', headers: { Cookie: cookie } }); assert.equal(connected.status, 303);
  const saved = await server.packsmart.store.get('alpha');
  assert.equal(saved.oauthChallenges.length, 0); assert.equal(decryptCredentials(saved.marketing.providers.canva.encryptedCredentials, KEY).refreshToken, 'test-only-oauth-refresh');
  assert.equal((await complete(owner)).status, 400); assert.equal(tokenRequests, 1);
  const publicResponse = await fetch(base + '/api/marketing', { headers: { Cookie: `__Host-packsmart_session=${owner.token}` } });
  assert.ok(!(await publicResponse.text()).includes('test-only-oauth'));
  const fresh = await start(owner); const freshState = new URL((await fresh.json()).authorizationUrl).searchParams.get('state');
  const revoked = await server.packsmart.store.get('alpha'); revoked.users[0].sessionVersion = 2; await server.packsmart.store.save('alpha', revoked);
  const expired = await fetch(base + '/api/marketing/providers/canva/oauth/callback?state=' + encodeURIComponent(freshState) + '&code=test-only-code', { redirect: 'manual', headers: { Cookie: `__Host-packsmart_session=${owner.token}; ${fresh.headers.get('set-cookie').split(';')[0]}` } });
  assert.equal(expired.status, 400); assert.equal(tokenRequests, 1);
});

test('creative jobs advance through Canva upload/autofill/export and Runway polling without publication', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const campaign = { product: { title: 'Mailing bags', sku: 'MAIL-001', price: 10, image: 'https://cdn.shopify.com/test.jpg' }, copy: { headline: 'Protect every parcel', cta: 'Shop now' }, creativeRequests: [{ provider: 'canva', status: 'pending' }, { provider: 'runway', status: 'pending' }], publish: { approvalRequired: true, status: 'not_requested' } };
  const config = { CANVA_ACCESS_TOKEN: 'test-only-token', CANVA_BRAND_TEMPLATE_ID: 'template', RUNWAY_API_KEY: 'test-only-key' };
  globalThis.fetch = async (url, options = {}) => {
    if (url === campaign.product.image) return new Response('test image', { headers: { 'content-type': 'image/jpeg' } });
    if (url.endsWith('/asset-uploads')) return json({ job: { id: 'upload' } });
    if (url.endsWith('/asset-uploads/upload')) return json({ job: { status: 'success', asset: { id: 'asset' } } });
    if (url.endsWith('/dataset')) return json({ dataset: { headline: { type: 'text' }, product_image: { type: 'image' } } });
    if (url.endsWith('/autofills')) { const body = JSON.parse(options.body); assert.equal(body.data.product_image.asset_id, 'asset'); assert.equal(body.data.headline.text, 'Protect every parcel'); return json({ job: { id: 'autofill' } }); }
    if (url.endsWith('/autofills/autofill')) return json({ job: { status: 'success', result: { design: { id: 'design' } } } });
    if (url.endsWith('/exports')) return json({ job: { id: 'export' } });
    if (url.endsWith('/exports/export')) return json({ job: { status: 'success', urls: ['https://example.test/creative.png'] } });
    if (url.endsWith('/recipes/product_ad')) return json({ id: 'task' });
    if (url.endsWith('/tasks/task')) return json({ status: 'SUCCEEDED', output: ['https://example.test/video.mp4'] });
    throw new Error('Unexpected endpoint');
  };
  for (let i = 0; i < 4; i++) await advanceCampaignCreatives(campaign, config);
  assert.equal(campaign.status, 'prepared'); assert.ok(campaign.creativeRequests.every(item => item.status === 'complete'));
  assert.deepEqual(campaign.publish, { approvalRequired: true, status: 'not_requested' });
});
