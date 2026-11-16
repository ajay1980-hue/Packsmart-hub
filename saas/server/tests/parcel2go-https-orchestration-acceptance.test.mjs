import assert from 'node:assert/strict';
import test from 'node:test';
import https from 'node:https';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fixture } from './parcel2go-live-integrated-fixture.mjs';
import { CLIENT, SECRET_VALUE, TOKEN, KEY, quoteBody } from './parcel2go-sandbox-fixture.mjs';
import { createParcel2GoLiveOrchestration } from '../lib/parcel2go-live-orchestration.mjs';
import { parcel2GoCanonicalHash as hash } from '../lib/parcel2go-live-canonical.mjs';

// Exercise the existing native HTTPS branch, not its mockRequest branch. Every
// request is intercepted before a socket exists. The saved credentials, account,
// state and responses all come from existing synthetic, in-memory fixtures.
async function setup(t, responseFor = () => ({})) {
  t.mock.method(net.Socket.prototype, 'connect', () => assert.fail('Socket creation forbidden'));
  t.mock.method(globalThis, 'fetch', () => assert.fail('Uninjected fetch forbidden'));
  const f = await fixture(), calls = [];
  t.mock.method(https, 'request', (url, options, callback) => {
    const call = { url: String(url), options, body: null, destroyed: false };
    calls.push(call);
    const request = new EventEmitter();
    request.destroy = () => { call.destroyed = true; };
    request.end = body => {
      call.body = body;
      queueMicrotask(() => {
        const operation = url.pathname.endsWith('/token') ? 'token' : 'quote';
        const spec = responseFor(operation, f) || {};
        if (spec.reset) { request.emit('error', new Error('Synthetic response lost')); return; }
        const data = spec.body ?? (operation === 'token'
          ? { access_token: TOKEN, token_type: 'Bearer', scope: 'public-api', expires_in: 3600 }
          : quoteBody());
        const bytes = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
        const response = new PassThrough();
        response.statusCode = spec.status ?? 200;
        response.headers = { 'content-type': 'application/json', 'content-length': String(bytes.length) };
        response.complete = true;
        callback(response);
        if (!response.destroyed) {
          // Real stream boundary, including a response split across chunks.
          const split = Math.floor(bytes.length / 2);
          response.write(bytes.subarray(0, split)); response.end(bytes.subarray(split));
        }
      });
    };
    return request;
  });
  const workspaceId = f.config.trustedBinding.workspaceId;
  const state = await f.store.get(workspaceId, { exactSnapshot: true });
  const connection = state.connections.find(row => row.id === f.config.trustedBinding.connectionId);
  const receipt = state.parcel2goLiveQuoteRuns.find(row => row.requestId === f.config.credentialAdmissionRequestId);
  assert.equal(receipt.status, 'completed');
  assert.equal(hash(receipt), f.config.expectedCredentialReceiptHash);
  assert.equal(receipt.connectionHash, hash(connection));
  const saved = structuredClone(f.fake.states.get(workspaceId));
  const args = {
    input: f.args.input, expectedPlanFingerprint: f.config.inputFingerprint,
    auth: { state, session: f.session }, trustedBinding: f.config.trustedBinding,
    envelope: { schema: 'runvara-parcel2go-live-credentials/v1', binding: f.config.trustedBinding,
      encryptedCredentials: connection.encryptedCredentials },
    key: KEY, expectedClientId: CLIENT, requestId: f.config.requestId, expiresAt: f.config.expiresAt,
    assertCurrent: f.config.assertCurrent,
    // Mirrors the existing admission's exact reread checkpoint. This test does
    // not create a production approval adapter or a durable live quote claim.
    refreshCurrent: async () => assert.deepEqual(await f.store.get(workspaceId, { exactSnapshot: true }), state)
  };
  const config = { mode: 'approved-https-orchestration/v1', expectedSessionFingerprint: hash(f.session),
    now: f.config.now, monotonic: f.config.monotonic };
  const make = extra => createParcel2GoLiveOrchestration({ ...config, ...extra });
  const runner = make(); t.after(() => runner.close()); f.calls.length = 0;
  return { f, calls, args, make, runner, saved, workspaceId };
}

function redacted(value) {
  const text = JSON.stringify(value);
  for (const secret of [CLIENT, SECRET_VALUE, TOKEN, KEY]) assert.equal(text.includes(secret), false);
}
const writes = f => f.calls.filter(call => call.settings.method === 'PATCH');

