import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { png, chunk } from './marketing-publication-asset-fixture.mjs';
import { snapshotPublicationImage, LOCAL_PUBLICATION_ASSET_MAX_BYTES } from '../lib/marketing-publication-asset.mjs';
import { createMetaPublicationLocalAsset, previewMetaMarketingPublication, createMetaPublicationPreparationSimulation,
  prepareMetaMarketingPublication, createMetaPublicationSimulation } from '../lib/marketing-publication.mjs';
import { publicApproval } from '../lib/action-display.mjs';
import { objectiveCanonicalDigest } from '../lib/objective-dispatch-policy.mjs';
import { executeConnectionWrite } from '../lib/connection-writes.mjs';
import { publicationFixture } from './marketing-publication-fixture.mjs';
import { jsonbOrder } from './content-jsonb-test-fixture.mjs';

const invalid = { code: 'META_PUBLICATION_LOCAL_ASSET_INVALID' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function attach(f, bytes = png()) {
  f.assetSnapshot = createMetaPublicationLocalAsset(await f.get(), f.campaignId, f.selection, f.session, bytes, 'image/png');
  return bytes;
}

test('PNG snapshot owns the exact view and describes decoded local pixels without remote evidence', () => {
  const input = png(), packed = Buffer.concat([Buffer.from('prefix'), input, Buffer.from('suffix')]);
  const view = new Uint8Array(packed.buffer, packed.byteOffset + 6, input.length);
  const result = snapshotPublicationImage(view, 'image/png');
  assert.deepEqual(result.bytes, input); assert.equal(result.descriptor.sha256, hash(input));
  assert.equal(result.descriptor.byteLength, input.length); assert.equal(result.descriptor.width, 1);
  assert.equal(result.descriptor.decoded, true); assert.equal(result.descriptor.providerDeliveryVerified, false);
  assert.equal(result.descriptor.pixelSha256, hash(Buffer.from([1, 2, 3, 255])));
  packed.fill(0); assert.deepEqual(result.bytes, input);
});

function encodedPng(raw, { width = 1, height = 1, color = 6, compressed = deflateSync(raw), split = false } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = color;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    ...(split ? [chunk('IDAT', compressed.subarray(0, 1)), chunk('IDAT', compressed.subarray(1, -2)), chunk('IDAT', compressed.subarray(-2))] : [chunk('IDAT', compressed)]), chunk('IEND', Buffer.alloc(0))]);
}

const decodedPixels = Buffer.from([10,20,30,255,40,50,60,128,11,22,33,250,44,55,66,120]);
for (const [filter, rows] of [
  [0, [[10,20,30,255,40,50,60,128], [11,22,33,250,44,55,66,120]]],
  [1, [[10,20,30,255,30,30,30,129], [11,22,33,250,33,33,33,126]]],
  [2, [[10,20,30,255,40,50,60,128], [1,2,3,251,4,5,6,248]]],
  [3, [[10,20,30,255,35,40,45,1], [6,12,18,123,19,19,20,187]]],
  [4, [[10,20,30,255,30,30,30,129], [1,2,3,251,4,5,6,248]]]
]) test(`complete PNG filter ${filter} reconstruction matches independent literal pixel bytes`, () => {
  const input = encodedPng(Buffer.from(rows.flatMap(row => [filter, ...row])), { width: 2, height: 2, split: true });
  const descriptor = snapshotPublicationImage(input, 'image/png').descriptor;
  assert.equal(descriptor.pixelSha256, hash(decodedPixels)); assert.equal(descriptor.pixelByteLength, decodedPixels.length);
  assert.equal(descriptor.decoded, true); assert.equal(descriptor.decoder, 'png8-noninterlaced-basic/v1');
});

test('Paeth upper-left predictor and all admitted color layouts are fully decoded', () => {
  const paeth = encodedPng(Buffer.from([4,15,5,4,251,6]), { width: 2, height: 2, color: 0 });
  assert.equal(snapshotPublicationImage(paeth, 'image/png').descriptor.pixelSha256, hash(Buffer.from([15,20,10,21])));
  for (const [color, pixels] of [[0,[42]], [2,[42,43,44]], [4,[42,155]], [6,[42,43,44,155]]]) {
    const result = snapshotPublicationImage(encodedPng(Buffer.from([0,...pixels]), { color }), 'image/png').descriptor;
    assert.equal(result.colorType, color); assert.equal(result.pixelByteLength, pixels.length); assert.equal(result.pixelSha256, hash(Buffer.from(pixels)));
  }
});

