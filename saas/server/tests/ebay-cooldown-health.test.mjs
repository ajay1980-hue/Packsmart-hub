import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';
import { connectionHealth, classifyConnectionIssue, intelligentConnections } from '../lib/connection-intelligence.mjs';
import { connectionSettings } from '../lib/connection-centre.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { monitoredSync } from '../lib/scheduler.mjs';
import { encryptCredentials } from '../lib/security.mjs';

const now = new Date('2026-10-09T12:00:00.000Z');
const recent = '2026-10-09T11:55:00.000Z';
const early = '2026-10-09T13:00:00.000Z';
const late = '2026-10-11T14:15:00.000Z';
const readiness = { oauthReady: true, refreshSupported: false };
const context = vm.createContext({ window: {}, Intl, Date });
vm.runInContext(await fs.readFile(new URL('../../presentation.js', import.meta.url), 'utf8'), context);
const ui = context.window.RunvaraUI;

function fixture(provider = 'ebay') {
  const state = {
    connections: [{ provider: provider === 'ebay' ? 'ebay_oauth' : provider, status: 'connected', encryptedCredentials: 'PRIVATE-CREDENTIAL' }],
    integrationStatus: { [provider]: { status: 'connected', areaSuccessAt: { orders: recent } } },
    connectionSettings: { [provider]: { autoSync: true, frequencyMinutes: 30, areas: ['orders'], managedReadSchedule: true } },
    connectionSyncs: [], audit: []
  };
  const channel = { id: provider, name: provider === 'ebay' ? 'eBay' : 'Shopify', configured: true,
    settings: connectionSettings(state, provider), history: [], lastSuccessfulSyncAt: recent };
  const health = (options = {}) => connectionHealth(state, channel, readiness, { now, ...options });
  const schedule = () => ui.schedule({ ...channel, health: health() }, {}, now.getTime());
  return { state, channel, health, schedule };
}

test('saved eBay cooldown is visible before Doctor has scheduled a retry and health remains read-only', () => {
  const { state, health, schedule } = fixture();
  state.integrationStatus.ebay.retryAt = late;
  const before = structuredClone(state);
  const result = health();
  assert.equal(result.nextRetryAt, late);
  assert.equal(result.automaticRetryAvailable, true);
  assert.equal(result.retryReviewRequired, false);
  assert.equal(result.status, 'Attention needed');
  assert.match(result.message, /11 Oct 2026, 14:15 UTC/);
  assert.match(schedule(), /^Eligible after .*Oct 2026.*\d{2}:\d{2}$/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CREDENTIAL/);
  assert.deepEqual(state, before);
});

test('fatal monitored Manager 429/5xx waits remain read cooldowns while real 401/403 failures retain access precedence', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const key = 'synthetic-cooldown-health-encryption-key-more-than-32-characters';
  for (const [upstreamStatus, header] of [[429, '172800'], [429, '9'.repeat(129)], [500, '172800'], [501, '172800'], [502, '172800'], [503, '172800'], [504, '172800'], [599, '172800'], [401, '172800'], [403, '172800']]) {
    const { state } = fixture();
    state.workspace = { id: 'fatal-ebay-cooldown-health' };
    state.connections = [{ id: 'manager-connection', provider: 'ebay', status: 'connected',
      encryptedCredentials: encryptCredentials({ baseUrl: 'https://synthetic-manager.example.test', expectedAccount: 'synthetic-seller', apiToken: 'synthetic-only' }, key) }];
    let calls = 0;
    const integrations = new IntegrationService({ NODE_ENV: 'test', CREDENTIALS_KEY: key }, { fetchImpl: async () => {
      calls++; return Response.json({}, { status: upstreamStatus, headers: { 'Retry-After': header } });
    } });
    await assert.rejects(monitoredSync(state, integrations, 'ebay', { areas: ['orders'], retry: false }), error => error.upstreamStatus === upstreamStatus);
    assert.equal(calls, 1, 'only the synthetic Manager status endpoint is read');
    if ([401,403].includes(upstreamStatus)) state.integrationStatus.ebay.retryAt = late;
    const channel = intelligentConnections(state, integrations, { now }).find(channel => channel.id === 'ebay');
    const result = channel.health;
    if (upstreamStatus === 429 || upstreamStatus >= 500) {
      assert.equal(state.connections[0].status, 'error', 'exercise the actual fatal read record mutation');
      assert.equal(result.authentication, 'not_verified', 'a recorded read cooldown does not establish an auth failure');
      assert.equal(state.integrationStatus.ebay.upstreamStatus, upstreamStatus);
      if (upstreamStatus >= 500) assert.equal(result.cause, 'provider_unavailable', 'a service cooldown is never relabeled as a rate limit');
      assert.equal(result.nextRetryAt, header.length > 128 ? null : '2026-10-11T12:00:00.000Z');
      assert.equal(result.retryReviewRequired, header.length > 128);
      assert.match(result.message, header.length > 128 ? /needs manual review/ : /must wait until 11 Oct 2026, 12:00 UTC/);
      assert.doesNotMatch(ui.schedule(channel, { autopilot: { enabled: true } }, now.getTime()), /Access needs review|Eligible at next check/);
    } else {
      assert.equal(result.authentication, 'attention');
      assert.equal(result.status, 'Reconnect required');
      assert.equal(result.nextRetryAt, null);
      assert.equal(result.action.action, 'reconnect');
      assert.equal(ui.schedule(channel, { autopilot: { enabled: true } }, now.getTime()), 'Access needs review');
    }
  }
});

