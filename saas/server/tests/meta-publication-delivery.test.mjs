import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {flowFixture} from './meta-publication-flow-fixture.mjs';
import {metaLedgerDigest} from '../lib/meta-publication-ledger.mjs';
import {prepareMetaAssetFixture, commitMetaAsset, readMetaAsset, metaAssetDescriptor, metaAssetFixtureUrl,
  serveMetaAssetFixture, verifyMetaAssetDeliveryFixture} from '../lib/meta-publication-delivery.mjs';
import {metaBoundedBytes, metaStrictJson} from '../lib/meta-publication-bounded.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('durable asset binds copied exact JPEG bytes and reference; delivery uses no global fetch', async t => {
  const f = await flowFixture(t), original = Buffer.from(f.bytes); f.bytes.fill(0);
  const d = metaAssetDescriptor(f.asset); assert.equal(d.image.sha256, hash(original));
  d.image.sha256 = 'x'; assert.equal(metaAssetDescriptor(f.asset).image.sha256, hash(original));
  const response = await serveMetaAssetFixture({digest: metaLedgerDigest(f.descriptor), token: f.token}, {request: f.rpc});
  assert.equal(response.headers.get('cache-control'), 'no-store, private');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
  const result = await verifyMetaAssetDeliveryFixture(f.asset, f.token, {request: f.rpc});
  assert.equal(result.providerDeliveryVerified, false); assert.equal(f.providerCalls.length, 0);
  assert.ok(result.url.startsWith('https://runvara.invalid/api/meta-publication-assets/'));
});
test('restart read restores exact bytes with fresh owner, without persisting delivery token or granting transport', async t => {
  const f = await flowFixture(t), d = f.descriptor;
  const module = await import('../lib/meta-publication-delivery.mjs?restart=' + Date.now());
  const cap = await module.readMetaAsset({workspaceId: f.workspaceId, assetId: d.assetId, digest: metaLedgerDigest(d)}, f.session, {request: f.rpc, loadFreshState: f.load});
  assert.deepEqual(module.metaAssetDescriptor(cap), d);
  assert.equal(JSON.stringify(d).includes(f.token), false);
  assert.throws(() => metaAssetDescriptor(cap), {code: 'META_ASSET_PROOF_REQUIRED'});
  assert.throws(() => module.metaAssetFixtureUrl(cap, 'a'.repeat(64)), {code: 'META_ASSET_DELIVERY_DENIED'});
});
test('missing, copied, forged and live issuers stay closed', async t => {
  const f = await flowFixture(t);
  assert.throws(() => metaAssetDescriptor({...f.asset}), {code: 'META_ASSET_PROOF_REQUIRED'});
  await assert.rejects(commitMetaAsset({}), {code: 'META_ASSET_CLOSED'});
  for (const patch of [{environment: 'production'}, {origin: 'https://packsmart-ops.onrender.com'}, {token: '../secret'}, {extra: true}])
    await assert.rejects(prepareMetaAssetFixture(f.campaignId, f.selection, f.session, f.bytes, {...f.assetOptions, ...patch}, {loadFreshState: f.load}));
});
test('asset ACK loss makes one exact lookup and does not write again', async t => {
  const f = await flowFixture(t); let commits = 0, reads = 0;
  const cap = await commitMetaAsset(f.assetCommand, {loadFreshState: f.load, request: async (name, body) => {
    if (name === 'runvara_commit_meta_asset_v1') {commits++; await f.rpc(name, body); throw Error('lost');}
    reads++; return f.rpc(name, body);
  }});
  assert.equal(commits, 1); assert.equal(reads, 1); assert.deepEqual(metaAssetDescriptor(cap), f.descriptor);
});
test('reopen rejects cross-tenant, substituted bytes and revocation during await', async t => {
  const f = await flowFixture(t), identity = {workspaceId: f.workspaceId, assetId: f.descriptor.assetId, digest: metaLedgerDigest(f.descriptor)};
  await assert.rejects(readMetaAsset({...identity, workspaceId: 'other'}, f.session, {request: f.rpc, loadFreshState: f.load}));
  await assert.rejects(readMetaAsset(identity, f.session, {loadFreshState: f.load, request: async (...args) => {
    const value = await (await f.rpc(...args)).json(); value.bytesBase64 = Buffer.from('substituted').toString('base64'); return Response.json(value);
  }}));
  await assert.rejects(readMetaAsset(identity, f.session, {loadFreshState: f.load, request: async (...args) => {
    const response = await f.rpc(...args); await f.change(s => s.users[0].sessionVersion++); return response;
  }}));
});
test('asset command checks source again after decode and before persistence', async t => {
  const f = await flowFixture(t); let reads = 0;
  await assert.rejects(prepareMetaAssetFixture(f.campaignId, f.selection, f.session, f.bytes, f.assetOptions, {loadFreshState: async () => {
    if (++reads === 2) await f.change(s => s.economics.BAGS.landed += 0.01); return f.get();
  }}), {code: 'META_ASSET_SOURCE_CHANGED'});
  await assert.rejects(commitMetaAsset(f.assetCommand, {request: f.rpc, loadFreshState: f.load}), {code: 'META_ASSET_SOURCE_CHANGED'});
});
test('wire parser rejects duplicate escaped keys, nesting and invalid UTF8', () => {
  for (const input of ['{"id":1,"\\u0069d":2}', '{"x":{"a":1,"a":1}}', '[1,]', '01', '[] false', '"\\ud800"', '['.repeat(26) + '0' + ']'.repeat(26)])
    assert.throws(() => metaStrictJson(Buffer.from(input)));
  assert.throws(() => metaStrictJson(Uint8Array.of(255)));
  assert.deepEqual(metaStrictJson(Buffer.from('{"a":[true,null,1.5]}')), {a: [true, null, 1.5]});
});

