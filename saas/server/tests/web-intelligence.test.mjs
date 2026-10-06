import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.mjs';
import {
  addWebIntelligenceTarget, ensureWebIntelligence, runWebIntelligence, scanWebIntelligenceTarget,
  setWebIntelligenceTargetActive, updateWebIntelligenceSettings, webIntelligenceSnapshot,
  parseFirecrawlObservation, WEB_SCAN_BLOCK_REASON, WEB_SCAN_MAX_MARKDOWN_BYTES
} from '../lib/web-intelligence.mjs';

function state(id = 'test-workspace') { const value = { workspace: { id } }; ensureWebIntelligence(value); return value; }
const add = s => addWebIntelligenceTarget(s, { name: 'Synthetic supplier', kind: 'supplier', url: 'https://example.test/prices' });
const response = markdown => ({ success: true, data: { markdown, metadata: { title: 'Synthetic prices', sourceURL: 'https://example.test/prices', statusCode: 200 } } });
function history(s, target) {
  target.snapshot = { fingerprint: 'a'.repeat(64), excerpt: 'Price £10.00', prices: [10], capturedAt: '2026-10-01T00:00:00.000Z' };
  Object.assign(target, { lastScannedAt: '2026-10-01T00:00:00.000Z', lastChangedAt: '2026-10-01T00:00:00.000Z', lastSuccessfulScan: { id: 'old-success' }, lastSuccessfulScanAt: '2026-10-01T00:00:00.000Z', lastStatus: 'connected', lastError: null });
  s.webIntelligence.findings = Array.from({ length: 505 }, (_, i) => ({ id: `finding_${i}`, targetId: target.id, detail: 'Existing evidence' }));
  s.webIntelligence.scans = Array.from({ length: 505 }, (_, i) => ({ id: `scan_${i}`, targetId: target.id, status: 'completed' }));
  Object.assign(s.webIntelligence, { lastRunAt: target.lastScannedAt, lastError: null, lastSuccessfulScan: { id: 'old-run' } });
}

test('web intelligence keeps public target CRUD and rejects private/non-HTTPS targets', () => {
  const s = state();
  for (const url of ['http://localhost:3000', 'https://127.0.0.1/prices', 'https://user:secret@example.test']) assert.throws(() => addWebIntelligenceTarget(s, { url }), { code: 'VALIDATION_FAILED' });
  const target = add(s); setWebIntelligenceTargetActive(s, target.id, false); assert.equal(target.active, false);
  const restored = addWebIntelligenceTarget(s, { url: target.url, name: 'Renamed supplier' });
  assert.equal(restored, target); assert.equal(target.active, true); assert.equal(s.webIntelligence.targets.length, 1);
});

test('settings, existing credentials, owner action, booleans and fake issuers cannot enable any HTTP request', async () => {
  const s = state(), target = add(s); let calls = 0;
  updateWebIntelligenceSettings(s, { enabled: true, maxTargetsPerRun: 10 });
  s.webIntelligence.settings.allowPaidScans = true;
  const bypass = { env: { FIRECRAWL_API_KEY: 'synthetic-only' }, fetchImpl: () => { calls++; assert.fail('No Firecrawl transport exists in this release'); },
    actor: 'owner', allowed: true, force: true, durableStore: true, reservationId: 'fake',
    authorizeScan: () => { calls++; assert.fail('No issuer may be invoked'); }, allowance: { allowed: true, maxCredits: 100 } };
  for (let i = 0; i < 3; i++) {
    const result = await runWebIntelligence(s, { ...bypass, targetId: target.id });
    assert.equal(result.reason, WEB_SCAN_BLOCK_REASON); assert.equal(result.scanned, 0); assert.equal(result.failed, 0); assert.equal(result.blocked, 1);
    assert.equal(result.effects.submissionAttempts, 0); assert.equal(result.effects.spend, 0); assert.equal(result.effects.externalWrites, false);
    assert.equal((await scanWebIntelligenceTarget(s, target, bypass)).reason, WEB_SCAN_BLOCK_REASON);
  }
  assert.equal(calls, 0); assert.equal(target.lastScannedAt, null); assert.equal(s.webIntelligence.lastRunAt, null); assert.deepEqual(s.webIntelligence.scans, []);
});