test('health honors the latest saved provider or Doctor deadline, including retained eBay diagnostics', () => {
  for (const [statusAt, diagnosticAt, doctorAt, expected] of [
    [early, null, late, late], [late, null, early, late], [early, late, early, late],
    [null, late, null, late], [null, null, late, late],
    [late, null, 'PRIVATE-NOT-A-DATE', late], [null, null, '2026-02-30T12:00:00Z', null]
  ]) {
    const { state, health } = fixture();
    state.integrationStatus.ebay.retryAt = statusAt;
    state.ebay = { coverage: { readDiagnostics: { orders: { retryAt: diagnosticAt } } } };
    state.connectionDoctor = { ebay: { nextRetryAt: doctorAt } };
    const result = health();
    assert.equal(result.nextRetryAt, expected);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-NOT-A-DATE/);
  }
});

test('expired eBay and Doctor deadlines stop appearing at the exact boundary', () => {
  const { state, channel, health, schedule } = fixture();
  channel.lastSuccessfulSyncAt = '2026-10-09T09:00:00.000Z';
  state.integrationStatus.ebay.retryAt = now.toISOString();
  state.connectionDoctor = { ebay: { nextRetryAt: now.toISOString() } };
  assert.equal(health().nextRetryAt, null);
  assert.equal(schedule(), 'Eligible at next check');
  state.integrationStatus.ebay.retryAt = new Date(now.getTime() + 1).toISOString();
  assert.equal(health().nextRetryAt, state.integrationStatus.ebay.retryAt);
  assert.match(schedule(), /^Eligible after /);
});

test('manual mode retains the provider wait explanation without offering an automatic retry', () => {
  const { state, channel, health, schedule } = fixture();
  channel.settings.autoSync = false;
  state.integrationStatus.ebay = { lastError: 'CONNECTION_RATE_LIMITED', retryAt: late };
  state.connectionDoctor = { ebay: { nextRetryAt: early } };
  const result = health();
  assert.equal(result.nextRetryAt, null);
  assert.equal(result.automaticRetryAvailable, false);
  assert.match(result.message, /11 Oct 2026, 14:15 UTC/);
  assert.match(result.message, /Automatic syncing is off.*Retry manually after that time/);
  assert.doesNotMatch(result.message, /will retry|before retrying|when ready/);
  assert.equal(schedule(), 'Automatic sync paused');
});

test('blocked, disconnected and exhausted eBay reads never promise a next automatic check', () => {
  for (const block of [
    ({ channel }) => { channel.settings.disconnected = true; },
    ({ channel }) => { channel.configured = false; },
    ({ channel }) => { channel.settings.areas = []; },
    ({ state }) => { state.connectionDoctor = { ebay: { exhausted: true, nextRetryAt: late } }; },
    ({ state }) => { state.connectionDoctor = { ebay: { pendingReadAttempts: 5, nextRetryAt: late } }; },
    ({ state }) => { state.integrationStatus.ebay.lastError = 'EBAY_ACCOUNT_RESTRICTED'; }
  ]) {
    const fixtureState = fixture();
    fixtureState.state.integrationStatus.ebay.retryAt = late;
    block(fixtureState);
    const result = fixtureState.health();
    assert.equal(result.nextRetryAt, null);
    assert.equal(result.automaticRetryAvailable, false);
    assert.doesNotMatch(fixtureState.schedule(), /Eligible/);
    assert.doesNotMatch(result.message, /will retry|before retrying/);
  }
  for (const options of [{ persistence: { primaryPersistence: false } }, { scheduler: { lastError: 'FAILED' } }]) {
    const { state, channel, health } = fixture();
    state.integrationStatus.ebay.retryAt = late;
    const result = health(options);
    assert.equal(result.nextRetryAt, null);
    assert.equal(result.automaticRetryAvailable, false);
    assert.equal(ui.schedule({ ...channel, health: result }, {}, now.getTime()), 'Automatic reads paused');
  }
});

