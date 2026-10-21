import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { draftMarketingCampaign } from '../lib/marketing.mjs';
import { reviewMetaMarketingCampaign } from '../lib/marketing-campaign-review.mjs';

const SECRET = 'synthetic-marketing-review-secret-at-least-32-characters';
const fixture = (workspaceId = 'review-alpha') => {
  const state = seedWorkspaceState({}, { workspaceId, email: `${workspaceId}@example.test` });
  state.users.push(...['admin', 'member', 'viewer'].map(role => ({ ...state.users[0], id: `${workspaceId}-${role}`, role })));
  state.products = [{ id: 'product-1', title: 'Synthetic mailing bags', status: 'active', image: 'https://example.test/synthetic.png',
    variants: [{ id: 'variant-1', sku: 'SYNTHETIC-50', title: 'Pack of 50', price: 20, inventory: 15, available: true }] }];
  state.economics['SYNTHETIC-50'] = { landed: 6, packing: 0.5, handling: 0.5, delivery: 1, paymentFee: 0.2, channelFee: 0.2, advertising: 0, otherVariable: 0 };
  Object.assign(state.marketing.settings, { minMarginPercent: 30, minInventory: 10 });
  state.connections = [{ id: `${workspaceId}-meta`, provider: 'meta', status: 'connected' }];
  const campaign = draftMarketingCampaign(state);
  const read = () => reviewMetaMarketingCampaign(state, campaign.id);
  return { state, campaign, read, variant: state.products[0].variants[0], record: state.economics['SYNTHETIC-50'] };
};
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

test('read-only review works on frozen state and confers no authority from connection, settings or recorded approval', () => {
  const f = fixture();
  Object.assign(f.state.marketing.settings, { mode: 'automatic', autoPublishOrganic: true, allowPaidAds: true });
  f.campaign.publish.approvalId = 'saved-approval';
  f.state.approvals = [{ id: 'saved-approval', type: 'social_commerce_publish', status: 'approved', payload: { marketingCampaignId: f.campaign.id } }];
  const before = JSON.stringify(f.state); freeze(f.state);
  const review = f.read();
  assert.equal(review.eligibility.eligible, true);
  assert.deepEqual(review.product.changedFields, []);
  assert.equal(review.publishing.connectionRecordedConnected, true);
  assert.equal(review.publishing.recordedApprovalStatus, 'approved');
  assert.equal(review.publishing.approvalConfersDispatchAuthority, false);
  assert.equal(review.publishing.publisherImplemented, false);
  assert.equal(review.publishing.ready, false);
  assert.deepEqual(review.publishing.blockers, ['PUBLISHER_NOT_IMPLEMENTED', 'PUBLISH_TARGET_AND_SCOPES_UNVERIFIED', 'EXACT_PUBLICATION_APPROVAL_REQUIRED']);
  assert.deepEqual(review.creatives, { newSubmissionsEnabled: false, reason: 'CREATIVE_ALLOWANCE_REQUIRED' });
  assert.equal(JSON.stringify(f.state), before);
});

test('financial completeness remains separate from the stock gate', () => {
  const f = fixture(); f.variant.inventory = 7;
  const review = f.read();
  assert.equal(review.eligibility.checks.costs, true);
  assert.equal(review.eligibility.checks.margin, true);
  assert.equal(review.eligibility.checks.stock, false);
  assert.equal(review.eligibility.eligible, false);
  assert.equal(review.product.current.inventory, 7);
  assert.ok(review.publishing.blockers.includes('PRODUCT_NOT_ELIGIBLE'));
  assert.throws(() => draftMarketingCampaign(f.state), { code: 'NO_MARKETING_CANDIDATE' });
});

test('incomplete material evidence remains unknown and does not imply order loss or include shipping income', () => {
  const f = fixture(); f.variant.price = 2.55;
  f.state.economics['SYNTHETIC-50'] = { landed: 1.0145, packing: 0.02029, delivery: 2, channelFee: 1 };
  const review = f.read();
  assert.equal(review.eligibility.checks.costs, false);
  assert.equal(review.eligibility.checks.stock, true);
  assert.deepEqual(review.eligibility.missingCostFields, ['picking / handling cost', 'payment processing fee', 'advertising allocation', 'other variable cost']);
  assert.equal(review.product.current.contribution, null);
  assert.equal(review.product.current.margin, null);
  assert.equal(review.eligibility.customerShippingIncluded, false);
  assert.equal(review.eligibility.orderProfitEstablished, false);
  assert.equal(review.eligibility.costEvidence, 'recorded_amounts_only_sources_not_verified');
});

test('exact source-cost margin boundaries agree with the released planner despite rounded display', () => {
  for (const [price, landed, expected] of [[20, 14.0008, false], [2.55, 1.785, true], [2.55, 1.7851, false]]) {
    const f = fixture(); f.variant.price = price;
    Object.assign(f.record, { landed, packing: 0, handling: 0, delivery: 0, paymentFee: 0, channelFee: 0, advertising: 0, otherVariable: 0 });
    const review = f.read();
    assert.equal(review.product.current.margin, 30);
    assert.equal(review.eligibility.checks.margin, expected);
    assert.equal(review.eligibility.eligible, expected);
    if (expected) assert.equal(draftMarketingCampaign(f.state).product.variantId, 'variant-1');
    else assert.throws(() => draftMarketingCampaign(f.state), { code: 'NO_MARKETING_CANDIDATE' });
  }
});

