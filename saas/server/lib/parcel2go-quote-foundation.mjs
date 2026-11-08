// Offline foundation only: not registered as a provider or HTTP route. No fetch,
// token exchange, persistence or environment-based activation exists here.
import { createHash } from 'node:crypto';
import { encryptCredentials, decryptCredentials } from './security.mjs';
import { assertQuietOwnerWorkspace } from './quiet-owner-workspace.mjs';

const WORKSPACE = 'packsmart-solutions';
const SCHEMA = 'runvara-parcel2go-credentials/v1';
const fail = code => { throw Object.assign(new Error('Parcel2Go preparation stopped.'), { code: 'PARCEL2GO_' + code, status: 409 }); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const text = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(x);
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
function plain(value) {
  const seen = new Set(); let nodes = 0;
  function visit(x, depth) {
    if (++nodes > 5000 || depth > 20) fail('INPUT_INVALID');
    if (x === null || ['string', 'boolean'].includes(typeof x) || typeof x === 'number' && Number.isFinite(x)) return;
    if (typeof x !== 'object' || seen.has(x) || !Array.isArray(x) && !object(x)) fail('INPUT_INVALID');
    seen.add(x);
    for (const key of Reflect.ownKeys(x)) {
      if (Array.isArray(x) && key === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(x, key);
      if (typeof key !== 'string' || !Object.hasOwn(d, 'value') || !d.enumerable || key === '__proto__') fail('INPUT_INVALID');
      if (Array.isArray(x) && !/^(0|[1-9][0-9]*)$/.test(key)) fail('INPUT_INVALID');
      visit(d.value, depth + 1);
    }
    if (Array.isArray(x) && Object.keys(x).length !== x.length) fail('INPUT_INVALID');
    seen.delete(x);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 65536) fail('INPUT_INVALID');
}
function exact(x, names) {
  if (!object(x) || Object.keys(x).sort().join('|') !== names.split(' ').sort().join('|')) fail('INPUT_INVALID');
}
function time(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('TIME_INVALID');
  return Date.parse(value);
}
function actor(auth, now) {
  plain(auth);
  const s = auth?.session, users = auth?.state?.users;
  if (!text(s?.sub) || !Number.isSafeInteger(s?.sessionVersion) || s.sessionVersion < 1
    || !Array.isArray(users) || users.filter(u => u?.id === s.sub && u.active === true
      && u.sessionVersion === s.sessionVersion).length !== 1) fail('OWNER_REQUIRED');
  try { assertQuietOwnerWorkspace(auth, { inspectEvidence: false }); } catch { fail('OWNER_REQUIRED'); }
  if (!Number.isSafeInteger(now) || !Number.isFinite(auth.session.exp) || auth.session.exp * 1000 <= now) fail('SESSION_EXPIRED');
}

// Pure, bounded mapper input; no credentials, persistence or transport.
export function prepareParcel2GoQuote(input, trustedBinding, now, {syntheticOnly=false}={}) {
  return intent(input, binding(trustedBinding), now, syntheticOnly);
}
function binding(value) {
  plain(value); exact(value, 'workspaceId connectionId accountId environment');
  if (value.workspaceId !== WORKSPACE || !text(value.connectionId) || !text(value.accountId) || value.environment !== 'sandbox') fail('BINDING_INVALID');
  return Object.freeze({ ...value });
}
function sameBinding(a, b) { return ['workspaceId', 'connectionId', 'accountId', 'environment'].every(k => a[k] === b[k]); }
function secret(value) { return typeof value === 'string' && value.length >= 8 && value.length <= 4096 && !/[\x00-\x20\x7f]/.test(value); }
function credentials(value, now, requireToken) {
  plain(value); exact(value, 'clientId clientSecret token');
  if (!secret(value.clientId) || !secret(value.clientSecret)) fail('CREDENTIALS_INVALID');
  if (value.token === null) { if (requireToken) fail('TOKEN_REQUIRED'); return; }
  const t = value.token; exact(t, 'accessToken tokenType scopes issuedAt expiresAt');
  if (!secret(t.accessToken) || t.tokenType !== 'Bearer' || !Array.isArray(t.scopes) || t.scopes.length !== 1 || t.scopes[0] !== 'public-api') fail('TOKEN_INVALID');
  const issued = time(t.issuedAt), expires = time(t.expiresAt);
  if (issued > now || expires <= issued || expires <= now) fail('TOKEN_EXPIRED');
}

// Proposed server-only storage envelope. This function does not store anything.
// Trusted binding is authenticated inside the existing AES-256-GCM ciphertext.
// Never put this return value in bootstrap, ordinary DTOs, logs or exports.
export function sealParcel2GoCredentials({ auth, trustedBinding, value, key, now = Date.now() }) {
  actor(auth, now); const b = binding(trustedBinding); credentials(value, now, false);
  if (typeof key !== 'string' || key.length < 32) fail('KEY_REQUIRED');
  const encryptedCredentials = encryptCredentials({ schema: SCHEMA, binding: b, credentials: value }, key);
  return Object.freeze({ schema: SCHEMA, id: b.connectionId, provider: 'parcel2go', ...b, encryptedCredentials });
}
function open(envelope, expected, key, now) {
  plain(envelope); exact(envelope, 'schema id provider workspaceId connectionId accountId environment encryptedCredentials');
  if (envelope.schema !== SCHEMA || envelope.provider !== 'parcel2go' || envelope.id !== expected.connectionId || !sameBinding(envelope, expected)) fail('BINDING_INVALID');
  if (typeof key !== 'string' || key.length < 32 || typeof envelope.encryptedCredentials !== 'string') fail('CREDENTIALS_INVALID');
  let stored;
  try { stored = decryptCredentials(envelope.encryptedCredentials, key); } catch { fail('CREDENTIALS_INVALID'); }
  plain(stored); exact(stored, 'schema binding credentials');
  if (stored.schema !== SCHEMA || !sameBinding(binding(stored.binding), expected)) fail('BINDING_INVALID');
  credentials(stored.credentials, now, true);
  // No decrypted values leave this function, including to the fixture callback.
}

// Pure parser only. Sent-at anchors lifetime conservatively; no assumed TTL,
// automatic exchange or refresh. Output is secret and server-only until sealed.
export function captureParcel2GoToken(response, { sentAt, receivedAt }) {
  plain(response);
  const keys = Object.keys(response).sort().join('|');
  if (!['access_token|expires_in|token_type', 'access_token|expires_in|scope|token_type'].includes(keys)
    || !secret(response.access_token) || response.token_type !== 'Bearer'
    || !Number.isSafeInteger(response.expires_in) || response.expires_in <= 0 || response.expires_in > 86400
    || response.scope !== undefined && response.scope !== 'public-api') fail('TOKEN_INVALID');
  const sent = time(sentAt), received = time(receivedAt), expires = sent + response.expires_in * 1000;
  if (received < sent || received >= expires) fail('TOKEN_EXPIRED');
  return Object.freeze({ accessToken: response.access_token, tokenType: 'Bearer', scopes: Object.freeze(['public-api']), issuedAt: sentAt, expiresAt: new Date(expires).toISOString() });
}

function measured(value, maximum) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$/.test(value) || Number(value) <= 0 || Number(value) > maximum) fail('MEASUREMENT_INVALID');
}
function intent(input, b, now, syntheticOnly=false) {
  plain(input); exact(input, 'operation requestId expectedRevision collectionCountry deliveryCountry parcel');
  if (input.operation !== 'quote') fail('OPERATION_UNSUPPORTED');
  if (!uuid(input.requestId) || !uuid(input.expectedRevision) || input.collectionCountry !== 'GBR' || input.deliveryCountry !== 'GBR') fail('INPUT_INVALID');
  const p = input.parcel; exact(p, 'measurementId measuredAt provenance weightGrams lengthMm widthMm heightMm declaredValueDecimal currency');
  if (!text(p.measurementId) || p.provenance !== (syntheticOnly?'synthetic_fixture':'measured_packed_parcel') || p.currency !== 'GBP') fail('MEASUREMENT_INVALID');
  const at = time(p.measuredAt); if (at > now || now - at > 86400000) fail('MEASUREMENT_STALE');
  measured(p.weightGrams, 1000000); for (const k of ['lengthMm', 'widthMm', 'heightMm']) measured(p[k], 10000);
  if (typeof p.declaredValueDecimal !== 'string' || !/^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/.test(p.declaredValueDecimal)) fail('VALUE_INVALID');
  // These are internal safety bounds, NOT verified courier limits. Wire units,
  // required addresses and full provider schema remain a separate mapping gate.
  const prepared = { schema: 'runvara-parcel2go-quote-intent/v1', ...b, ...structuredClone(input) };
  const parcelFingerprint = createHash('sha256').update(JSON.stringify([b.workspaceId, b.connectionId, b.accountId, b.environment, input.collectionCountry, input.deliveryCountry,
    ...['measurementId', 'measuredAt', 'provenance', 'weightGrams', 'lengthMm', 'widthMm', 'heightMm', 'declaredValueDecimal', 'currency'].map(k => p[k])])).digest('hex');
  return { ...prepared, parcelFingerprint };
}
function quoteResult(value, prepared, now, started) {
  plain(value); exact(value, 'schema requestId parcelFingerprint observedAt quotes');
  if (value.schema !== 'runvara-parcel2go-quote-fixture/v1' || value.requestId !== prepared.requestId || value.parcelFingerprint !== prepared.parcelFingerprint
    || time(value.observedAt) < started || time(value.observedAt) > now || !Array.isArray(value.quotes) || value.quotes.length > 50) fail('QUOTE_INVALID');
  const codes = new Set();
  const quotes = value.quotes.map(q => {
    exact(q, 'serviceCode amountDecimal currency tax expiresAt');
    if (typeof q.serviceCode !== 'string' || !/^[A-Z0-9_-]{1,40}$/.test(q.serviceCode) || codes.has(q.serviceCode)
      || typeof q.amountDecimal !== 'string' || !/^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/.test(q.amountDecimal)
      || q.currency !== 'GBP' || !['included', 'excluded', 'unknown'].includes(q.tax)
      || q.expiresAt !== null && (time(q.expiresAt) <= now || time(q.expiresAt) <= time(value.observedAt))) fail('QUOTE_INVALID');
    codes.add(q.serviceCode); return Object.freeze({ ...q, priceGuaranteed: false, purchaseAllowed: false });
  });
  return Object.freeze({ schema: 'runvara-parcel2go-quote-review/v1', provider: 'parcel2go', environment: 'sandbox', synthetic: true,
    liveReady: false, requestId: prepared.requestId, observedAt: value.observedAt, quotes: Object.freeze(quotes), purchaseAllowed: false, deliveryGuaranteed: false });
}

