// Explicit native disposable PostgreSQL proof; excluded from *.test.mjs.
import assert from 'node:assert/strict';
import {before, beforeEach, afterEach, after, test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID, createHash} from 'node:crypto';
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
  console.log('PRODUCTION_NATIVE_SAFETY=' + JSON.stringify({...row, disposable: true, providerCalls: 0, productionActivation: false}));
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
  for (const name of ['schema.sql', 'migrations/20261007074031_reporting_status_cas.sql', 'prepared/meta-production-v1.sql']) await admin.query(await readFile(new URL('../supabase/' + name, import.meta.url), 'utf8'));
});
afterEach(async () => {await Promise.all([...clients].map(close)); if (database) {await root.query('DROP DATABASE ' + database); console.log('PRODUCTION_NATIVE_DATABASE_DROPPED=' + database); database = null;}});
after(async () => {await root?.end();});

import {productionFixture} from './meta-production-fixture.mjs';
import {metaLedgerDigest, metaLedgerText} from '../lib/meta-production-ledger.mjs';
const assetRpcNames = ['runvara_commit_meta_prod_asset_v1', 'runvara_read_meta_prod_asset_v1', 'runvara_deliver_meta_prod_asset_v1'];
const rpcNames = [...assetRpcNames, 'runvara_commit_meta_prod_readiness_v1', 'runvara_read_meta_prod_readiness_v1', 'runvara_commit_meta_prod_ledger_v1', 'runvara_lookup_meta_prod_ledger_v1', 'runvara_read_meta_prod_ledger_v1'];
const queryRpc = (name, raw, role = 'service_role') => {
  assert.ok(rpcNames.includes(name));
  return using(role, c => c.query('SELECT public.' + name + '($1::text) value', [typeof raw === 'string' ? raw : JSON.stringify(raw)]).then(r => r.rows[0].value));
};
async function nativeFlow(t) {
  const f = await productionFixture(t, {rpc: async (name, body) => Response.json(await queryRpc(name, body.p_request)), seed: async f => {
    const state = await f.get();
    await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
    await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId, state]);
    await admin.query("UPDATE public.runvara_meta_prod_asset_control_v1 SET mode='active'");
    await admin.query("UPDATE public.runvara_meta_prod_ledger_control_v1 SET mode='active'");
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
  f.rawAsset = () => structuredClone(f.calls.find(c => c.name === 'runvara_commit_meta_prod_asset_v1').r);
  return f;
}
test('native production controller retains exact bytes, approval and publication result across restart', async t => {
  assert.deepEqual((await admin.query('SELECT mode FROM public.runvara_meta_prod_ledger_control_v1')).rows, [{mode: 'prepared'}]);
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  const result = await f.execute(); assert.equal(result.resultId, '900002');
  const a = (await admin.query('SELECT bytes,descriptor FROM public.runvara_meta_prod_assets_v1')).rows[0];
  assert.deepEqual(a.bytes, f.bytes); assert.equal(a.descriptor.provenance, 'server_meta_publication/production-v1');
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_prod_ledger_events_v1')).rows[0].n, 5);
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_prod_readiness_v1')).rows[0].n, 2);
  f.controller = f.reopen(); assert.equal((await f.read()).retained.resultId, '900002'); await f.execute();
  assert.equal(f.providerCalls.filter(c => c.options.method === 'POST').length, 2);
  assert.equal((await f.get()).connectionWrites?.length || 0, 0);
});

test('native pending approval already fences predecessor deletion, mutation, generic approval and legacy writes', async t => {
  const f = await nativeFlow(t); await f.prepare();
  const mutate = change => f.change(s => change(s, s.approvals.find(a => a.type === 'protected_meta_production_publication')));
  for (const change of [s => {s.approvals = [];}, (s,a) => {a.type = 'social_commerce_publish';}, (s,a) => {a.payload.binding.caption += '!';},
    (s,a) => {a.status = 'approved'; a.decidedBy = f.session.userId;},
    s => {(s.connectionWrites ||= []).push({id: 'legacy-collision', provider: 'meta', input: {instagramId: f.binding.target.instagramId, caption: f.binding.caption, imageUrl: f.binding.asset.url}});}]) {
    await assert.rejects(mutate(change), rejected('P0L05'));
  }
  await f.change(s => {(s.notifications ||= []).push({id: 'safe-unrelated-record'});});
  await f.approve(); await f.controller.decide(f.campaignId, f.body.requestId, {decision: 'rejected', consent: f.proposal.consent}, f.session);
  await assert.rejects(f.execute()); assert.equal(f.providerCalls.length, 0);
});

test('native production controls pause new work and delivery while exact retained review remains readable', async t => {
  const f = await nativeFlow(t); await f.prepare();
  const raw = f.rawAsset();
  for (const mode of ['prepared', 'paused']) {
    await admin.query('UPDATE public.runvara_meta_prod_asset_control_v1 SET mode=$1', [mode]);
    await assert.rejects(queryRpc('runvara_commit_meta_prod_asset_v1', raw), rejected('P0A03'));
    await assert.rejects(f.approve(), rejected('P0L03'));
    assert.equal((await f.controller.image(f.campaignId, f.body.requestId, f.session)).bytesBase64, f.body.jpegBase64);
  }
});

test('native production rejects fixture provenance, invalid origin, altered bytes and duplicate JSON', async t => {
  const f = await nativeFlow(t); await f.prepare(); const raw = f.rawAsset();
  for (const patch of [{origin: 'https://runvara.invalid'}, {provenance: 'native_fixture_no_provider_action/v1'}, {providerDeliveryVerified: true}]) {
    await assert.rejects(queryRpc('runvara_commit_meta_prod_asset_v1', {...raw, descriptor: {...raw.descriptor, ...patch}}), rejected('P0A01'));
  }
  await assert.rejects(queryRpc('runvara_commit_meta_prod_asset_v1', JSON.stringify(raw).replace('{', '{"contract":"duplicate",')), rejected('P0A01'));
  const altered = Buffer.from(f.bytes); altered[100] ^= 1;
  await assert.rejects(queryRpc('runvara_commit_meta_prod_asset_v1', {...raw, bytesBase64: altered.toString('base64')}), rejected('P0A01'));
});

test('native role boundaries deny direct tables and helpers; rows remain immutable', async t => {
  const f = await nativeFlow(t); await f.prepare();
  for (const role of ['anon', 'authenticated', 'service_role']) await using(role, async c => {
    for (const table of ['runvara_meta_prod_assets_v1', 'runvara_meta_prod_ledger_events_v1', 'runvara_meta_prod_readiness_v1']) {
      for (const verb of ['SELECT * FROM', 'DELETE FROM', 'TRUNCATE']) await assert.rejects(c.query(verb + ' public.' + table), rejected('42501'));
    }
    for (const expression of ["runvara_meta_prod_hash('{}'::jsonb)", "runvara_meta_prod_unique('{}'::json)", "runvara_meta_prod_canonical('{}'::jsonb)", 'runvara_meta_prod_approval_guard_v1()']) {
      await assert.rejects(c.query('SELECT public.' + expression), rejected('42501'));
    }
    if (role !== 'service_role') for (const name of rpcNames) await assert.rejects(c.query('SELECT public.' + name + '(\'{}\')'), rejected('42501'));
  });
  await assert.rejects(admin.query('DELETE FROM public.runvara_meta_prod_assets_v1'), rejected('P0M05'));
  await assert.rejects(admin.query('TRUNCATE public.runvara_meta_prod_assets_v1'), rejected('P0M05'));
});

test('native concurrent execution cannot duplicate either provider mutation', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  await Promise.allSettled([f.execute(), f.execute()]);
  for (const path of ['/303/media', '/303/media_publish']) assert.ok(f.providerCalls.filter(c => c.p === path).length <= 1);
  const reads = f.providerCalls.length; await f.read(); assert.equal(f.providerCalls.length, reads);
});