const validZlib = deflateSync(Buffer.from([0,1,2,3,255]));
const invalidAdler = Buffer.from(validZlib); invalidAdler[invalidAdler.length - 1] ^= 1;
for (const [name, input] of [
  ['invalid zlib', encodedPng(null, { compressed: Buffer.from([1,2,3,4]) })],
  ['truncated zlib', encodedPng(null, { compressed: validZlib.subarray(0,-1) })],
  ['bad Adler with valid PNG CRC', encodedPng(null, { compressed: invalidAdler })],
  ['trailing compressed input', encodedPng(null, { compressed: Buffer.concat([validZlib,Buffer.from([0])]) })],
  ['concatenated streams', encodedPng(null, { compressed: Buffer.concat([validZlib,validZlib]) })],
  ['short scanline', encodedPng(Buffer.from([0,1,2,3]))],
  ['extra scanline data', encodedPng(Buffer.from([0,1,2,3,255,0]))],
  ['unknown row filter', encodedPng(Buffer.from([5,1,2,3,255]))],
  ['deflate expansion beyond exact row size', encodedPng(Buffer.alloc(1024*1024))],
  ['decoded memory limit', encodedPng(Buffer.from([0,1,2,3,255]), { width: 8192, height: 4096 })]
]) test(`valid PNG structure cannot hide ${name}`, () => assert.throws(() => snapshotPublicationImage(input, 'image/png'), invalid));

test('intrinsic view metadata prevents accessor spoofing without invoking getters', () => {
  const input = png(); let reads = 0;
  for (const key of ['buffer', 'byteLength', 'byteOffset']) Object.defineProperty(input, key, { get() { reads++; throw new Error('accessor'); } });
  assert.equal(snapshotPublicationImage(input, 'image/png').descriptor.sha256, hash(input));
  assert.equal(reads, 0);
});

for (const [name, bytes, mime] of [
  ['empty', Buffer.alloc(0), 'image/png'],
  ['oversized', Buffer.alloc(LOCAL_PUBLICATION_ASSET_MAX_BYTES + 1), 'image/png'],
  ['shared buffer', new Uint8Array(new SharedArrayBuffer(100)), 'image/png'],
  ['proxy', new Proxy(png(), {}), 'image/png'],
  ['plain object', { length: 100, buffer: png() }, 'image/png'],
  ['DataView', new DataView(new ArrayBuffer(100)), 'image/png'],
  ['wrong MIME', png(), 'image/jpeg'],
  ['truncated', png().subarray(0, -1), 'image/png'],
  ['trailing bytes', Buffer.concat([png(), Buffer.from([1])]), 'image/png'],
  ['wrong signature', Buffer.alloc(100), 'image/png'],
  ['zero width', png(1, { width: 0 }), 'image/png'],
  ['dimension limit', png(1, { width: 16385 }), 'image/png'],
  ['pixel limit', png(1, { width: 10000, height: 10000 }), 'image/png'],
  ['interlaced', png(1, { interlace: 1 }), 'image/png'],
  ['palette', png(1, { color: 3 }), 'image/png'],
  ['bit depth', png(1, { bitDepth: 16 }), 'image/png'],
  ['animation', png(1, { extra: chunk('acTL', Buffer.alloc(8)) }), 'image/png'],
  ['high-bit chunk name', png(1, { extra: chunk('\xc9DAT', Buffer.alloc(1)) }), 'image/png']
]) test(`local snapshot refuses ${name}`, () => assert.throws(() => snapshotPublicationImage(bytes, mime), invalid));

test('one-byte corruption, malformed chunk lengths and missing data are refused', () => {
  const corrupt = png(); corrupt[45] ^= 1;
  const length = png(); length.writeUInt32BE(0xffffffff, 33);
  const missingData = Buffer.concat([png().subarray(0, 33), chunk('IEND', Buffer.alloc(0))]);
  for (const bytes of [corrupt, length, missingData]) assert.throws(() => snapshotPublicationImage(bytes, 'image/png'), invalid);
});

