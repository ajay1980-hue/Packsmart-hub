import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { deriveBusinessGraph, deriveBusinessGraphSummary } from '../lib/business-graph.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const costs = () => ({ landed: 2, packing: 0.2, handling: 0.1, delivery: 1, paymentFee: 0.3, channelFee: 0.4, advertising: 0, otherVariable: 0, supplierId: 's1' });
function fixture(workspaceId = 'tenant-a') {
  const state = seedWorkspaceState({}, { workspaceId });
  state.products = [
    { id: 'p1', externalId: 'external-p1', provider: 'shopify', title: 'Mailing bags', status: 'active', variants: [{ id: 'v1', externalId: 'external-v1', sku: 'BAGS', price: 10, inventory: 50 }] },
    { id: 'p2', provider: 'shopify', title: 'Boxes', variants: [{ id: 'v2', sku: 'BOXES', price: 12 }] }
  ];
  state.economics = { BAGS: costs(), BOXES: { landed: 3 }, ORPHAN: { landed: 1 } };
  state.suppliers = [{ id: 's1', name: 'Packaging supplier', active: true }];
  state.ebay = { source: 'ebay-oauth-readonly', listings: [{ id: 'offer1', offerId: 'offer1', listingId: 'listing1', sku: 'BAGS', status: 'PUBLISHED' }], drafts: [{ id: 'draft1', sku: 'UNKNOWN', status: 'UNPUBLISHED' }] };
  state.orders = [
    { id: 'order1', provider: 'shopify', financialStatus: 'PAID', customerId: 'customer1', customerEmail: 'private@example.com', lineItems: [{ id: 'line1', sku: 'BAGS', quantity: 2 }] },
    { id: 'order2', provider: 'shopify', customerEmail: 'private@example.com', lineItems: [{ id: 'line2', sku: 'NO-COST', quantity: 1 }] }
  ];
  state.channelData = { shopify: { customers: [{ id: 'customer1', numberOfOrders: 2 }] } };
  state.marketing.campaigns = [{ id: 'campaign1', status: 'draft', product: { productId: 'p1', variantId: 'v1', sku: 'BAGS' }, channels: ['meta', 'pinterest'], publish: { approvalRequired: true, approvalId: 'approval1' }, copy: { longCaption: 'A campaign prompt and private body' } }];
  state.opportunities = [{ id: 'opportunity1', status: 'requires_approval', approvalId: 'approval1', experimentId: 'experiment1', evidence: [{ type: 'economics', id: 'BAGS' }, { type: 'product', id: 'p1' }, { type: 'variant', id: 'external-v1' }] }];
  state.approvals = [{ id: 'approval1', status: 'approved', executionStatus: 'executed', financialImpact: 9000, payload: { opportunityId: 'opportunity1', experimentId: 'experiment1', campaignId: 'campaign1' }, impact: { verified: true, contributionProtected: 20 } }];
  state.workRecords = [{ id: 'work1', status: 'COMPLETED', approvalId: 'approval1', title: 'Private user command', evidence: [{ impact: { id: 'impact1', verified: true, incrementalContribution: 30, method: 'holdout' } }] }];
  state.revenueEngine.experiments = [{ id: 'experiment1', status: 'completed', opportunityId: 'opportunity1', approvalId: 'approval1', impact: { verified: true, incrementalContribution: 50, method: 'holdout' } }];
  return state;
}
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
const nodesOf = (graph, type) => graph.nodes.filter(node => node.type === type);
const edgesOf = (graph, relation) => graph.edges.filter(edge => edge.relation === relation);
const nodeAt = (graph, pointer, type) => graph.nodes.find(node => node.sourceRef.pointer === pointer && (!type || node.type === type));
function assertIntegrity(graph) {
  const ids = new Set(graph.nodes.map(node => node.id));
  assert.equal(ids.size, graph.nodes.length);
  assert.equal(new Set(graph.edges.map(edge => edge.id)).size, graph.edges.length);
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.from), 'edge source exists in the same projection');
    assert.ok(ids.has(edge.to), 'edge target exists in the same projection');
    assert.equal(edge.provenance.sourceRef.workspaceId, graph.workspaceId);
  }
  for (const mapping of graph.unknownMappings) assert.ok(ids.has(mapping.subjectId));
}

