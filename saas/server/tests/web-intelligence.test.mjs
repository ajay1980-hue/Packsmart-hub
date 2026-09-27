import test from 'node:test';
import assert from 'node:assert/strict';
import { addWebIntelligenceTarget, ensureWebIntelligence, runWebIntelligence, webIntelligenceSnapshot } from '../lib/web-intelligence.mjs';

function state() {
  const value = { workspace: { id: 'test-workspace' } };
  ensureWebIntelligence(value);
  return value;
}

test('web intelligence rejects private or non-https targets', () => {
  const s = state();
  assert.throws(() => addWebIntelligenceTarget(s, { name: 'Local', url: 'http://localhost:3000' }), /public HTTPS/);
  assert.throws(() => addWebIntelligenceTarget(s, { name: 'Private', url: 'https://127.0.0.1/prices' }), /public HTTPS/);
});

test('first Firecrawl scan establishes baseline and later price changes create a finding', async () => {
  const s = state();
  const target = addWebIntelligenceTarget(s, { name: 'Competitor A', kind: 'competitor', url: 'https://example.com/prices' });
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return new Response(JSON.stringify({
      success: true,
      data: {
        markdown: call === 1 ? '# Boxes\nPrice £10.00' : '# Boxes\nPrice £9.50',
        metadata: { title: 'Boxes', sourceURL: 'https://example.com/prices' }
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const env = { FIRECRAWL_API_KEY: 'fc-test' };
  const first = await runWebIntelligence(s, { env, fetchImpl, targetId: target.id, actor: 'test' });
  assert.equal(first.scanned, 1); assert.equal(first.changed, 0); assert.equal(s.webIntelligence.findings.length, 0);
  const second = await runWebIntelligence(s, { env, fetchImpl, targetId: target.id, actor: 'test' });
  assert.equal(second.changed, 1); assert.equal(second.priceChanged, 1);
  assert.equal(s.webIntelligence.findings[0].type, 'price_change');
  assert.deepEqual(s.webIntelligence.findings[0].evidence.priceDiff.added, [9.5]);
  assert.deepEqual(s.webIntelligence.findings[0].evidence.priceDiff.removed, [10]);
  const snapshot = webIntelligenceSnapshot(s, env);
  assert.equal(snapshot.provider.configured, true);
  assert.equal(snapshot.radar.monitoredTargets, 1);
});

test('Firecrawl failures retain the watch target and record a failed scan', async () => {
  const s = state();
  const target = addWebIntelligenceTarget(s, { name: 'Supplier', kind: 'supplier', url: 'https://supplier.example/catalogue' });
  const fetchImpl = async () => new Response(JSON.stringify({ success: false, error: 'rate limited' }), { status: 429, headers: { 'content-type': 'application/json' } });
  const result = await runWebIntelligence(s, { env: { FIRECRAWL_API_KEY: 'fc-test' }, fetchImpl, targetId: target.id });
  assert.equal(result.failed, 1);
  assert.equal(target.lastStatus, 'error');
  assert.equal(s.webIntelligence.scans[0].status, 'failed');
});
