// Synthetic importer accounting only. No provider/database/network calls leave
// this process. The stage transport below records actual serialized fixture
// bodies; it is not PostgreSQL authority or a substitute for integrated tests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { IntegrationService } from '../lib/integrations.mjs';
import { seedWorkspaceState, createStore } from '../lib/store.mjs';
import { encryptCredentials } from '../lib/security.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { createShopifyOrderRecoveryBinding, createShopifyOrderRecoveryStage, createShopifyOrderRecoveryCapability,
  resumeShopifyOrderRecoveryStage, getShopifyOrderRecoveryStage, shopifyOrderRecoverySummary } from '../lib/shopify-order-recovery.mjs';
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const startedAt = new Date().toISOString(), sourceAt = new Date(Date.parse(startedAt) - 60000).toISOString();
const money = amount => ({ shopMoney: { amount, currencyCode: 'GBP' } });
const raw = Array.from({ length: 500 }, (_, i) => ({ id: `gid://shopify/Order/${10000000000000 + i}`, name: `#${i}`,
  createdAt: sourceAt, updatedAt: sourceAt, cancelledAt: null, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
  totalPriceSet: money('100.25'), currentTotalPriceSet: money('100.25'), currentTotalTaxSet: money('16.71'), currentTotalDiscountsSet: money('1.00'),
  currentShippingPriceSet: money('3.49'), paymentGatewayNames: ['shopify_payments'],
  lineItems: { nodes: Array.from({ length: 4 }, (_, j) => ({ id: `gid://shopify/LineItem/${10000000000000 + i * 100 + j}`, name: 'Synthetic packaging line',
    sku: `SKU-${j}`, quantity: 1, originalTotalSet: money('25.0625'), discountedTotalSet: money('24.8125') })), pageInfo: { hasNextPage: false } } }));