test('saved synthetic envelope reaches native token/quote wire and strict response parser without sockets', async t => {
  const { f, calls, args, runner, saved, workspaceId } = await setup(t);
  const out = await runner.run(args);
  assert.deepEqual(calls.map(call => call.url), [
    'https://www.parcel2go.com/auth/connect/token', 'https://www.parcel2go.com/api/quotes'
  ]);
  const form = Object.fromEntries(new URLSearchParams(calls[0].body));
  assert.deepEqual(form, { grant_type: 'client_credentials', scope: 'public-api', client_id: CLIENT, client_secret: SECRET_VALUE });
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].body), {
    CollectionAddress: { Country: 'GBR', VatStatus: 'NotRegistered', Postcode: 'SW1A 1AA' },
    DeliveryAddress: { Country: 'GBR', VatStatus: 'Individual', Postcode: 'M1 1AE' },
    Parcels: [{ Weight: 5, Length: 45, Width: 30, Height: 25, Value: 15.15 }]
  });
  for (const call of calls) {
    assert.equal(call.options.method, 'POST'); assert.equal(call.options.agent, false);
    assert.equal(call.options.rejectUnauthorized, true); assert.equal(call.options.minVersion, 'TLSv1.2');
    assert.equal(call.options.headers['Content-Length'], Buffer.byteLength(call.body));
    assert.equal(call.options.headers.Cookie, undefined);
  }
  assert.equal(out.result.responseSource, 'live-http', 'native branch marker; all I/O is mocked in this test');
  assert.equal(out.result.liveReady, false); assert.equal(out.result.purchaseAllowed, false);
  assert.equal(out.result.priceGuaranteed, false); assert.equal(out.result.deliveryGuaranteed, false);
  assert.equal(out.result.quotes[0].totalDecimal, '12.66');
  assert.equal(out.result.quotes[0].netDecimal, '10.55'); assert.equal(out.result.quotes[0].vatDecimal, '2.11');
  assert.equal(out.projectionHash, hash(out.result)); redacted(out);
  assert.equal(JSON.stringify(out).includes(args.envelope.encryptedCredentials), false);
  assert.equal(JSON.stringify(out).includes('<script>'), false);
  assert.deepEqual(f.fake.states.get(workspaceId), saved); assert.equal(writes(f).length, 0);
  await assert.rejects(runner.run(args)); assert.equal(calls.length, 2);
});

for (const [change, code] of [
  ['session', 'SESSION_BINDING_INVALID'], ['plan', 'INPUT_CHANGED'],
  ['tenant', 'BINDING_INVALID'], ['transport', 'CONFIG_INVALID']
]) {
  test(`native orchestration refuses mismatched ${change} before token dispatch`, async t => {
    const { calls, args, make } = await setup(t);
    const runner = make(change === 'session' ? { expectedSessionFingerprint: '0'.repeat(64) }
      : change === 'transport' ? { mockRequest: () => assert.fail('Injected transport used') } : {});
    t.after(() => runner.close());
    if (change === 'plan') args.expectedPlanFingerprint = '0'.repeat(64);
    if (change === 'tenant') args.trustedBinding = { ...args.trustedBinding, workspaceId: 'synthetic-other-tenant' };
    await assert.rejects(runner.run(args), { code: `PARCEL2GO_LIVE_${code}` });
    await assert.rejects(runner.run(args), { code: 'PARCEL2GO_LIVE_ATTEMPT_SPENT' }); assert.equal(calls.length, 0);
  });
}

for (const boundary of ['token', 'quote']) for (const change of ['owner', 'credential', 'expiry']) {
  test(`reread or deadline change after ${boundary} prevents completion: ${change}`, async t => {
    const { f, calls, args, runner } = await setup(t, (operation, f) => {
      if (operation === boundary) {
        const state = f.fake.states.get(f.config.trustedBinding.workspaceId);
        if (change === 'owner') state.users[0].active = false;
        if (change === 'credential') state.connections.find(row => row.provider === 'parcel2go-live').encryptedCredentials = 'synthetic-replaced';
        if (change === 'expiry') f.advance(300000);
      }
    });
    await assert.rejects(runner.run(args), { code: 'PARCEL2GO_LIVE_OUTCOME_UNKNOWN' });
    await assert.rejects(runner.run(args));
    assert.equal(calls.length, boundary === 'token' ? 1 : 2); assert.equal(writes(f).length, 0);
  });
}

for (const failure of ['issuer_401', 'invalid_token', 'quote_reset', 'quote_redirect', 'quote_totals', 'quote_secret']) {
  test(`native orchestration closes without retries or unsafe output: ${failure}`, async t => {
    const { f, calls, args, runner, saved, workspaceId } = await setup(t, operation => {
      if (operation === 'token' && failure === 'issuer_401') return { status: 401 };
      if (operation === 'token' && failure === 'invalid_token') return { body: '{invalid' };
      if (operation === 'quote' && failure === 'quote_reset') return { reset: true };
      if (operation === 'quote' && failure === 'quote_redirect') return { status: 302 };
      if (operation === 'quote' && failure === 'quote_totals') {
        const body = quoteBody(); body.Quotes[0].TotalPrice = 12.67; return { body };
      }
      if (operation === 'quote' && failure === 'quote_secret') {
        const body = quoteBody(); body.Quotes[0].Service.Slug = TOKEN; return { body };
      }
    });
    await assert.rejects(runner.run(args), error => {
      assert.equal(error.code, 'PARCEL2GO_LIVE_OUTCOME_UNKNOWN'); redacted({ message: error.message, code: error.code }); return true;
    });
    await assert.rejects(runner.run(args));
    assert.equal(calls.length, failure === 'issuer_401' || failure === 'invalid_token' ? 1 : 2);
    assert.equal(writes(f).length, 0); assert.deepEqual(f.fake.states.get(workspaceId), saved);
  });
}

test('native orchestration acceptance does not enable a durable live quote admission', async t => {
  const { f, calls } = await setup(t);
  assert.throws(() => f.make({ mode: 'approved-https-integrated/v1', mockRequest: undefined }));
  assert.equal(calls.length, 0); assert.equal(writes(f).length, 0);
});
