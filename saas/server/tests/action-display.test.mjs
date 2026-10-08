import test from 'node:test';
import assert from 'node:assert/strict';
import { publicConnectionWrite, publicApproval, OBJECTIVE_CONTENT_DISPLAY_SCHEMA } from '../lib/action-display.mjs';
import { reviewedActionFixture } from './reviewed-action-test-fixture.mjs';
import { resolveRecordedActionEvidence, canonicalReviewedActionJson, validateReviewedSourceAction } from '../lib/reviewed-action-evidence.mjs';
import { objectiveContentFixture } from './objective-content-fixture.mjs';
import { objectiveCanonicalDigest } from '../lib/objective-dispatch-policy.mjs';

const secret = { privateSource: 'hidden-value-canary-not-public' };
const references = { objectiveId: 'objective_00000000-0000-0000-0000-000000000001', objectiveRevision: 2,
  jobId: 'job_display', reportId: 'objective_review_' + 'a'.repeat(32), opportunityId: 'opportunity-display', productId: 'gid://shopify/Product/71' };
function write(input = { operation: 'product_content', productId: references.productId, title: 'Exact 雪\nTitle', description: '' }, provider = 'shopify') {
  return { id: 'write_display', requestId: 'display_request_0001', provider, input, digest: 'public-input-digest',
    connectionId: 'shopify-display', account: 'display.myshopify.com', requestedBy: 'public-owner', requiresApproval: true,
    approvalId: 'approval-display', status: 'completed', createdAt: '2026-10-01T00:00:00.000Z', completedAt: '2026-10-02T00:00:00.000Z',
    result: { externalId: references.productId, confirmed: true, recovery: 'Public recovery text', privateFuture: secret },
    objectivePolicyProposal: { schema: 'runvara-objective-dispatch-proposal/v2', origin: 'owner_objective_content', provider: 'shopify', operation: 'product_content',
      source: { schema: 'runvara-objective-content-source/v1', ...references, actorSessionVersion: secret, privateFuture: secret }, privateFuture: secret },
    dispatchClaim: secret, providerState: secret, recordedActionContext: secret, stableApproval: secret, privateFuture: secret };
}
function noCanary(value) { assert.equal(JSON.stringify(value).includes(secret.privateSource), false); }

test('write display is a fresh nested projection preserving exact public bytes and diagnostic references', () => {
  const original = write(); original.input.future = secret;
  const before = JSON.stringify(original), projected = publicConnectionWrite(original);
  noCanary(projected);
  assert.deepEqual(projected.input, { operation: 'product_content', productId: references.productId, title: 'Exact 雪\nTitle', description: '' });
  assert.deepEqual(projected.result, { externalId: references.productId, recovery: 'Public recovery text', confirmed: true });
  assert.deepEqual(projected.sourceDisplay, { schema: OBJECTIVE_CONTENT_DISPLAY_SCHEMA, origin: 'owner_objective_content', status: 'available', ...references });
  assert.equal(projected.digest, 'public-input-digest'); assert.equal(projected.account, original.account);
  for (const key of ['objectivePolicyProposal', 'source', 'dispatchClaim', 'providerState', 'recordedActionContext', 'stableApproval', 'privateFuture']) assert.equal(Object.hasOwn(projected, key), false);
  assert.notEqual(projected, original); assert.notEqual(projected.input, original.input); assert.notEqual(projected.result, original.result);
  projected.input.title = 'Different display'; projected.sourceDisplay.objectiveId = 'changed'; projected.result.externalId = 'changed';
  assert.equal(JSON.stringify(original), before);
});

const inputs = [
  ['shopify', { operation: 'product_content', productId: references.productId, title: '雪\nExact', description: '' }],
  ['shopify', { operation: 'internal_note', productId: references.productId, note: 'Private to business, intentionally public here\n雪' }],
  ...['product_tags_add', 'product_tags_remove'].map(operation => ['shopify', { operation, productId: references.productId, tags: ['New 雪'], expectedTags: ['Existing'] }]),
  ['meta', { operation: 'catalog_product_create', catalogId: '10', name: 'Exact', description: 'Line 1\n雪', retailerId: 'SKU', brand: 'Brand', category: 'Home', url: 'https://example.test/product', imageUrl: 'https://example.test/image.jpg', priceMinor: 123, currency: 'GBP', availability: 'out of stock', condition: 'new', visibility: 'staging' }],
  ['meta', { operation: 'catalog_product_update', catalogId: '10', productId: '11', name: 'Exact', description: 'Line 1\n雪' }],
  ['meta', { operation: 'catalog_inventory', catalogId: '10', productId: '11', quantity: 0, availability: 'out of stock' }],
  ['meta', { operation: 'catalog_visibility', catalogId: '10', productId: '11', visibility: 'staging' }],
  ['meta', { operation: 'facebook_publish', pageId: '12', message: 'Line 1\n雪', link: 'https://example.test/' }],
  ['meta', { operation: 'facebook_update', pageId: '12', message: 'Line 1\n雪', postId: '12_13' }],
  ['meta', { operation: 'instagram_publish', pageId: '12', instagramId: '14', caption: 'Line 1\n雪', imageUrl: 'https://example.test/image.jpg' }]
];
for (const [provider, input] of inputs) test(`${provider} ${input.operation} retains only its exact typed operation fields`, () => {
  const record = write({ ...input, future: secret }, provider), before = JSON.stringify(record);
  const projected = publicConnectionWrite(record); assert.deepEqual(projected.input, input); noCanary(projected);
  assert.equal(JSON.stringify(record), before);
  for (const key of Object.keys(input)) {
    const malformed = publicConnectionWrite(write({ ...input, [key]: secret }, provider));
    noCanary(malformed); assert.equal(Object.hasOwn(malformed.input, key), false, key);
  }
  if (input.tags) { projected.input.tags.push('display change'); assert.deepEqual(record.input.tags, input.tags); }
});

