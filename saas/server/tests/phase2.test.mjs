import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requiresApproval,
  createSessionToken,
  verifySessionToken,
  encryptCredentials,
  decryptCredentials,
  publicConnection
} from '../lib/security.mjs';
import { seedWorkspaceState, addAudit } from '../lib/store.mjs';

test('all Packsmart money/risk action classes require approval', () => {
  for (const type of ['spend_money', 'supplier_order', 'refund', 'major_price_change', 'live_external_action']) {
    assert.equal(requiresApproval(type), true, `${type} must stay approval-gated`);
  }
  assert.equal(requiresApproval('daily_ops_brief'), false);
  assert.equal(requiresApproval('seo_check'), false);
});

test('session tokens are signed, workspace scoped and reject the wrong secret', () => {
  const token = createSessionToken({
    userId: 'owner-1',
    workspaceId: 'packsmart-solutions',
    email: 'owner@example.test'
  }, 'test-session-secret', 300);
  const payload = verifySessionToken(token, 'test-session-secret');
  assert.equal(payload.sub, 'owner-1');
  assert.equal(payload.workspaceId, 'packsmart-solutions');
  assert.equal(verifySessionToken(token, 'wrong-secret'), null);
});

test('integration credentials are encrypted and never exposed by public connection shape', () => {
  const credentials = { refreshToken: 'secret-refresh-token', apiKey: 'secret-api-key' };
  const encrypted = encryptCredentials(credentials, 'separate-credential-key');
  assert.equal(encrypted.includes('secret-refresh-token'), false);
  assert.deepEqual(decryptCredentials(encrypted, 'separate-credential-key'), credentials);

  const exposed = publicConnection({
    id: 'conn-1',
    provider: 'ebay',
    label: 'eBay',
    status: 'configured',
    encryptedCredentials: encrypted,
    createdAt: 'now',
    updatedAt: 'now'
  });
  assert.equal('encryptedCredentials' in exposed, false);
});

test('customer-zero seed creates owner workspace, safe automation defaults and audit trail', () => {
  const state = seedWorkspaceState({ PACKSMART_ADMIN_EMAIL: 'owner@example.test' });
  assert.equal(state.workspace.id, 'packsmart-solutions');
  assert.equal(state.users[0].role, 'owner');
  assert.equal(state.automations.profitGuard, true);
  assert.equal(state.subscription.plan, 'customer-zero');
  const before = state.audit.length;
  const event = addAudit(state, { type: 'test_event', actor: 'owner-1', detail: { ok: true } });
  assert.equal(state.audit.length, before + 1);
  assert.equal(event.type, 'test_event');
});
