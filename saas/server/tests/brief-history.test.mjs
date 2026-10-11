import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIEF_HISTORY_CONTRACT, BRIEF_HISTORY_MAX_BYTES, BRIEF_HISTORY_READ_MAX_BYTES,
  BRIEF_HISTORY_MAX_INPUT_ROWS,
  planBriefHistoryCompaction, assertBriefHistoryPlanCurrent, canonicalBriefJSON, verifyBriefArchiveRow,
  assertBriefArchiveReference, briefHistoryList, briefHistoryIntegrity } from '../lib/brief-history.mjs';

const NOW = '2026-10-11T16:00:00.000Z', WORKSPACE = 'tenant-history';
const brief = (id, generatedAt = '2026-10-10T12:00:00.000Z') => ({ id, generatedAt, summary: 'Recorded historical summary',
  logic: 'deterministic-v2', orders30d: 12, rows: [{ b: 2, a: 'evidence '.repeat(150) }] });
const state = rows => ({ workspace: { id: WORKSPACE }, dailyBriefs: [brief('latest'), ...rows] });
const plan = rows => planBriefHistoryCompaction(state(rows), { now: NOW });
const projection = candidate => ({ id: candidate.row.id, workspace_id: WORKSPACE, metrics: structuredClone(candidate.row.metrics) });
function reorder(value) {
  if (Array.isArray(value)) return value.map(reorder);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)]));
  return value;
}

test('planner preserves all current UTC rows, index zero, invalid/future dates and ambiguous identities', () => {
  const rows = [brief('today-a', NOW), brief('today-b', '2026-10-11T00:00:00Z'), brief('future', '2027-01-01T00:00:00Z'),
    brief('invalid', '2026-02-30T00:00:00Z'), brief('nonutc', '2026-10-10T12:00:00+00:00'), brief('bad-id '),
    brief('duplicate'), brief('duplicate'), brief('eligible'), brief('already')];
  rows.at(-1).archive = null;
  const input = state(rows), before = structuredClone(input), result = planBriefHistoryCompaction(input, { now: NOW });
  assert.deepEqual(result.candidates.map(item => item.row.metrics.id), ['eligible']);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(input.dailyBriefs[9]), false);
});

test('planner respects existing 30 retained IDs and counts duplicate IDs outside the retained window', () => {
  const input = state(Array.from({ length: 35 }, (_, i) => brief(`row-${i}`)));
  input.dailyBriefs[31].id = 'row-0';
  const result = planBriefHistoryCompaction(input, { now: NOW });
  assert.deepEqual(result.candidates.map(item => item.row.metrics.id), ['row-1', 'row-2']);
  assert.ok(result.candidates.every(item => item.index < 30));
});

test('optional planner bounds the whole duplicate scan at 4096 rows and skips larger inputs', () => {
  const input = state(Array.from({ length: BRIEF_HISTORY_MAX_INPUT_ROWS - 1 }, (_, index) => brief(`row-${index}`)));
  input.dailyBriefs.at(-1).id = 'row-0';
  assert.deepEqual(planBriefHistoryCompaction(input, { now: NOW }).candidates.map(item => item.row.metrics.id), ['row-1', 'row-2']);
  input.dailyBriefs.push(brief('overflow'));
  assert.equal(planBriefHistoryCompaction(input, { now: NOW }).candidates.length, 0);
  assert.equal(input.dailyBriefs.length, BRIEF_HISTORY_MAX_INPUT_ROWS + 1);
});

test('oversized JSON property names are rejected before key encoding', () => {
  const original = brief('large-key'); original.rows = [{ ['x'.repeat(BRIEF_HISTORY_MAX_BYTES + 1)]: 'value' }];
  assert.throws(() => canonicalBriefJSON(original), { code: 'BRIEF_ARCHIVE_INTEGRITY_FAILED' });
  assert.equal(plan([original]).candidates.length, 0);
});

test('planner admits at most two snapshots and measures strict serialized savings before stubbing', () => {
  const small = { id: 'small', generatedAt: NOW.replace('11T', '10T'), summary: 'short' };
  const result = plan([small, brief('one'), brief('two'), brief('three')]);
  assert.equal(result.candidates.length, 2);
  for (const item of result.candidates) {
    assert.ok(item.originalBytes <= BRIEF_HISTORY_MAX_BYTES);
    assert.equal(item.originalBytes, Buffer.byteLength(JSON.stringify(item.row.metrics)));
    assert.equal(item.stubBytes, Buffer.byteLength(JSON.stringify(item.stub)));
    assert.ok(item.stubBytes < item.originalBytes);
    assert.ok(item.readBytes <= BRIEF_HISTORY_READ_MAX_BYTES);
    assert.equal(item.stub.rows, undefined);
    assert.equal(item.stub.summary, item.row.metrics.summary);
    assert.equal(item.stub.orders30d, 12);
    assert.equal(item.row.metrics.id, item.reference.briefId);
    assert.notEqual(item.row.id, item.row.metrics.id);
  }
});

test('64KiB admission is exact and JSONB numeric exponent expansion cannot exceed the read cap', () => {
  const exact = brief('exact');
  exact.rows = [{ value: '' }];
  exact.rows[0].value = 'x'.repeat(BRIEF_HISTORY_MAX_BYTES - Buffer.byteLength(JSON.stringify(exact)));
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), BRIEF_HISTORY_MAX_BYTES);
  assert.equal(plan([exact]).candidates.length, 1);
  exact.rows[0].value += 'x';
  assert.equal(plan([exact]).candidates.length, 0);
  const expanding = brief('expanding'); expanding.rows = Array(1000).fill(1e308);
  assert.ok(Buffer.byteLength(JSON.stringify(expanding)) < BRIEF_HISTORY_MAX_BYTES);
  assert.equal(plan([expanding]).candidates.length, 0);
});