test('unknown operations and object-shaped scalar/result fields never pass through', () => {
  assert.deepEqual(publicConnectionWrite(write({ operation: 'future_operation', future: secret })).input, {});
  const record = write();
  for (const key of ['id', 'digest', 'account', 'status', 'errorCode', 'requiresApproval', 'dispatchBlocked']) record[key] = secret;
  record.result = { externalId: secret, confirmed: secret, recovery: secret };
  const result = publicConnectionWrite(record); noCanary(result); assert.deepEqual(result.result, {});
  for (const key of ['id', 'digest', 'account', 'status', 'errorCode', 'requiresApproval', 'dispatchBlocked']) assert.equal(Object.hasOwn(result, key), false);
  assert.equal(Object.hasOwn(publicConnectionWrite(write({ operation: 'product_tags_add', tags: ['one', secret] })).input, 'tags'), false);
});

test('unavailable and unknown display origins cannot silently become manual', () => {
  for (const malformed of [null, {}, { ...write().objectivePolicyProposal, source: null },
    { ...write().objectivePolicyProposal, source: { schema: 'unknown', ...references } },
    { ...write().objectivePolicyProposal, source: { schema: 'runvara-objective-content-source/v1', ...references, objectiveRevision: secret } }]) {
    const projected = publicConnectionWrite({ ...write(), objectivePolicyProposal: malformed });
    assert.equal(projected.sourceDisplay.status, 'unavailable'); noCanary(projected);
    assert.deepEqual(Object.keys(projected.sourceDisplay).sort(), ['schema', 'origin', 'status'].sort());
  }
  const v2 = { schema: 'runvara-objective-dispatch-proposal/v2' };
  assert.equal(publicConnectionWrite({ ...write(), objectivePolicyProposal: v2 }).sourceDisplay.origin, 'owner_objective_content');
  for (const origin of ['owner_manual', 'owner_objective_content', 'future']) {
    const result = publicConnectionWrite({ ...write(), objectivePolicyProposal: { schema: 'future', origin, source: secret } });
    assert.equal(result.sourceDisplay.status, 'unavailable'); noCanary(result);
  }
  const manual = { ...write(), objectivePolicyProposal: { schema: 'runvara-objective-dispatch-proposal/v1', origin: 'owner_manual' } };
  assert.equal(Object.hasOwn(publicConnectionWrite(manual), 'sourceDisplay'), false);
  delete manual.objectivePolicyProposal;
  assert.equal(Object.hasOwn(publicConnectionWrite(manual), 'sourceDisplay'), false);
  for (const change of [row => { row.provider = 'meta'; }, row => { row.input.operation = 'internal_note'; },
    row => { row.objectivePolicyProposal.provider = 'meta'; }, row => { row.objectivePolicyProposal.operation = 'internal_note'; },
    row => { row.objectivePolicyProposal.source.productId += '9'; },
    row => { row.input.productId = row.objectivePolicyProposal.source.productId = 'gid://shopify/Product/' + '9'.repeat(100); }]) {
    const record = write(); change(record); assert.equal(publicConnectionWrite(record).sourceDisplay.status, 'unavailable');
  }
});