test('graph uses the existing persisted commerce, control, marketing and measurement schemas', () => {
  const state = fixture();
  const graph = deriveBusinessGraph(state);
  assert.equal(graph.schema, 'runvara-business-graph/v1');
  assert.equal(graph.workspaceId, 'tenant-a');
  assert.equal(graph.mode, 'detail');
  assert.equal(graph.coverage.complete, true);
  assert.equal(graph.summary.nodesByType.product, 2);
  assert.equal(graph.summary.nodesByType.variant, 2);
  assert.equal(graph.summary.nodesByType.listing, 2);
  assert.equal(graph.summary.nodesByType.customer, 1);
  assert.equal(graph.summary.nodesByType.outcome, 3);
  assert.equal(graph.summary.verifiedOutcomeRecords, 3);
  for (const relation of ['has_variant', 'uses_sku', 'has_economics', 'sourced_from_supplier', 'placed_by_customer', 'promotes_product', 'promotes_variant', 'requires_approval', 'references_opportunity', 'references_campaign', 'evaluated_by_experiment', 'has_recorded_outcome', 'has_evidence_for']) {
    assert.ok(edgesOf(graph, relation).length, relation);
    assert.equal(graph.summary.edgesByRelation[relation], edgesOf(graph, relation).length);
  }
  for (const node of graph.nodes) {
    assert.equal(node.sourceRef.workspaceId, 'tenant-a');
    let value = state;
    for (const key of node.sourceRef.pointer.split('/').slice(1)) value = value[key];
    assert.notEqual(value, undefined, `source reference resolves: ${node.sourceRef.pointer}`);
  }
  assertIntegrity(graph);
});

test('graph is deterministic and read-only against deeply frozen authoritative state', t => {
  const state = frozen(fixture());
  const before = JSON.stringify(state);
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Graph attempted a provider request'); });
  const timer = t.mock.method(globalThis, 'setTimeout', () => { throw new Error('Graph attempted to schedule work'); });
  assert.deepEqual(deriveBusinessGraph(state), deriveBusinessGraph(state));
  assert.deepEqual(deriveBusinessGraphSummary(state), deriveBusinessGraphSummary(state));
  assert.equal(JSON.stringify(state), before);
  assert.equal(network.mock.callCount(), 0);
  assert.equal(timer.mock.callCount(), 0);
  const graph = deriveBusinessGraph(state);
  assert.equal(graph.persistence.writesPerformed, 0);
  assert.equal(graph.persistence.separateGraphStored, false);
  assert.equal(graph.persistence.mode, 'projection-of-authoritative-persisted-records');
  assert.equal(graph.safeguards.providerRequests, false);
});

test('workspace identity is mandatory, explicit conflicting tenant IDs are rejected', () => {
  for (const state of [{}, { workspace: {} }, { workspace: { id: '' } }]) assert.throws(() => deriveBusinessGraph(state), { code: 'WORKSPACE_REQUIRED' });
  assert.throws(() => deriveBusinessGraph(fixture(), { workspaceId: 'tenant-b' }), { code: 'WORKSPACE_MISMATCH' });
  for (const field of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id']) {
    const state = fixture();
    state.products[0][field] = 'tenant-b';
    assert.throws(() => deriveBusinessGraph(state), { code: 'WORKSPACE_MISMATCH' }, field);
  }
  for (const location of [state => state.products[0].variants[0], state => state.orders[0].lineItems[0], state => state.economics.BAGS, state => state.approvals[0].payload, state => state.revenueEngine.experiments[0].impact, state => state.workRecords[0].evidence[0]]) {
    const state = fixture();
    location(state).workspaceId = 'tenant-b';
    assert.throws(() => deriveBusinessGraph(state), { code: 'WORKSPACE_MISMATCH' });
  }
  assert.equal(deriveBusinessGraph(fixture(), { workspaceId: 'tenant-a' }).workspaceId, 'tenant-a');
});

