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
  for (const name of ['schema.sql', 'migrations/20261007074031_reporting_status_cas.sql', 'prepared/synthetic-meta-receipts.sql', 'prepared/synthetic-meta-observations.sql', 'prepared/meta-publication-ledger-v1.sql']) await admin.query(await readFile(new URL('../supabase/' + name, import.meta.url), 'utf8'));
});
afterEach(async () => {await Promise.all([...clients].map(close)); if (database) {await root.query('DROP DATABASE ' + database); console.log('LEDGER_NATIVE_DATABASE_DROPPED=' + database); database = null;}});
after(async () => {await root?.end();});
async function seed(t, account = '101', mode = 'fixture', dailyLimit = 2) {
  const f = await ledgerFixture(t, account, dailyLimit);
  await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
  await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId, f.state]);
  await admin.query('UPDATE public.runvara_meta_ledger_control_v1 SET mode=$1', [mode]);
  f.rpc = async (name, body) => {
    assert.ok(['runvara_commit_meta_ledger_v1', 'runvara_lookup_meta_ledger_v1', 'runvara_read_meta_ledger_v1'].includes(name));
    const result = await using('service_role', c => c.query('SELECT public.' + name + '($1::text) value', [body.p_request]));
    return Response.json(result.rows[0].value);
  };
  f.run = async command => f.accept(await commitMetaLedgerCommand(command, {request: f.rpc}));
  f.reserve = () => f.run(f.command());
  f.admit = phase => f.run(f.command('admit', phase));
  f.settle = (proof, resultId = null, status = null) => f.run(prepareMetaLedgerSettlement(proof, 'settle-' + randomUUID(), metaLedgerFixtureOutcome(proof.event.phase, resultId, status)));
  f.ready = async () => {await f.reserve(); const c = await f.admit('container'); await f.settle(c, '900001'); const p = await f.admit('publish'); await f.settle(p); return p;};
  f.save = () => admin.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, f.state]);
  return f;
}
test('prepared, paused and missing control refuse creation; fixture cannot claim provider provenance', async t => {
  const f = await seed(t, '101', 'prepared'); await deny(f.raw());
  await admin.query("UPDATE public.runvara_meta_ledger_control_v1 SET mode='paused'"); await deny(f.raw());
  await admin.query("UPDATE public.runvara_meta_ledger_control_v1 SET mode='fixture'");
  for (const provenance of ['live', 'runvara-synthetic-meta-receipts/v1', false]) await deny({...f.raw(), provenance});
  const proof = await f.reserve(); assert.equal(proof.transportPermitted, false); assert.equal(proof.executedExternally, false);
  await admin.query('DELETE FROM public.runvara_meta_ledger_control_v1'); await deny(f.raw());
});
test('service browser roles cannot directly alter ledger/control or execute helpers; owner is outside threat model', async t => {
  const f = await seed(t); const raw = f.raw();
  for (const role of ['anon', 'authenticated', 'service_role']) await using(role, async c => {
    for (const table of ['control', 'proposals', 'events']) {
      for (const operation of ['SELECT * FROM', 'DELETE FROM', 'TRUNCATE']) await assert.rejects(c.query(operation + ' public.runvara_meta_ledger_' + table + '_v1'), rejected('42501'));
    }
    await assert.rejects(c.query("SELECT public.runvara_meta_ledger_actor_v1('{}','{}','x')"), rejected('42501'));
    if (role !== 'service_role') await assert.rejects(commit(raw, c), rejected('42501'));
  });
  const proof = await f.reserve(); assert.equal(proof.event.sequence, 1);
  await assert.rejects(admin.query('UPDATE public.runvara_meta_ledger_events_v1 SET sequence=sequence'), rejected('P0M05'));
  await assert.rejects(admin.query('TRUNCATE public.workspaces CASCADE'), rejected('P0M05', 'P0L05'));
});
test('exact JSON and JS SQL parity; malformed booleans, duplicate keys, unsafe integers and binding changes reject', async t => {
  const f = await seed(t);
  const samples = [{caption: 'é 👩🏽‍💻 \\ " \n\t', value: null, yes: true, no: false, integer: 9007199254740991}, {z: [], a: {b: [1, -1, '雪']}}];
  for (const value of samples) assert.equal((await admin.query('SELECT public.runvara_meta_canonical($1::jsonb) value', [value])).rows[0].value, metaLedgerText(value));
  const raw = f.raw(); await deny(JSON.stringify(raw).replace('"kind":"reserve"', '"kind":"reserve","kind":"reserve"'));
  for (const mutate of [r => r.actor.sessionVersion = '1', r => r.actor.sessionVersion = 9007199254740992,
    r => r.binding.caption += 'changed', r => r.binding.asset.providerDeliveryVerified = 'false',
    r => r.binding.target.instagramId = 303, r => r.binding.actor.sessionVersion = null,
    r => r.binding.asset.sha256 = 'x'.repeat(64), r => r.expectedState._revision = 'stale']) {
    const changed = structuredClone(raw); mutate(changed); await deny(changed);
  }
  f.state.users[0].disabled = 'false'; await f.save(); await deny({...raw, expectedState: f.state});
});
test('identity and approval drift reject; exact source state is locked without overwriting it', async t => {
  const f = await seed(t); const raw = f.raw();
  for (const mutate of [s => s.users[0].sessionVersion++, s => s.approvals.at(-1).status = 'rejected',
    s => s.connections[0].metadata.assets.pages[0].instagram.id = '999', s => s.connectionSettings.meta.revision++,
    s => s.connections[0].metadata.grantedScopes = [], s => s.products[0].variants[0].inventory = 0]) {
    const current = structuredClone(f.state); mutate(current);
    await admin.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, current]); await deny(raw);
  }
  await f.save(); await f.reserve();
  const current = (await admin.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId])).rows[0].state;
  assert.deepEqual(current, f.state); assert.equal(current.connectionWrites.length, 0);
});
test('predecessor creation, exact-identity substitution, deletion, and stale repeatable-read writer are fenced', async t => {
  const f = await seed(t); const legacy = {id: 'legacy', requestId: 'other', provider: 'meta', input: {instagramId: f.binding.target.instagramId, caption: f.binding.caption, imageUrl: f.binding.asset.url}};
  const marked = structuredClone(f.state); marked.connectionWrites.push({id: 'new', metaLedgerCursor: {fake: true}});
  await assert.rejects(admin.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, marked]), rejected('P0L05'));
  for (const marker of [{schema: 'runvara-meta-publication-ledger/v2'}, {receiptContract: 'runvara-meta-receipts/v999'}]) {
    marked.connectionWrites = [{id: 'new', marketingPublication: marker}];
    await assert.rejects(admin.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, marked]), rejected('P0L05'));
  }
  f.state.connectionWrites.push(legacy); await f.save(); await deny(f.raw()); f.state.connectionWrites = []; await f.save();
  const older = await connect(); await older.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await older.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId]);
  await f.reserve();
  const next = structuredClone(f.state); next.connectionWrites.push(legacy);
  await assert.rejects(older.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, next]), rejected('40001'));
  await older.query('ROLLBACK');
  await assert.rejects(admin.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, next]), rejected('P0L05'));
  await assert.rejects(admin.query('DELETE FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId]), rejected('P0L05'));
  f.state.workspace.name = 'Unrelated permitted change'; await f.save();
});
test('phase order, exact container and immutable publication anchor; lost ACK only looks up and never resends', async t => {
  const f = await seed(t); await f.reserve(); await deny(f.raw('admit', 'publish'));
  const container = await f.admit('container'); await deny(f.raw('admit', 'container'));
  await f.settle(container, '900001'); const publishCommand = f.command('admit', 'publish'); const calls = [];
  const p = f.accept(await commitMetaLedgerCommand(publishCommand, {request: async (name, body) => {
    calls.push(name); const r = await f.rpc(name, body); if (name === 'runvara_commit_meta_ledger_v1') throw Error('ACK lost after commit'); return r;
  }}));
  assert.deepEqual(calls, ['runvara_commit_meta_ledger_v1', 'runvara_lookup_meta_ledger_v1']);
  assert.equal(p.recovered, true); assert.equal(p.transportPermitted, false); assert.equal(p.event.containerId, '900001');
  const duplicate = await f.run(publishCommand); assert.equal(duplicate.replayed, true); await deny(f.raw('admit', 'publish'));
  await f.settle(p); const read = await f.admit('read'); assert.equal(read.event.publicationAdmission, p.digest);
  const outcome = await f.settle(read, null, 'PUBLISHED'); assert.equal(outcome.event.data.resultId, null);
  assert.equal(outcome.event.data.outcome, 'unresolved_do_not_resend');
});
test('late settlement survives revocation and stale workspace state; conflicting outcomes reject atomically', async t => {
  const f = await seed(t); await f.reserve(); const c = await f.admit('container');
  const settle = prepareMetaLedgerSettlement(c, 'late-exact-settlement', metaLedgerFixtureOutcome('container', '900001'));
  f.state.users[0].disabled = true; f.state._revision = 'new-unrelated-revision'; f.state.workspace.name = 'Retain this'; await f.save();
  const before = JSON.stringify(f.state); const done = await f.run(settle); assert.equal(done.event.data.resultId, '900001');
  assert.deepEqual((await admin.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId])).rows[0].state, JSON.parse(before));
  const altered = JSON.parse(metaLedgerCommandBody(settle).p_request); altered.requestId = 'conflicting-result'; altered.data.resultId = '999999'; await deny(altered);
  const lookup = {contract: done.contract, workspaceId: f.workspaceId, writeId: f.binding.writeId, actor: f.binding.actor, requestId: done.event.requestId, requestFingerprint: done.event.requestFingerprint};
  await assert.rejects(f.rpc('runvara_lookup_meta_ledger_v1', {p_request: JSON.stringify(lookup)}), rejected('P0L02'));
  assert.equal((await admin.query("SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1 WHERE kind='settle'")).rows[0].n, 1);
});
test('recovery has fresh session, expected head, no permission/budget/hold release; late result remains retainable', async t => {
  const f = await seed(t); await f.ready(); const read = await f.admit('read');
  const data = {contract: META_LEDGER_RECOVERY, reason: 'fixture uncertain response', evidenceRef: 'local-native-case', action: 'close_unresolved_retain_hold'};
  const raw = f.raw('recover', 'read', data, read.digest); await deny({...raw, data: {...data, operator: true}});
  await deny({...raw, expectedHead: '0'.repeat(64)});
  f.state.users[0].sessionVersion = 2; await f.save(); await deny(raw); f.session.sessionVersion = 2;
  const recovery = await f.run(f.command('recover', 'read', data, read.digest)); assert.equal(recovery.event.actor.sessionVersion, 2); assert.equal(read.event.actor.sessionVersion, 1);
  await deny({...raw, actor: {userId: f.session.userId, sessionVersion: 2}, expectedHead: recovery.digest, requestId: 'recover-again'});
  const active = (await admin.query("SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1 a WHERE a.kind='admit' AND NOT EXISTS(SELECT 1 FROM public.runvara_meta_ledger_events_v1 s WHERE s.kind='settle' AND s.admission_digest=a.event_digest)")).rows[0].n; assert.equal(active, 1);
  const late = await f.settle(read, null, 'PUBLISHED'); assert.equal(late.event.previousDigest, recovery.digest);
  assert.equal(late.event.data.resultId, null); assert.equal(late.event.actor.sessionVersion, 1);
});
test('global/account concurrency is shared across workspaces; lock-wait uses fresh DB clock and backwards time fails closed', async t => {
  const fs = await Promise.all(['101', '102', '103'].map(a => seed(t, a)));
  for (const f of fs) await f.reserve();
  const lock = await connect('postgres'); await lock.query('BEGIN'); await lock.query('SELECT * FROM public.runvara_meta_ledger_control_v1 FOR UPDATE');
  const queued = fs[0].admit('container');
  await new Promise(resolve => setTimeout(resolve, 150));
  const released = (await lock.query('SELECT clock_timestamp() at')).rows[0].at; await lock.query('COMMIT');
  const first = await queued; assert.ok(new Date(first.event.at).valueOf() >= released.valueOf() - 1);
  const results = await Promise.allSettled(fs.slice(1).map(f => f.admit('container')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  await admin.query("UPDATE public.runvara_meta_ledger_control_v1 SET last_clock=clock_timestamp()+interval '1 hour'");
  await deny(fs[0].raw('admit', 'container'));
});
test('retained container cannot be adopted by an older writer under a different identity or workspace', async t => {
  const f = await seed(t), other = await seed(t, '102'); await f.reserve(); const c = await f.admit('container');
  const known = {id: 'legacy-foreign-id', provider: 'meta', input: {instagramId: '303', caption: 'different', imageUrl: 'https://example.test/changed.png'}, providerState: {containerId: '900001'}};
  other.state.connectionWrites.push(known); await other.save();
  const result = await f.settle(c, '900001'); assert.equal(result.event.containerConflict, true);
  assert.equal(result.event.data.resultId, '900001'); await deny(f.raw('admit', 'publish'));
  other.state.users[0].disabled = true; other.state.workspace.name = 'Unrelated collision update'; await other.save();
  other.state.connectionWrites.push(structuredClone(other.state.connectionWrites[0])); await assert.rejects(other.save(), rejected('P0L05')); other.state.connectionWrites.pop();
  other.state.connectionWrites[0].status = 'executing'; await assert.rejects(other.save(), rejected('P0L05'));
  other.state.connectionWrites = []; await other.save(); await deny(f.raw('admit', 'publish'));
  for (const target of [f, other]) {
    target.state.connectionWrites = [known]; await assert.rejects(target.save(), rejected('P0L05'));
    target.state.connectionWrites = [{...known, providerState: {}, dispatchClaim: {phases: {instagram_container: {resultId: '900001'}}}}];
    await assert.rejects(target.save(), rejected('P0L05')); target.state.connectionWrites = [];
  }
});
test('saved automatic consent works; disconnected and nested tenant markers fail at the SQL authority boundary', async t => {
  const f = await seed(t); f.state.connectionSettings.meta.permissionMode = 'automatic'; f.state.connectionSettings.meta.consent = {mode: 'automatic'};
  const b = buildMetaLedgerFixtureProposal(f.state, f.campaignId, f.selection, f.session, {environment: 'test',
    writeId: f.binding.writeId, requestId: f.binding.requestId, claimId: f.binding.claimId, approvalId: f.binding.approvalId,
    approvalRevision: 1, asset: {sha256: 'a'.repeat(64), byteLength: 321, mediaType: 'image/png', deliveryDigest: 'b'.repeat(64)}});
  Object.assign(f.binding, b); f.state.approvals.at(-1).payload.bindingDigest = metaLedgerDigest(b); await f.save();
  const raw = f.raw();
  for (const mutate of [s => s.connectionSettings.meta.disconnected = true,
    s => s.connectionSettings.meta.consent = {mode: 'automatic', tenant_id: 'another'},
    s => s.connections[0].metadata.assets.pages[0].workspaceId = 'another',
    s => s.connectionSettings.meta.consent.mode = 'manual']) {
    const state = structuredClone(f.state); mutate(state);
    await admin.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, state]);
    await deny({...raw, expectedState: state});
  }
  await f.save(); await f.reserve();
});
test('admission capacity includes earlier legacy daily reservations and permanently reserved rows', async t => {
  const f = await seed(t); const today = (await admin.query("SELECT to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD') recorded_day")).rows[0].recorded_day;
  f.state.connectionWrites = Array.from({length: f.binding.dailyLimit}, (_, i) => ({id: 'legacy-allowance-' + i, marketingPublication: {day: today}}));
  await f.save(); await deny(f.raw()); f.state.connectionWrites = []; await f.save();
  // Database-owner fixture seeds represent already retained historical rows.
  // No service grant can insert these and no caller clock is used for admission.
  await admin.query("INSERT INTO public.runvara_meta_ledger_proposals_v1(workspace_id,write_id,request_id,logical_key,binding,binding_digest,provenance,created_at) SELECT $1,'retained-'||n,'retained-request-'||n,'retained-key-'||n,$2,$3,'native_fixture_no_provider_action/v1',clock_timestamp()-interval '1 day' FROM generate_series(1,16) n", [f.workspaceId, f.binding, metaLedgerDigest(f.binding)]);
  await deny(f.raw()); assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_ledger_proposals_v1')).rows[0].n, 16);
});
test('global retention rejects before mutation and does not consume a partial reservation', async t => {
  const f = await seed(t);
  await admin.query("INSERT INTO public.runvara_meta_ledger_proposals_v1(workspace_id,write_id,request_id,logical_key,binding,binding_digest,provenance,created_at) SELECT $1,'global-fixture-'||n,'global-request-'||n,'global-key-'||n,$2,$3,'native_fixture_no_provider_action/v1',clock_timestamp()-interval '1 day' FROM generate_series(1,128) n", [f.workspaceId, f.binding, metaLedgerDigest(f.binding)]);
  const other = await seed(t, '102'); await deny(other.raw());
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_ledger_proposals_v1')).rows[0].n, 128);
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1')).rows[0].n, 0);
});
test('observation append failure rolls back settlement and preserves reserved capacity; paused mode still retains admitted outcomes', async t => {
  const f = await seed(t); await f.ready(); const read = await f.admit('read');
  const command = prepareMetaLedgerSettlement(read, 'observation-atomic-outcome', metaLedgerFixtureOutcome('read', null, 'PUBLISHED'));
  await admin.query("CREATE FUNCTION public.ledger_fixture_inject_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF new.kind='settle' AND new.phase='read' THEN RAISE EXCEPTION USING ERRCODE='P0T01',MESSAGE='fixture failure'; END IF; RETURN new; END $$; CREATE TRIGGER ledger_fixture_fail BEFORE INSERT ON public.runvara_meta_ledger_events_v1 FOR EACH ROW EXECUTE FUNCTION public.ledger_fixture_inject_failure()");
  const before = (await admin.query('SELECT barrier,last_clock FROM public.runvara_meta_ledger_control_v1')).rows[0];
  await assert.rejects(commit(metaLedgerCommandBody(command).p_request), rejected('P0T01'));
  assert.deepEqual((await admin.query('SELECT barrier,last_clock FROM public.runvara_meta_ledger_control_v1')).rows[0], before);
  assert.equal((await admin.query("SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1 WHERE kind='settle' AND phase='read'")).rows[0].n, 0);
  await admin.query("DROP TRIGGER ledger_fixture_fail ON public.runvara_meta_ledger_events_v1; DROP FUNCTION public.ledger_fixture_inject_failure(); UPDATE public.runvara_meta_ledger_control_v1 SET mode='paused'");
  const result = await f.run(command); assert.equal(result.event.data.statusCode, 'PUBLISHED');
});
test('account cadence is shared across tenants and settings revisions; five-minute horizon never refills attempts', async t => {
  const f = await seed(t); await f.ready(); const read = await f.admit('read'); await f.settle(read);
  await deny(f.raw('admit', 'read'));
  const other = await seed(t); await other.reserve(); const c = await other.admit('container'); await other.settle(c, '900002'); const p = await other.admit('publish'); await other.settle(p);
  await deny(other.raw('admit', 'read')); // Same Meta account/Instagram, different tenant.
  // Existing historical debt fixture: only the owner can bypass immutability;
  // model a read first admitted over five minutes ago without OS clock changes.
  await admin.query("ALTER TABLE public.runvara_meta_ledger_events_v1 DISABLE TRIGGER runvara_meta_ledger_events_immutable; UPDATE public.runvara_meta_ledger_events_v1 SET at=clock_timestamp()-interval '301 seconds' WHERE kind='admit' AND phase='read'; ALTER TABLE public.runvara_meta_ledger_events_v1 ENABLE TRIGGER runvara_meta_ledger_events_immutable");
  await deny(f.raw('admit', 'read')); // Cadence elapsed; closing horizon remains closed.
  const total = (await admin.query("SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1 WHERE kind='admit' AND phase='read'")).rows[0].n; assert.equal(total, 1);
});
test('fresh exact retained lookup accepts rotated owner session, rejects cross-tenant and revocation during await', async t => {
  const f = await seed(t); const command = f.command(); const reserved = await f.run(command);
  f.state.users[0].sessionVersion = 2; f.session.sessionVersion = 2; await f.save();
  const read = await readMetaLedgerDecision(command, f.session, {request: f.rpc, loadFreshState: async () => structuredClone(f.state)});
  assert.equal(read.digest, reserved.digest); assert.equal(read.event.actor.sessionVersion, 1);
  await assert.rejects(readMetaLedgerDecision(command, {...f.session, workspaceId: 'other'}, {request: f.rpc, loadFreshState: async () => f.state}), {code: 'META_LEDGER_AUTHORITY'});
  await assert.rejects(readMetaLedgerDecision(command, f.session, {request: async (...args) => {
    const response = await f.rpc(...args); f.state.users[0].disabled = true; await f.save(); return response;
  }, loadFreshState: async () => structuredClone(f.state)}), {code: 'META_LEDGER_AUTHORITY'});
});
test('canonical operation replay ignores JSON key order; same request ID with changed content conflicts', async t => {
  const f = await seed(t); const raw = f.raw(); const saved = await commit(raw);
  const reordered = Object.fromEntries(Object.entries(raw).reverse());
  reordered.binding = Object.fromEntries(Object.entries(raw.binding).reverse());
  const replay = await commit(reordered); assert.equal(replay.digest, saved.digest); assert.equal(replay.replayed, true); assert.equal(replay.transportPermitted, false);
  await deny({...raw, phase: 'publish'});
  const changed = structuredClone(raw); changed.binding.caption += 'changed'; await deny(changed);
});
test('recovery and late settlement serialize compatibly; acknowledgement replay never extends the read budget', async t => {
  const f = await seed(t); await f.ready(); const read = await f.admit('read');
  const data = {contract: META_LEDGER_RECOVERY, reason: 'native concurrent close', evidenceRef: 'native-race', action: 'close_unresolved_retain_hold'};
  const recovery = f.command('recover', 'read', data, read.digest), settle = prepareMetaLedgerSettlement(read, 'race-late-outcome', metaLedgerFixtureOutcome('read', null, 'PUBLISHED'));
  const results = await Promise.allSettled([commit(metaLedgerCommandBody(recovery).p_request), commit(metaLedgerCommandBody(settle).p_request)]);
  assert.equal(results[1].status, 'fulfilled');
  if (results[0].status === 'rejected') assert.ok(['P0L04'].includes(results[0].reason.code));
  else {const replay = await commit(metaLedgerCommandBody(recovery).p_request); assert.equal(replay.replayed, true); assert.equal(replay.transportPermitted, false);}
  const rows = (await admin.query("SELECT kind,event FROM public.runvara_meta_ledger_events_v1 WHERE admission_digest=$1 ORDER BY sequence", [read.digest])).rows;
  assert.equal(rows.filter(r => r.kind === 'settle').length, 1); assert.equal(rows.at(-1).event.data.resultId, null);
  assert.equal((await admin.query("SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1 WHERE kind='admit' AND phase='read'")).rows[0].n, 1);
});
test('fresh module can recover exact retained identity after restart, rotation and arbitrary workspace change without old command bytes', async t => {
  const f = await seed(t); const proof = await f.reserve(); const identity = {workspaceId: f.workspaceId, writeId: f.binding.writeId, requestId: proof.event.requestId, bindingDigest: metaLedgerDigest(f.binding)};
  f.state.users[0].sessionVersion = 2; f.session.sessionVersion = 2; f.state.workspace.name = 'Changed after restart'; f.state._revision = 'new-revision'; await f.save();
  const restarted = await import('../lib/meta-publication-ledger.mjs?restart-native=' + randomUUID());
  const retained = await restarted.readMetaLedgerRetained(identity, f.session, {request: f.rpc, loadFreshState: async () => structuredClone(f.state)});
  assert.equal(retained.digest, proof.digest); assert.equal(retained.event.actor.sessionVersion, 1); assert.equal(retained.transportPermitted, false);
  assert.throws(() => restarted.prepareMetaLedgerSettlement(retained, 'forged-restart-send', {}), {code: 'META_LEDGER_PROOF_REQUIRED'});
  await assert.rejects(restarted.readMetaLedgerRetained({...identity, bindingDigest: '0'.repeat(64)}, f.session, {request: f.rpc, loadFreshState: async () => f.state}));
});
test('approved decision changes under the same revision cannot authorize a later phase', async t => {
  const f = await seed(t); const reserved = await f.reserve();
  f.state.approvals.at(-1).decidedAt = '2026-10-19T00:00:00.000Z'; await f.save();
  await deny(f.raw('admit', 'container'));
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1')).rows[0].n, 1);
  assert.match(reserved.event.approvalDigest, /^[a-f0-9]{64}$/);
});
test('old reporting RPC retains unrelated updates; a predecessor row lock causes bounded refusal instead of a lock cycle', async t => {
  const f = await seed(t); const raw = f.raw(); const locked = await connect();
  await locked.query('BEGIN'); await locked.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1 FOR UPDATE', [f.workspaceId]);
  await assert.rejects(commit(raw), rejected('55P03'));
  await locked.query('UPDATE public.saas_workspace_state SET state=state WHERE workspace_id=$1', [f.workspaceId]); await locked.query('COMMIT');
  await f.reserve();
  const next = randomUUID(), report = {status: 'connected', detail: 'native coexistence', lastSyncAt: null, lastFailureAt: null, lastError: null, failures: []};
  const update = await using('service_role', c => c.query('SELECT * FROM public.runvara_commit_reporting_status($1,$2,$3,$4::jsonb,clock_timestamp())', [f.workspaceId, f.state._revision, next, report]));
  assert.equal(update.rowCount, 1);
  const state = (await admin.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId])).rows[0].state;
  assert.equal(state._revision, next); assert.deepEqual(state.integrationStatus.reporting, report); assert.deepEqual(state.connectionWrites, []);
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1')).rows[0].n, 1);
});
test('lifetime read-attempt debt survives historical-window expiry and cannot be replenished', async t => {
  const f = await seed(t); await f.ready(); const original = await f.admit('read'); await f.settle(original);
  // Owner-only historical fixture, explicitly not a claim of five provider
  // requests: construct canonical retained debt to test the native cap.
  for (let i = 0; i < 4; i++) {
    const head = (await admin.query('SELECT sequence,event_digest FROM public.runvara_meta_ledger_events_v1 WHERE workspace_id=$1 ORDER BY sequence DESC LIMIT 1', [f.workspaceId])).rows[0];
    const event = {...original.event, sequence: head.sequence + 1, requestId: 'historical-read-' + i, previousDigest: head.event_digest,
      requestFingerprint: createHash('sha256').update('historical-' + i).digest('hex')};
    const digest = metaLedgerDigest(event);
    await admin.query("INSERT INTO public.runvara_meta_ledger_events_v1 VALUES($1,$2,$3,$4,'admit','read',null,$5,$6,$7,$8,clock_timestamp()-interval '301 seconds','meta:101:303')", [f.workspaceId, f.binding.writeId, event.sequence, event.requestId, digest, event.requestFingerprint, metaLedgerText(event), event]);
    const raw = {...f.raw('settle', 'read', metaLedgerFixtureOutcome('read'), digest), requestId: 'historical-settle-' + i};
    const settled = await commit(raw); f.setHead(settled.digest);
  }
  const count = (await admin.query("SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1 WHERE kind='admit' AND phase='read'")).rows[0].n; assert.equal(count, 5);
  await deny(f.raw('admit', 'read'));
  assert.equal((await admin.query("SELECT count(*)::int n FROM public.runvara_meta_ledger_events_v1 WHERE kind='admit' AND phase='read'")).rows[0].n, 5);
});
test('ledger-first reservation prevents a predecessor from exceeding the shared daily allowance while preserving late outcomes', async t => {
  const f = await seed(t, '101', 'fixture', 1); await f.reserve();
  const today = (await admin.query("SELECT to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD') recorded_day")).rows[0].recorded_day;
  f.state.connectionWrites.push({id: 'different-legacy', provider: 'meta', status: 'pending_approval',
    input: {caption: 'different', imageUrl: 'https://example.test/different.png', instagramId: '303'},
    marketingPublication: {campaignId: 'other-campaign', day: today}});
  await assert.rejects(f.save(), rejected('P0L05')); f.state.connectionWrites = [];
  // JSONB can retain 1.0 from a generic writer even though JS serializes it 1.
  await admin.query("UPDATE public.saas_workspace_state SET state=jsonb_set(state,'{marketing,settings,dailyOrganicLimit}','1.0'::jsonb) WHERE workspace_id=$1", [f.workspaceId]);
  const legacy = {id: 'scaled-limit-legacy', marketingPublication: {day: today}};
  await assert.rejects(admin.query("UPDATE public.saas_workspace_state SET state=jsonb_set(state,'{connectionWrites}',$2::jsonb) WHERE workspace_id=$1", [f.workspaceId, JSON.stringify([legacy])]), rejected('P0L05'));
  f.state.workspace.name = 'Permitted unrelated update'; await f.save();
  const admitted = await f.admit('container'); assert.equal(admitted.event.phase, 'container'); await f.settle(admitted, '900001');
  assert.equal((await admin.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId])).rows[0].state.workspace.name, 'Permitted unrelated update');
});
