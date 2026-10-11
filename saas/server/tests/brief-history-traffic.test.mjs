import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { buildDailyBrief } from '../lib/operations.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
function fixture() {
  const state = seedWorkspaceState({}, { workspaceId: 'synthetic-brief-traffic', email: 'owner@brief-traffic.test' });
  state._revision = 'synthetic-predecessor';
  const now = new Date();
  state.orders = Array.from({ length: 12 }, (_, n) => ({ id: `synthetic-order-${n}`, provider: n % 2 ? 'shopify' : 'ebay',
    currency: 'GBP', createdAt: new Date(now.getTime() - 3600000).toISOString(), financialStatus: 'PAID',
    fulfillmentStatus: 'FULFILLED', total: '12.3400', tax: null,
    lineItems: [{ sku: 'SYNTHETIC', quantity: 1, net: null }] }));
  const original = buildDailyBrief(state, { now });
  state.dailyBriefs = Array.from({ length: 30 }, (_, n) => ({ ...structuredClone(original), id: `traffic-brief-${n}`,
    generatedAt: n < 8 ? now.toISOString() : '2020-01-02T12:00:00.000Z' }));
  return state;
}
async function scenario(enabled) {
  const original = fixture(), fake = fakeSupabase({ initialStates: [original] }), calls = [];
  const store = createStore({ SUPABASE_URL: 'https://brief-traffic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only',
    ...(enabled ? { BRIEF_HISTORY_COMPACTION_CONTRACT: 'runvara-brief-history/v1' } : {}) }, {
    fetchImpl: async (url, options) => {
      const response = await fake.fetchImpl(url, options), text = await response.clone().text();
      calls.push({ method: options.method || 'GET', path: new URL(url).pathname,
        requestBytes: Buffer.byteLength(options.body || ''), responseBytes: Buffer.byteLength(text),
        archiveInsert: new Headers(options.headers).get('prefer')?.includes('ignore-duplicates') || false });
      return response;
    }
  });
  let current = await store.get(original.workspace.id);
  const saves = [];
  for (let n = 0; n < 11; n++) {
    const start = calls.length;
    current = await store.save(original.workspace.id, current);
    const slice = calls.slice(start);
    saves.push({ requestBytes: slice.reduce((sum, item) => sum + item.requestBytes, 0),
      responseBytes: slice.reduce((sum, item) => sum + item.responseBytes, 0),
      archiveInserts: slice.filter(item => item.archiveInsert).length, hotBriefBytes: bytes(current.dailyBriefs) });
  }
  const archiveRows = (fake.tables.get('operations_briefs') || []).filter(row => row.id.startsWith('brief-v1:'));
  const unchangedStart = calls.length;
  current = await store.save(original.workspace.id, current);
  const unchangedCalls = calls.slice(unchangedStart);
  assert.deepEqual(current.dailyBriefs.slice(0, 8), original.dailyBriefs.slice(0, 8), 'Every today-UTC cache entry stays full');
  assert.deepEqual(current.dailyBriefs.map(item => item.id), original.dailyBriefs.map(item => item.id));
  assert.ok(saves.every(save => save.archiveInserts <= 2));
  assert.equal(unchangedCalls.filter(item => item.archiveInsert || item.method === 'GET' && item.path.endsWith('/operations_briefs')).length, 0);
  return { original, current, store, saves, archiveRows, measurements: {
    initialHotBriefBytes: bytes(original.dailyBriefs), finalHotBriefBytes: bytes(current.dailyBriefs),
    newContentArchiveRows: archiveRows.length, additionalArchivePayloadBytes: bytes(archiveRows),
    elevenSaveRequestBytes: saves.reduce((sum, item) => sum + item.requestBytes, 0),
    elevenSaveResponseBytes: saves.reduce((sum, item) => sum + item.responseBytes, 0), saves
  } };
}

test('synthetic archive traffic and hot-state savings are measured separately; repeated reads are not hidden', async () => {
  const closed = await scenario(false), open = await scenario(true);
  assert.equal(closed.archiveRows.length, 0); assert.equal(open.archiveRows.length, 22);
  assert.equal(closed.measurements.initialHotBriefBytes, open.measurements.initialHotBriefBytes);
  assert.ok(open.measurements.finalHotBriefBytes < closed.measurements.finalHotBriefBytes);
  assert.ok(open.measurements.additionalArchivePayloadBytes > 0, 'Smaller hot state still costs additional archive storage');
  for (const original of open.original.dailyBriefs) {
    assert.deepEqual(await open.store.getBrief(open.original.workspace.id, original.id, { state: open.current }), original);
  }
  const report = { scope: 'Synthetic application JSON body bytes; excludes HTTP/TLS overhead, compression, physical storage and provider billing.',
    fixture: { retainedBriefs: 30, todayPreserved: 8, historical: 22, saves: 11, newArchivesPerSave: 2 },
    producerClosed: closed.measurements, producerOpen: open.measurements,
    measuredHotBriefReduction: closed.measurements.finalHotBriefBytes - open.measurements.finalHotBriefBytes,
    measuredElevenSaveRequestReduction: closed.measurements.elevenSaveRequestBytes - open.measurements.elevenSaveRequestBytes,
    measuredElevenSaveResponseIncrease: open.measurements.elevenSaveResponseBytes - closed.measurements.elevenSaveResponseBytes,
    everyRetainedSnapshotRecovered: true, liveSavingClaimed: false };
  if (process.env.BRIEF_HISTORY_EVIDENCE_DIR) {
    assert.ok(path.isAbsolute(process.env.BRIEF_HISTORY_EVIDENCE_DIR));
    await fs.mkdir(process.env.BRIEF_HISTORY_EVIDENCE_DIR, { recursive: true });
    await fs.writeFile(path.join(process.env.BRIEF_HISTORY_EVIDENCE_DIR, 'synthetic-brief-traffic.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log('BRIEF_HISTORY_SYNTHETIC_TRAFFIC=' + JSON.stringify({ hotBytesSaved: report.measuredHotBriefReduction,
    extraArchivePayloadBytes: open.measurements.additionalArchivePayloadBytes,
    elevenSaveRequestReduction: report.measuredElevenSaveRequestReduction,
    elevenSaveResponseIncrease: report.measuredElevenSaveResponseIncrease }));
});