test('native current session revocation closes delivery and disclosure; admitted late result remains retained', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  f.providerHook = async path => {if (path === '/303/media') {await f.change(s => {s.users[0].sessionVersion += 1;}); return Response.json({id: '900001'});}};
  await assert.rejects(f.execute()); await assert.rejects(f.read());
  const rows = (await admin.query("SELECT event#>>'{data,resultId}' result FROM public.runvara_meta_prod_ledger_events_v1 WHERE kind='settle' AND phase='container'")).rows;
  assert.deepEqual(rows, [{result: '900001'}]); assert.equal(f.providerCalls.filter(c => c.p === '/303/media_publish').length, 0);
  const delivered = f.assetCalls[0].url.split('/');
  await assert.rejects(f.controller.deliver(delivered.at(-2), delivered.at(-1).replace(/\.jpg$/, '')));
});

test('native stale workspace between JS guard and SQL admission cannot make a provider call', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  f.beforeRpc = async (name, r) => {if (name === 'runvara_commit_meta_prod_ledger_v1' && r.kind === 'reserve') {f.beforeRpc = null; await f.change(s => {s.economics.BAGS.landed += 0.000001;});}};
  await assert.rejects(f.execute()); assert.equal(f.providerCalls.length, 0);
});

test('native delivery requires current exact approval, closes on revocation, and never grants anonymous database access', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve(); await f.execute();
  const parts = new URL(f.assetCalls[0].url).pathname.split('/'), digest = parts.at(-2), token = parts.at(-1).slice(0, -4);
  await f.controller.decide(f.campaignId, f.body.requestId, {decision: 'rejected', consent: f.proposal.consent}, f.session);
  const value = await queryRpc('runvara_deliver_meta_prod_asset_v1', {contract: 'runvara-meta-durable-asset/production-v1', digest, token});
  assert.equal(value, null); await assert.rejects(f.controller.deliver(digest, token));
});

