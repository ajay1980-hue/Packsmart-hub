// Explicit native disposable PostgreSQL proof; excluded from *.test.mjs.
import assert from 'node:assert/strict';
import {before, beforeEach, afterEach, after, test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID, createHash} from 'node:crypto';
import {ledgerFixture} from './meta-publication-ledger-fixture.mjs';
import {metaLedgerText, metaLedgerDigest, metaLedgerCommandBody, commitMetaLedgerCommand,
  prepareMetaLedgerSettlement, metaLedgerFixtureOutcome, readMetaLedgerDecision, buildMetaLedgerFixtureProposal, META_LEDGER_RECOVERY} from '../lib/meta-publication-ledger.mjs';
assert.equal(process.env.OUTCOME_ALLOW_DISPOSABLE_TEST_DB, '1');
const url = new URL(process.env.OUTCOME_TEST_DATABASE_URL);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol)); assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.pathname, '/runvara_outcome_test'); assert.equal(url.username, 'postgres');
assert.equal(url.search, ''); assert.equal(url.hash, '');
const {Client} = createRequire(new URL('./atomic-usage/package.json', import.meta.url))('pg');
const clients = new Set(); let root, admin, database, child;
async function connect(role = 'service_role') {
  const c = new Client({connectionString: child.toString(), ssl: false, options: '', statement_timeout: 15000});
  await c.connect(); clients.add(c); assert.ok(['postgres', 'service_role', 'anon', 'authenticated'].includes(role));
  if (role !== 'postgres') await c.query('SET SESSION AUTHORIZATION ' + role); return c;
}
async function close(c) {clients.delete(c); await c.end();}
const using = async (role, fn) => {const c = await connect(role); try {return await fn(c);} finally {await close(c);}};
const commit = async (raw, c) => {
  const fn = client => client.query('SELECT public.runvara_commit_meta_ledger_v1($1::text) value', [typeof raw === 'string' ? raw : JSON.stringify(raw)]).then(r => r.rows[0].value);
  return c ? fn(c) : using('service_role', fn);
};
const rejected = (...codes) => e => {assert.ok(codes.includes(e.code), e.code + ': ' + e.message); return true;};
const deny = raw => assert.rejects(commit(raw), rejected('P0L01', 'P0L02', 'P0L03', 'P0L04', 'P0L05', 'P0M01', '23505'));
before(async () => {
  root = new Client({connectionString: url.toString(), ssl: false, options: ''}); await root.connect();
  const row = (await root.query("SELECT current_database() db,current_user role,current_setting('listen_addresses') listen,current_setting('server_version_num')::int version")).rows[0];
  assert.equal(row.db, 'runvara_outcome_test'); assert.equal(row.role, 'postgres'); assert.equal(row.listen, '127.0.0.1');
  assert.ok(row.version >= 170000 && row.version < 180000); assert.equal(root.connection.stream.remoteAddress, '127.0.0.1');
  console.log('LEDGER_NATIVE_SAFETY=' + JSON.stringify({...row, disposable: true, providerCalls: 0, productionActivation: false}));
});
beforeEach(async () => {
  database = 'runvara_ledger_test_' + randomUUID().replaceAll('-', ''); await root.query('CREATE DATABASE ' + database);
  child = new URL(url); child.pathname = '/' + database; admin = await connect('postgres');
  assert.equal((await admin.query("SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace")).rows[0].n, 0);
  let fixture = await readFile(new URL('./atomic-usage-postgres-fixture.sql', import.meta.url), 'utf8');
  for (const name of ['anon', 'authenticated', 'service_role', 'atomic_usage_untrusted']) {
    const existing = (await admin.query('SELECT rolsuper,rolcanlogin,rolbypassrls FROM pg_roles WHERE rolname=$1', [name])).rows[0];
    if (existing) {assert.deepEqual(existing, {rolsuper: false, rolcanlogin: false, rolbypassrls: name === 'service_role'}); fixture = fixture.replace(new RegExp('create role ' + name + ' [^;]+;'), '');}
  }
  await admin.query(fixture);
  for (const name of ['schema.sql', 'migrations/20261007074031_reporting_status_cas.sql', 'prepared/synthetic-meta-receipts.sql', 'prepared/synthetic-meta-observations.sql', 'prepared/meta-publication-ledger-v1.sql', 'prepared/meta-publication-delivery-v1.sql', 'prepared/meta-publication-readiness-v1.sql']) await admin.query(await readFile(new URL('../supabase/' + name, import.meta.url), 'utf8'));
});
afterEach(async () => {await Promise.all([...clients].map(close)); if (database) {await root.query('DROP DATABASE ' + database); console.log('LEDGER_NATIVE_DATABASE_DROPPED=' + database); database = null;}});
after(async () => {await root?.end();});
import {flowFixture} from './meta-publication-flow-fixture.mjs';
import {prepareMetaAssetFixture, commitMetaAsset, metaAssetDescriptor, readMetaAsset, serveMetaAssetFixture} from '../lib/meta-publication-delivery.mjs';
import {executeMetaSingleImageFixture, readMetaSingleImageFixture} from '../lib/meta-publication-flow.mjs';
import {prepareMetaLedgerCommand} from '../lib/meta-publication-ledger.mjs';
import {observeMetaReadinessFixture} from '../lib/meta-publication-readiness.mjs';
const assetRpcNames = ['runvara_commit_meta_asset_v1', 'runvara_read_meta_asset_v1', 'runvara_deliver_meta_asset_v1'];
const rpcNames = [...assetRpcNames, 'runvara_commit_meta_readiness_v1', 'runvara_read_meta_readiness_v1', 'runvara_commit_meta_ledger_v1', 'runvara_lookup_meta_ledger_v1', 'runvara_read_meta_ledger_v1'];
const queryRpc = (name, raw, role = 'service_role') => {
  assert.ok(rpcNames.includes(name));
  return using(role, c => c.query('SELECT public.' + name + '($1::text) value', [typeof raw === 'string' ? raw : JSON.stringify(raw)]).then(r => r.rows[0].value));
};
async function nativeFlow(t) {
  const f = await flowFixture(t, {rpc: async (name, body) => Response.json(await queryRpc(name, body.p_request)), seed: async f => {
    const state = await f.get();
    await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
    await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId, state]);
    await admin.query("UPDATE public.runvara_meta_asset_control_v1 SET mode='fixture'");
    await admin.query("UPDATE public.runvara_meta_ledger_control_v1 SET mode='fixture'");
    // Native test persistence adapter: actual conditional JSONB writes and the
    // existing DB writer barrier. This does not claim hosted PostgREST coverage.
    f.store = {
      get: async workspace => using('service_role', c => c.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [workspace]).then(r => r.rows[0]?.state)),
      save: async (workspace, state, {beforeCommit = () => {}} = {}) => {
        beforeCommit(state); const revision = state._revision;
        const next = {...structuredClone(state), _revision: randomUUID()}; beforeCommit(next);
        const saved = await using('service_role', c => c.query("UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1 AND state->>'_revision'=$3 RETURNING state", [workspace, next, revision]).then(r => r.rows[0]?.state));
        assert.ok(saved, 'native CAS failed'); state._revision = saved._revision; return saved;
      }
    };
    f.get = () => f.store.get(f.workspaceId);
    f.change = async change => {const current = await f.get(); change(current); return f.store.save(f.workspaceId, current);};
  }});
  f.rawAsset = () => structuredClone(f.calls.find(c => c.name === 'runvara_commit_meta_asset_v1').r);
  return f;
}
test('native delivery and approval-to-two-phase flow retain exact bytes and immutable outcomes after reopen', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  const outcome = await f.execute(); assert.equal(outcome.resultId, '900002'); assert.equal(outcome.executedExternally, false);
  assert.equal(f.providerCalls.filter(c => c.options.method === 'POST').length, 2);
  const row = (await admin.query('SELECT bytes,descriptor FROM public.runvara_meta_assets_v1')).rows[0];
  assert.deepEqual(row.bytes, f.bytes); assert.deepEqual(row.descriptor, f.descriptor);
  const cap = await readMetaAsset({workspaceId: f.workspaceId, assetId: f.descriptor.assetId, digest: metaLedgerDigest(f.descriptor)}, f.session, {request: f.rpc, loadFreshState: f.load});
  const response = await serveMetaAssetFixture({digest: metaLedgerDigest(metaAssetDescriptor(cap)), token: f.token}, {request: f.rpc});
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1')).rows[0].n, 5);
  f.composition = f.compose(); assert.equal((await f.execute()).resultId, '900002'); assert.equal(f.providerCalls.filter(c => c.options.method === 'POST').length, 2);
  assert.equal((await f.get()).connectionWrites?.length || 0, 0);
});
test('native prepared/paused modes, live origins and forged provenance cannot open delivery', async t => {
  const f = await nativeFlow(t), raw = f.rawAsset();
  for (const mode of ['prepared', 'paused']) {
    await admin.query('UPDATE public.runvara_meta_asset_control_v1 SET mode=$1', [mode]);
    await assert.rejects(queryRpc('runvara_commit_meta_asset_v1', raw), rejected('P0A03'));
    await assert.rejects(queryRpc('runvara_deliver_meta_asset_v1', {contract: raw.contract, digest: metaLedgerDigest(f.descriptor), token: f.token}), rejected('P0A03'));
  }
  await admin.query("UPDATE public.runvara_meta_asset_control_v1 SET mode='fixture'");
  for (const patch of [{origin: 'https://packsmart-ops.onrender.com'}, {provenance: 'production'}, {providerDeliveryVerified: true}]) {
    await assert.rejects(queryRpc('runvara_commit_meta_asset_v1', {...raw, descriptor: {...raw.descriptor, ...patch}}), rejected('P0A01'));
  }
});
test('native direct table access and helper execution are denied; immutable rows cannot be deleted or replaced', async t => {
  const f = await nativeFlow(t);
  for (const role of ['anon', 'authenticated', 'service_role']) await using(role, async c => {
    for (const table of ['runvara_meta_assets_v1', 'runvara_meta_asset_control_v1', 'runvara_meta_readiness_v1']) for (const verb of ['SELECT * FROM', 'DELETE FROM', 'TRUNCATE'])
      await assert.rejects(c.query(verb + ' public.' + table), rejected('42501'));
    await assert.rejects(c.query('SELECT public.runvara_meta_asset_ledger_guard_v1()'), rejected('42501'));
    await assert.rejects(c.query('SELECT public.runvara_meta_readiness_ledger_guard_v1()'), rejected('42501'));
    await assert.rejects(c.query('SELECT public.runvara_meta_readiness_ack_v1(null,false)'), rejected('42501'));
    if (role !== 'service_role') for (const name of [...assetRpcNames, 'runvara_commit_meta_readiness_v1', 'runvara_read_meta_readiness_v1']) await assert.rejects(c.query('SELECT public.' + name + '(\'{}\')'), rejected('42501'));
  });
  await assert.rejects(admin.query('UPDATE public.runvara_meta_assets_v1 SET bytes=bytes'), rejected('P0M05'));
  await assert.rejects(admin.query('DELETE FROM public.runvara_meta_assets_v1'), rejected('P0M05'));
  await assert.rejects(admin.query('TRUNCATE public.runvara_meta_assets_v1'), rejected('P0M05'));
  await assert.rejects(admin.query('TRUNCATE public.runvara_meta_readiness_v1'), rejected('P0M05'));
  assert.equal(f.providerCalls.length, 0);
});
test('native exact replay, conflicting request, byte digest, duplicate keys and cross-tenant reads', async t => {
  const f = await nativeFlow(t), raw = f.rawAsset();
  const results = await Promise.all([queryRpc('runvara_commit_meta_asset_v1', raw), queryRpc('runvara_commit_meta_asset_v1', raw)]);
  assert.ok(results.every(r => r.replayed));
  const modified = structuredClone(raw); modified.descriptor.tokenDigest = 'b'.repeat(64);
  await assert.rejects(queryRpc('runvara_commit_meta_asset_v1', modified), rejected('P0A04'));
  await assert.rejects(queryRpc('runvara_commit_meta_asset_v1', {...raw, bytesBase64: Buffer.alloc(f.bytes.length).toString('base64')}), rejected('P0A01'));
  await assert.rejects(queryRpc('runvara_commit_meta_asset_v1', JSON.stringify(raw).replace('"expiresAt":', '"expiresAt":1,"expiresAt":')), rejected('P0A01'));
  await assert.rejects(queryRpc('runvara_read_meta_asset_v1', {contract: raw.contract, workspaceId: 'another-tenant', assetId: f.descriptor.assetId, digest: metaLedgerDigest(f.descriptor), actor: f.descriptor.actor}), rejected('P0L02'));
  assert.equal(await queryRpc('runvara_deliver_meta_asset_v1', {contract: raw.contract, digest: metaLedgerDigest(f.descriptor), token: 'a'.repeat(64)}), null);
});
test('native asset expiry, paused control and fabricated delivery prevent ledger reservation', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  const state = await f.get(), original = structuredClone(f.binding);
  const raw = b => JSON.parse(metaLedgerCommandBody(prepareMetaLedgerCommand(state, b, f.session,
    {kind: 'reserve', phase: 'proposal', requestId: b.requestId, expectedHead: null, admissionDigest: null, data: {}})).p_request);
  await admin.query("UPDATE public.runvara_meta_asset_control_v1 SET mode='paused'");
  await assert.rejects(commit(raw(original)), rejected('P0A03'));
  await admin.query("UPDATE public.runvara_meta_asset_control_v1 SET mode='fixture'");
  // Owner-seeded historical expiry is a fixture, not elapsed/provider evidence.
  await admin.query('ALTER TABLE public.runvara_meta_assets_v1 DISABLE TRIGGER runvara_meta_assets_immutable');
  await admin.query("UPDATE public.runvara_meta_assets_v1 SET expires_at=clock_timestamp()-interval '1 second'");
  await admin.query('ALTER TABLE public.runvara_meta_assets_v1 ENABLE TRIGGER runvara_meta_assets_immutable');
  await assert.rejects(commit(raw(original)), rejected('P0A04'));
  assert.equal(await queryRpc('runvara_deliver_meta_asset_v1', {contract: f.descriptor.contract, digest: metaLedgerDigest(f.descriptor), token: f.token}), null);
  const last = (await admin.query('SELECT last_clock FROM public.runvara_meta_asset_control_v1')).rows[0].last_clock; assert.ok(last);
  await admin.query("UPDATE public.runvara_meta_asset_control_v1 SET last_clock=clock_timestamp()+interval '1 hour'");
  await assert.rejects(queryRpc('runvara_deliver_meta_asset_v1', {contract: f.descriptor.contract, digest: metaLedgerDigest(f.descriptor), token: f.token}), rejected('P0A03'));
});
test('native owner revocation closes byte disclosure but preserves admitted publication result', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  f.providerHook = async p => {if (p.endsWith('/media_publish')) {await f.change(s => s.users[0].disabled = true); return Response.json({id: '900002'});}};
  await assert.rejects(f.execute());
  const row = (await admin.query("SELECT event FROM public.runvara_meta_ledger_events_v1 WHERE kind='settle' AND phase='publish'")).rows[0];
  assert.equal(row.event.data.resultId, '900002');
  await assert.rejects(readMetaSingleImageFixture(f.composition, f.binding, f.session));
  await assert.rejects(queryRpc('runvara_deliver_meta_asset_v1', {contract: f.descriptor.contract, digest: metaLedgerDigest(f.descriptor), token: f.token}), rejected('P0L02'));
});
test('native competing executions retain permanent admission and at most one transport per phase', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  await Promise.allSettled([f.execute(), f.execute()]);
  for (const phase of ['container', 'publish']) assert.ok((await admin.query("SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1 WHERE kind='admit' AND phase=$1", [phase])).rows[0].n <= 1);
  assert.ok(f.providerCalls.filter(c => c.p.endsWith('/media')).length <= 1); assert.ok(f.providerCalls.filter(c => c.p.endsWith('/media_publish')).length <= 1);
  assert.equal((await f.execute()).resendPermitted, false);
});
test('native lost admission ACK and process replacement cannot send the held phase', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  f.afterRpc = (name, raw, response) => {if (name === 'runvara_commit_meta_ledger_v1' && raw.kind === 'admit') throw Error('ACK lost'); return response;};
  await f.execute(); assert.equal(f.providerCalls.length, 0); f.afterRpc = null; f.composition = f.compose();
  await f.execute(); assert.equal(f.providerCalls.length, 0);
  assert.equal((await admin.query("SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1 WHERE kind='admit'")).rows[0].n, 1);
});
test('native storage capacity is permanent and bounded; expiry does not reclaim identities', async t => {
  const f = await nativeFlow(t);
  // Explicit owner-seeded capacity fixtures; no claims of 15 provider actions.
  await admin.query("INSERT INTO public.runvara_meta_assets_v1 SELECT workspace_id,asset_id||n,request_id||n,descriptor,encode(sha256(convert_to(digest||n,'UTF8')),'hex'),bytes,created_at,clock_timestamp()-interval '1 hour' FROM public.runvara_meta_assets_v1 CROSS JOIN generate_series(1,15) n");
  const cmd = await prepareMetaAssetFixture(f.campaignId, f.selection, f.session, f.bytes, {...f.assetOptions, requestId: 'another-asset-request'}, {loadFreshState: f.load});
  await assert.rejects(commitMetaAsset(cmd, {request: f.rpc, loadFreshState: f.load}));
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_assets_v1')).rows[0].n, 16);
});
test('native extension preserves existing PNG ledger fixture compatibility and its closed provenance', async t => {
  const f = await ledgerFixture(t);
  await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
  await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId, f.state]);
  await admin.query("UPDATE public.runvara_meta_ledger_control_v1 SET mode='fixture'");
  const response = await commit(f.raw()); assert.equal(response.transportPermitted, false);
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_assets_v1')).rows[0].n, 0);
});
test('native non-ready container cannot consume publication admission; cadence persists after restart', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  f.providerHook = p => p === '/900001' ? Response.json({id: '900001', status_code: 'IN_PROGRESS'}) : undefined;
  await f.execute(); assert.equal(f.providerCalls.filter(c => c.options.method === 'POST').length, 1);
  const head = (await admin.query('SELECT event_digest FROM public.runvara_meta_ledger_events_v1 ORDER BY sequence DESC LIMIT 1')).rows[0].event_digest;
  const state = await f.get();
  const raw = JSON.parse(metaLedgerCommandBody(prepareMetaLedgerCommand(state, f.binding, f.session, {kind: 'admit', phase: 'publish', requestId: 'direct-publish-readiness-check', expectedHead: head, admissionDigest: null, data: {}})).p_request);
  await assert.rejects(commit(raw), rejected('P0R04'));
  const readRaw = f.calls.find(c => c.name === 'runvara_commit_meta_readiness_v1' && c.r.kind === 'admit').r;
  await assert.rejects(queryRpc('runvara_commit_meta_readiness_v1', {...readRaw, requestId: 'readiness-too-soon'}), rejected('P0R03'));
  const count = f.providerCalls.length; f.composition = f.compose(); await f.execute(); assert.equal(f.providerCalls.length, count);
  assert.equal((await admin.query("SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1 WHERE kind='admit' AND phase='publish'")).rows[0].n, 0);
});
test('native uncertain readiness keeps shared account hold and later exact settlement survives revocation', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  f.providerHook = p => p === '/900001' ? new Response('unparseable', {headers: {'content-type': 'application/json'}}) : undefined;
  await assert.rejects(f.execute());
  const held = (await admin.query("SELECT * FROM public.runvara_meta_readiness_v1 WHERE kind='admit'")).rows[0];
  const state = await f.get(), head = (await admin.query('SELECT event_digest FROM public.runvara_meta_ledger_events_v1 ORDER BY sequence DESC LIMIT 1')).rows[0].event_digest;
  const raw = JSON.parse(metaLedgerCommandBody(prepareMetaLedgerCommand(state, f.binding, f.session, {kind: 'admit', phase: 'publish', requestId: 'direct-publish-held-check', expectedHead: head, admissionDigest: null, data: {}})).p_request);
  await assert.rejects(commit(raw), rejected('P0R03'));
  const readRaw = f.calls.find(c => c.name === 'runvara_commit_meta_readiness_v1').r;
  await f.change(s => s.users[0].disabled = true);
  const late = await queryRpc('runvara_commit_meta_readiness_v1', {...readRaw, kind: 'settle', requestId: 'native-late-ready-result', expectedState: null, admissionDigest: held.digest, statusCode: 'FINISHED'});
  assert.equal(JSON.parse(late.eventText).statusCode, 'FINISHED');
  await assert.rejects(f.execute());
  await assert.rejects(admin.query('DELETE FROM public.runvara_meta_readiness_v1'), rejected('P0M05'));
});
test('native wrong container, altered approval and duplicate readiness keys fail without dispatch', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  f.providerHook = p => p === '/900001' ? Response.json({id: '1234', status_code: 'FINISHED'}) : undefined;
  await assert.rejects(f.execute());
  assert.equal((await admin.query("SELECT count(*)::int n FROM public.runvara_meta_readiness_v1 WHERE kind='settle'")).rows[0].n, 0);
  const raw = f.calls.find(c => c.name === 'runvara_commit_meta_readiness_v1').r;
  await assert.rejects(queryRpc('runvara_commit_meta_readiness_v1', JSON.stringify(raw).replace('"kind":"admit"', '"kind":"admit","kind":"admit"')), rejected('P0R01'));
  await f.change(s => s.approvals[0].decisionNote = 'changed under same revision');
  await assert.rejects(queryRpc('runvara_commit_meta_readiness_v1', {...raw, requestId: 'changed-readiness-decision', expectedState: await f.get()}), rejected('P0R04'));
});