test('local bytes bind preview, approval, simulated dispatch and receipt without disclosing bytes', async t => {
  const f = await publicationFixture(t), bytes = await attach(f), expectedHash = hash(bytes);
  const preview = await f.preview(); bytes.fill(0);
  assert.equal(preview.asset.bytesVerified, false);
  assert.equal(preview.asset.localSnapshot.sha256, expectedHash);
  assert.equal(preview.asset.localSnapshot.context.workspaceId, f.workspaceId);
  const prepared = await f.prepare(), state = await f.get();
  const display = publicApproval(state.approvals.find(row => row.id === prepared.approvalId));
  assert.deepEqual(display.payload.publication.asset.localSnapshot, preview.asset.localSnapshot);
  await f.approve(); const run = await f.execute(), history = await f.read();
  assert.equal(run.simulation.observations().length, 2);
  for (const row of run.simulation.observations()) {
    assert.equal(row.localAssetSha256, expectedHash); assert.equal(row.providerDeliveryVerified, false);
  }
  assert.equal(history.receiptStatus, 'simulated_confirmed');
  assert.deepEqual(history.receipt.localAssetSnapshot, preview.asset.localSnapshot);
  const json = JSON.stringify({ preview, display, history, observations: run.simulation.observations() });
  assert.doesNotMatch(json, /"(?:bytes|buffer|data|base64|filePath)"|iVBORw0|"type":"Buffer"/);
  assert.equal(history.executedExternally, false);
});

test('changed bytes under the same URL change the approval identity and cannot execute the old proposal', async t => {
  const f = await publicationFixture(t); await attach(f, png(1)); const first = await f.preview();
  await f.prepare(); await f.approve(); await attach(f, png(2)); const second = await f.preview();
  assert.equal(first.asset.url, second.asset.url); assert.notEqual(first.sourceRevision, second.sourceRevision);
  assert.notEqual(first.asset.localSnapshot.sha256, second.asset.localSnapshot.sha256);
  await assert.rejects(f.execute(), invalid); assert.equal(f.executions.length, 0);
  assert.equal((await f.read()).receiptStatus, 'absent');
});

for (const field of ['sha256', 'byteLength']) test(`a caller-supplied ${field} cannot replace captured bytes`, async t => {
  const f = await publicationFixture(t); await attach(f); const body = await f.body();
  body.asset.localSnapshot[field] = field === 'sha256' ? 'a'.repeat(64) : body.asset.localSnapshot.byteLength + 1;
  await assert.rejects(f.prepare(body), invalid);
  assert.equal((await f.get()).connectionWrites?.length || 0, 0);
});

test('forged or cloned capabilities and JSON-only snapshots confer no authority', async t => {
  const f = await publicationFixture(t); await attach(f); const body = await f.body(), state = await f.get();
  for (const assetSnapshot of [{}, { ...f.assetSnapshot }, structuredClone(f.assetSnapshot), body.asset.localSnapshot])
    assert.throws(() => previewMetaMarketingPublication(state, f.campaignId, f.selection, f.session, { assetSnapshot }), invalid);
  assert.throws(() => createMetaPublicationPreparationSimulation(state, f.campaignId, body, f.session), invalid);
  await f.prepare(); await f.approve(); const saved = await f.get();
  assert.throws(() => createMetaPublicationSimulation(saved, saved.connectionWrites[0]), invalid);
  const denied = () => assert.fail('No credential, persistence or provider boundary may run');
  await assert.rejects(executeConnectionWrite(saved, saved.connectionWrites[0].id, f.session.userId,
    { connectorCredentials: denied }, denied, { actorSession: f.session }), { code: 'META_PUBLICATION_PRODUCTION_CLOSED' });
  await assert.rejects(prepareMetaMarketingPublication(state, f.campaignId, body, f.session,
    { persist: denied, durableStore: true }), { code: 'META_PUBLICATION_PREPARATION_CLOSED' });
});

test('local snapshot cannot cross tenant or campaign context', async t => {
  const f = await publicationFixture(t), other = await publicationFixture(t, 'other-local-asset');
  await attach(f); other.assetSnapshot = f.assetSnapshot;
  await assert.rejects(other.preview(), invalid);
  const state = await f.get(), campaign = structuredClone(state.marketing.campaigns[0]);
  campaign.id = 'different-campaign'; state.marketing.campaigns.push(campaign);
  assert.throws(() => previewMetaMarketingPublication(state, campaign.id, f.selection, f.session, { assetSnapshot: f.assetSnapshot }), invalid);
});