test('native unresolved readiness survives restart and cannot offer or dispatch a continuation', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  f.providerHook = path => {if (path === '/900001') throw Error('synthetic lost readiness');};
  await assert.rejects(f.execute()); const count = f.providerCalls.length;
  f.controller = f.reopen(); const retained = (await f.read()).retained;
  assert.equal(retained.phase, 'readiness_unresolved'); assert.equal(retained.canContinue, false);
  assert.equal(retained.resultId, null); await f.execute(); assert.equal(f.providerCalls.length, count);
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_prod_readiness_v1')).rows[0].n, 1);
});

test('native retained budget includes first lifetime admission and shared ledger read debt', async t => {
  const f = await nativeFlow(t); await f.prepare(); await f.approve();
  f.beforeRpc = name => {if (name === 'runvara_commit_meta_prod_readiness_v1') throw Error('synthetic stop before first read');};
  await assert.rejects(f.execute()); f.beforeRpc = null;
  const source = f.calls.find(c => c.name === 'runvara_commit_meta_prod_readiness_v1').r;
  const now = Date.now(), legacyAt = new Date(now - 400000).toISOString();
  // Explicit owner-seeded historical rows in the disposable database only.
  // No existing immutable row, system clock or production data is changed.
  const prior = (await admin.query("SELECT * FROM public.runvara_meta_prod_ledger_events_v1 WHERE kind='admit' AND phase='container'")).rows[0];
  const event = {...prior.event, requestId: 'synthetic-historical-ledger-read', sequence: 4, phase: 'read', at: legacyAt};
  await admin.query(`INSERT INTO public.runvara_meta_prod_ledger_events_v1
    (workspace_id,write_id,sequence,request_id,kind,phase,admission_digest,event_digest,request_fingerprint,event_text,event,at,account_key)
    VALUES($1,$2,4,$3,'admit','read',null,$4,$5,$6,$7,$8,$9)`,
  [f.workspaceId, f.binding.writeId, event.requestId, metaLedgerDigest(event), event.requestFingerprint, metaLedgerText(event), event, legacyAt, prior.account_key]);
  const {expectedState, ...operation} = source;
  for (const [attempt, age] of [[2, 301000], [3, 240000]]) {
    const admission = {contract: source.contract, provenance: 'server_meta_publication/production-v1', workspaceId: f.workspaceId,
      writeId: f.binding.writeId, requestId: 'synthetic-history-' + attempt, kind: 'admit', actor: source.actor,
      bindingDigest: metaLedgerDigest(f.binding), containerId: '900001', attempt, admissionDigest: null, statusCode: null,
      approvalDigest: prior.event.approvalDigest, at: new Date(now - age).toISOString(), requestFingerprint: metaLedgerDigest(operation), providerReadPerformed: false};
    const settlement = {...admission, requestId: admission.requestId + '.settle', kind: 'settle', admissionDigest: metaLedgerDigest(admission),
      statusCode: 'IN_PROGRESS', at: new Date(now - age + 1).toISOString(), providerReadPerformed: true};
    for (const row of [admission, settlement]) await admin.query(`INSERT INTO public.runvara_meta_prod_readiness_v1
      (workspace_id,write_id,request_id,kind,attempt,admission_digest,event,event_text,digest,fingerprint,at,account_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [f.workspaceId, f.binding.writeId, row.requestId, row.kind, row.attempt, row.admissionDigest, row, metaLedgerText(row), metaLedgerDigest(row), row.requestFingerprint, row.at, prior.account_key]);
  }
  const request = {contract: source.contract, workspaceId: f.workspaceId, writeId: f.binding.writeId, bindingDigest: metaLedgerDigest(f.binding), actor: source.actor};
  const retained = await queryRpc('runvara_read_meta_prod_readiness_v1', request);
  assert.deepEqual(retained.budget, {attempts: 3, firstAt: legacyAt, lastAt: new Date(now - 240000).toISOString()});
  const count = f.providerCalls.length, view = (await f.read()).retained;
  assert.equal(view.phase, 'readiness_budget_closed'); assert.equal(view.canContinue, false);
  await f.execute(); assert.equal(f.providerCalls.length, count);
});