test('every entity and relationship identity is tenant scoped, including shared source IDs', () => {
  const left = deriveBusinessGraph(fixture('tenant-a'));
  const right = deriveBusinessGraph(fixture('tenant-b'));
  const leftIds = new Set([...left.nodes, ...left.edges].map(item => item.id));
  for (const item of [...right.nodes, ...right.edges]) assert.equal(leftIds.has(item.id), false);
  assert.equal(JSON.stringify(left).includes('tenant-b'), false);
  assert.equal(JSON.stringify(right).includes('tenant-a'), false);
});

test('no credentials, command bodies, raw identities or customer PII appear in any reference', () => {
  const state = fixture();
  const secret = 'secret-private-payload-unique-value';
  const email = 'unique-raw-identifier@example.com';
  state.orders[0].id = email;
  state.orders[0].customerId = email;
  state.orders[0].customerName = secret;
  state.orders[0].shippingAddress = { line1: secret };
  state.products[0].id = email;
  state.products[0].variants[0].sku = email;
  state.economics[email] = costs();
  state.suppliers[0].id = email;
  state.economics[email].supplierId = email;
  state.workRecords[0].id = email;
  state.workRecords[0].title = secret;
  state.approvals[0].action = secret;
  state.approvals[0].payload.body = secret;
  state.connections = [{ provider: 'shopify', encryptedCredentials: secret }];
  state.aiProvider = { apiKey: secret, prompt: secret };
  state.marketing.campaigns[0].copy.longCaption = secret;
  const graph = deriveBusinessGraph(state);
  const serialized = JSON.stringify(graph);
  for (const value of [secret, email, 'private@example.com', 'Private user command', 'customer1']) assert.equal(serialized.includes(value), false, value);
  assert.equal(graph.safeguards.rawRecordIdsIncluded, false);
  const dictionaryRef = nodesOf(graph, 'economics').find(node => node.sourceRef.keyHash === createHash('sha256').update(JSON.stringify(['tenant-a', 'economics-key', email])).digest('hex'));
  assert.ok(dictionaryRef, 'opaque dictionary selector still locates authoritative economics');
});

test('missing economics remain unknown, incomplete costs do not become fabricated zero profit', () => {
  const graph = deriveBusinessGraph(fixture());
  const complete = nodesOf(graph, 'economics').filter(node => node.attributes.complete);
  const incomplete = nodesOf(graph, 'economics').filter(node => !node.attributes.complete);
  assert.equal(complete.length, 1);
  assert.equal(incomplete.length, 2);
  for (const node of incomplete) {
    assert.ok(node.attributes.missingFields.length);
    assert.equal(node.attributes.contribution, null);
  }
  assert.ok(graph.summary.unknownByReason.missing_economics >= 2);
  assert.ok(graph.summary.unknownByReason.no_recorded_sku_match >= 1);
});

test('variant-ID economics fallback is preserved without inventing an SKU', () => {
  const state = { workspace: { id: 'tenant' }, products: [{ id: 'p', provider: 'shopify', variants: [{ id: 'v', price: 12 }] }], economics: { v: costs() } };
  const graph = deriveBusinessGraph(state);
  assert.equal(nodesOf(graph, 'sku').length, 0);
  assert.equal(edgesOf(graph, 'has_economics')[0].provenance.basis, 'recorded-variant-id-fallback');
  assert.equal(graph.summary.unknownByReason.missing_sku, 1);
});

test('duplicate source IDs, delimiter collisions and duplicate SKUs never silently merge products', () => {
  const state = fixture();
  state.products = [
    { id: 'a:b', provider: 'shopify', variants: [{ id: 'c', sku: 'SHARED' }] },
    { id: 'a', provider: 'shopify', variants: [{ id: 'b:c', sku: 'SHARED' }] },
    { id: 'a', provider: 'shopify', variants: [{ id: 'b:c', sku: 'SHARED' }, { id: 'b:c', sku: 'SHARED' }] },
    { id: 'a', provider: 'ebay', variants: [{ id: 'b:c', sku: 'OTHER' }] }
  ];
  state.marketing.campaigns[0].product = { productId: 'a', variantId: 'b:c', sku: 'SHARED' };
  const graph = deriveBusinessGraph(state);
  assert.equal(nodesOf(graph, 'product').length, 4);
  assert.equal(nodesOf(graph, 'variant').length, 5);
  assert.equal(graph.summary.unknownByReason.shared_sku_not_unique_variant, 4);
  assert.ok(graph.summary.unknownByReason.duplicate_record_id >= 2);
  assert.ok(graph.summary.unknownByReason.ambiguous_reference >= 2);
  assert.equal(edgesOf(graph, 'promotes_product').length, 0);
  assert.equal(edgesOf(graph, 'promotes_variant').length, 0);
  assertIntegrity(graph);
});