// These contract tests use existing PNG proposals to isolate the new shared
// admission boundary from JPEG transport. No provider is called by this helper.
async function boundaryFixture(t, account = '101') {
  const f = await ledgerFixture(t, account);
  await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
  await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId, f.state]);
  await admin.query("UPDATE public.runvara_meta_ledger_control_v1 SET mode='fixture'");
  f.rpc = async (name, body) => Response.json(await queryRpc(name, body.p_request));
  f.run = async command => f.accept(await commitMetaLedgerCommand(command, {request: f.rpc}));
  f.reserve = () => f.run(f.command());
  f.admit = phase => f.run(f.command('admit', phase));
  f.settle = (proof, resultId = null) => f.run(prepareMetaLedgerSettlement(proof, 'settle-' + randomUUID(), metaLedgerFixtureOutcome(proof.event.phase, resultId)));
  f.container = async id => {await f.reserve(); const a = await f.admit('container'); await f.settle(a, id);};
  f.readyRaw = () => ({contract: 'runvara-meta-container-readiness/v1', workspaceId: f.workspaceId, writeId: f.binding.writeId,
    requestId: 'ready-' + randomUUID(), kind: 'admit', actor: f.raw().actor, binding: f.binding, expectedState: f.state, admissionDigest: null, statusCode: null});
  return f;
}
const readinessCommit = raw => queryRpc('runvara_commit_meta_readiness_v1', raw);
const readinessSettle = (raw, admission, statusCode = 'FINISHED') => readinessCommit({...raw, kind: 'settle', requestId: 'settle-' + randomUUID(), expectedState: null, admissionDigest: admission.digest, statusCode});