export function createParcel2GoQuoteFoundation({ mode = 'disabled/v1', trustedBinding, fixtureQuote, now = Date.now } = {}) {
  if (!['disabled/v1', 'offline-fixture/v1'].includes(mode)) fail('DISABLED');
  const enabled = mode === 'offline-fixture/v1';
  const b = enabled ? binding(trustedBinding) : null;
  if (enabled && typeof fixtureQuote !== 'function') fail('FIXTURE_REQUIRED');
  const attempts = new Set(); let lastClock = null, clockClosed = false;
  const clock = () => {
    const t = now();
    if (!Number.isSafeInteger(t) || lastClock !== null && t < lastClock) clockClosed = true;
    lastClock = t; if (clockClosed) fail('TIME_INVALID'); return t;
  };
  const status = () => Object.freeze({ provider: 'parcel2go', mode, enabled: false, liveReady: false,
    fixtureMode: enabled, quotePreparationOnly: true, providerEnforcedReadOnlyScope: false,
    tokenExchange: false, orders: false, payment: false, labels: false, tracking: false, webhooks: false, automaticSync: false });
  async function quote(args = {}) {
    if (!enabled) fail('DISABLED');
    plain(args); exact(args, 'auth input envelope key');
    const { auth, input, envelope, key } = args;
    const started = clock(); actor(auth, started);
    const prepared = intent(input, b, started);
    if (auth.state._revision !== prepared.expectedRevision) fail('STATE_CHANGED');
    open(envelope, b, key, started);
    if (attempts.has(prepared.requestId)) fail('ATTEMPT_SPENT');
    attempts.add(prepared.requestId); // Offline concurrency fence; NOT durable live admission.
    let result;
    try { result = await fixtureQuote(structuredClone(prepared)); } catch { fail('FIXTURE_OUTCOME_UNKNOWN'); }
    const ended = clock(); actor(auth, ended);
    if (ended - started >= 300000 || auth.state._revision !== prepared.expectedRevision) fail('STATE_CHANGED');
    open(envelope, b, key, ended);
    return quoteResult(result, prepared, ended, started);
  }
  return Object.freeze({ status, quote });
}
