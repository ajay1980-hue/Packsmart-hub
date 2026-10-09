import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveOperations, AUTOMATION_DEFINITIONS } from '../lib/operations.mjs';
import { runSpecialist } from '../lib/agents.mjs';
import { detectOpportunities } from '../lib/control.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const now = new Date('2026-10-09T17:00:00Z');
const product = (id, status = 'active', extra = {}) => ({ id, provider: 'shopify', title: 'Pouch', description: '', image: null, status, variants: [], ...extra });
function fixture(products, workspaceId = 'seo-a') {
  const state = seedWorkspaceState({}, { workspaceId });
  state.products = products;
  return state;
}
const derive = state => deriveOperations(state, { now });
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('SEO display separates retained lifecycle history without claiming active products are published', () => {
  const state = fixture([product('active'), product('draft', 'draft'), product('archived', 'archived')]);
  const before = structuredClone(state), result = derive(freeze(state)), view = result.seoReview;
  assert.equal(view.actionableCount, 0);
  assert.equal(view.publicationStatus, 'unknown');
  assert.equal(view.visibilityReview.count, 3);
  assert.equal(view.retainedHistory.count, 8);
  assert.equal(result.seoIssues, 11);
  assert.deepEqual(view.visibilityReview.items, [[0, 'image'], [0, 'title'], [0, 'description']]);
  assert.deepEqual(new Set(view.retainedHistory.items.map(([index]) => state.products[index].status)), new Set(['draft', 'archived']));
  assert.deepEqual(state, before, 'Display classification cannot change retained products, history or approvals');
});

test('publication-like extras, source mode, URLs, stock and provider listings cannot promote a finding', () => {
  const state = fixture([product('p', 'active', { published: true, publishedAt: '2026-10-09T12:00:00Z', published_at: '2026-10-09T12:00:00Z', onlineStoreUrl: 'https://example.invalid/products/p', handle: 'p', inventory: 99, available: true, publication: { status: 'published' } })]);
  state.integrationStatus.shopify = { status: 'connected', source: 'public-storefront', lastSyncAt: now.toISOString() };
  state.ebay = { listings: [{ id: 'p', sku: 'p', status: 'PUBLISHED' }] };
  state.channelData = { pinterest: { pins: [{ id: 'p', link: 'https://example.invalid/products/p' }] } };
  const view = derive(state).seoReview;
  assert.equal(view.actionableCount, 0);
  assert.equal(view.visibilityReview.count, 3);
  assert.deepEqual(view.visibilityReview.items[0], [0, 'image']);
  assert.doesNotMatch(JSON.stringify(view), /onlineStoreUrl|example.invalid|publishedAt/);
});

test('missing, malformed and future lifecycle values remain visible for review', () => {
  for (const status of [null, '', false, 1, {}, [], 'future-status', 'published', '<img src=x onerror=alert(1)>']) {
    const view = derive(fixture([product('p', status)])).seoReview;
    assert.equal(view.retainedHistory.count, 0);
    assert.equal(view.visibilityReview.count, 4);
    assert.ok(view.visibilityReview.items.every(([index]) => index === 0));
    assert.equal(view.actionableCount, 0);
  }
  const missing = product('missing'); delete missing.status;
  assert.equal(derive(fixture([missing])).seoReview.visibilityReview.count, 4);
});

test('recorded unlisted state is distinct from draft/archive and never labelled unpublished', () => {
  const view = derive(fixture([product('unlisted', 'UNLISTED')])).seoReview;
  assert.equal(view.retainedHistory.count, 0);
  assert.equal(view.visibilityReview.count, 4);
  assert.deepEqual(view.visibilityReview.items, [[0, 'image'], [0, 'title'], [0, 'description'], [0, 'lifecycle']]);
  assert.equal(view.actionableCount, 0);
});

test('grouping precedes display caps so retained history cannot crowd out active review', () => {
  const state = fixture([...Array.from({ length: 60 }, (_, i) => product(`archived-${i}`, 'archived')), product('current-active')]);
  const result = derive(state), view = result.seoReview;
  assert.equal(view.retainedHistory.count, 240);
  assert.equal(view.retainedHistory.items.length, 100);
  assert.equal(view.retainedHistory.omitted, 140);
  assert.equal(view.visibilityReview.count, 3);
  assert.equal(view.visibilityReview.items.length, 3);
  assert.equal(view.visibilityReview.omitted, 0);
  assert.ok(view.visibilityReview.items.every(([index]) => state.products[index].id === 'current-active'));
  assert.equal(result.seoIssueItems.length, 100, 'Legacy diagnostic sample keeps its existing bound/order');
  assert.ok(result.seoIssueItems.every(row => row.productId.startsWith('archived-')));
});