test('review follows every existing draft eligibility gate and reports unknown stock explicitly', () => {
  for (const [field, change] of [
    ['active', f => { f.state.products[0].status = 'draft'; }],
    ['available', f => { f.variant.available = false; }],
    ['stock', f => { f.variant.inventory = 9; }],
    ['costs', f => { delete f.record.handling; }],
    ['price', f => { f.variant.price = ''; }],
    ['margin', f => { f.record.landed = 100; }],
    ['image', f => { delete f.state.products[0].image; }]
  ]) {
    const f = fixture(); change(f);
    assert.equal(f.read().eligibility.checks[field], false, field);
    assert.throws(() => draftMarketingCampaign(f.state), { code: 'NO_MARKETING_CANDIDATE' }, field);
  }
  const f = fixture(); f.variant.inventory = null;
  const review = f.read();
  assert.equal(review.eligibility.checks.stock, true);
  assert.equal(review.eligibility.inventoryBasis, 'count_unavailable_existing_availability_rule');
  assert.equal(draftMarketingCampaign(f.state).product.inventory, null);
});

test('review reads fresh product and setting values without rewriting the retained campaign', () => {
  const f = fixture(); const saved = structuredClone(f.campaign);
  f.variant.price = 25; f.state.products[0].title = 'Changed title'; f.state.marketing.settings.minInventory = 20;
  const review = f.read();
  assert.deepEqual(review.product.changedFields, ['title', 'price']);
  assert.equal(review.product.current.price, 25);
  assert.equal(review.eligibility.minInventory, 20);
  assert.equal(review.eligibility.checks.stock, false);
  assert.ok(review.publishing.blockers.includes('DRAFT_PRODUCT_CHANGED'));
  assert.deepEqual(f.campaign, saved);
});

test('exact product and variant identity never falls back to SKU or an ambiguous match', () => {
  const f = fixture();
  f.state.products[0].id = 'another-product';
  assert.equal(f.read().product.targetStatus, 'missing');
  assert.equal(f.read().eligibility.eligible, false);
  f.state.products[0].id = f.campaign.product.productId;
  f.state.products[0].variants.push(structuredClone(f.variant));
  assert.equal(f.read().product.targetStatus, 'ambiguous');
  assert.equal(f.read().product.current, null);
  assert.equal(f.read().eligibility.eligible, false);
});

test('campaign lookup and approval display reject missing, duplicate and unrelated identities', () => {
  const f = fixture();
  assert.throws(() => reviewMetaMarketingCampaign(f.state, 'not-in-this-workspace'), { code: 'MARKETING_CAMPAIGN_NOT_FOUND', status: 404 });
  f.campaign.publish.approvalId = 'other';
  f.state.approvals = [{ id: 'other', type: 'social_commerce_publish', status: 'approved', payload: { marketingCampaignId: 'another-campaign' } }];
  assert.equal(f.read().publishing.recordedApprovalStatus, 'unverified');
  f.state.marketing.campaigns.push(structuredClone(f.campaign));
  assert.throws(f.read, { code: 'MARKETING_CAMPAIGN_AMBIGUOUS', status: 409 });
});

test('SKU-only drafts and replacement rows cannot masquerade as retained variant IDs', () => {
  const original = fixture(); delete original.variant.id;
  const legacy = draftMarketingCampaign(original.state);
  assert.equal(legacy.product.variantId, original.variant.sku, 'Preserve the existing planner display fallback');
  const legacyReview = reviewMetaMarketingCampaign(original.state, legacy.id);
  assert.equal(legacyReview.product.targetStatus, 'missing');
  assert.equal(legacyReview.eligibility.eligible, false);
  const replaced = fixture(); delete replaced.variant.id;
  replaced.variant.sku = replaced.campaign.product.variantId;
  replaced.state.economics[replaced.variant.sku] = { ...replaced.record };
  assert.equal(replaced.read().product.targetStatus, 'missing');
  assert.equal(replaced.read().product.current, null);
  assert.equal(replaced.read().eligibility.eligible, false);
});

test('explicit external variant IDs work while blank or malformed retained IDs do not', () => {
  const f = fixture(); f.variant.externalId = f.variant.id; delete f.variant.id;
  assert.equal(f.read().product.targetStatus, 'found');
  assert.equal(f.read().eligibility.eligible, true);
  for (const invalid of [' ', '\t', 'bad\nidentity']) {
    f.variant.externalId = invalid; f.campaign.product.variantId = invalid;
    assert.equal(f.read().product.targetStatus, 'missing');
    assert.equal(f.read().eligibility.eligible, false);
  }
});