test('blocked work retains every snapshot, finding, scan and successful timestamp without trimming history', async () => {
  const s = state(), target = add(s); history(s, target); const before = structuredClone(s.webIntelligence);
  const result = await runWebIntelligence(s, { targetId: target.id });
  assert.deepEqual(s.webIntelligence, before); assert.equal(result.effects.historicalExposureUnknown, true);
  assert.equal(result.effects.spend, null); assert.equal(result.effects.costStatus, 'unknown');
  const snapshot = webIntelligenceSnapshot(s, { FIRECRAWL_API_KEY: 'synthetic-only' });
  assert.equal(snapshot.provider.configured, true); assert.equal(snapshot.provider.liveScanningAvailable, false);
  assert.equal(snapshot.provider.status, 'allowance_required'); assert.match(snapshot.provider.readinessLabel, /paused/i);
  assert.equal(snapshot.findings[0].id, before.findings[0].id); assert.deepEqual(snapshot.targets[0].lastSuccessfulScan, target.lastSuccessfulScan);
  assert.deepEqual(s.webIntelligence, before, 'Reading a bounded UI snapshot never trims durable history');
});

test('same-object and independent snapshot retries remain blocked without provider calls', async () => {
  const s = state(); add(s); let calls = 0;
  const options = { fetchImpl: async () => { calls++; throw new Error('Network forbidden'); }, env: { FIRECRAWL_API_KEY: 'synthetic' } };
  const rows = await Promise.all([s, s, structuredClone(s), structuredClone(s)].map(value => runWebIntelligence(value, options)));
  assert.ok(rows.every(row => row.reason === WEB_SCAN_BLOCK_REASON && row.effects.submissionAttempts === 0));
  assert.equal(calls, 0);
});

test('disabled/no-target work is explicit no-work; explicit target scope cannot touch another target', async () => {
  const s = state(); assert.equal((await runWebIntelligence(s)).reason, 'WEB_NO_ACTIVE_TARGETS');
  const first = add(s), second = addWebIntelligenceTarget(s, { url: 'https://example.test/other' });
  const result = await runWebIntelligence(s, { targetId: second.id }); assert.equal(result.blocked, 1);
  assert.equal(first.lastScannedAt, null); assert.equal(second.lastScannedAt, null);
  for (const targetId of ['foreign-id', '', 0, true, ['fake']]) await assert.rejects(runWebIntelligence(s, { targetId }), { code: 'WEB_TARGET_NOT_FOUND' });
  await assert.rejects(scanWebIntelligenceTarget(s, structuredClone(first)), { code: 'WEB_TARGET_NOT_FOUND' });
  first.workspaceId = 'another-tenant'; await assert.rejects(runWebIntelligence(s, { targetId: first.id }), { code: 'WEB_TARGET_NOT_FOUND' }); delete first.workspaceId;
  first.tenant = { id: 'another-tenant' }; await assert.rejects(runWebIntelligence(s, { targetId: first.id }), { code: 'WEB_TARGET_NOT_FOUND' }); delete first.tenant;
  s.webIntelligence.settings.enabled = false; const stopped = await runWebIntelligence(s);
  assert.equal(stopped.reason, 'WEB_SCANNING_DISABLED'); assert.equal(stopped.blocked, 0); assert.equal(stopped.effects.spend, 0);
});

test('foreign parent and nested target scope markers reject before normalization without altering saved data', async () => {
  const markers = [
    ['workspaceId', 'other-workspace'], ['workspace_id', 'other-workspace'],
    ['tenantId', 'other-workspace'], ['tenant_id', 'other-workspace'],
    ['workspace', 'other-workspace'], ['tenant', 'other-workspace'],
    ['workspace', { id: 'other-workspace' }], ['tenant', { id: 'other-workspace' }],
    ['workspace', { id: 'test-workspace', tenantId: 'other-workspace' }],
    ['tenant', { id: 'test-workspace', workspace_id: 'other-workspace' }],
    ['tenant', { id: 'test-workspace', workspace: { id: 'other-workspace' } }]
  ];
  for (const level of ['state', 'intel', 'target']) for (const [key, value] of markers) {
    // state.workspace.id is the authoritative tenant identity, so preserve it.
    if (level === 'state' && key === 'workspace' && (typeof value !== 'object' || value.id !== 'test-workspace')) continue;
    const s = state(), target = add(s); history(s, target);
    const marked = level === 'state' ? s : level === 'intel' ? s.webIntelligence : target;
    marked[key] = structuredClone(value);
    const before = structuredClone(s), originalIntel = s.webIntelligence;
    for (const attempt of [() => runWebIntelligence(s, { targetId: target.id }), () => scanWebIntelligenceTarget(s, target)]) {
      await assert.rejects(attempt(), { code: 'WEB_TARGET_NOT_FOUND' }, `${level}.${key}`);
      assert.deepEqual(s, before, `${level}.${key} must retain all saved content`);
      assert.equal(s.webIntelligence.targets[0], target);
      if (level !== 'target') assert.equal(s.webIntelligence, originalIntel, 'Parent scope must be checked before normalization');
    }
  }
});