test('both display groups are bounded with exact omitted counts', () => {
  const result = derive(fixture([...Array.from({ length: 60 }, (_, i) => product(`a-${i}`)), ...Array.from({ length: 60 }, (_, i) => product(`d-${i}`, 'draft'))]));
  const view = result.seoReview;
  assert.equal(view.itemLimit, 100);
  assert.deepEqual([view.visibilityReview.count, view.visibilityReview.items.length, view.visibilityReview.omitted], [180, 100, 80]);
  assert.deepEqual([view.retainedHistory.count, view.retainedHistory.items.length, view.retainedHistory.omitted], [240, 100, 140]);
  assert.equal(view.visibilityReview.count + view.retainedHistory.count, result.seoIssues);
});

test('legacy SEO finding bytes and ordinary opportunity evidence remain intact', () => {
  const state = fixture([product('draft', 'draft')]);
  const expected = [
    { productId: 'draft', product: 'Pouch', issue: 'Missing product image' },
    { productId: 'draft', product: 'Pouch', issue: 'Thin product title' },
    { productId: 'draft', product: 'Pouch', issue: 'Thin product description' },
    { productId: 'draft', product: 'Pouch', issue: 'Product is draft' }
  ];
  assert.deepEqual(derive(state).seoIssueItems, expected);
  detectOpportunities(state, 'test', { now });
  const retained = structuredClone(state.opportunities);
  const source = JSON.stringify(state);
  derive(state);
  assert.equal(JSON.stringify(state), source);
  assert.deepEqual(state.opportunities, retained);
  assert.equal(retained.filter(row => row.kind === 'seo').length, expected.length);
  assert.deepEqual(retained.filter(row => row.kind === 'seo').map(row => row.evidence[0].detail).sort(), expected.map(row => row.issue).sort());
});

test('reclassification uses current retained records without changing saved history or approvals', () => {
  const state = fixture([product('p', 'archived')]);
  state.approvals = [{ id: 'approval-old', status: 'approved', history: [{ status: 'approved', at: now.toISOString() }] }];
  state.agentRuns = [{ id: 'run-old', finding: 'Original recorded SEO result' }];
  const retained = structuredClone({ approvals: state.approvals, agentRuns: state.agentRuns });
  assert.equal(derive(state).seoReview.retainedHistory.count, 4);
  state.products[0].status = 'active';
  const result = derive(state);
  assert.equal(result.seoReview.retainedHistory.count, 0);
  assert.equal(result.seoReview.visibilityReview.count, 3);
  assert.deepEqual({ approvals: state.approvals, agentRuns: state.agentRuns }, retained);
});

test('per-workspace projections do not share product identity or mutable result rows', () => {
  const a = fixture([product('same-id', 'draft', { title: 'Tenant A' })], 'a');
  const b = fixture([product('same-id', 'active', { title: 'Tenant B' })], 'b');
  const viewA = derive(a).seoReview, viewB = derive(b).seoReview;
  assert.ok(viewA.retainedHistory.items.every(([index]) => a.products[index].title === 'Tenant A'));
  assert.ok(viewB.visibilityReview.items.every(([index]) => b.products[index].title === 'Tenant B'));
  assert.doesNotMatch(JSON.stringify(viewA), /Tenant A|same-id/, 'References do not duplicate catalogue content');
  viewA.retainedHistory.items[0][0] = 999;
  assert.equal(a.products[0].title, 'Tenant A');
  assert.ok(derive(b).seoReview.visibilityReview.items.every(([index]) => b.products[index].title === 'Tenant B'));
});

test('empty or content-complete catalogue never implies publication was verified', () => {
  for (const products of [[], [product('complete', 'active', { title: 'Protective bubble pouches', description: 'A sufficiently detailed product description. '.repeat(3), image: 'https://example.invalid/image.png' })]]) {
    const result = derive(fixture(products));
    assert.equal(result.seoIssues, 0);
    assert.equal(result.seoReview.actionableCount, 0);
    assert.equal(result.seoReview.publicationStatus, 'unknown');
    assert.equal(result.seoReview.visibilityReview.count, 0);
    assert.equal(result.seoReview.retainedHistory.count, 0);
  }
});

test('current SEO narrative describes retained findings and uncertainty without rewriting evidence', () => {
  const state = fixture([product('p', 'draft')]), run = runSpecialist('seo', state, { now });
  assert.match(run.finding, /retained catalogue SEO findings/);
  assert.match(run.finding, /Customer visibility is unverified/);
  assert.doesNotMatch(run.finding, /actionable catalogue/);
  assert.deepEqual(run.data.issues, derive(state).seoIssueItems);
  assert.doesNotMatch(AUTOMATION_DEFINITIONS.find(row => row.id === 'seoChecks').detail, /unpublished products/);
});