test('disabled channel, disabled planner and disconnected Meta remain visible blockers', () => {
  const f = fixture(); f.state.marketing.settings.enabled = false;
  f.state.marketing.settings.channels.meta = false; f.campaign.channels = ['pinterest'];
  f.state.connections[0].status = 'disconnected';
  const review = f.read();
  for (const code of ['MARKETING_AUTOPILOT_OFF', 'MARKETING_CHANNEL_DISABLED', 'CAMPAIGN_CHANNEL_NOT_SELECTED', 'META_NOT_CONNECTED']) assert.ok(review.publishing.blockers.includes(code));
});

test('review never reads credentials or serializes private provider, approval or campaign data', () => {
  const f = fixture();
  Object.defineProperty(f.state.connections[0], 'encryptedCredentials', { get() { assert.fail('Credential access is forbidden'); } });
  Object.defineProperty(f.state.marketing, 'providers', { get() { assert.fail('Provider credential access is forbidden'); } });
  f.campaign.copy.private = 'PRIVATE_CANARY'; f.campaign.futurePrivate = { value: 'PRIVATE_CANARY' };
  f.record.notes = 'PRIVATE_CANARY';
  assert.equal(JSON.stringify(f.read()).includes('PRIVATE_CANARY'), false);
});

async function apiFixture(t, { quiet = false } = {}) {
  const alpha = fixture(), beta = fixture('review-beta');
  const states = new Map([[alpha.state.workspace.id, alpha.state], [beta.state.workspace.id, beta.state]]);
  const counters = { reads: 0, saves: 0, providerCalls: 0 };
  const store = { provider: 'synthetic-memory', async get(id) { counters.reads++; return states.get(id) || null; },
    async save() { counters.saves++; assert.fail('A campaign review must not save state'); } };
  const unexpected = async () => { counters.providerCalls++; assert.fail('Provider transport is forbidden'); };
  const originalFetch = globalThis.fetch; globalThis.fetch = unexpected;
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: SECRET, CREDENTIALS_KEY: SECRET,
    ...(quiet ? { RUNVARA_STARTUP_MODE: 'quiet' } : {}) }, { store, fetchImpl: unexpected, schedulerEnabled: false, agentOpsEnabled: false });
  t.after(async () => { globalThis.fetch = originalFetch; await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  assert.equal(server.address().address, '127.0.0.1');
  const token = (which = alpha, role = 'owner', version) => {
    const user = which.state.users.find(user => user.role === role);
    return createSessionToken({ workspaceId: which.state.workspace.id, userId: user.id, role, email: user.email,
      sessionVersion: version ?? user.sessionVersion }, SECRET);
  };
  const route = `/api/marketing/campaigns/${alpha.campaign.id}/review/meta`;
  const request = (pathname = route, auth = token()) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: pathname,
      headers: auth ? { Cookie: `packsmart_session=${auth}` } : {} }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks)) }));
      res.on('error', reject);
    }); req.on('error', reject); req.end();
  });
  return { alpha, beta, states, counters, token, route, request };
}

test('HTTP review preserves authentication, current roles, session version and tenant isolation with zero writes or provider calls', async t => {
  const f = await apiFixture(t); const before = JSON.stringify([...f.states]);
  assert.equal((await f.request(f.route, null)).status, 401);
  assert.equal((await f.request(f.route, f.token(f.alpha, 'viewer'))).status, 403);
  assert.equal((await f.request(f.route, f.token(f.alpha, 'member'))).status, 403);
  assert.equal((await f.request(f.route, f.token(f.alpha, 'owner', 999))).status, 401);
  assert.equal((await f.request(f.route, f.token(f.beta))).status, 404);
  for (const role of ['owner', 'admin']) {
    const response = await f.request(f.route, f.token(f.alpha, role));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.workspaceId, f.alpha.state.workspace.id);
    assert.equal(response.body.publishing.ready, false);
    assert.match(response.headers['cache-control'], /no-store/);
  }
  assert.equal((await f.request(`${f.route}?workspaceId=review-beta`)).status, 400);
  assert.equal((await f.request(f.route.replace('/meta', '/pinterest'))).status, 404);
  assert.equal(JSON.stringify([...f.states]), before);
  assert.equal(f.counters.saves, 0); assert.equal(f.counters.providerCalls, 0);
  const oldOwnerToken = f.token(); f.alpha.state.users[0].role = 'viewer';
  assert.equal((await f.request(f.route, oldOwnerToken)).status, 403, 'Stored role must outrank a stale token role');
});

test('HTTP review uses the next retained snapshot and quiet startup blocks it before any store access', async t => {
  await t.test('fresh retained snapshot', async t => {
    const f = await apiFixture(t);
    assert.equal((await f.request()).body.eligibility.eligible, true);
    f.alpha.variant.inventory = 7;
    assert.equal((await f.request()).body.eligibility.checks.stock, false);
    assert.equal(f.counters.saves, 0); assert.equal(f.counters.providerCalls, 0);
  });
  await t.test('quiet startup', async t => {
    const f = await apiFixture(t, { quiet: true });
    const response = await f.request(); assert.equal(response.status, 503);
    assert.equal(f.counters.reads, 0); assert.equal(f.counters.saves, 0); assert.equal(f.counters.providerCalls, 0);
  });
});