test('unique record IDs retain stable graph IDs when source arrays are reordered', () => {
  const state = fixture();
  state.revenueEngine.experiments.push({ id: 'second-measurement', status: 'completed', impact: { verified: true, costAvoided: 20 } });
  const before = deriveBusinessGraph(state);
  state.products.reverse();
  state.orders.reverse();
  state.revenueEngine.experiments.reverse();
  const after = deriveBusinessGraph(state);
  for (const type of ['product', 'variant', 'order', 'order_line', 'sku', 'customer', 'experiment', 'outcome']) {
    assert.deepEqual(nodesOf(before, type).map(node => node.id).sort(), nodesOf(after, type).map(node => node.id).sort(), type);
  }
  assert.deepEqual(before.edges.map(edge => edge.id).sort(), after.edges.map(edge => edge.id).sort());
});

test('shared SKU and campaign names are not treated as product identity or conversion attribution', () => {
  const state = fixture();
  state.orders[0].campaignName = 'campaign1';
  state.orders[0].utmCampaign = 'campaign1';
  const graph = deriveBusinessGraph(state);
  assert.equal(edgesOf(graph, 'lists_product').length, 0);
  assert.equal(edgesOf(graph, 'lists_variant').length, 0);
  assert.equal(edgesOf(graph, 'references_variant').length, 0);
  const orderIds = new Set(nodesOf(graph, 'order').map(node => node.id));
  const campaignIds = new Set(nodesOf(graph, 'campaign').map(node => node.id));
  assert.equal(graph.edges.some(edge => orderIds.has(edge.from) && campaignIds.has(edge.to)), false);
  assert.equal(graph.summary.unknownByReason.no_explicit_product_or_variant_reference, 2);
  assert.equal(graph.summary.unknownByReason.sku_only_not_verified_product_identity, 2);
});

test('only explicit unique provider-scoped variant IDs join order lines to variants', () => {
  const state = fixture();
  state.products.push({ id: 'p-other', provider: 'ebay', variants: [{ id: 'v1', sku: 'BAGS' }] });
  state.orders[0].lineItems[0].variantId = 'v1';
  const graph = deriveBusinessGraph(state);
  const relation = edgesOf(graph, 'references_variant');
  assert.equal(relation.length, 1);
  assert.equal(graph.nodes.find(node => node.id === relation[0].to).attributes.channel, 'shopify');
});

test('historical eBay line legacyItemId fallbacks cannot create SKU or economics joins', () => {
  const state = fixture();
  // This is the actual persisted mapEbayOrder shape. Its `sku` may have come
  // from line.legacyItemId; no source discriminator survives normalization.
  state.orders = [{ id: 'ebay-order', provider: 'ebay', lineItems: [{ id: 'line', sku: 'BAGS', quantity: 1, net: 10 }] }];
  const graph = deriveBusinessGraph(state);
  const line = nodeAt(graph, '/orders/0/lineItems/0', 'order_line');
  assert.ok(line);
  assert.equal(graph.edges.some(edge => edge.from === line.id && ['uses_sku', 'has_economics'].includes(edge.relation)), false);
  assert.equal(graph.summary.unknownByReason.unverified_provider_sku_provenance, 2);
  // The independently recorded eBay listing SKU is still usable evidence.
  const listing = nodeAt(graph, '/ebay/listings/0', 'listing');
  assert.ok(graph.edges.some(edge => edge.from === listing.id && edge.relation === 'has_economics'));
});