test('untrusted eBay retry timing is fail-closed and never displayed as a raw provider value', () => {
  for (const saved of [{ retryReviewRequired: true }, { retryAt: 'PRIVATE-UNTRUSTED-DEADLINE' }, { retryAt: late, retryReviewRequired: true }]) {
    const { state, health, schedule } = fixture();
    Object.assign(state.integrationStatus.ebay, saved);
    state.connectionDoctor = { ebay: { nextRetryAt: early } };
    const result = health();
    assert.equal(result.retryReviewRequired, true);
    assert.equal(result.automaticRetryAvailable, false);
    assert.equal(result.nextRetryAt, null);
    assert.equal(result.status, 'Attention needed');
    assert.equal(result.cause, 'retry_review_required');
    assert.match(result.message, /retry deadline could not be represented safely and needs manual review.*Automatic reads are paused/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-UNTRUSTED-DEADLINE|will retry|before retrying/);
    assert.equal(schedule(), 'Retry timing needs review');
    assert.equal(ui.connectionMessage({ id: 'ebay', health: result, recovery: { message: 'Retry selected data' },
      readDiagnostics: { marketing: { errorIds: ['35077'] } } }), result.message, 'Overview uses the same saved hold copy as the connection card');
  }
});

test('access failures and expiry retain precedence over cooldown and retry timing review', () => {
  for (const auth of [
    ({ state }) => { state.integrationStatus.ebay.lastError = 'EBAY_AUTH_REQUIRED'; },
    ({ state }) => { state.connections[0].lastError = 'ACCOUNT_MISMATCH'; },
    ({ state }) => { state.connectionAuthAttention = { ebay: { code: 'TOKEN_EXPIRED' } }; },
    ({ channel }) => { channel.accessExpiresAt = '2026-10-09T11:00:00.000Z'; }
  ]) {
    const fixtureState = fixture();
    Object.assign(fixtureState.state.integrationStatus.ebay, { retryAt: late, retryReviewRequired: true });
    auth(fixtureState);
    const result = fixtureState.health();
    assert.equal(result.status, 'Reconnect required');
    assert.equal(result.action.action, 'reconnect');
    assert.equal(result.nextRetryAt, null);
    assert.equal(fixtureState.schedule(), 'Access needs review');
    assert.doesNotMatch(result.message, /will retry|before retrying/);
  }
});

test('Promoted Listings restriction remains primary while its commerce reads respect the cooldown', () => {
  const { state, channel, health, schedule } = fixture();
  state.ebay = { coverage: { readDiagnostics: { marketing: { httpStatus: 409, errorIds: ['35077'] } } } };
  state.integrationStatus.ebay.retryAt = late;
  let result = health();
  assert.equal(result.cause, 'provider_restriction');
  assert.match(result.message, /not enabled Promoted Listings/);
  assert.match(result.message, /Commerce reads must wait until 11 Oct 2026, 14:15 UTC/);
  assert.equal(result.nextRetryAt, late);
  channel.settings.autoSync = false;
  result = health();
  assert.equal(result.nextRetryAt, null);
  assert.match(result.message, /Automatic syncing is off; retry manually after that time/);
  channel.settings.autoSync = true;
  state.integrationStatus.ebay.retryReviewRequired = true;
  result = health();
  assert.equal(result.cause, 'provider_restriction');
  assert.match(result.message, /not enabled Promoted Listings/);
  assert.match(result.message, /retry deadline could not be represented safely and needs manual review/);
  assert.doesNotMatch(result.message, /commerce reads can continue/i);
  assert.equal(result.nextRetryAt, null);
  assert.equal(schedule(), 'Retry timing needs review');
  assert.equal(classifyConnectionIssue(state, 'ebay', now).kind, 'provider_restriction');
});