test('native readiness and legacy admission share global two/account one holds in both orders', async t => {
  const fs = await Promise.all(['101', '102', '103', '104', '102', '101'].map(a => boundaryFixture(t, a)));
  for (const [i, f] of fs.entries()) {
    if ([0, 3, 4].includes(i)) await f.reserve(); else await f.container(String(910000 + i));
  }
  // Readiness first: an older executor cannot take its account's slot.
  const raw = fs[1].readyRaw(), first = await readinessCommit(raw);
  await assert.rejects(commit(fs[4].raw('admit', 'container')), rejected('P0R03'));
  const legacy = await fs[0].admit('container');
  await assert.rejects(readinessCommit(fs[2].readyRaw()), rejected('P0R03'));
  await assert.rejects(commit(fs[3].raw('admit', 'container')), rejected('P0R03'));
  await readinessSettle(raw, first); await fs[0].settle(legacy, '919999');
  // Legacy first: readiness cannot take its account's slot, then must count
  // the second global slot held through the other contract as well.
  const older = await fs[0].admit('publish');
  await assert.rejects(readinessCommit(fs[5].readyRaw()), rejected('P0R03'));
  const nextRaw = fs[2].readyRaw(), next = await readinessCommit(nextRaw);
  await assert.rejects(commit(fs[3].raw('admit', 'container')), rejected('P0R03'));
  assert.equal(JSON.parse(next.eventText).attempt, 1);
  await readinessSettle(nextRaw, next); await fs[0].settle(older);
});