test('campaign-generated SKU fallback cannot join an unrelated real catalogue SKU', () => {
  const state = fixture();
  state.products[0].variants[0].sku = '';
  state.products[1].variants[0].sku = 'p1-v1';
  state.marketing.campaigns[0].product.sku = 'p1-v1';
  state.economics['p1-v1'] = costs();
  const graph = deriveBusinessGraph(state);
  const campaign = nodesOf(graph, 'campaign')[0];
  assert.equal(graph.edges.some(edge => edge.from === campaign.id && edge.relation === 'uses_sku'), false);
  assert.ok(graph.edges.some(edge => edge.from === campaign.id && edge.relation === 'promotes_variant'));
  assert.equal(graph.summary.unknownByReason.campaign_sku_not_verified_in_catalogue, 1);
  const normal = deriveBusinessGraph(fixture());
  const safeEdge = normal.edges.find(edge => edge.from === nodesOf(normal, 'campaign')[0].id && edge.relation === 'uses_sku');
  assert.ok(safeEdge);
  assert.equal(safeEdge.provenance.sourceRef.pointer, '/products/0/variants/0');
});

test('customer references use recorded identifiers only and remain provider scoped', () => {
  const state = fixture();
  state.orders = [
    { id: 'o1', provider: 'shopify', customerId: 'same', lineItems: [] },
    { id: 'o2', provider: 'ebay', customerId: 'same', lineItems: [] },
    { id: 'o3', provider: 'shopify', customerEmailHash: 'recorded-hash', lineItems: [] },
    { id: 'o4', provider: 'shopify', customerEmailHash: 'recorded-hash', lineItems: [] },
    { id: 'o5', provider: 'shopify', customerEmail: 'same@example.com', customerName: 'Same Person', lineItems: [] },
    { id: 'o6', customerId: 'same', lineItems: [] }
  ];
  state.channelData = {};
  const graph = deriveBusinessGraph(state);
  assert.equal(nodesOf(graph, 'customer').length, 3);
  assert.equal(edgesOf(graph, 'placed_by_customer').length, 4);
  assert.equal(graph.summary.unknownByReason.missing_customer_identifier_or_channel, 2);
  assert.equal(JSON.stringify(graph).includes('recorded-hash'), false);
});

test('only verified terminal outcomes are labelled realised; forecasts and pending approvals stay separate', () => {
  const state = fixture();
  state.approvals[0].status = 'pending';
  state.workRecords[0].status = 'PLANNED';
  state.revenueEngine.experiments = [
    { id: 'running', status: 'running', impact: { verified: true, incrementalContribution: 10 } },
    { id: 'measured', status: 'measured', impact: { verified: false, incrementalContribution: 20 } },
    { id: 'verified-zero', status: 'completed', impact: { status: 'verified', incrementalContribution: 0 } },
    { id: 'forecast', status: 'completed', expectedContributionProfit: 99999 }
  ];
  const graph = deriveBusinessGraph(state);
  assert.equal(nodesOf(graph, 'outcome').length, 5);
  assert.equal(graph.summary.verifiedOutcomeRecords, 1);
  assert.equal(JSON.stringify(graph).includes('99999'), false);
  assert.equal(JSON.stringify(graph).includes('9000'), false);
  assert.equal(nodesOf(graph, 'outcome').find(node => node.attributes.realised).attributes.metricFields[0], 'incrementalContribution');
});

test('outcome counts are explicitly source-record counts, never deduplicated commercial impact', () => {
  const state = fixture();
  state.approvals[0].impact.id = 'same-evidence';
  state.workRecords[0].evidence[0].impact.id = 'same-evidence';
  state.revenueEngine.experiments[0].impact.id = 'same-evidence';
  const graph = deriveBusinessGraph(state);
  assert.equal(graph.summary.verifiedOutcomeRecords, 3);
  assert.equal(graph.summary.outcomeCountsAreSourceRecords, true);
  assert.equal('verifiedRealisedOutcomes' in graph.summary, false);
  assert.equal('verifiedValue' in graph.summary, false);
  assert.equal(new Set(nodesOf(graph, 'outcome').map(node => node.id)).size, 3);
});

