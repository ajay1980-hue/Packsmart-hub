import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticConnectionAreas, connectionCentre, connectionDue, saveConnectionSettings, validateAreas } from '../lib/connection-centre.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

function fixture(workspaceId = 'whatsapp-synthetic') {
  const state = seedWorkspaceState({}, { workspaceId });
  const calls = [];
  const service = new IntegrationService({}, { fetchImpl: async (...args) => {
    calls.push(args); assert.fail('Unsupported channel must not request a provider');
  } });
  return { state, service, calls };
}

for (const provider of ['whatsapp_business', 'amazon']) {
  test(`${provider}: retained credentials/status cannot advertise a missing adapter as connected`, () => {
    const { state, service, calls } = fixture();
    state.connections = [{ id: 'synthetic-retained', provider, encryptedCredentials: 'synthetic-opaque-ciphertext', status: 'connected' }];
    state.integrationStatus[provider] = { status: 'connected', lastSuccessfulSyncAt: new Date().toISOString() };
    const before = structuredClone(state);
    const channel = connectionCentre(state, service).find(row => row.id === provider);
    assert.equal(channel.configured, false);
    assert.equal(channel.status, 'not_configured');
    assert.equal(channel.availability, 'awaiting_provider_approval');
    assert.deepEqual(channel.areas, []);
    assert.deepEqual(channel.writes, []);
    assert.deepEqual(state, before);
    assert.deepEqual(calls, []);
  });

  test(`${provider}: persisted unsupported areas cannot enter automatic read scheduling`, () => {
    const { state, calls } = fixture();
    state.connectionSettings = { [provider]: { areas: ['messages', 'orders'], autoSync: true, frequencyMinutes: 15 } };
    state.integrationStatus[provider] = { status: 'connected' };
    const before = structuredClone(state);
    assert.deepEqual(automaticConnectionAreas(state, provider), []);
    assert.deepEqual(automaticConnectionAreas(state, provider, ['messages']), []);
    assert.equal(connectionDue(state, provider), false);
    assert.deepEqual(state, before);
    assert.deepEqual(calls, []);
  });
}

test('WhatsApp setup interest remains tenant-local and cannot grant read/write permission', () => {
  const alpha = fixture('alpha-whatsapp'), beta = fixture('beta-whatsapp');
  alpha.state.connectionSettings = { whatsapp_business: { supportRequestedAt: new Date().toISOString() } };
  const a = connectionCentre(alpha.state, alpha.service).find(row => row.id === 'whatsapp_business');
  const b = connectionCentre(beta.state, beta.service).find(row => row.id === 'whatsapp_business');
  assert.equal(a.supportRequested, true);
  assert.equal(b.supportRequested, false);
  assert.equal(a.configured, false);
  assert.throws(() => validateAreas('whatsapp_business', ['messages']), { code: 'SYNC_AREAS_INVALID' });
  const before = structuredClone(alpha.state);
  assert.throws(() => saveConnectionSettings(alpha.state, 'whatsapp_business', {
    revision: 0, permissionMode: 'automatic', confirmPermission: 'whatsapp_business:automatic'
  }, { id: 'synthetic-owner', role: 'owner' }), { code: 'WRITE_UNSUPPORTED' });
  assert.deepEqual(alpha.state, before);
});

test('implemented Shopify areas continue to reach automatic eligibility', () => {
  const { state } = fixture();
  state.connectionSettings = { shopify: { areas: ['products'], autoSync: true } };
  assert.deepEqual(automaticConnectionAreas(state, 'shopify'), ['products']);
  assert.equal(connectionDue(state, 'shopify'), true);
});
