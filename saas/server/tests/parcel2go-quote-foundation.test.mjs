import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createParcel2GoQuoteFoundation, sealParcel2GoCredentials, captureParcel2GoToken } from '../lib/parcel2go-quote-foundation.mjs';
import { publicConnection, decryptCredentials } from '../lib/security.mjs';
import { CONNECTORS, connector } from '../lib/connection-centre.mjs';

const AT = Date.parse('2026-11-08T16:00:00.000Z');
const KEY = 'synthetic-only-encryption-key-0000000000';
const CLIENT = 'synthetic-client-0001', SECRET = 'synthetic-secret-0001', TOKEN = 'synthetic-token-0001';
const REV = '11111111-1111-4111-8111-111111111111', REQUEST = '22222222-2222-4222-8222-222222222222';
const BINDING = { workspaceId: 'packsmart-solutions', connectionId: 'synthetic-connection', accountId: 'synthetic-account', environment: 'sandbox' };
const iso = x => new Date(x).toISOString();
function fixture() {
  let now = AT, calls = 0, callback;
  const auth = { state: { _revision: REV, workspace: { id: 'packsmart-solutions' }, users: [{ id: 'synthetic-owner', role: 'owner', active: true, sessionVersion: 4, passwordChangeRequired: false }] },
    session: { workspaceId: 'packsmart-solutions', sub: 'synthetic-owner', sessionVersion: 4, exp: AT / 1000 + 3600 } };
  const value = { clientId: CLIENT, clientSecret: SECRET, token: captureParcel2GoToken({ access_token: TOKEN, token_type: 'Bearer', expires_in: 7200 }, { sentAt: iso(AT - 1000), receivedAt: iso(AT) }) };
  const envelope = sealParcel2GoCredentials({ auth, trustedBinding: BINDING, value, key: KEY, now });
  const input = { operation: 'quote', requestId: REQUEST, expectedRevision: REV, collectionCountry: 'GBR', deliveryCountry: 'GBR', parcel: {
    measurementId: 'synthetic-measurement-001', measuredAt: iso(AT - 2000), provenance: 'measured_packed_parcel', weightGrams: '250.000', lengthMm: '200', widthMm: '100', heightMm: '50', declaredValueDecimal: '12.30', currency: 'GBP' } };
  const result = p => ({ schema: 'runvara-parcel2go-quote-fixture/v1', requestId: p.requestId, parcelFingerprint: p.parcelFingerprint, observedAt: iso(now), quotes: [{ serviceCode: 'SYNTHETIC_SERVICE', amountDecimal: '4.20', currency: 'GBP', tax: 'unknown', expiresAt: null }] });
  const adapter = createParcel2GoQuoteFoundation({ mode: 'offline-fixture/v1', trustedBinding: BINDING, now: () => now, fixtureQuote: async p => {
    calls++; const serialized = JSON.stringify(p); for (const secret of [CLIENT, SECRET, TOKEN, KEY, envelope.encryptedCredentials]) assert.ok(!serialized.includes(secret));
    return callback ? callback(p) : result(p);
  } });
  const args = { auth, input, envelope, key: KEY };
  return { auth, value, input, envelope, adapter, args, result, run: () => adapter.quote(args), calls: () => calls, setNow: t => { now = t; }, respond: cb => { callback = cb; } };
}
const rejects = (f, code) => assert.rejects(f, e => e.code === 'PARCEL2GO_' + code && ![TOKEN, SECRET, CLIENT, KEY].some(s => JSON.stringify({ message: e.message, stack: e.stack }).includes(s)));