test('native concurrent readiness admissions serialize across independent connections', async t => {
  const fs = await Promise.all(['201', '202', '203'].map(a => boundaryFixture(t, a)));
  for (const [i, f] of fs.entries()) await f.container(String(920000 + i));
  const results = await Promise.allSettled(fs.map(f => readinessCommit(f.readyRaw())));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.code === 'P0R03').length, 1);
  assert.equal((await admin.query("SELECT count(*)::int n FROM public.runvara_meta_readiness_v1 WHERE kind='admit'")).rows[0].n, 2);
});

test('native readiness rejects an old repeatable-read snapshot after another admission', async t => {
  const a = await boundaryFixture(t, '301'), b = await boundaryFixture(t, '302');
  await a.container('930001'); await b.container('930002');
  const stale = await connect(); await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await stale.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [a.workspaceId]);
  await readinessCommit(b.readyRaw());
  await assert.rejects(stale.query('SELECT public.runvara_commit_meta_readiness_v1($1) value', [JSON.stringify(a.readyRaw())]), rejected('40001'));
  await stale.query('ROLLBACK');
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_readiness_v1 WHERE workspace_id=$1', [a.workspaceId])).rows[0].n, 0);
});

// Owner-only historical fixtures for native clock/budget assertions. They are
// not elapsed-time or provider-call evidence. Keep canonical event bytes and
// dependent settlement identities consistent when aging a readiness admission.
async function ageReadiness(workspaceId, seconds = 61, settlementSeconds = seconds) {
  const rows = (await admin.query('SELECT * FROM public.runvara_meta_readiness_v1 WHERE workspace_id=$1 ORDER BY kind', [workspaceId])).rows;
  const replacements = new Map(), now = Date.now();
  await admin.query('ALTER TABLE public.runvara_meta_readiness_v1 DISABLE TRIGGER runvara_meta_readiness_immutable');
  try {
    for (const row of rows) {
      const event = {...row.event, at: new Date(now - 1000 * (row.kind === 'admit' ? seconds : settlementSeconds)).toISOString()};
      if (row.kind === 'settle') event.admissionDigest = replacements.get(row.admission_digest);
      const digest = metaLedgerDigest(event); replacements.set(row.digest, digest);
      await admin.query('UPDATE public.runvara_meta_readiness_v1 SET event=$1,event_text=$2,digest=$3,at=$4,admission_digest=$5 WHERE digest=$6',
        [event, metaLedgerText(event), digest, event.at, event.admissionDigest, row.digest]);
    }
  } finally {await admin.query('ALTER TABLE public.runvara_meta_readiness_v1 ENABLE TRIGGER runvara_meta_readiness_immutable');}
}

