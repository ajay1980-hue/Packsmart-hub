import {test} from 'node:test';
import assert from 'node:assert/strict';
import {flowFixture} from './meta-publication-flow-fixture.mjs';
import {createMetaSingleImageFixture, executeMetaSingleImageFixture, readMetaSingleImageFixture} from '../lib/meta-publication-flow.mjs';
import {readMetaAsset} from '../lib/meta-publication-delivery.mjs';
import {metaLedgerDigest} from '../lib/meta-publication-ledger.mjs';
const posts = f => f.providerCalls.filter(c => c.options.method === 'POST');
test('exact pending approval and protected phases compose two posts without legacy executable records', async t => {
  const f = await flowFixture(t); await f.prepare();
  await assert.rejects(f.execute()); assert.equal(f.providerCalls.length, 0);
  await f.approve(); const result = await f.execute();
  assert.equal(result.resultId, '900002'); assert.equal(result.executedExternally, false); assert.equal(result.publishingEnabled, false);
  assert.deepEqual(posts(f).map(c => c.p), ['/303/media', '/303/media_publish']);
  assert.deepEqual(JSON.parse(posts(f)[0].options.body), {image_url: 'https://runvara.invalid/api/meta-publication-assets/' + metaLedgerDigest(f.descriptor) + '/' + f.token + '.jpg', caption: f.binding.caption});
  assert.deepEqual(JSON.parse(posts(f)[1].options.body), {creation_id: '900001'});
  assert.equal((await f.get()).connectionWrites?.length || 0, 0);
  assert.deepEqual(f.events.map(e => e.event.kind + ':' + e.event.phase), ['reserve:proposal', 'admit:container', 'settle:container', 'admit:publish', 'settle:publish']);
  assert.equal(f.events.every(e => e.event.provenance === 'native_fixture_no_provider_action/v1'), true);
  assert.ok(f.providerCalls.every(c => new URL(c.url).hostname === 'graph.runvara.invalid'));
  assert.equal(f.providerCalls.filter(c => c.p === '/900001').length, 1);
  assert.deepEqual(f.readiness.map(e => e.event.kind), ['admit', 'settle']);
  assert.equal(JSON.stringify((await f.get()).audit).includes(f.token), false);
});
test('replay and fresh composition after restart disclose retained outcome without another transport', async t => {
  const f = await flowFixture(t); await f.prepare(); await f.approve(); await f.execute(); const count = f.providerCalls.length;
  f.composition = f.compose();
  const d = f.descriptor;
  f.asset = await readMetaAsset({workspaceId: f.workspaceId, assetId: d.assetId, digest: metaLedgerDigest(d)}, f.session, {request: f.rpc, loadFreshState: f.load});
  assert.equal((await f.prepare()).replayed, true);
  assert.equal((await f.execute()).resultId, '900002'); assert.equal(f.providerCalls.length, count);
});
test('competing executions issue each POST at most once', async t => {
  const f = await flowFixture(t); await f.prepare(); await f.approve();
  const result = await Promise.allSettled([f.execute(), f.execute()]);
  assert.ok(result.some(r => r.status === 'fulfilled')); assert.equal(posts(f).filter(c => c.p.endsWith('/media')).length, 1);
  assert.equal(posts(f).filter(c => c.p.endsWith('/media_publish')).length, 1);
});
test('lost admission ACK is recovered as evidence only and never submits', async t => {
  const f = await flowFixture(t); await f.prepare(); await f.approve();
  f.afterRpc = (name, r, response) => {if (name === 'runvara_commit_meta_ledger_v1' && r.kind === 'admit') throw Error('lost ACK'); return response;};
  assert.equal((await f.execute()).resendPermitted, false); assert.equal(posts(f).length, 0);
  f.afterRpc = null; await f.execute(); assert.equal(posts(f).length, 0);
});
for (const [name, change] of [['stock', s => s.products[0].variants[0].inventory = 0], ['cost', s => delete s.economics.BAGS],
  ['approval', s => s.approvals[0].status = 'rejected'], ['approval note', s => s.approvals[0].decisionNote = 'changed'],
  ['session', s => s.users[0].sessionVersion++], ['target', s => s.connections[0].metadata.assets.pages[0].instagram.id = '999']]) {
  test('fresh source and decision gate stops ' + name + ' changed during preflight', async t => {
    const f = await flowFixture(t); await f.prepare(); await f.approve(); let changed = false;
    f.providerHook = async p => {if (p.endsWith('/content_publishing_limit') && !changed) {changed = true; await f.change(change);}};
    await assert.rejects(f.execute()); assert.equal(posts(f).length, 0);
  });
}
for (const [name, path, result] of [['account', '/me', {id: '999'}], ['target', '/202', {id: '202', tasks: ['CREATE_CONTENT'], instagram_business_account: {id: '999'}}],
  ['permission', '/me/permissions', {data: []}], ['task', '/202', {id: '202', tasks: ['ANALYZE'], instagram_business_account: {id: '303'}}],
  ['quota', '/303/content_publishing_limit', {data: [{quota_usage: 50, config: {quota_total: 50}}]}]]) {
  test('provider ' + name + ' drift denies transport with an admitted hold', async t => {
    const f = await flowFixture(t); await f.prepare(); await f.approve(); f.providerHook = p => p === path ? Response.json(result) : undefined;
    await assert.rejects(f.execute()); assert.equal(posts(f).length, 0);
    assert.equal(f.events.at(-1).event.kind, 'admit'); f.providerHook = null; await f.execute(); assert.equal(posts(f).length, 0);
  });
}
test('unknown mutation response and duplicate keys retain no-resend after restart', async t => {
  const f = await flowFixture(t); await f.prepare(); await f.approve();
  f.providerHook = p => p.endsWith('/media') ? new Response('{"id":"1","id":"2"}', {headers: {'content-type': 'application/json'}}) : undefined;
  await assert.rejects(f.execute()); assert.equal(posts(f).length, 1);
  f.composition = f.compose(); f.providerHook = null; await f.execute(); assert.equal(posts(f).length, 1);
});
test('observed publication settles after revocation but disclosure refuses the old owner', async t => {
  const f = await flowFixture(t); await f.prepare(); await f.approve();
  f.providerHook = async p => {if (p.endsWith('/media_publish')) {await f.change(s => s.users[0].disabled = true); return Response.json({id: '900002'});}};
  await assert.rejects(f.execute());
  assert.equal(f.events.at(-1).event.data.resultId, '900002'); assert.equal(f.events.at(-1).event.kind, 'settle');
  await assert.rejects(readMetaSingleImageFixture(f.composition, f.binding, f.session));
});
test('forged composition, missing injection and copied asset remain closed', async t => {
  const f = await flowFixture(t); await f.prepare(); await f.approve();
  assert.throws(() => createMetaSingleImageFixture({environment: 'production', store: f.store, request: f.rpc, fetch: f.fetch}));
  assert.throws(() => createMetaSingleImageFixture({environment: 'test', store: f.store, request: f.rpc}));
  await assert.rejects(executeMetaSingleImageFixture({}, f.binding, f.asset, f.token, f.session));
  await assert.rejects(executeMetaSingleImageFixture(f.composition, f.binding, {...f.asset}, f.token, f.session));
  assert.equal(f.providerCalls.length, 0);
});
for (const status_code of ['IN_PROGRESS', 'ERROR', 'EXPIRED', 'PUBLISHED']) {
  test('exact ' + status_code + ' readiness never consumes publication admission or sends a POST', async t => {
    const f = await flowFixture(t); await f.prepare(); await f.approve();
    f.providerHook = p => p === '/900001' ? Response.json({id: '900001', status_code}) : undefined;
    const result = await f.execute(); assert.equal(result.resultId, null);
    assert.equal(posts(f).length, 1); assert.equal(f.events.some(e => e.event.kind === 'admit' && e.event.phase === 'publish'), false);
    const count = f.providerCalls.length; f.composition = f.compose(); await f.execute(); assert.equal(f.providerCalls.length, count);
  });
}
test('mismatched readiness and lost readiness ACK retain the GET hold without replay', async t => {
  for (const lost of [false, true]) {
    const f = await flowFixture(t); await f.prepare(); await f.approve();
    if (lost) f.afterRpc = (name, r, response) => {if (name === 'runvara_commit_meta_readiness_v1' && r.kind === 'admit') throw Error('lost readiness ACK'); return response;};
    else f.providerHook = p => p === '/900001' ? Response.json({id: '999999', status_code: 'FINISHED'}) : undefined;
    if (lost) await f.execute(); else await assert.rejects(f.execute());
    assert.equal(f.readiness.length, 1); assert.equal(posts(f).length, 1);
    const count = f.providerCalls.length; f.afterRpc = null; f.providerHook = null; await f.execute(); assert.equal(f.providerCalls.length, count);
  }
});
test('late exact readiness settles after revocation but cannot lead to publication', async t => {
  const f = await flowFixture(t); await f.prepare(); await f.approve();
  f.providerHook = async p => {if (p === '/900001') {await f.change(s => s.users[0].disabled = true); return Response.json({id: '900001', status_code: 'FINISHED'});}};
  await assert.rejects(f.execute()); assert.equal(f.readiness.at(-1).event.kind, 'settle');
  assert.equal(f.readiness.at(-1).event.statusCode, 'FINISHED'); assert.equal(posts(f).length, 1);
});
