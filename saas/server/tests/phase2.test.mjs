import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSessionCookie,
  createSessionToken,
  decryptCredentials,
  encryptCredentials,
  hashPassword,
  publicConnection,
  requiresApproval,
  sessionCookie,
  validatePassword,
  verifyPassword,
  verifySessionToken
} from '../lib/security.mjs';
import { buildDailyBrief, normalizeApprovalRequest, SOCIAL_COMMERCE_CHANNELS } from '../lib/operations.mjs';
import { addAudit, seedWorkspaceState } from '../lib/store.mjs';

const SESSION_SECRET = 'session-test-secret-that-is-more-than-thirty-two-characters';
const CREDENTIALS_KEY = 'credential-test-secret-that-is-more-than-thirty-two-characters';

test('all Packsmart money, marketplace and social risk classes require approval', () => {
  for (const type of [
    'spend_money',
    'advertising_spend',
    'supplier_order',
    'refund',
    'major_price_change',
    'paid_service_purchase',
    'live_external_action',
    'risky_marketplace_action',
    'social_commerce_publish',
    'social_advertising_change'
  ]) assert.equal(requiresApproval(type), true, `${type} must stay approval-gated`);
  assert.equal(requiresApproval('daily_ops_brief'), false);
  assert.equal(requiresApproval('seo_check'), false);
});

test('session tokens are signed, expiring and workspace scoped', () => {
  const token = createSessionToken({
    userId: 'owner-1',
    workspaceId: 'packsmart-solutions',
    email: 'owner@example.test'
  }, SESSION_SECRET, 300);
  const payload = verifySessionToken(token, SESSION_SECRET);
  assert.equal(payload.sub, 'owner-1');
  assert.equal(payload.workspaceId, 'packsmart-solutions');
  assert.ok(payload.csrf.length >= 24);
  assert.equal(verifySessionToken(token, 'wrong-secret-that-is-still-long-enough-123456789'), null);
  assert.equal(verifySessionToken(token, SESSION_SECRET, payload.exp + 1), null);
  assert.match(sessionCookie(token), /HttpOnly/);
  assert.match(sessionCookie(token), /SameSite=Strict/);
  assert.match(clearSessionCookie(), /Max-Age=0/);
});

test('passwords use a salted scrypt hash and enforce production strength', () => {
  const password = 'PacksmartOwner!2026Secure';
  const encoded = hashPassword(password);
  assert.equal(encoded.includes(password), false);
  assert.equal(verifyPassword(password, encoded), true);
  assert.equal(verifyPassword('WrongPassword!2026', encoded), false);
  assert.throws(() => validatePassword('short'), /14-256/);
});

test('integration credentials are encrypted and never exposed by public connection shape', () => {
  const credentials = { refreshToken: 'secret-refresh-token', apiKey: 'secret-api-key' };
  const encrypted = encryptCredentials(credentials, CREDENTIALS_KEY);
  assert.equal(encrypted.includes('secret-refresh-token'), false);
  assert.deepEqual(decryptCredentials(encrypted, CREDENTIALS_KEY), credentials);
  assert.throws(() => decryptCredentials(encrypted, 'different-long-encryption-key-material-1234'));

  const exposed = publicConnection({
    id: 'conn-1',
    provider: 'ebay',
    label: 'eBay',
    status: 'configured',
    encryptedCredentials: encrypted,
    metadata: { account: 'packsmartsolutions20', refreshToken: 'never-public' },
    createdAt: 'now',
    updatedAt: 'now'
  });
  assert.equal('encryptedCredentials' in exposed, false);
  assert.equal('refreshToken' in exposed.metadata, false);
});

test('customer-zero seed creates an owner, automation rules, free plan and audit trail', () => {
  const state = seedWorkspaceState({ PACKSMART_ADMIN_EMAIL: 'owner@example.test' });
  assert.equal(state.workspace.id, 'packsmart-solutions');
  assert.equal(state.users[0].role, 'owner');
  assert.equal(state.users[0].passwordChangeRequired, true);
  assert.equal(state.automations.profitGuard, true);
  assert.equal(state.automations.channelMismatchAlerts, true);
  assert.equal(state.subscription.plan, 'customer-zero');
  assert.equal(state.subscription.status, 'internal');
  const before = state.audit.length;
  const event = addAudit(state, { type: 'test_event', actor: 'owner-1', detail: { ok: true } });
  assert.equal(state.audit.length, before + 1);
  assert.equal(event.type, 'test_event');
});

test('approval records capture business justification and never imply execution', () => {
  const approval = normalizeApprovalRequest({
    type: 'advertising_spend',
    action: 'Run a TikTok launch campaign',
    reason: 'Test launch demand',
    financialImpact: 75,
    expectedBenefit: 'Qualified visitors',
    risk: 'Spend may not convert',
    source: 'daily-brief'
  }, 'owner-1');
  assert.equal(approval.status, 'pending');
  assert.equal(approval.executedExternally, false);
  assert.equal(approval.executionStatus, 'not_connected');
});

test('daily brief is deterministic and covers all requested operating signals', () => {
  const state = seedWorkspaceState({});
  state.products = [{
    id: 'p1',
    title: 'Packsmart Bubble Pouch',
    handle: 'bubble-pouch',
    status: 'active',
    description: 'Protective self-seal bubble pouch for ecommerce orders with reliable dispatch protection.',
    image: 'https://cdn.shopify.com/image.png',
    variants: [{ id: 'v1', sku: 'BP-50', title: 'Pack of 50', price: 10, inventory: 5 }]
  }];
  state.orders = [{ id: 'o1', createdAt: new Date().toISOString(), financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', total: 10 }];
  const brief = buildDailyBrief(state);
  assert.equal(brief.logic, 'deterministic-v1');
  assert.equal(brief.orders30d, 1);
  assert.equal(brief.stockRisks, 1);
  assert.equal(brief.missingCosts, 1);
  assert.ok(brief.topActions.length > 0);
});

test('major social-commerce sales channels are included in the production registry', () => {
  assert.deepEqual(SOCIAL_COMMERCE_CHANNELS.map(channel => channel.id), [
    'meta',
    'tiktok_shop',
    'pinterest',
    'google_youtube',
    'whatsapp_business'
  ]);
});