test('canonical digest and content key survive JSONB object-key and number representation roundtrips', () => {
  const original = brief('same'); original.rows[0].numbers = [1e20, 1e-7, -0, 1.25];
  const one = plan([original]).candidates[0], two = plan([reorder(original)]).candidates[0];
  assert.deepEqual(one.reference, two.reference);
  const row = reorder(projection(one));
  row.metrics.rows[0].numbers = JSON.parse('[100000000000000000000,0.0000001,0,1.2500]');
  assert.deepEqual(verifyBriefArchiveRow([row], one.reference, WORKSPACE, 'same'), one.row.metrics);
  const foreign = { workspace: { id: 'other-tenant' }, dailyBriefs: [brief('latest'), original] };
  assert.notEqual(planBriefHistoryCompaction(foreign, { now: NOW }).candidates[0].row.id, one.row.id);
});

test('reader denies altered body keys, array order, value types, identity, scope and oversized/deep bodies', () => {
  const original = brief('safe'); original.rows.push({ value: 'second' }); original.optional = null;
  const item = plan([original]).candidates[0];
  const edits = [
    row => { row.id += '0'; }, row => { row.workspace_id = 'other'; }, row => { row.extra = true; },
    row => { row.metrics.id = 'other'; }, row => { delete row.metrics.generatedAt; },
    row => { row.metrics.generatedAt = 'bad'; }, row => { row.metrics.rows.reverse(); },
    row => { row.metrics.orders30d = '12'; }, row => { delete row.metrics.optional; },
    row => { row.metrics.archive = {}; }, row => { row.metrics.rows[0].tenantId = 'other'; },
    row => { row.metrics.rows[0].a = 'x'.repeat(65536); },
    row => { let nested = {}; row.metrics.deep = nested; for (let i = 0; i < 40; i++) nested = nested.next = {}; }
  ];
  for (const edit of edits) {
    const row = projection(item); edit(row);
    assert.throws(() => verifyBriefArchiveRow([row], item.reference, WORKSPACE, 'safe'), error => error.code === 'BRIEF_ARCHIVE_INTEGRITY_FAILED');
  }
  assert.throws(() => verifyBriefArchiveRow([], item.reference, WORKSPACE, 'safe'), { code: 'BRIEF_ARCHIVE_UNAVAILABLE' });
  assert.throws(() => verifyBriefArchiveRow([projection(item), projection(item)], item.reference, WORKSPACE, 'safe'));
});

test('strict versioned references reject unknown versions, missing fields, surplus keys and tenant forgery', () => {
  const item = plan([brief('safe')]).candidates[0];
  for (const edit of [ref => { ref.schema = 'runvara-brief-history/v2'; }, ref => { delete ref.hashFormat; },
    ref => { ref.hashFormat = 'JSON.stringify'; }, ref => { ref.workspaceId = 'other'; }, ref => { ref.briefId = 'other'; },
    ref => { ref.extra = true; }, ref => { ref.sha256 = 12; }, ref => { ref.archiveId = 'safe'; },
    ref => { Object.defineProperty(ref, 'table', { get: () => 'operations_briefs' }); }]) {
    const ref = structuredClone(item.reference); edit(ref);
    assert.throws(() => assertBriefArchiveReference(ref, WORKSPACE, 'safe'), { code: 'BRIEF_ARCHIVE_REFERENCE_INVALID' });
  }
});

test('strict JSON never silently loses undefined, accessor, symbol, sparse, cyclic or exotic values', () => {
  const sparse = [1]; sparse.length = 2;
  const extra = []; extra.extra = true;
  const getter = {}; Object.defineProperty(getter, 'value', { get: () => 1, enumerable: true });
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(), sparse, extra, getter, cycle,
    { [Symbol('key')]: 1 }, { value: undefined }, { value: '\u0000' }, { value: '\ud800' }]) {
    assert.throws(() => canonicalBriefJSON(value), { code: 'BRIEF_ARCHIVE_INTEGRITY_FAILED' });
  }
});

test('source guards reject same-ID edit, same-content replacement and collection reordering', () => {
  for (const edit of [input => { input.dailyBriefs[1].rows[0].a += 'edit'; },
    input => { input.dailyBriefs[1] = structuredClone(input.dailyBriefs[1]); },
    input => { input.dailyBriefs.reverse(); }, input => { input.dailyBriefs = [...input.dailyBriefs]; }]) {
    const input = state([brief('old')]), prepared = planBriefHistoryCompaction(input, { now: NOW });
    assertBriefHistoryPlanCurrent(prepared); edit(input);
    assert.throws(() => assertBriefHistoryPlanCurrent(prepared), { code: 'BRIEF_HISTORY_SOURCE_CHANGED' });
  }
});

test('history list is bounded summary-only metadata and does not claim archive integrity before reading', () => {
  const item = plan([brief('old')]).candidates[0], input = state([structuredClone(item.stub), ...Array.from({ length: 35 }, (_, i) => brief(`full-${i}`))]);
  const list = briefHistoryList(input);
  assert.equal(list.length, 30);
  assert.deepEqual(Object.keys(list[0]), ['id', 'generatedAt', 'summary', 'archived', 'integrity']);
  assert.equal(list[0].integrity, 'retained');
  assert.equal(list[1].integrity, 'archive_pending_read');
  assert.equal(briefHistoryIntegrity(item.stub, { workspaceId: WORKSPACE, verified: true }), 'verified_archive');
  assert.equal(briefHistoryIntegrity({ ...item.stub, archive: { ...item.reference, schema: BRIEF_HISTORY_CONTRACT + 'bad' } }), 'archive_unavailable');
  assert.equal(JSON.stringify(list).includes('evidence '), false);
});
