import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInternalGrokEvaluation } from '../lib/grok-evaluation.mjs';
import { publicModelCatalog, routeAiWork } from '../lib/ai-economics.mjs';

const NOW = Date.parse('2026-10-11T17:00:00.000Z');
const TEST_KEY = 'xai-' + 'synthetic-test-only-'.repeat(3);
function fixture() {
  const user = { id: 'internal-owner', email: 'owner@example.test', role: 'owner', active: true, sessionVersion: 3 };
  const state = { workspace: { id: 'packsmart-solutions' }, users: [user],
    orders: [{ customer: 'private-customer-sentinel' }], credentials: { key: 'private-business-key-sentinel' } };
  return { auth: { user, state, session: { sub: user.id, workspaceId: state.workspace.id, sessionVersion: 3 } },
    env: { PACKSMART_ADMIN_EMAIL: user.email, XAI_API_KEY: TEST_KEY }, now: NOW };
}
const rejects = (input, code, status = 403) => assert.throws(() => prepareInternalGrokEvaluation(input), error => error.code === code && error.status === status);

test('evaluation preparation admits only the fresh, unique internal platform owner', () => {
  rejects({}, 'AUTH_REQUIRED', 401);
  for (const role of ['admin', 'member', 'viewer']) {
    const f = fixture(); f.auth.user.role = role; rejects(f, 'PLATFORM_ADMIN_REQUIRED');
  }
  for (const change of [f => { f.auth.session.workspaceId = 'customer-tenant'; },
    f => { f.auth.user.email = 'another-owner@example.test'; }]) {
    const f = fixture(); change(f); rejects(f, 'PLATFORM_ADMIN_REQUIRED');
  }
  for (const change of [f => { f.auth.state.workspace.id = 'customer-tenant'; },
    f => { f.auth.user.active = false; }, f => { f.auth.user.passwordChangeRequired = true; },
    f => { f.auth.session.sessionVersion = 2; }, f => { f.auth.session.sub = 'missing-user'; },
    f => { f.auth.state.users.push({ ...f.auth.user }); },
    f => { f.auth.user = { ...f.auth.user }; }]) {
    const f = fixture(); change(f); rejects(f, 'GROK_EVALUATION_IDENTITY_INVALID');
  }
  assert.equal(prepareInternalGrokEvaluation(fixture()).workspaceId, 'packsmart-solutions');
});

test('flags and a stored key cannot authorise transport, writes, customers or spend', () => {
  for (const flags of [{}, { RUNVARA_XAI_INTERNAL_EVAL_ENABLED: 'true', RUNVARA_XAI_PAID_USAGE_APPROVED: 'true' },
    { RUNVARA_XAI_INTERNAL_EVAL_ENABLED: true, RUNVARA_XAI_PAID_USAGE_APPROVED: 'TRUE' }]) {
    const f = fixture(); Object.assign(f.env, flags);
    const result = prepareInternalGrokEvaluation(f);
    assert.equal(result.configuration.secretStored, true);
    assert.equal(result.configuration.internalEvaluationRequested, flags.RUNVARA_XAI_INTERNAL_EVAL_ENABLED === 'true');
    assert.equal(result.configuration.paidUsageApproved, flags.RUNVARA_XAI_PAID_USAGE_APPROVED === 'true');
    for (const field of ['executionAuthorized', 'writesAuthorized', 'customerEnabled', 'liveEvaluationCompleted']) assert.equal(result[field], false);
    for (const code of ['GROK_PAID_TRANSPORT_NOT_IMPLEMENTED', 'GROK_BILLABLE_TOKEN_BOUND_UNVERIFIED', 'GROK_DURABLE_ADMISSION_REQUIRED']) assert.ok(result.blockers.includes(code));
    assert.ok(result.evaluation.cases.every(item => item.readyToSend === false));
  }
  for (const key of [undefined, '', 'not-an-xai-key']) {
    const f = fixture(); f.env.XAI_API_KEY = key;
    const result = prepareInternalGrokEvaluation(f);
    assert.equal(result.configuration.secretStored, false); assert.ok(result.blockers.includes('GROK_SECRET_NOT_STORED'));
  }
});

test('only immutable synthetic requests are prepared and no secret or tenant data is projected', () => {
  const f = fixture(), before = structuredClone(f), result = prepareInternalGrokEvaluation(f);
  const encoded = JSON.stringify(result);
  for (const value of [TEST_KEY, 'private-customer-sentinel', 'private-business-key-sentinel', f.auth.user.email, f.auth.user.id]) assert.ok(!encoded.includes(value));
  assert.deepEqual(f, before);
  assert.equal(result.evaluation.cases.length, 3);
  for (const item of result.evaluation.cases) {
    assert.equal(item.request.model, 'grok-4.7'); assert.deepEqual(item.request.tools, []); assert.equal(item.request.store, false);
    assert.equal(item.request.max_output_tokens, undefined);
    assert.match(item.requestDigest, /^[a-f0-9]{64}$/); assert.ok(item.request.input.includes('Synthetic deterministic findings:'));
    assert.throws(() => { item.request.model = 'customer-model'; }, TypeError);
    assert.throws(() => item.acceptance.push('Bypass approval'), TypeError);
  }
  assert.equal(result.costs.upperBoundVerified, false); assert.equal(result.costs.indicativeOnly, true);
  assert.equal(result.costs.example.threeRequestCostUsd, 0.015);
  const again = prepareInternalGrokEvaluation(f);
  assert.deepEqual(again, result); assert.notEqual(again.evaluation.cases, result.evaluation.cases);
});

test('untrusted endpoint, model and approval hints do not alter existing OpenAI routing', () => {
  const before = publicModelCatalog(), f = fixture();
  Object.assign(f.env, { XAI_BASE_URL: 'https://untrusted.invalid', XAI_MODEL: 'different-model', XAI_OUTPUT_LIMIT_VERIFIED: 'true' });
  f.auth.state.aiEconomics = { routingMode: 'quality' }; f.auth.state.subscription = { plan: 'pro' };
  const route = routeAiWork(structuredClone(f.auth.state), { jobType: 'agent_command', payload: { command: 'Full audit' } });
  const result = prepareInternalGrokEvaluation(f);
  assert.equal(result.endpoint, 'https://api.x.ai/v1/responses'); assert.equal(result.model, 'grok-4.7');
  assert.equal(route.provider, 'openai'); assert.equal(route.model, 'gpt-5.6-sol');
  assert.deepEqual(publicModelCatalog(), before); assert.ok(before.every(item => item.provider !== 'xai'));
});

test('invalid timestamps are rejected before evaluation preparation', () => {
  for (const now of [NaN, Infinity, -1, 1.5, '2026-10-11', 253402300800000]) rejects({ ...fixture(), now }, 'GROK_EVALUATION_TIME_INVALID', 400);
});
