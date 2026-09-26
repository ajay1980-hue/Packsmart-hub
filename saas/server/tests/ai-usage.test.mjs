import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkspaceState } from '../lib/store.mjs';
import { aiUsageSnapshot, quoteCreativeCredits, releaseAiCredits, reserveAiCredits, settleAiCredits } from '../lib/ai-usage.mjs';

test('AI usage allowance follows subscription plan and is tenant-local', () => {
  const state = seedWorkspaceState({}, { workspaceId: 'tenant-a', email: 'owner@example.com', plan: 'growth' });
  const snapshot = aiUsageSnapshot(state, {});
  assert.equal(snapshot.allowanceCredits, 2500);
  assert.equal(snapshot.remainingCredits, 2500);
  assert.equal(state.aiUsage.ledger.length, 0);
});

test('creative quotes hide provider units behind Runvara credits', () => {
  assert.equal(quoteCreativeCredits({ provider: 'canva', kind: 'social_post' }, {}).credits, 8);
  assert.equal(quoteCreativeCredits({ provider: 'runway', kind: 'product_video' }, {}).credits, 60);
});

test('reservations prevent overspend and settlement records provider cost', () => {
  const state = seedWorkspaceState({}, { workspaceId: 'tenant-b', email: 'owner@example.com', plan: 'starter' });
  const reservation = reserveAiCredits(state, {
    provider: 'runway',
    operation: 'product_video',
    credits: 60,
    estimatedProviderCostMinor: 45,
    campaignId: 'campaign_1'
  }, {});
  let snapshot = aiUsageSnapshot(state, {});
  assert.equal(snapshot.reservedCredits, 60);
  assert.equal(snapshot.remainingCredits, 440);

  settleAiCredits(state, reservation.id, { actualProviderCostMinor: 42, providerReference: 'task_123' }, {});
  snapshot = aiUsageSnapshot(state, {});
  assert.equal(snapshot.reservedCredits, 0);
  assert.equal(snapshot.spentCredits, 60);
  assert.equal(snapshot.estimatedProviderCostMinor, 42);
});

test('released reservations restore available credits', () => {
  const state = seedWorkspaceState({}, { workspaceId: 'tenant-c', email: 'owner@example.com', plan: 'starter' });
  const reservation = reserveAiCredits(state, { provider: 'canva', operation: 'social_post', credits: 8 }, {});
  releaseAiCredits(state, reservation.id, { reason: 'provider_failed_before_start' }, {});
  const snapshot = aiUsageSnapshot(state, {});
  assert.equal(snapshot.spentCredits, 0);
  assert.equal(snapshot.reservedCredits, 0);
  assert.equal(snapshot.remainingCredits, 500);
});

test('credit exhaustion blocks a provider request before spend', () => {
  const state = seedWorkspaceState({}, { workspaceId: 'tenant-d', email: 'owner@example.com', plan: 'starter' });
  reserveAiCredits(state, { provider: 'runway', operation: 'large_job', credits: 500 }, {});
  assert.throws(
    () => reserveAiCredits(state, { provider: 'runway', operation: 'another_job', credits: 1 }, {}),
    error => error.code === 'AI_CREDITS_EXHAUSTED'
  );
});