test('wire parser accepts the maximum asset base64 string without a regex stack limit', () => {
  const bytesBase64 = Buffer.alloc(2 * 1024 * 1024, 0x5a).toString('base64');
  const bytes = Buffer.from(JSON.stringify({bytesBase64, descriptorText: '{"caption":"escaped \\\"quote\\\""}'}));
  assert.equal(metaStrictJson(bytes).bytesBase64, bytesBase64);
  assert.throws(() => metaStrictJson(Buffer.from('"' + 'a'.repeat(bytesBase64.length))));
});
test('wire bounds enforce exact length, encoding, redirects and copied reusable buffers', async () => {
  for (const headers of [{'content-length': '20'}, {'content-encoding': 'gzip'}]) await assert.rejects(metaBoundedBytes(async () => new Response('abcd', {headers: {'content-type': 'image/jpeg', ...headers}}), {maxBytes: 4, mediaType: 'image/jpeg'}));
  const chunk = Uint8Array.of(1, 2); let n = 0;
  const bytes = await metaBoundedBytes(async () => ({status: 200, headers: new Headers({'content-type': 'image/jpeg'}), body: {getReader: () => ({read: async () => {
    n++; if (n > 2) return {done: true}; chunk.fill(n); return {done: false, value: chunk};}, cancel() {}})}}), {maxBytes: 4, mediaType: 'image/jpeg'});
  assert.deepEqual([...bytes], [1, 1, 2, 2]);
});
test('ignored abort, late body and stuck cancellation remain bounded', {timeout: 2000}, async () => {
  let cancels = 0;
  await assert.rejects(metaBoundedBytes(async () => {await new Promise(r => setTimeout(r, 40)); return {body: {cancel: () => {cancels++; return new Promise(() => {});}}};}, {maxBytes: 10, mediaType: 'image/jpeg', timeoutMs: 10}));
  await new Promise(r => setTimeout(r, 70)); assert.equal(cancels, 1);
});