test('schedule respects both ordinary cadence and the health deadline, including waits without prior history', () => {
  const { channel } = fixture();
  const scheduled = health => ui.schedule({ ...channel, health }, {}, now.getTime());
  const expected = at => `Eligible after ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(at))}`;
  assert.equal(scheduled({ nextRetryAt: '2026-10-09T12:10:00.000Z' }), expected('2026-10-09T12:25:00.000Z'));
  assert.equal(scheduled({ nextRetryAt: early }), expected(early));
  assert.equal(scheduled({ nextRetryAt: 'PRIVATE-INVALID' }), expected('2026-10-09T12:25:00.000Z'));
  channel.lastSuccessfulSyncAt = null;
  assert.equal(scheduled({ nextRetryAt: early }), expected(early));
  assert.match(scheduled({ nextRetryAt: late }), /Oct 2026/);
});

test('other providers keep their health contract and ordinary scheduling behavior', () => {
  const { state, channel, health } = fixture('shopify');
  state.integrationStatus.ebay = { retryAt: late, retryReviewRequired: true };
  state.ebay = { coverage: { readDiagnostics: { orders: { retryAt: late } } } };
  state.connectionDoctor = { shopify: { nextRetryAt: early } };
  const result = health();
  assert.equal(result.nextRetryAt, early);
  assert.equal(result.retryReviewRequired, undefined);
  assert.equal(result.automaticRetryAvailable, undefined);
  assert.equal(result.status, 'Healthy');
  const expected = `Eligible after ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date('2026-10-09T12:25:00.000Z'))}`;
  assert.equal(ui.schedule({ ...channel, health: result }, {}, now.getTime()), expected);
});

test('release connection card and management dialog render saved eBay wait and review copy without requests', async t => {
  const errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8'),
    { url: 'https://cooldown.example.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  window.Date.now = () => now.getTime();
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  for (const file of ['presentation.js', 'connections-ui.js']) window.eval(await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
  let requests = 0;
  window.RunvaraConnections.init({ escapeHtml: value => ui.escape(value), date: value => new Date(value).toISOString(),
    notify: () => {}, setView: () => {}, reload: async () => {}, request: async () => { requests++; assert.fail('Saved cooldown display must not request a provider or write state'); } });
  for (const mode of ['deadline', 'manual', 'review', 'exhausted']) {
    const { state } = fixture();
    state.integrationStatus.ebay.retryAt = late;
    if (mode === 'manual') state.connectionSettings.ebay.autoSync = false;
    if (mode === 'review') state.integrationStatus.ebay.retryReviewRequired = true;
    if (mode === 'exhausted') state.connectionDoctor = { ebay: { pendingReadAttempts: 5 } };
    const integrations = { oauthReady: () => true, refreshSupported: () => false, connectionAccessExpiry: () => null,
      shopifyConfigured: () => false, ebayConfigured: () => true, ebayConnection: () => state.connections[0] };
    const channels = intelligentConnections(state, integrations, { now });
    window.RunvaraConnections.render({ user: { role: 'owner' }, workspace: { id: 'cooldown-ui' }, autopilot: { enabled: true }, connectionCentre: channels });
    const card = document.querySelector('[data-channel-card="ebay"]');
    const message = card.querySelector('.connection-health').textContent;
    const next = [...card.querySelectorAll('.connection-facts div')].find(row => row.querySelector('dt').textContent === 'Next automatic read').querySelector('dd').textContent;
    assert.equal(message, channels.find(channel => channel.id === 'ebay').health.message);
    assert.equal(window.RunvaraUI.connectionMessage(channels.find(channel => channel.id === 'ebay')), message);
    if (mode === 'deadline') assert.match(next, /^Eligible after .*Oct 2026/);
    else assert.doesNotMatch(next, /Eligible/);
    for (const close of ['button', 'escape']) {
      card.querySelector('.connection-title').click();
      assert.equal(document.querySelector('#connection-dialog').open, true);
      assert.equal(document.querySelector('#connection-detail > .connection-notice > p').textContent, message);
      if (mode === 'review') assert.equal(document.querySelector('#connection-detail > .connection-notice button').dataset.connectionAction, 'open');
      if (close === 'button') document.querySelector('#connection-close').click();
      else document.querySelector('#connection-dialog').dispatchEvent(new window.Event('cancel', { cancelable: true }));
      assert.equal(document.querySelector('#connection-dialog').open, false);
    }
  }
  assert.equal(requests, 0);
  assert.deepEqual(errors, []);
});
