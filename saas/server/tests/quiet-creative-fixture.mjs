import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { seedWorkspaceState } from '../lib/store.mjs';
import { creativeDigest, newCreativeRequest } from '../lib/creative-safety.mjs';
import { creativeRpcParams, creativeRpcResult } from '../lib/creative-allowance.mjs';
import { runwayCreativeInput } from '../lib/marketing-providers.mjs';
import { createQuietCreativePilot, runQuietCreativePilot, CREATIVE_PILOT_SCHEMA } from '../lib/quiet-creative-pilot.mjs';

// Entirely synthetic state, prices and account. No network or real entitlement.
export function quietCreativeFixture() {
  let wall = Date.now(), mono = 0;
  const state = seedWorkspaceState({}, { workspaceId: 'alpha', email: 'owner@alpha.test', passwordHash: 'synthetic' });
  state._revision = randomUUID(); Object.assign(state.users[0], { passwordChangeRequired: false, active: true, sessionVersion: 1 });
  const campaign = { id: 'campaign', status: 'draft', product: { title: 'Synthetic carton', image: 'https://example.test/synthetic.png' }, copy: { headline: 'Synthetic test' }, creativeRequests: [] };
  const request = newCreativeRequest({ workspaceId: 'alpha', campaignId: campaign.id, provider: 'runway', kind: 'product_video', formats: [] });
  campaign.creativeRequests.push(request); state.marketing.campaigns = [campaign];
  const auth = { user: state.users[0], session: { workspaceId: 'alpha', sub: state.users[0].id, sessionVersion: 1 } };
  const env = { NODE_ENV: 'test', RUNVARA_STARTUP_MODE: 'quiet', RUNWAY_API_KEY: 'synthetic-key-only', MARKETING_ENV_WORKSPACE_ID: 'alpha' };
  const input = runwayCreativeInput(campaign, request, env);
  const descriptor = { schema: CREATIVE_PILOT_SCHEMA, workspaceId: 'alpha', ownerId: state.users[0].id, campaignId: campaign.id, requestId: request.id,
    providerAccountId: 'synthetic-account', policyRevision: 'synthetic-policy-v1', priceRevision: 'synthetic-price-v1',
    inputDigest: creativeDigest({ workspaceId: 'alpha', campaignId: campaign.id, requestId: request.id, provider: 'runway', phase: 'generation', endpoint: input.endpoint, payloadDigest: input.payloadDigest, accountBinding: input.accountBinding, sourceDigest: input.sourceDigest }),
    sourceDigest: input.sourceDigest, payloadDigest: input.payloadDigest, accountBinding: input.accountBinding,
    operationId: randomUUID(), maxCostMicros: 600, notBefore: new Date(wall - 1000).toISOString(), expiresAt: new Date(wall + 599000).toISOString() };
  env.RUNVARA_QUIET_CREATIVE_PILOT = JSON.stringify(descriptor);
  let saved = structuredClone(state), row = null, reserved = false, confirmed = false, saveCount = 0;
  const hooks = {}, calls = [], posts = [], reads = [], saves = [];
  const fault = code => Object.assign(Error(code), { code });
  const budget = () => ({ limitMicros: '1000', reservedMicros: reserved ? '600' : '0', heldMicros: reserved ? '600' : '0', spentMicros: '0', releasedMicros: '0', uncertainMicros: row?.reservationStatus === 'uncertain' ? '600' : '0', overrunMicros: '0', availableMicros: reserved ? '400' : '1000', overrunBlocked: false });
  const snapshotRow = () => row && ({ ...structuredClone(row), heldCostMicros: reserved ? '600' : '0', tenantBudget: budget(), accountBudget: budget() });
  const store = {
    provider: 'supabase',
    async get(id, options) { assert.equal(id, 'alpha'); assert.equal(options.exactSnapshot, true); await hooks.get?.(); return structuredClone(saved); },
    async save(id, value, options) {
      assert.equal(id, 'alpha'); assert.equal(options.ownedSnapshot, true); const n = ++saveCount;
      await hooks.beforeSave?.(value, n);
      options.beforeEffects(value, {}); options.beforeCommit(value);
      if (saved._revision !== value._revision) throw fault('STATE_CONFLICT');
      value._revision = randomUUID(); saved = structuredClone(value); saves.push(structuredClone(value));
      await hooks.afterSave?.(value, n);
      return structuredClone(saved);
    },
    async creativeAllowanceRpc(name, id, args) {
      const params = creativeRpcParams(name, id, args); calls.push({ name, params }); await hooks.beforeRpc?.(name, args);
      let result;
      if (name === 'review') result = row ? [snapshotRow()] : [];
      else if (name === 'prepare') {
        assert.equal(args.revision, saved._revision); assert.equal(args.operationId, descriptor.operationId);
        row ||= { id: 'approval-synthetic', approvalType: 'creative_phase/v1', ...args.binding, status: 'pending', revision: 1,
          maxCostMicros: 600, currency: 'USD', expiresAt: new Date(wall + 120000).toISOString(), policyRevision: descriptor.policyRevision,
          priceRevision: descriptor.priceRevision, providerAccountId: descriptor.providerAccountId, reservationStatus: null, upstreamId: null,
          accountingStatus: null, accountedCostMicros: null };
        delete row.endpoint; delete row.payloadDigest; delete row.sourceDigest;
        result = snapshotRow();
      } else if (name === 'decide') {
        if (!row || args.approvalId !== row.id || args.revision !== row.revision) throw fault('CREATIVE_APPROVAL_CONFLICT');
        row.status = args.decision; row.revision++; result = snapshotRow();
      } else if (name === 'reserve') {
        if (reserved || row?.status !== 'approved') result = { allowed: false, reason: 'CREATIVE_ALLOWANCE_REQUIRED' };
        else {
          reserved = true; row.reservationStatus = 'held'; row.accountingStatus = 'held';
          result = { allowed: true, workspaceId: 'alpha', campaignId: campaign.id, requestId: request.id, provider: 'runway', phase: 'generation',
            inputDigest: descriptor.inputDigest, approvalId: row.id, approvalRevision: row.revision, reservationId: 'reservation-synthetic',
            policyRevision: row.policyRevision, currency: 'USD', maxCostMicros: row.maxCostMicros, verifiedUpperBound: true, expiresAt: row.expiresAt };
        }
      } else if (name === 'confirm') {
        if (confirmed || !reserved || row.status !== 'approved') throw fault('CREATIVE_DISPATCH_ALREADY_CLAIMED');
        assert.equal(args.revision, saved._revision); confirmed = true; row.reservationStatus = 'dispatching';
        result = { ok: true, reservationId: args.reservationId, status: 'dispatching' };
      } else if (name === 'observe') {
        if (row.upstreamId && args.upstreamId && row.upstreamId !== args.upstreamId) throw fault('CREATIVE_RECEIPT_CONFLICT');
        row.reservationStatus = args.outcome; row.accountingStatus = args.outcome === 'uncertain' ? 'uncertain' : 'held'; row.upstreamId ||= args.upstreamId;
        result = { ok: true, reservationId: args.reservationId, status: args.outcome };
      } else throw Error('Unexpected RPC ' + name);
      await hooks.afterRpc?.(name, result); return creativeRpcResult(name, result, params);
    }
  };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') { posts.push({ url, body: JSON.parse(options.body) }); assert.equal(url, input.endpoint); }
    else { reads.push(url); assert.equal(url, 'https://api.dev.runwayml.com/v1/tasks/task-synthetic'); }
    if (hooks.provider) return hooks.provider(url, options);
    return Response.json(options.method === 'POST' ? { id: 'task-synthetic' } : { status: 'SUCCEEDED', output: ['https://example.test/synthetic.mp4'] });
  };
  const create = () => createQuietCreativePilot(env, { now: () => wall, monotonic: () => mono });
  let pilot = create();
  const f = { env, descriptor, state, campaign, request, auth, hooks, calls, posts, reads, saves, store, input,
    get pilot() { return pilot; }, get saved() { return saved; }, get row() { return row; }, get held() { return reserved ? 600 : 0; },
    setSaved(value) { saved = structuredClone(value); },
    clock(ms) { wall += ms; mono += Math.max(0, ms); }, restart() { pilot = create(); return pilot; },
    run(operation, body = { requestId: request.id }, extras = {}) { return runQuietCreativePilot({ pilot, store, auth, env, operation, body, fetchImpl, ...extras }); },
    async ready() { await f.run('prepare'); return f.run('decide', { requestId: request.id, approvalId: row.id, revision: row.revision, decision: 'approved' }); }
  };
  return f;
}