test('approval projection preserves public narrative, references and history for every origin without stored mutation', () => {
  const evidence = [{ type: 'objective_review', id: references.reportId, detail: `Public report ${references.jobId}`, at: null, privateFuture: secret }];
  const original = { id: 'approval', type: 'customer_facing_publish', action: 'Public action 雪', reason: `Public goal ${references.objectiveId}`,
    financialImpact: null, expectedBenefit: 'Exact\nbenefit', risk: 'Medium', requestedBy: 'owner', source: 'objective-content', revision: 1,
    status: 'approved', decidedAt: null, decisionNote: null, executedExternally: false, evidence,
    payload: { connectionWriteId: 'write', opportunityId: 'opportunity', experimentId: null, verifiedExperiment: false, legacyReviewRecorded: true, marketingCampaignId: 'campaign', digest: secret, source: secret },
    history: [{ revision: 1, status: 'pending', actor: 'owner', at: '2026-10-01T00:00:00Z', note: null, action: 'Original action', reason: 'Original public narrative', financialImpact: 0, expectedBenefit: 'Benefit', risk: 'Low', evidence, privateFuture: secret }],
    privateFuture: secret, stableApproval: secret, objectivePolicyProposal: secret, recordedActionContext: secret };
  const before = JSON.stringify(original), projected = publicApproval(original); noCanary(projected);
  assert.equal(projected.reason, original.reason); assert.equal(projected.expectedBenefit, original.expectedBenefit);
  assert.deepEqual(projected.payload, { connectionWriteId: 'write', opportunityId: 'opportunity', experimentId: null, marketingCampaignId: 'campaign', verifiedExperiment: false, legacyReviewRecorded: true });
  assert.deepEqual(projected.evidence, [{ type: 'objective_review', id: references.reportId, detail: `Public report ${references.jobId}`, at: null }]);
  assert.equal(projected.history[0].reason, 'Original public narrative'); assert.equal(projected.history[0].financialImpact, 0);
  projected.evidence[0].detail = 'changed'; projected.history[0].evidence[0].detail = 'changed'; projected.payload.connectionWriteId = 'changed';
  assert.equal(JSON.stringify(original), before);
  const malformed = publicApproval({ ...original, reason: secret, source: secret, revision: secret, payload: { connectionWriteId: secret, verifiedExperiment: secret }, evidence: [{ type: secret, id: secret, detail: secret, at: secret }], history: [{ reason: secret, evidence: [{ detail: secret }] }] });
  noCanary(malformed); assert.deepEqual(malformed.evidence, [{}]); assert.deepEqual(malformed.payload, {});
});

test('optional source and nested list accessors are never invoked during display', () => {
  let reads = 0; const getter = () => { reads++; throw new Error('Must not read optional accessor'); };
  const record = write(); Object.defineProperty(record.objectivePolicyProposal, 'source', { get: getter });
  Object.defineProperty(record, 'recordedActionContext', { get: getter });
  assert.equal(publicConnectionWrite(record).sourceDisplay.status, 'unavailable');
  const evidence = []; Object.defineProperty(evidence, 0, { get: getter }); evidence.map = getter;
  const history = [{ evidence }]; Object.defineProperty(history, 1, { get: getter }); history.map = getter;
  assert.deepEqual(publicApproval({ evidence, history }), { payload: {}, evidence: [], history: [{ evidence: [] }] });
  const tags = []; Object.defineProperty(tags, 0, { get: getter });
  assert.deepEqual(publicConnectionWrite(write({ operation: 'product_tags_add', tags })).input, { operation: 'product_tags_add' });
  assert.equal(reads, 0);
});

test('generic projection leaves manual immutable evidence, claims and canonical bytes unchanged', () => {
  const fixture = reviewedActionFixture({ description: 'Exact approved 雪\n\nEnding newline\n' });
  const bytes = JSON.stringify(fixture.state), canonical = canonicalReviewedActionJson(fixture.source);
  const view = publicConnectionWrite(fixture.write); publicApproval(fixture.approval);
  assert.equal(JSON.stringify(fixture.state), bytes); assert.equal(view.input.description, fixture.source.input.description);
  assert.equal(canonicalReviewedActionJson(resolveRecordedActionEvidence(fixture.state, fixture.write.id)), canonical);
  assert.equal(canonicalReviewedActionJson(validateReviewedSourceAction(fixture.source, { workspaceId: 'tenant-a' })), canonical);
  assert.equal(view.dispatchClaim, undefined); assert.equal(view.recordedActionContext, undefined);
});

test('v2 fresh success and post-submission missing source keep exact dispatch counts and stored authority', async () => {
  for (const unavailable of [false, true]) {
    const f = await objectiveContentFixture();
    if (unavailable) f.hooks.fetch = async () => { f.state.products = []; return Response.json({ data: { productUpdate: { product: { id: f.write.input.productId }, userErrors: [] } } }); };
    const completed = await f.run(), before = JSON.stringify(f.database.states.get(f.state.workspace.id));
    const proposalDigest = objectiveCanonicalDigest(completed.objectivePolicyProposal), projected = publicConnectionWrite(completed);
    assert.equal(projected.status, 'completed'); assert.equal(projected.sourceDisplay.status, 'available');
    assert.equal(projected.result.externalId, f.write.input.productId); assert.equal(projected.objectivePolicyProposal, undefined);
    assert.deepEqual(f.counts, { job: 3, credentials: 1, saves: 3, fresh: 2, mutations: 1 });
    assert.equal(JSON.stringify(f.database.states.get(f.state.workspace.id)), before);
    assert.equal(objectiveCanonicalDigest(completed.objectivePolicyProposal), proposalDigest);
    const again = publicConnectionWrite(await f.run()); assert.deepEqual(again, projected);
    assert.deepEqual(f.counts, { job: 3, credentials: 1, saves: 3, fresh: 2, mutations: 1 });
  }
});
