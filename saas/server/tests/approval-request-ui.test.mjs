import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
const source = fs.readFileSync(new URL('../../approval-request-ui.js', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function memory() { const map = new Map(); return { map, getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) }; }
function harness(t, { storage = memory(), identity, respond } = {}) {
  const dom = new JSDOM('<form><input name="action"><input name="type" value="customer_facing_publish"><textarea name="reason"></textarea><button type="submit">Create request</button></form><p id="error"></p>', { url: 'https://synthetic.example.test', runScripts: 'outside-only' });
  t.after(() => dom.window.close()); const w = dom.window; Object.defineProperty(w.crypto, 'randomUUID', { value: randomUUID });
  w.eval(source);
  let who = identity || { workspaceId: 'alpha', actorId: 'owner', role: 'owner', session: {} };
  const form = w.document.querySelector('form'), error = w.document.querySelector('#error'), calls = [], resolved = [];
  const ui = w.RunvaraApprovalRequest.create({ form, error, storage, identity: () => who,
    onResolved: approval => resolved.push(approval), request: async (path, options) => {
      const body = JSON.parse(options.body); calls.push({ path, body, options });
      assert.equal(storage.map?.size ?? 1, 1, 'identity retained before transport'); return respond?.(path, body, options);
    } });
  form.elements.action.value = 'Exact synthetic action'; form.elements.reason.value = 'Retain this draft';
  const panel = form.nextElementSibling, buttons = panel.querySelectorAll('button');
  return { dom, w, form, error, storage, calls, resolved, ui, panel, check: buttons[0], retry: buttons[1],
    submit: () => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })),
    changeIdentity: value => { who = value; ui.refresh(); }, identity: () => who };
}
const success = body => ({ requestId: body.requestId, approval: { id: 'approval_saved', status: 'pending' }, executedExternally: false });

test('initial submission persists before transport, suppresses double submit and clears only on exact success', async t => {
  let resolve; const h = harness(t, { respond: () => new Promise(done => { resolve = done; }) });
  h.submit(); h.submit(); assert.equal(h.calls.length, 1); assert.equal(h.form.elements.action.disabled, true);
  const saved = JSON.parse([...h.storage.map.values()][0]); assert.equal(saved.body.action, 'Exact synthetic action'); assert.equal(JSON.stringify(saved).includes('csrf'), false);
  resolve(success(h.calls[0].body)); await turn(); assert.equal(h.storage.map.size, 0); assert.equal(h.resolved.length, 1); assert.equal(h.form.elements.action.disabled, false);
});

test('uncertainty survives reload with zero automatic requests; exact read resolves without replay', async t => {
  const storage = memory(); const first = harness(t, { storage, respond: async () => { throw Error('Unknown response'); } });
  first.submit(); await turn(); assert.equal(first.calls.length, 1); assert.match(first.panel.textContent, /Outcome unknown/);
  first.submit(); assert.equal(first.calls.length, 1);
  const reference = first.calls[0].body;
  const next = harness(t, { storage, respond: async (path, body) => { assert.equal(path, '/api/actions/reconcile'); return { ...success(body), found: true }; } });
  assert.equal(next.calls.length, 0); assert.equal(next.form.elements.action.disabled, true);
  next.check.click(); await turn(); assert.equal(next.calls.length, 1); assert.deepEqual(next.calls[0].body, reference);
  assert.equal(storage.map.size, 0); assert.equal(next.resolved.length, 1);
});

test('read absence offers only a deliberate retry with the same frozen identity/content', async t => {
  let call = 0; const h = harness(t, { respond: async (path, body) => {
    if (++call === 1) throw Error('Unknown');
    if (call === 2) return { requestId: body.requestId, found: false, approval: null, executedExternally: false };
    return success(body);
  } });
  h.submit(); await turn(); assert.equal(h.retry.hidden, true); const sent = structuredClone(h.calls[0].body);
  h.check.click(); await turn(); assert.equal(h.retry.hidden, false); assert.equal(h.calls.length, 2);
  h.form.elements.action.value = 'DOM was changed while disabled';
  h.retry.click(); await turn(); assert.deepEqual(h.calls[2].body, sent); assert.equal(h.calls[2].path, '/api/actions'); assert.equal(h.resolved.length, 1);
});

for (const status of [400, 401, 403, 409, 503]) test('later refusal ' + status + ' cannot clear a prior unknown request', async t => {
  let attempt = 0; const h = harness(t, { respond: async () => { if (++attempt === 1) throw Error('Lost response');
    throw Object.assign(Error('Refused'), { status, code: 'APPROVAL_REQUEST_INPUT_INVALID' }); } });
  h.submit(); await turn(); const retained = [...h.storage.map.values()][0]; h.check.click(); await turn();
  assert.equal([...h.storage.map.values()][0], retained); assert.equal(h.form.elements.action.disabled, true); assert.equal(h.resolved.length, 0);
});

test('first conclusive input rejection is editable; failed local storage never submits', async t => {
  const h = harness(t, { respond: async () => { throw Object.assign(Error('Correct input'), { status: 400, code: 'APPROVAL_REQUEST_INPUT_INVALID' }); } });
  h.submit(); await turn(); assert.equal(h.storage.map.size, 0); assert.equal(h.form.elements.action.disabled, false);
  const storage = memory(); storage.setItem = () => { throw Error('Unavailable'); };
  const blocked = harness(t, { storage }); blocked.submit(); await turn(); assert.equal(blocked.calls.length, 0);
  assert.match(blocked.panel.textContent, /Nothing new was submitted/);
});

test('interrupted and late response cannot clear the original reference or update another identity', async t => {
  let finish; const h = harness(t, { respond: () => new Promise(resolve => { finish = resolve; }) });
  const owner = h.identity(); h.submit(); const body = h.calls[0].body; h.ui.interrupt(); finish(success(body)); await turn();
  assert.equal(h.resolved.length, 0); assert.equal(h.storage.map.size, 1); assert.match(h.panel.textContent, /Outcome unknown/);
  h.changeIdentity({ workspaceId: 'beta', actorId: 'owner', role: 'owner', session: {} }); assert.equal(h.calls.length, 1); assert.equal(h.form.elements.action.value, '');
  h.changeIdentity(owner); assert.equal(h.form.elements.action.value, 'Exact synthetic action'); assert.equal(h.form.elements.action.disabled, true);
  h.changeIdentity({ ...owner, role: 'viewer', session: {} }); assert.equal(h.form.elements.action.value, ''); assert.equal(h.storage.map.size, 1);
});

test('session replacement during transport ignores the old result and restores the retained request', async t => {
  let finish; const h = harness(t, { respond: () => new Promise(resolve => { finish = resolve; }) });
  h.submit(); h.changeIdentity({ ...h.identity(), session: {} }); finish(success(h.calls[0].body)); await turn();
  assert.equal(h.resolved.length, 0); assert.equal(h.storage.map.size, 1); assert.match(h.panel.textContent, /Outcome unknown/);
});

test('corrupt saved references and storage getter failures fail closed without crashing or transport', async t => {
  const storage = memory(); storage.map.set('runvara:approval-request:v1:alpha:owner', '{bad');
  const h = harness(t, { storage }); h.submit(); assert.equal(h.calls.length, 0); assert.equal(storage.map.size, 1); assert.equal(h.form.elements.action.disabled, true);
  const blocked = memory(); blocked.getItem = () => { throw Error('Unavailable'); };
  const other = harness(t, { storage: blocked }); other.submit(); assert.equal(other.calls.length, 0);
});