test('scope checks preserve matching optional markers and reject hidden/computed or malformed parent markers before no-work', async () => {
  const s = state(), target = add(s), workspaceId = s.workspace.id;
  // Store persistence has its own private symbol; scope validation must allow it.
  Object.defineProperty(s, Symbol('persisted'), { value: true });
  Object.assign(s, { workspaceId, tenant: { id: workspaceId } });
  for (const row of [s.webIntelligence, target]) Object.assign(row, { tenant_id: workspaceId,
    workspace: { id: workspaceId, tenantId: workspaceId }, tenant: workspaceId });
  assert.equal((await runWebIntelligence(s)).reason, WEB_SCAN_BLOCK_REASON);
  assert.equal((await scanWebIntelligenceTarget(s, target)).reason, WEB_SCAN_BLOCK_REASON);
  for (const level of ['state', 'intel', 'workspace']) for (const hidden of [false, true]) {
    const malformed = state(); malformed.webIntelligence.settings.enabled = false;
    const row = level === 'state' ? malformed : level === 'intel' ? malformed.webIntelligence : malformed.workspace;
    let reads = 0;
    Object.defineProperty(row, 'tenantId', hidden ? { value: 'other-workspace' }
      : { enumerable: true, get() { reads++; return 'other-workspace'; } });
    const originalIntel = malformed.webIntelligence;
    await assert.rejects(runWebIntelligence(malformed), { code: 'WEB_TARGET_NOT_FOUND' });
    assert.equal(reads, 0); assert.equal(malformed.webIntelligence, originalIntel);
  }
  const malformed = state(), originalIntel = [];
  originalIntel.workspaceId = 'other-workspace'; malformed.webIntelligence = originalIntel;
  await assert.rejects(runWebIntelligence(malformed), { code: 'WEB_TARGET_NOT_FOUND' });
  assert.equal(malformed.webIntelligence, originalIntel, 'An array must not normalize a foreign scope into an empty local container');
});

test('raw persisted scope markers survive FileStore.get normalization and reject scans without changing saved evidence', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'web-scope-load-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  const store = createStore({ SAAS_STATE_FILE: filePath });
  assert.equal(store.provider, 'file');
  const markers = [
    ['workspaceId', 'other-workspace'], ['workspace_id', 'other-workspace'],
    ['tenantId', 'other-workspace'], ['tenant_id', 'other-workspace'],
    ['workspace', 'other-workspace'], ['tenant', 'other-workspace'],
    ['workspace', { id: 'other-workspace' }], ['tenant', { id: 'other-workspace' }],
    ['workspace', { id: 'test-workspace', tenantId: 'other-workspace' }],
    ['tenant', { id: 'test-workspace', workspace: { id: 'other-workspace' } }],
    ['tenant', null]
  ];
  for (const level of ['state', 'intel', 'target']) for (const [key, value] of markers) {
    if (level === 'state' && key === 'workspace' && (typeof value !== 'object' || value.id !== 'test-workspace')) continue;
    const raw = state(), target = add(raw); history(raw, target);
    const marked = level === 'state' ? raw : level === 'intel' ? raw.webIntelligence : target;
    marked[key] = structuredClone(value);
    // Deliberately bypass store.save: persist the raw historical representation.
    const bytes = JSON.stringify({ [raw.workspace.id]: raw });
    await fs.writeFile(filePath, bytes);
    const loaded = await store.get(raw.workspace.id);
    const loadedTarget = loaded.webIntelligence.targets[0];
    const loadedMarker = level === 'state' ? loaded : level === 'intel' ? loaded.webIntelligence : loadedTarget;
    assert.ok(Object.hasOwn(loadedMarker, key), `${level}.${key} must survive the real load path`);
    if (level === 'state' && key === 'workspace') {
      for (const [field, expected] of Object.entries(value)) assert.deepEqual(loadedMarker[key][field], expected);
    } else assert.deepEqual(loadedMarker[key], value);
    assert.deepEqual(loaded.webIntelligence, raw.webIntelligence, 'Normalization retains every saved web observation');
    const evidence = structuredClone(loaded.webIntelligence), originalIntel = loaded.webIntelligence;
    await assert.rejects(runWebIntelligence(loaded, { targetId: target.id }), { code: 'WEB_TARGET_NOT_FOUND' });
    await assert.rejects(scanWebIntelligenceTarget(loaded, loadedTarget), { code: 'WEB_TARGET_NOT_FOUND' });
    assert.deepEqual(loaded.webIntelligence, evidence);
    if (level !== 'target') assert.equal(loaded.webIntelligence, originalIntel);
    assert.equal(await fs.readFile(filePath, 'utf8'), bytes, 'Rejected work never rewrites the raw saved state');
  }
});

