import assert from 'node:assert/strict';
import test from 'node:test';
import { IntegrationService } from '../lib/integrations.mjs';

const old = '2026-10-16T12:00:00.000Z', now = Date.parse('2026-10-19T12:00:00.000Z');
function fixture(mode) {
  let requests = 0, orderFailure = false, orderDeferred = false;
  const state = { workspace: { id: 'diagnostic-age' }, products: [], orders: [], integrationStatus: {
    ebay: { lastFailureAt: '2026-10-18T12:00:00.000Z' } }, ebay: { coverage: { readDiagnostics: {} } } };
  const diagnostic = { code: 'UPSTREAM_REQUEST_FAILED', httpStatus: 409, errorIds: ['35077'], at: old, automaticRetryBlocked: true };
  const surface = mode === 'oauth' ? 'marketing' : 'promotions';
  state.ebay.coverage.readDiagnostics[surface] = diagnostic;
  const service = new IntegrationService({}, { fetchImpl: () => assert.fail('No external transport') });
  const config = { mode: mode === 'oauth' ? 'direct_oauth' : 'manager', expectedAccount: 'synthetic-seller',
    marketplaceId: 'EBAY_GB', connection: { metadata: {} } };
  const failed = () => { requests++; throw Object.assign(new Error('synthetic eligibility failure'), {
    code: 'UPSTREAM_REQUEST_FAILED', upstreamStatus: 409, upstreamErrorIds: ['35077'] }); };
  service.ebayAccessToken = async () => 'synthetic-token';
  service.ebayIdentity = async () => ({ username: 'synthetic-seller' });
  service.fetchEbayOrders = async () => { if (orderFailure) throw Object.assign(new Error('synthetic'), { upstreamStatus: 500, cooldownDeferred: orderDeferred }); return []; };
  service.fetchEbayInventoryItems = async () => [];
  service.fetchEbayOffers = async () => [];
  service.fetchEbayMarketing = async () => failed();
  service.ebayConfigured = () => true;
  service.ebayConfig = () => config;
  service.ebayGet = async (_config, paths) => {
    if (paths.some(p => p.endsWith('/status'))) return { connected: true, account: 'synthetic-seller' };
    if (paths.some(p => p.endsWith('/promotions'))) return failed();
    if (orderFailure && paths.some(p => p.endsWith('/orders'))) throw Object.assign(new Error('synthetic'), { upstreamStatus: 500, cooldownDeferred: orderDeferred });
    return { items: [] };
  };
  const sync = (automatic, areas = ['orders','promotions']) => mode === 'oauth' ? service.syncEbayOAuth(state, config, { automatic, areas })
    : service.syncEbay(state, { automatic, areas });
  return { state, service, diagnostic, surface, sync, requests: () => requests, failOrders: (deferred = false) => { orderFailure = true; orderDeferred = deferred; } };
}
for (const mode of ['oauth', 'manager']) {
  test(`${mode}: cached optional failure retains its occurrence time and does not retry eligibility`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const f = fixture(mode), result = await f.sync(true);
    assert.equal(f.requests(), 0);
    assert.equal(result.status, 'connected');
    assert.ok(result.lastError);
    assert.equal(result.lastSyncAt, new Date(now).toISOString());
    assert.equal(result.lastFailureAt, '2026-10-18T12:00:00.000Z', 'never backdate a newer historical failure to an older selected surface');
    assert.deepEqual(f.state.ebay.coverage.readDiagnostics[f.surface], f.diagnostic);
    assert.deepEqual(result.failedAreas, ['promotions']);
  });
  test(`${mode}: manual failed recheck records a new occurrence and the next automatic read preserves it`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const f = fixture(mode), result = await f.sync(false), failureAt = new Date(now).toISOString();
    assert.equal(f.requests(), 1);
    assert.equal(result.lastFailureAt, failureAt);
    t.mock.timers.tick(3600000);
    assert.equal((await f.sync(true)).lastFailureAt, failureAt);
    assert.equal(f.requests(), 1);
  });
  test(`${mode}: a new independent failure advances time; a legacy missing diagnostic time is not invented`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const f = fixture(mode); delete f.diagnostic.at;
    assert.equal((await f.sync(true)).lastFailureAt, '2026-10-18T12:00:00.000Z');
    f.failOrders();
    assert.equal((await f.sync(true)).lastFailureAt, new Date(now).toISOString());
    assert.equal(f.requests(), 0);
  });
  test(`${mode}: cached observations and deferred reads never advance time; unselected observations retain their occurrence`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const f = fixture(mode); f.state.integrationStatus.ebay.lastFailureAt = old;
    assert.equal((await f.sync(true)).lastFailureAt, old);
    f.failOrders(true); assert.equal((await f.sync(true)).lastFailureAt, old);
    f.state.ebay.coverage.readDiagnostics.orders = { at: '2026-10-18T18:00:00.000Z', code: 'READ_FAILED' };
    assert.equal((await f.sync(true, ['promotions'])).lastFailureAt, '2026-10-18T18:00:00.000Z');
    assert.equal(f.requests(), 0);
  });
}

test('all-deferred marketing ad diagnostics do not invent a failure; mixed actual failures do', async t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  for (const deferred of [true, false]) {
    const f = fixture('oauth'); f.state.integrationStatus.ebay.lastFailureAt = old;
    f.service.fetchEbayMarketing = async () => ({ campaigns: [], campaignsRead: true, ads: [], adFailures: [
      { campaignId: 'deferred', httpStatus: 429, errorIds: [], deferred: true },
      { campaignId: 'other', httpStatus: 429, errorIds: [], deferred }
    ] });
    assert.equal((await f.sync(false)).lastFailureAt, deferred ? old : new Date(now).toISOString());
    assert.equal(f.state.ebay.coverage.readDiagnostics.marketing.deferred === true, deferred);
  }
});