for (const change of ['job', 'completion', 'request', 'URL', 'reference']) test(`changed export ${change} invalidates the local capability`, async t => {
  const f = await publicationFixture(t); await attach(f);
  await f.change(state => {
    const creative = state.marketing.campaigns[0].creativeRequests[0];
    if (change === 'job') creative.jobId += '-new';
    if (change === 'completion') creative.completedAt = '2020-01-01T00:00:00.000Z';
    if (change === 'request') { creative.id += '-new'; f.selection.creativeRequestId = creative.id; }
    if (change === 'URL') { creative.assetUrls = ['https://example.test/other.png']; f.selection.assetUrl = creative.assetUrls[0]; }
    if (change === 'reference') creative.additionalEvidence = 'changed';
  });
  await assert.rejects(f.preview(), invalid);
});

test('export mutation between container and publication prevents the final synthetic send', async t => {
  const f = await publicationFixture(t); await attach(f); await f.prepare(); await f.approve();
  await assert.rejects(f.execute({ persist: async (run, options, save) => {
    const saved = await save(options);
    if (run.saves === 3) run.state.marketing.campaigns[0].creativeRequests[0].jobId += '-changed';
    return saved;
  } }));
  assert.equal(f.executions[0].simulation.observations().filter(row => row.phase === 'instagram_publish').length, 0);
});

test('even a rehashed receipt cannot claim different local snapshot evidence', async t => {
  const f = await publicationFixture(t); await attach(f); await f.prepare(); await f.approve(); await f.execute();
  await f.change(state => {
    const receipt = state.connectionWrites[0].marketingPublicationReceipt;
    receipt.localAssetSnapshot.sha256 = 'a'.repeat(64);
    const { digest, ...body } = receipt; receipt.digest = objectiveCanonicalDigest(body);
  });
  await assert.rejects(f.read(), { code: 'META_PUBLICATION_RECEIPT_INVALID' });
});

test('public approval projection cannot leak extra local snapshot fields or invoke accessors', async t => {
  const f = await publicationFixture(t); await attach(f); await f.prepare();
  const state = await f.get(), approval = state.approvals[0], local = approval.payload.publication.asset.localSnapshot;
  local.bytes = 'private-marker'; local.context.filePath = 'private-path'; let reads = 0;
  Object.defineProperty(local, 'sha256', { enumerable: true, get() { reads++; throw new Error('accessor'); } });
  assert.doesNotMatch(JSON.stringify(publicApproval(approval)), /private-marker|private-path/); assert.equal(reads, 0);
});

test('JSONB-style key reordering preserves the exact local asset proposal across a cold reload', async t => {
  const f = await publicationFixture(t); await attach(f); await f.prepare(); await f.approve();
  await f.change(state => { state.connectionWrites = jsonbOrder(state.connectionWrites); state.approvals = jsonbOrder(state.approvals); });
  assert.equal((await f.execute()).result.status, 'completed');
  assert.equal((await f.read()).receiptStatus, 'simulated_confirmed');
});

test('retained v1 evidence stays structurally verified only and is never upgraded to decoded', async t => {
  const f = await publicationFixture(t); await attach(f); await f.prepare();
  await f.change(state => {
    const write = state.connectionWrites[0], local = write.marketingPublication.asset.localSnapshot;
    Object.assign(local, { schema: 'runvara-local-publication-asset/v1', mimeEvidence: 'png_signature_structure_crc_not_decoded', decoded: false });
    for (const key of ['pixelSha256','pixelByteLength','colorType','decoder']) delete local[key];
    const { digest, ...body } = write.marketingPublication; write.marketingPublication.digest = objectiveCanonicalDigest(body);
    const approval = state.approvals.find(row => row.id === write.approvalId);
    approval.payload.marketingPublicationDigest = write.marketingPublication.digest;
    approval.payload.publication = structuredClone(write.marketingPublication);
  });
  const before = JSON.stringify(await f.get()), history = await f.read();
  assert.equal(history.publication.asset.localSnapshot.decoded, false);
  assert.equal(history.publication.asset.localSnapshot.schema, 'runvara-local-publication-asset/v1');
  assert.equal(JSON.stringify(await f.get()), before);
  assert.equal(publicApproval((await f.get()).approvals[0]).payload.publication.asset.localSnapshot.decoded, false);
  await assert.rejects(f.execute(), invalid, 'A new v2 capability cannot authorize an old descriptor');
});