test('all output limits are capped and never leave dangling relationships', () => {
  const state = fixture();
  const graph = deriveBusinessGraph(state, { recordLimit: 2, nestedLimit: 1, nodeLimit: 12, edgeLimit: 3, unknownLimit: 2 });
  assert.ok(graph.nodes.length <= 12);
  assert.ok(graph.edges.length <= 3);
  assert.ok(graph.unknownMappings.length <= 2);
  assert.equal(graph.coverage.truncated, true);
  assert.equal(graph.coverage.complete, false);
  assert.ok(graph.coverage.droppedNodes > 0);
  assert.ok(graph.coverage.droppedEdges > 0);
  assert.ok(graph.coverage.omittedUnknownMappings > 0);
  assertIntegrity(graph);
  const capped = deriveBusinessGraph(state, { recordLimit: 1e9, nestedLimit: 1e9, scanLimit: 1e9, nodeLimit: 1e9, edgeLimit: 1e9, unknownLimit: 1e9 });
  assert.deepEqual(capped.limits, { recordLimit: 500, nestedLimit: 100, scanLimit: 10000, nodeLimit: 2000, edgeLimit: 4000, unknownLimit: 500 });
});

test('a partial target index does not assert a unique relationship before unseen duplicates', () => {
  const state = fixture();
  state.products = [{ id: 'p1', provider: 'shopify', variants: [] }, { id: 'p1', provider: 'shopify', variants: [] }];
  const graph = deriveBusinessGraph(state, { recordLimit: 1 });
  assert.equal(edgesOf(graph, 'promotes_product').length, 0);
  assert.ok(graph.summary.unknownByReason.target_index_incomplete);
  assert.equal(graph.coverage.sources.find(source => source.collection === 'products.variants').totalKnown, false);
});

test('summary is cheap, bounded, honest about truncation and includes no source records', () => {
  const state = fixture();
  let touched = 0;
  state.products = Array.from({ length: 5000 }, (_, index) => ({
    get id() { touched++; return `p-${index}`; }, provider: 'shopify',
    variants: Array.from({ length: 10 }, (_, item) => ({ id: `v-${index}-${item}`, sku: `SKU-${index}-${item}` }))
  }));
  const graph = deriveBusinessGraphSummary(state, { recordLimit: 1e9, nestedLimit: 1e9, scanLimit: 1e9, nodeLimit: 1e9, edgeLimit: 1e9 });
  assert.equal(graph.mode, 'summary');
  assert.equal('nodes' in graph, false);
  assert.equal('edges' in graph, false);
  assert.equal('unknownMappings' in graph, false);
  assert.ok(graph.coverage.scannedRecords <= 250);
  assert.ok(touched < 100, 'does not scan the entire catalogue');
  assert.equal(graph.coverage.sources.find(source => source.collection === 'products').available, 5000);
  assert.equal(graph.coverage.truncated, true);
  assert.equal(graph.summary.countsAreProjectionOnly, true);
  assert.ok(JSON.stringify(graph).length < 15000);
});

test('dictionary scanning is bounded and never mistakes a projected-out cost profile for missing costs', () => {
  const state = fixture();
  state.economics = { unrelated: costs(), BAGS: costs() };
  const graph = deriveBusinessGraph(state, { recordLimit: 1 });
  const coverage = graph.coverage.sources.find(source => source.collection === 'economics');
  assert.equal(coverage.scanned, 1);
  assert.equal(coverage.totalKnown, false);
  assert.equal(coverage.truncated, true);
  const variant = nodeAt(graph, '/products/0/variants/0', 'variant');
  assert.ok(graph.unknownMappings.some(mapping => mapping.subjectId === variant.id && mapping.relation === 'has_economics' && mapping.reason === 'target_outside_projection'));
  assert.equal(graph.unknownMappings.some(mapping => mapping.subjectId === variant.id && mapping.reason === 'missing_economics'), false);
});

test('invalid records and absent collections do not claim complete coverage or synthesize businesses', () => {
  const empty = deriveBusinessGraph({ workspace: { id: 'empty' } });
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.edges.length, 0);
  const graph = deriveBusinessGraph({ workspace: { id: 'invalid' }, products: [null, 'invalid', 5] });
  assert.equal(graph.coverage.sources.find(source => source.collection === 'products').invalid, 3);
  assert.equal(graph.coverage.complete, false);
  assert.equal(graph.nodes.length, 0);
  const malformed = deriveBusinessGraph({ workspace: { id: 'invalid' }, products: {}, economics: [] });
  assert.equal(malformed.coverage.complete, false);
});