const categories = () => Object.fromEntries(['provider', 'stageMutations', 'summaryReads', 'fullReads', 'authorityReads', 'ordinaryStore'].map(key => [key, { requests: 0, requestBodyBytes: 0, decodedResponseBodyBytes: 0 }]));
const add = (counter, request, response) => { counter.requests++; counter.requestBodyBytes += request ? bytes(request) : 0; counter.decodedResponseBodyBytes += response ? bytes(response) : 0; };
async function run(recovery, interrupted) {
  const counters = categories(), workspaceId = `budget-${recovery ? 'recovery' : 'ordinary'}-${interrupted ? 'interrupted' : 'complete'}`;
  const state = seedWorkspaceState({}, { workspaceId }); state._revision = randomUUID();
  state.connections = [{ id: 'connection', provider: 'shopify', status: 'connected', metadata: { shopDomain: 'fixture.myshopify.com', shopId: 'shop-id' },
    encryptedCredentials: encryptCredentials({ storeDomain: 'fixture.myshopify.com', accessToken: 'synthetic-token' }, 'synthetic-budget-encryption-key-at-least-thirty-two') }];
  const db = fakeSupabase({ initialStates: [state] });
  const store = createStore({ SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-fixture-key' }, { fetchImpl: async (url, options) => {
    const response = await db.fetchImpl(url, options); add(counters.ordinaryStore, options?.body, await response.clone().text()); return response;
  } });
  let shouldInterrupt = interrupted;
  const service = new IntegrationService({ CREDENTIALS_KEY: 'synthetic-budget-encryption-key-at-least-thirty-two' }, { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body), offset = body.variables.after ? Number(body.variables.after) : 0;
    assert.match(body.query, /query PacksmartOpsOrders/);
    if (shouldInterrupt && offset === 400) { shouldInterrupt = false; add(counters.provider, options.body, '{"error":"synthetic interrupted read"}'); throw new Error('synthetic interruption'); }
    const nodes = raw.slice(offset, offset + 50), next = offset + nodes.length;
    const payload = { data: { orders: { nodes, pageInfo: { hasNextPage: next < raw.length, endCursor: next < raw.length ? String(next) : null } } } };
    add(counters.provider, options.body, payload); return Response.json(payload, { headers: { 'X-Shopify-API-Version': '2026-07' } });
  } });
  let stage, attempt = 0;
  const actor = { id: 'owner', sessionVersion: 1, sessionDigest: 'a'.repeat(64), expiresAt: new Date(Date.parse(startedAt) + 3600000).toISOString() };
  function mutation(kind, page = null) {
    const request = { schema: 'runvara-order-recovery/v1', kind, workspaceId, stageId: stage.id,
      admission: stage.admissions.at(-1), expectedStageRevision: kind === 'reserve' ? stage.revision - 1 : stage.revision, actor,
      ...(page ? { page } : { expectedRevision: state._revision, nextRevision: randomUUID(), state, ...(kind === 'reserve' ? { binding: stage.binding } : {}) }) };
    const response = { schema: 'shopify-order-recovery-ack/v1', kind, workspaceId, stageId: stage.id, requestFingerprint: 'sha256:' + 'a'.repeat(64),
      stageRevision: request.expectedStageRevision + 1, expectedRevision: page ? null : request.expectedRevision, nextRevision: page ? null : request.nextRevision,
      logicalBytes: stage.logicalBytes, status: kind === 'finalize' ? 'committed' : stage.status, replayed: false };
    add(counters.stageMutations, JSON.stringify({ p_request: JSON.stringify(request) }), response);
  }
  do {
    attempt++;
    if (recovery) {
      const readInput = { schema: 'runvara-order-recovery/v1', workspaceId, stageId: stage?.id ?? null, actor, view: 'summary' };
      add(counters.summaryReads, JSON.stringify({ p_request: JSON.stringify(readInput) }), stage ? shopifyOrderRecoverySummary(stage) : null);
      add(counters.fullReads, JSON.stringify({ p_request: JSON.stringify({ ...readInput, view: 'full' }) }), stage || null);
      const admission = { runId: `run-${attempt}`, leaseUntil: new Date(Date.parse(startedAt) + 600000).toISOString(), attempt,
        workspaceRevision: state._revision, actorId: actor.id, actorSessionVersion: actor.sessionVersion, sessionDigest: actor.sessionDigest };
      stage = stage ? resumeShopifyOrderRecoveryStage(stage, admission) : createShopifyOrderRecoveryStage({ id: 'stage', binding: createShopifyOrderRecoveryBinding(state, service, { startedAt }), admission });
      mutation('reserve');
      const cap = createShopifyOrderRecoveryCapability({ stage, atomicAppend: true,
        assertCurrent: () => { add(counters.authorityReads, null, { _revision: state._revision, workspace: state.workspace, actor, connection: state.connections[0], run: admission,
          settings: state.connectionSettings?.shopify ?? {}, doctor: state.connectionDoctor?.shopify ?? {}, status: state.integrationStatus?.shopify ?? {}, firstSync: null, sourceGeneration: stage.binding.sourceGeneration }); },
        appendPage: (page, next) => { mutation('append', page); stage = next; } });
      try { await service.syncShopify(state, { areas: ['orders'], orderRecovery: cap }); }
      catch (error) { stage = getShopifyOrderRecoveryStage(cap); if (error.message === 'synthetic interruption') continue; throw error; }
      stage = getShopifyOrderRecoveryStage(cap); mutation('finalize');
    } else {
      try { await service.syncShopify(state, { areas: ['orders'] }); }
      catch (error) { if (error.message === 'synthetic interruption') continue; throw error; }
    }
    await store.save(workspaceId, state);
    break;
  } while (attempt < 5);
  assert.equal(state.orders.length, 500);
  return { attempts: attempt, stageLogicalBytes: stage?.logicalBytes ?? 0, counters,
    totals: Object.values(counters).reduce((sum, item) => ({ requests: sum.requests + item.requests, requestBodyBytes: sum.requestBodyBytes + item.requestBodyBytes,
      decodedResponseBodyBytes: sum.decodedResponseBodyBytes + item.decodedResponseBodyBytes }), { requests: 0, requestBodyBytes: 0, decodedResponseBodyBytes: 0 }) };
}
const ordinaryComplete = await run(false, false), ordinaryInterrupted = await run(false, true), recoveryComplete = await run(true, false), recoveryInterrupted = await run(true, true);
assert.equal(ordinaryComplete.counters.provider.requests, 10); assert.equal(recoveryComplete.counters.provider.requests, 10);
assert.equal(ordinaryInterrupted.counters.provider.requests, 19); assert.equal(recoveryInterrupted.counters.provider.requests, 11);
assert.equal(recoveryComplete.counters.stageMutations.requests, 12); assert.equal(recoveryInterrupted.counters.stageMutations.requests, 13);
console.log(JSON.stringify({ scope: 'Synthetic importer/callback measurement. Stage RPC and authority projections are fixture models; ordinary primary/reporting/mirror requests use the real store against fakeSupabase. Actual store-to-PostgreSQL recovery transport must be measured separately.',
  fixture: { orders: 500, lines: 2000, interruption: 'after eight checkpointed pages, before ninth response' },
  ordinaryComplete, ordinaryInterrupted, recoveryComplete, recoveryInterrupted,
  interpretation: 'Recovery saves eight provider calls in this interrupted fixture. Stage mutations, hydration, authority and ordinary storage still add calls and bytes. This is not a monetary or total-bandwidth saving claim.' }, null, 2));
