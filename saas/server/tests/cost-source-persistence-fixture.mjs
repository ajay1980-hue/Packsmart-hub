import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { seedWorkspaceState } from '../lib/store.mjs';
import { costSourceReviewContext, prepareCostSourceReview } from '../lib/cost-source-review.mjs';

export const ACCEPTED_TREE = '846d356fe85f1689b8361fbb46ddf09f997dbc33';
export const COST_SOURCE_TIME = '2026-10-12T10:00:00.000Z';
export const COST_SOURCE_SELECTOR = Object.freeze({ productId: 'gid://shopify/Product/901',
  variantId: 'gid://shopify/ProductVariant/902', sku: 'SOURCE-SYNTHETIC-902' });
export const COST_SOURCE_ACTOR = Object.freeze({ userId: 'source-owner', sessionVersion: 1,
  workspaceId: 'source-synthetic' });
export const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
export const sourceBasis = (identifier = 'SYNTHETIC-INVOICE-001') => ({ currency: 'GBP', taxBasis: 'unknown',
  effectiveFrom: null, effectiveUntil: null,
  sources: [{ component: 'landed', kind: 'invoice', identifier, issuedOn: '2026-10-01' }] });

export function sourceState() {
  const state = seedWorkspaceState({}, { workspaceId: 'source-synthetic', name: 'Synthetic source fixture',
    slug: 'source-synthetic', email: 'source-fixture@example.invalid' });
  state.workspace.updatedAt = COST_SOURCE_TIME;
  state.users = [{ id: COST_SOURCE_ACTOR.userId, email: 'source-fixture@example.invalid', role: 'owner',
    active: true, passwordChangeRequired: false, sessionVersion: 1 }];
  state.products = [{ id: COST_SOURCE_SELECTOR.productId, externalId: COST_SOURCE_SELECTOR.productId,
    provider: 'shopify', title: 'Synthetic cost source product', variants: [{ id: COST_SOURCE_SELECTOR.variantId,
      externalId: COST_SOURCE_SELECTOR.variantId, sku: COST_SOURCE_SELECTOR.sku, price: '12.50' }] }];
  state.connections = [{ id: 'source-shopify', provider: 'shopify', metadata: {
    shopDomain: 'source-fixture.myshopify.com', shopId: 'gid://shopify/Shop/903' } }];
  state.economics = { [COST_SOURCE_SELECTOR.sku]: { landed: '4.2500', packing: 0, delivery: null,
    supplierVatRecoverable: false, marginFloor: 20, notes: 'Synthetic ordinary cost note', updatedAt: COST_SOURCE_TIME } };
  state.costHistory = [{ id: 'ordinary-source-fixture-history', sku: COST_SOURCE_SELECTOR.sku,
    changedBy: COST_SOURCE_ACTOR.userId, changedFields: ['landed'], before: { landed: null },
    after: { landed: '4.2500' }, createdAt: COST_SOURCE_TIME }];
  return state;
}

export function reviewInput(state, { identifier, requestId = crypto.randomUUID(), basis } = {}) {
  const context = costSourceReviewContext(state, COST_SOURCE_SELECTOR, COST_SOURCE_ACTOR, { now: COST_SOURCE_TIME });
  return { ...COST_SOURCE_SELECTOR, sourceRevision: context.sourceRevision, requestId,
    basis: basis ?? sourceBasis(identifier) };
}

export function appendReview(state, options) {
  const input = reviewInput(state, options);
  const plan = prepareCostSourceReview(state, input, COST_SOURCE_ACTOR, { now: COST_SOURCE_TIME });
  if (!plan.duplicate) {
    state.economics[COST_SOURCE_SELECTOR.sku] = plan.economics;
    state.costHistory = [plan.historyEvent, ...state.costHistory];
  }
  return { input, plan };
}

export function acceptedSource(path) {
  assert.match(path, /^saas\/server\/(?:lib\/store|server)\.mjs$/);
  return execFileSync('git', ['show', `${ACCEPTED_TREE}:${path}`], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)), encoding: 'utf8', maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1' }
  });
}

// The exact accepted store module is evaluated without instantiating a server,
// FileStore, scheduler, worker or integration. Only relative import locations
// are rebased so the historical source can use its unchanged library imports.
export async function acceptedStoreModule() {
  const source = acceptedSource('saas/server/lib/store.mjs');
  const rebased = source.replace(/(from\s+['"])(\.\/[^'"]+)(['"])/g,
    (_, prefix, relative, suffix) => `${prefix}${new URL(relative, new URL('../lib/store.mjs', import.meta.url)).href}${suffix}`);
  return { module: await import(`data:text/javascript;base64,${Buffer.from(rebased).toString('base64')}`),
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex') };
}

// Execute the complete exact legacy DTO function, with unrelated derivations
// stubbed. This proves the actual bootstrap source's disclosure contract; it
// deliberately does not claim to be an HTTP/authentication/derivation test.
export function acceptedBootstrap(state, user) {
  const source = acceptedSource('saas/server/server.mjs');
  const start = source.indexOf('  function bootstrapPayload(state, user, csrf) {');
  const end = source.indexOf('\n  async function activateOwner(', start);
  assert.ok(start > 0 && end > start, 'Accepted bootstrap source must be present');
  const body = source.slice(start, end);
  const empty = () => ({}), list = () => [];
  const context = {
    state, user, env: {}, VERSION: 'accepted-tree', CUSTOMER_ZERO_WORKSPACE: 'customer-zero',
    AUTOMATION_DEFINITIONS: [], AGENT_DEFINITIONS: [], AUTONOMY_LEVELS: [], OPERATIONS_CALCULATION_VERSION: 'fixture',
    deriveOperations: () => ({ orderProfitability: [], orderDetailCoverage: {} }),
    clamp: (_value, _min, _max, fallback) => fallback,
    publicUser: value => ({ id: value.id, role: value.role }), normalizeEmail: value => value,
    currentBrief: empty, deriveBusinessState: empty, deriveLearning: empty, deriveOpportunityQueue: empty,
    runGrowthCouncil: empty, deriveImpact: empty, derivePortfolioAllocation: empty, deriveExecutionPlan: empty,
    revenueEngineSnapshot: empty, marketingSnapshot: empty, webIntelligenceSnapshot: empty,
    publicApproval: empty, publicConnection: empty, publicConnectionWrite: empty,
    intelligentConnections: list, doctorNotifications: list, recommendations: list, connectionCentre: list,
    integrationMatrix: empty, onboardingState: empty, onboardingJourney: empty, agentTeamSnapshot: empty,
    controlSnapshot: empty, integrations: { ebayOAuthStatus: empty }, store: { provider: 'synthetic' },
    scheduler: { status: {} }, orderRecovery: { available: () => false }, publicOrderRecoveryObservation: empty
  };
  const payload = vm.runInNewContext(`${body}\nbootstrapPayload(state, user, 'synthetic-csrf');`, context, { timeout: 1000 });
  return { payload, bootstrapSha256: crypto.createHash('sha256').update(body).digest('hex') };
}