test('native JPEG publish requires present fresh readiness; a late FINISHED settlement cannot renew it', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  f.beforeRpc = name => {if (name === 'runvara_commit_meta_readiness_v1') throw Error('stop before readiness');};
  await assert.rejects(f.execute()); f.beforeRpc = null;
  const head = (await admin.query('SELECT event_digest FROM public.runvara_meta_ledger_events_v1 ORDER BY sequence DESC LIMIT 1')).rows[0].event_digest;
  const publish = JSON.parse(metaLedgerCommandBody(prepareMetaLedgerCommand(await f.get(), f.binding, f.session,
    {kind: 'admit', phase: 'publish', requestId: 'direct-freshness-publish', expectedHead: head, admissionDigest: null, data: {}})).p_request);
  await assert.rejects(commit(publish), rejected('P0R04'));
  const raw = f.calls.find(c => c.name === 'runvara_commit_meta_readiness_v1').r;
  const admitted = await readinessCommit(raw); await readinessSettle(raw, admitted);
  await ageReadiness(f.workspaceId, 61, 0); // old GET, recently settled result
  await assert.rejects(commit(publish), rejected('P0R04'));
  await ageReadiness(f.workspaceId, 61, 61); // both old
  await assert.rejects(commit(publish), rejected('P0R04'));
  assert.equal(f.providerCalls.filter(c => c.options.method === 'POST').length, 1);
  assert.equal((await admin.query("SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1 WHERE phase='publish'")).rows[0].n, 0);
});