test('default off never invokes fixture or reads credential getters', async () => {
  let called = false; const adapter = createParcel2GoQuoteFoundation({ fixtureQuote: () => { called = true; } });
  await rejects(() => adapter.quote({ get envelope() { throw Error('must not read'); } }), 'DISABLED');
  assert.equal(called, false); assert.equal(adapter.status().enabled, false);
});
for (const mode of ['enabled/v1', 'live', 'sandbox', true, null]) test(`unreleased mode ${mode} refused`, () => assert.throws(() => createParcel2GoQuoteFoundation({ mode }), /preparation stopped/));
test('fixture mode requires explicit test transport; no fetch default', () => assert.throws(() => createParcel2GoQuoteFoundation({ mode: 'offline-fixture/v1', trustedBinding: BINDING }), e => e.code === 'PARCEL2GO_FIXTURE_REQUIRED'));
test('synthetic quote preserves decimals and unknown expiry/tax; grants no action', async () => {
  const f = fixture(), before = JSON.stringify(f.args), result = await f.run();
  assert.equal(f.calls(), 1); assert.equal(JSON.stringify(f.args), before);
  assert.equal(result.quotes[0].amountDecimal, '4.20'); assert.equal(result.quotes[0].expiresAt, null); assert.equal(result.quotes[0].tax, 'unknown');
  assert.equal(result.synthetic, true); assert.equal(result.liveReady, false); assert.equal(result.purchaseAllowed, false); assert.equal(result.deliveryGuaranteed, false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.quotes[0]));
});
test('public status contains no secret or credential envelope, all operations closed', () => {
  const f = fixture(), status = f.adapter.status();
  for (const k of ['enabled', 'liveReady', 'providerEnforcedReadOnlyScope', 'tokenExchange', 'orders', 'payment', 'labels', 'tracking', 'webhooks', 'automaticSync']) assert.equal(status[k], false);
  for (const x of [TOKEN, SECRET, CLIENT, KEY, f.envelope.encryptedCredentials]) assert.ok(!JSON.stringify(status).includes(x));
});
test('existing encryption roundtrip binds tenant/account/environment inside ciphertext', () => {
  const f = fixture(), decoded = decryptCredentials(f.envelope.encryptedCredentials, KEY);
  assert.deepEqual(decoded.binding, BINDING); assert.equal(decoded.credentials.clientSecret, SECRET);
  assert.ok(!JSON.stringify(f.envelope).includes(SECRET)); assert.ok(!JSON.stringify(f.envelope).includes(TOKEN));
  const dto = JSON.stringify(publicConnection(f.envelope)); for (const x of [TOKEN, SECRET, CLIENT, f.envelope.encryptedCredentials]) assert.ok(!dto.includes(x));
});
test('encryption uses unique IV for same synthetic input', () => {
  const f = fixture(); const second = sealParcel2GoCredentials({ auth: f.auth, trustedBinding: BINDING, value: f.value, key: KEY, now: AT });
  assert.notEqual(second.encryptedCredentials, f.envelope.encryptedCredentials);
});
for (const [name, change, code] of [
  ['nonowner', f => f.auth.state.users[0].role = 'member', 'OWNER_REQUIRED'],
  ['administrator', f => f.auth.state.users[0].role = 'admin', 'OWNER_REQUIRED'],
  ['revoked owner', f => f.auth.state.users[0].active = false, 'OWNER_REQUIRED'],
  ['password setup', f => f.auth.state.users[0].passwordChangeRequired = true, 'OWNER_REQUIRED'],
  ['session version', f => f.auth.session.sessionVersion = 3, 'OWNER_REQUIRED'],
  ['tenant', f => f.auth.session.workspaceId = 'other', 'OWNER_REQUIRED'],
  ['duplicate owner', f => f.auth.state.users.push({ ...f.auth.state.users[0] }), 'OWNER_REQUIRED'],
  ['expired session', f => f.auth.session.exp = AT / 1000, 'SESSION_EXPIRED'],
  ['stale revision', f => f.input.expectedRevision = REQUEST, 'STATE_CHANGED'],
  ['missing credentials', f => f.args.envelope = null, 'INPUT_INVALID'],
  ['wrong key', f => f.args.key = KEY + 'wrong', 'CREDENTIALS_INVALID'],
  ['short key', f => f.args.key = 'short', 'CREDENTIALS_INVALID'],
  ['tampered ciphertext', f => f.args.envelope = { ...f.envelope, encryptedCredentials: f.envelope.encryptedCredentials + 'x' }, 'CREDENTIALS_INVALID'],
  ['account mismatch', f => f.args.envelope = { ...f.envelope, accountId: 'other' }, 'BINDING_INVALID'],
  ['connection mismatch', f => f.args.envelope = { ...f.envelope, connectionId: 'other' }, 'BINDING_INVALID'],
  ['environment mismatch', f => f.args.envelope = { ...f.envelope, environment: 'live' }, 'BINDING_INVALID'],
  ['missing parcel', f => delete f.input.parcel, 'INPUT_INVALID'],
  ['inferred parcel', f => f.input.parcel.provenance = 'catalogue_estimate', 'MEASUREMENT_INVALID'],
  ['wrong weight unit', f => { f.input.parcel.weightKg = '1'; delete f.input.parcel.weightGrams; }, 'INPUT_INVALID'],
  ['stale measurement', f => f.input.parcel.measuredAt = iso(AT - 86400001), 'MEASUREMENT_STALE'],
  ['future measurement', f => f.input.parcel.measuredAt = iso(AT + 1), 'MEASUREMENT_STALE'],
  ['numeric weight', f => f.input.parcel.weightGrams = 250, 'MEASUREMENT_INVALID'],
  ['zero weight', f => f.input.parcel.weightGrams = '0', 'MEASUREMENT_INVALID'],
  ['exponential weight', f => f.input.parcel.weightGrams = '1e3', 'MEASUREMENT_INVALID'],
  ['oversize parcel', f => f.input.parcel.lengthMm = '10001', 'MEASUREMENT_INVALID'],
  ['unknown currency', f => f.input.parcel.currency = null, 'MEASUREMENT_INVALID'],
  ['amount float', f => f.input.parcel.declaredValueDecimal = 12.3, 'VALUE_INVALID'],
  ['negative value', f => f.input.parcel.declaredValueDecimal = '-1.00', 'VALUE_INVALID'],
  ['international', f => f.input.deliveryCountry = 'USA', 'INPUT_INVALID'],
  ['personal data injection', f => f.input.customerEmail = 'synthetic@example.invalid', 'INPUT_INVALID'],
  ['endpoint override', f => f.input.url = 'https://example.invalid', 'INPUT_INVALID']
]) test(`before fixture: ${name}`, async () => { const f = fixture(); change(f); await rejects(f.run, code); assert.equal(f.calls(), 0); });
for (const operation of ['order', 'payment', 'label', 'fulfilment', 'webhook', 'tracking', 'token', 'quote-and-pay']) test(`unsupported ${operation} before credential access`, async () => {
  const f = fixture(); f.input.operation = operation; f.args.envelope = null; await rejects(f.run, 'OPERATION_UNSUPPORTED'); assert.equal(f.calls(), 0);
});
test('encrypted binding cannot be relabelled to another account', async () => {
  const f = fixture(); const swapped = sealParcel2GoCredentials({ auth: f.auth, trustedBinding: { ...BINDING, accountId: 'another-account' }, value: f.value, key: KEY, now: AT });
  f.args.envelope = { ...swapped, accountId: BINDING.accountId }; await rejects(f.run, 'BINDING_INVALID'); assert.equal(f.calls(), 0);
});
test('client credentials without token remain sealed but cannot quote', async () => {
  const f = fixture(); f.args.envelope = sealParcel2GoCredentials({ auth: f.auth, trustedBinding: BINDING, value: { ...f.value, token: null }, key: KEY, now: AT });
  await rejects(f.run, 'TOKEN_REQUIRED'); assert.equal(f.calls(), 0);
});
test('expired token never invokes transport or renewal', async () => { const f = fixture(); f.setNow(AT + 7200000); f.auth.session.exp += 10000; await rejects(f.run, 'TOKEN_EXPIRED'); assert.equal(f.calls(), 0); });
for (const scope of ['payment', 'public-api payment', 'my-profile', 'public-api my-profile', '']) test(`token scope ${scope || 'empty'} rejected`, () => {
  assert.throws(() => captureParcel2GoToken({ access_token: TOKEN, token_type: 'Bearer', expires_in: 7200, scope }, { sentAt: iso(AT), receivedAt: iso(AT) }), e => e.code === 'PARCEL2GO_TOKEN_INVALID');
});
for (const expires_in of [0, -1, 1.5, '7200', 86401, null]) test(`invalid provider lifetime ${expires_in}`, () => assert.throws(() => captureParcel2GoToken({ access_token: TOKEN, token_type: 'Bearer', expires_in }, { sentAt: iso(AT), receivedAt: iso(AT) })));
test('returned lifetime used without fixed two-hour assumption', () => { const t = captureParcel2GoToken({ access_token: TOKEN, token_type: 'Bearer', expires_in: 90, scope: 'public-api' }, { sentAt: iso(AT), receivedAt: iso(AT + 15000) }); assert.equal(t.expiresAt, iso(AT + 90000)); });
test('token received at expiry rejected', () => assert.throws(() => captureParcel2GoToken({ access_token: TOKEN, token_type: 'Bearer', expires_in: 1 }, { sentAt: iso(AT), receivedAt: iso(AT + 1000) })));
for (const [name, change, code = 'QUOTE_INVALID'] of [
  ['wrong schema', r => r.schema = 'provider-response'], ['request mismatch', r => r.requestId = REV], ['parcel mismatch', r => r.parcelFingerprint = 'wrong'],
  ['duplicate service', r => r.quotes.push({ ...r.quotes[0] })], ['negative price', r => r.quotes[0].amountDecimal = '-1.00'],
  ['number price', r => r.quotes[0].amountDecimal = 4.2], ['wrong currency', r => r.quotes[0].currency = 'USD'], ['invented tax', r => r.quotes[0].tax = 'assumed'],
  ['expired quote', r => r.quotes[0].expiresAt = iso(AT)], ['future capture', r => r.observedAt = iso(AT + 1)], ['stale capture', r => r.observedAt = iso(AT - 1)],
  ['unbounded options', r => r.quotes = Array.from({ length: 51 }, (_, i) => ({ ...r.quotes[0], serviceCode: 'CODE_' + i }))],
  ['provider body secret', r => r.access_token = TOKEN, 'INPUT_INVALID'], ['checkout URL', r => r.quotes[0].url = 'https://example.invalid', 'INPUT_INVALID']
]) test(`fixture response: ${name}`, async () => { const f = fixture(); f.respond(p => { const r = f.result(p); change(r); return r; }); await rejects(f.run, code); await rejects(f.run, 'ATTEMPT_SPENT'); assert.equal(f.calls(), 1); });
test('fixture error cannot leak body/token; attempt stays spent', async () => { const f = fixture(); f.respond(() => { throw Error(TOKEN + SECRET); }); await rejects(f.run, 'FIXTURE_OUTCOME_UNKNOWN'); await rejects(f.run, 'ATTEMPT_SPENT'); assert.equal(f.calls(), 1); });
test('concurrent duplicate is fenced before second await', async () => {
  const f = fixture(); let release; f.respond(p => new Promise(r => { release = () => r(f.result(p)); }));
  const first = f.run(); await rejects(f.run, 'ATTEMPT_SPENT'); release(); await first; assert.equal(f.calls(), 1);
});
for (const kind of ['revoked', 'revision', 'expired', 'late', 'backward']) test(`in-flight ${kind} fails closed`, async () => {
  const f = fixture(); f.respond(p => { const r = f.result(p); if (kind === 'revoked') f.auth.state.users[0].active = false;
    if (kind === 'revision') f.auth.state._revision = REQUEST;
    if (kind === 'expired') f.auth.session.exp = AT / 1000;
    if (kind === 'late') f.setNow(AT + 300000);
    if (kind === 'backward') f.setNow(AT - 1); return r; });
  await assert.rejects(f.run); assert.equal(f.calls(), 1);
});
test('getters are rejected without invocation', async () => { const f = fixture(); let reads = 0; Object.defineProperty(f.input.parcel, 'weightGrams', { enumerable: true, get() { reads++; return '250'; } }); await rejects(f.run, 'INPUT_INVALID'); assert.equal(reads, 0); });
test('prototype-bearing input rejected', async () => { const f = fixture(); f.input.parcel = Object.assign(Object.create({ hidden: true }), f.input.parcel); await rejects(f.run, 'INPUT_INVALID'); });
test('sparse quotes rejected', async () => { const f = fixture(); f.respond(p => ({ ...f.result(p), quotes: new Array(1) })); await rejects(f.run, 'INPUT_INVALID'); });
test('fingerprint changes with measurements and account binding is included', async () => {
  const a = fixture(), b = fixture(); let first, second; a.respond(p => { first = p.parcelFingerprint; return a.result(p); }); b.input.parcel.weightGrams = '251'; b.respond(p => { second = p.parcelFingerprint; return b.result(p); }); await a.run(); await b.run(); assert.notEqual(first, second);
});
test('existing connector registry stays unchanged and rejects Parcel2Go', () => { assert.equal(Object.hasOwn(CONNECTORS, 'parcel2go'), false); assert.throws(() => connector('parcel2go')); });
test('no production wiring, network primitive, log or environment activation', () => {
  const source = fs.readFileSync(new URL('../lib/parcel2go-quote-foundation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|node:https|node:http|console\.|process\.env|\.writeFile|\.save\(/);
  for (const file of ['../server.mjs', '../lib/integrations.mjs', '../lib/startup-mode.mjs']) assert.ok(!fs.readFileSync(new URL(file, import.meta.url), 'utf8').includes('parcel2go-quote-foundation'));
});
