import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';

test('cockpit renders authenticated controls and submits real persisted workflows', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-cockpit-'));
  const secret = 'ui-test-only-session-secret-more-than-32-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: 'ui-test-only-credential-key-more-than-32-characters', SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const state = seedWorkspaceState({}, { workspaceId: 'ui-test', email: 'ui@example.test', passwordHash: 'test-only' });
  state.products = [{ id: 'p1', title: '<img src=x onerror=alert(1)>', status: 'active', variants: [{ id: 'v1', sku: 'SKU-1', price: 10, inventory: 1, available: true }] }];
  await server.packsmart.store.save('ui-test', state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: 'ui-test', email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const errors = [], calls = [], console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole: console, pretendToBeVisual: true });
  t.after(async () => { dom.window.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const { window } = dom, document = window.document;
  window.Headers = Headers; window.scrollTo = () => {}; window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (route, options = {}) => {
    const headers = new Headers(options.headers); headers.set('Cookie', `packsmart_session=${token}`);
    const response = await fetch(base + route, { ...options, headers });
    calls.push({ route, method: options.method || 'GET', status: response.status }); return response;
  };
  const until = async condition => {
    for (let attempt = 0; attempt < 150; attempt++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(`UI did not reach expected state. Errors: ${errors.join('; ')}; message: ${document.querySelector('#global-error').textContent}`);
  };
  for (const file of ['control-ui.js', 'app.js']) window.eval(await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
  await until(() => !document.querySelector('#app-shell').classList.contains('hidden'));
  assert.ok(!calls.some(call => call.route === '/api/migrate-pilot'), 'a future tenant never imports the customer-zero browser cache');
  assert.equal(document.querySelector('[onerror]'), null, 'source text is escaped');
  for (const button of document.querySelectorAll('#main-nav [data-view]')) { button.click(); assert.ok(document.getElementById(`view-${button.dataset.view}`).classList.contains('active')); }
  const decision = document.getElementById('decision-form');
  for (const [key, value] of Object.entries({ key: 'ui-goal', category: 'goal', title: 'A verified UI goal', content: 'Check operations daily.', source: 'DOM integration test' })) decision.elements[key].value = value;
  decision.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.getElementById('decision-list').textContent.includes('A verified UI goal'));
  document.getElementById('autopilot-toggle').click();
  await until(() => document.getElementById('autopilot-status').textContent.startsWith('ON'));
  const opportunity = document.querySelector('[data-opportunity]'); assert.ok(opportunity); opportunity.click();
  await until(() => document.querySelector('[data-modify-approval]'));
  document.querySelector('[data-modify-approval]').click();
  const edit = document.getElementById('approval-edit-form'); edit.elements.action.value = 'Revised UI proposal';
  edit.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.getElementById('approval-list').textContent.includes('Revised UI proposal'));
  document.querySelector('[data-approval][data-decision="approved"]').click();
  await until(() => calls.some(call => call.route.endsWith('/decision') && call.status === 200));
  const agent = document.querySelector('[data-agent-form="stock"]'); agent.elements.enabled.value = 'false';
  agent.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(async () => (await server.packsmart.store.get('ui-test')).agentSettings.stock.enabled === false);
  await until(() => document.getElementById('global-success').textContent === 'Agent policy saved.');
  const saved = await server.packsmart.store.get('ui-test');
  assert.equal(saved.approvals[0].status, 'approved'); assert.equal(saved.approvals[0].revision, 2);
  assert.equal(saved.approvals[0].executedExternally, false); assert.ok(saved.decisions.some(item => item.key === 'ui-goal'));
  assert.deepEqual(errors, []); assert.ok(!calls.some(call => call.status >= 400));
});