test('pure receipt parsing preserves price extraction without performing or publishing a scan', () => {
  const first = parseFirecrawlObservation(response('# Boxes\nPrice £10.00'), { requestedUrl: 'https://example.test/prices' });
  const next = parseFirecrawlObservation(response('# Boxes\nPrice £9.50'), { requestedUrl: 'https://example.test/prices' });
  assert.deepEqual(first.prices, [10]); assert.deepEqual(next.prices, [9.5]); assert.notEqual(first.fingerprint, next.fingerprint);
  assert.equal(first.sourceUrl, 'https://example.test/prices'); assert.equal(first.contentTruncated, false);
  assert.equal(Object.hasOwn(first, 'capturedAt'), false, 'A pure parsed payload is not a successful live scan');
});

test('malformed HTTP200, missing/empty/non-string content, unsuccessful pages and oversized data never erase valid evidence', () => {
  const s = state(), target = add(s); history(s, target); const before = structuredClone(s);
  const cases = [{}, 'not JSON', { markdown: 'old permissive envelope' }, { success: true }, { success: 'true', data: { markdown: 'x' } },
    { success: false, error: 'synthetic-secret-MUST-NOT-LEAK' }, { success: true, data: { markdown: '' } },
    { success: true, data: { markdown: '   ' } }, { success: true, data: { markdown: {} } },
    { success: true, data: { markdown: 0 } }, { success: true, data: { markdown: ['invented content'] } },
    response('x'.repeat(WEB_SCAN_MAX_MARKDOWN_BYTES + 1)), { success: true, data: { markdown: 'Missing', metadata: { statusCode: 404 } } }];
  for (const payload of cases) assert.throws(() => parseFirecrawlObservation(payload, { requestedUrl: target.url }), error => {
    assert.equal(error.code, 'WEB_SCAN_RESPONSE_UNVERIFIED'); assert.ok(!error.message.includes('synthetic-secret')); return true;
  });
  assert.throws(() => parseFirecrawlObservation(response('valid'), { requestedUrl: target.url, httpStatus: 503 }), { code: 'WEB_SCAN_RESPONSE_UNVERIFIED' });
  assert.deepEqual(s, before); assert.equal(target.snapshot.prices[0], 10); assert.equal(s.webIntelligence.findings.length, 505);
});

test('pure parser rejects mismatched/private source identity and computed fields without executing them', () => {
  for (const sourceURL of ['https://another.example/prices', 'http://example.test/prices', 'https://127.0.0.1/prices', 'https://user:secret@example.test/prices', 1]) {
    const payload = response('valid content'); payload.data.metadata.sourceURL = sourceURL;
    assert.throws(() => parseFirecrawlObservation(payload, { requestedUrl: 'https://example.test/prices' }), { code: 'WEB_SCAN_SOURCE_UNVERIFIED' });
  }
  let getters = 0; const payload = response('valid'); Object.defineProperty(payload.data, 'markdown', { enumerable: true, get() { getters++; return 'unsafe'; } });
  assert.throws(() => parseFirecrawlObservation(payload, { requestedUrl: 'https://example.test/prices' }), { code: 'WEB_SCAN_RESPONSE_UNVERIFIED' });
  assert.equal(getters, 0);
});