test('native non-ready restart after cadence reuses the container and performs only the remaining publication', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  f.providerHook = p => p === '/900001' ? Response.json({id: '900001', status_code: 'IN_PROGRESS'}) : undefined;
  await f.execute(); await ageReadiness(f.workspaceId);
  f.providerHook = null; f.composition = f.compose();
  assert.equal((await f.execute()).resultId, '900002');
  assert.equal(f.providerCalls.filter(c => c.p.endsWith('/media')).length, 1);
  assert.equal(f.providerCalls.filter(c => c.p.endsWith('/media_publish')).length, 1);
  assert.equal((await admin.query("SELECT count(*)::int n FROM public.runvara_meta_readiness_v1 WHERE kind='admit'")).rows[0].n, 2);
});

test('native shared lifetime debt caps readiness plus legacy reads at five even after cooldown', async t => {
  const f = await boundaryFixture(t); await f.container('940001');
  const originalRaw = f.readyRaw(), original = await readinessCommit(originalRaw); await readinessSettle(originalRaw, original);
  // Three canonical historical readiness admissions, settled by the real RPC.
  // These owner-seeded rows are debt fixtures, not three actual GET requests.
  for (let i = 0; i < 3; i++) {
    const event = {...JSON.parse(original.eventText), requestId: 'history-ready-' + i, attempt: i + 2,
      requestFingerprint: metaLedgerDigest({historical: i}), at: new Date(Date.now() - 61000).toISOString()};
    const digest = metaLedgerDigest(event);
    await admin.query("INSERT INTO public.runvara_meta_readiness_v1 VALUES($1,$2,$3,'admit',$4,null,$5,$6,$7,$8,$9,'meta:101:303')",
      [f.workspaceId, f.binding.writeId, event.requestId, event.attempt, event, metaLedgerText(event), digest, event.requestFingerprint, event.at]);
    await readinessSettle(originalRaw, {digest});
  }
  await ageReadiness(f.workspaceId); // All four are within the five-minute horizon.
  const p = await f.admit('publish'); await f.settle(p);
  const read = await f.admit('read'); await f.settle(read);
  await admin.query('ALTER TABLE public.runvara_meta_ledger_events_v1 DISABLE TRIGGER runvara_meta_ledger_events_immutable');
  try {await admin.query("UPDATE public.runvara_meta_ledger_events_v1 SET at=clock_timestamp()-interval '61 seconds' WHERE phase='read' AND kind='admit'");}
  finally {await admin.query('ALTER TABLE public.runvara_meta_ledger_events_v1 ENABLE TRIGGER runvara_meta_ledger_events_immutable');}
  await assert.rejects(commit(f.raw('admit', 'read')), rejected('P0R03'));
  const counts = (await admin.query("SELECT (SELECT count(*) FROM public.runvara_meta_readiness_v1 WHERE kind='admit')::int ready,(SELECT count(*) FROM public.runvara_meta_ledger_events_v1 WHERE phase='read' AND kind='admit')::int ledger")).rows[0];
  assert.deepEqual(counts, {ready: 4, ledger: 1});
});

test('native readiness counts older read cadence on the same account across tenants', async t => {
  const a = await boundaryFixture(t), b = await boundaryFixture(t);
  await a.container('950001'); await b.container('950002');
  const p = await a.admit('publish'); await a.settle(p); const read = await a.admit('read'); await a.settle(read);
  await assert.rejects(readinessCommit(b.readyRaw()), e => {assert.equal(e.code, 'P0R03'); assert.match(e.message, /BUDGET/); return true;});
});
