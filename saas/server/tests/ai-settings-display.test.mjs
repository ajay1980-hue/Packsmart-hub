import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_PRICING_UPDATED_AT, configureAiEconomics, ensureAiEconomics, publicAiSettings } from '../lib/ai-economics.mjs';

test('public AI settings are a detached allowlist while server configuration stays lossless', () => {
  const governance = { version: 1, enabled: false, providers: { openai: { accountId: 'private-account' } } };
  const state = { aiEconomics: { routingMode: 'quality', monthlyCostLimitUsd: 0, pricingUpdatedAt: '2026-09-27',
    updatedAt: '2026-10-01T12:34:56.789Z', updatedBy: 'platform-owner', governance,
    credentials: { apiKey: 'synthetic-private-key' }, futurePrivateField: ['private-evidence'] } };
  const before = structuredClone(state);
  const projected = publicAiSettings(state.aiEconomics);
  assert.deepEqual(projected, { routingMode: 'quality', monthlyCostLimitUsd: 0, pricingUpdatedAt: '2026-09-27',
    updatedAt: '2026-10-01T12:34:56.789Z', updatedBy: 'platform-owner' });
  assert.deepEqual(state, before, 'the projector never mutates stored settings');
  assert.notEqual(projected, state.aiEconomics);
  projected.routingMode = 'economy'; projected.updatedBy = 'different-actor';
  assert.deepEqual(state, before, 'mutating the DTO cannot edit the server state');
  const retained = ensureAiEconomics(state);
  assert.equal(retained.governance, governance);
  const configured = configureAiEconomics(state, { routingMode: 'economy', monthlyCostLimitUsd: null,
    governance: { enabled: true }, credentials: 'ignored-client-input' }, 'owner');
  assert.equal(configured, state.aiEconomics, 'internal configure contract remains lossless');
  assert.equal(configured.governance, governance);
  assert.deepEqual(configured.credentials, before.aiEconomics.credentials);
  assert.deepEqual(configured.futurePrivateField, before.aiEconomics.futurePrivateField);
  assert.equal(publicAiSettings(configured).monthlyCostLimitUsd, null);
  assert.equal(publicAiSettings(configured).updatedBy, 'owner');
  assert.equal(publicAiSettings(configured).updatedAt, configured.updatedAt);
});

test('public AI settings preserve valid scalar bounds and fail closed for malformed values', () => {
  const defaults = { routingMode: 'balanced', monthlyCostLimitUsd: null, pricingUpdatedAt: AI_PRICING_UPDATED_AT };
  for (const value of [undefined, null, [], false, 0, 'private-string', {}]) assert.deepEqual(publicAiSettings(value), defaults);
  for (const value of [0, 12.5, 1000000, null]) assert.equal(publicAiSettings({ monthlyCostLimitUsd: value }).monthlyCostLimitUsd, value);
  for (const value of [undefined, -1, 1000001, NaN, Infinity, '10', {}, [], true]) {
    assert.equal(publicAiSettings({ monthlyCostLimitUsd: value }).monthlyCostLimitUsd, null);
  }
  for (const value of ['economy', 'balanced', 'quality']) assert.equal(publicAiSettings({ routingMode: value }).routingMode, value);
  for (const value of [null, {}, [], 'QUALITY', 'private-mode']) assert.equal(publicAiSettings({ routingMode: value }).routingMode, 'balanced');
  for (const value of [null, {}, [], 0, false, 'private-date', '2026-02-30', '2026-13-01', '2026-09-27'.repeat(1000)]) {
    assert.equal(publicAiSettings({ pricingUpdatedAt: value }).pricingUpdatedAt, AI_PRICING_UPDATED_AT);
  }
  assert.equal(publicAiSettings({ pricingUpdatedAt: '2024-02-29' }).pricingUpdatedAt, '2024-02-29');
  assert.deepEqual(publicAiSettings({ updatedAt: null, updatedBy: null }), { ...defaults, updatedAt: null, updatedBy: null });
  for (const updatedAt of ['2026-10-01T12:34:56Z', '2026-10-01T12:34:56.789Z']) {
    assert.equal(publicAiSettings({ updatedAt }).updatedAt, updatedAt);
  }
  for (const updatedBy of ['system', 'platform-owner', 'user_123', 'owner@example.test', 'x'.repeat(120)]) {
    assert.equal(publicAiSettings({ updatedBy }).updatedBy, updatedBy);
  }
  const nested = { credentials: { apiKey: 'synthetic-private-value' } };
  for (const value of [undefined, nested, [nested], new Date(), 0, false, '', ' ', 'x'.repeat(121)]) {
    const projected = publicAiSettings({ updatedAt: value, updatedBy: value });
    assert.deepEqual(projected, defaults);
  }
  for (const updatedAt of ['2026-02-30T12:34:56.789Z', '2026-10-01T25:00:00.000Z', '2026-10-01', '2026-10-01T12:34:56Z\n']) {
    assert.equal(Object.hasOwn(publicAiSettings({ updatedAt }), 'updatedAt'), false);
  }
  for (const updatedBy of ['actor\nprivate', 'actor\u0000private', 'actor\u007fprivate']) {
    assert.equal(Object.hasOwn(publicAiSettings({ updatedBy }), 'updatedBy'), false);
  }
});

test('public AI settings never traverse unknown fields, invoke accessors or inherit values', () => {
  const settings = Object.create({ routingMode: 'quality', monthlyCostLimitUsd: 99, pricingUpdatedAt: '2024-02-29',
    updatedAt: '2026-10-01T12:34:56.789Z', updatedBy: 'inherited-actor' });
  for (const key of ['governance', 'routingMode', 'monthlyCostLimitUsd', 'pricingUpdatedAt', 'updatedAt', 'updatedBy']) {
    Object.defineProperty(settings, key, { enumerable: true, get() { assert.fail('projector must not invoke accessors'); } });
  }
  settings.unknown = settings;
  settings.toJSON = () => assert.fail('projector must not serialize its input');
  assert.deepEqual(publicAiSettings(settings), publicAiSettings({}));
  assert.deepEqual(publicAiSettings(Object.getPrototypeOf(settings)), {
    routingMode: 'quality', monthlyCostLimitUsd: 99, pricingUpdatedAt: '2024-02-29',
    updatedAt: '2026-10-01T12:34:56.789Z', updatedBy: 'inherited-actor'
  });
  assert.deepEqual(publicAiSettings(Object.create(Object.getPrototypeOf(settings))), publicAiSettings({}));
  assert.ok(Buffer.byteLength(JSON.stringify(publicAiSettings({ updatedAt: '2026-10-01T12:34:56.789Z', updatedBy: '💡'.repeat(60) }))) < 1024);
});

