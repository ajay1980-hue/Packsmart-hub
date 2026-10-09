import { createHash } from 'node:crypto';
import { connectionSettings, SHOPIFY_ORDER_READ_POLICY, shopifyOrderReadBinding } from './connection-centre.mjs';
import { shopifyOrderReadWindow, sourceAmount } from './shopify-order-source.mjs';

export const SHOPIFY_ORDER_RECOVERY_CONTRACT = 'runvara-order-recovery/v1';
export const SHOPIFY_ORDER_RECOVERY_PARSER_POLICY = 'shopify-order-source/v1';
export const SHOPIFY_ORDER_RECOVERY_LIMITS = Object.freeze({ stages: 8, stageBytes: 2097152, globalBytes: 16777216,
  controlBytes: 4096, receiptBytes: 16384, pages: 10, orders: 500, pageSize: 50, lines: 100, admissions: 5,
  ackBytes: 2048, summaryBytes: 32768, fullBytes: 2162688, requestBytes: 2162688, encodedRequestBytes: 4325440, inputBytes: 8192 });
const BINDING = 'shopify-order-recovery-binding/v1', STAGE = 'shopify-order-recovery-stage/v1', PAGE = 'shopify-order-recovery-page/v1';
const VERSION = /^20\d\d-(01|04|07|10)$/, HASH = /^[a-f0-9]{64}$/, REF = /^sor[123]:[a-f0-9]{64}$/;
const COSTS = ['actualShippingCost', 'paymentFees', 'channelFees', 'advertisingCost', 'otherVariableCosts'];
const MONEY = ['total', 'currentTotal', 'currentTax', 'discounts', 'shippingCharged'];
const ORDER_KEYS = ['id', 'externalId', 'provider', 'name', 'createdAt', 'updatedAt', 'cancelledAt', 'financialStatus', 'fulfillmentStatus',
  'customerEmailHash', 'statusPageUrl', ...MONEY, 'currency', 'tax', 'refunds', 'paymentGatewayNames', ...COSTS, 'lineItems'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const clone = value => structuredClone(value);
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, max = 256, empty = false) => typeof value === 'string' && (empty || value.length > 0) && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sourceDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
function keys(value, required, optional = []) {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(descriptors);
  return required.every(key => Object.hasOwn(descriptors, key)) && actual.every(key => typeof key === 'string' && [...required, ...optional].includes(key)
    && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable);
}
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const shopifyOrderRecoveryFingerprint = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
export function shopifyOrderRecoveryError(reason = 'INVALID') {
  return Object.assign(new Error('Shopify order recovery needs review; previous orders were retained.'), {
    code: `SHOPIFY_ORDER_RECOVERY_${reason}`, status: 409, nonRetryable: true
  });
}
const requireThat = (condition, reason = 'INVALID') => { if (!condition) throw shopifyOrderRecoveryError(reason); };
function validateBinding(binding) {
  requireThat(keys(binding, ['schema', 'workspaceId', 'source', 'parserPolicy', 'queryPolicy', 'settingsRevision', 'sourceGeneration', 'startedAt', 'window', 'firstSync']), 'BINDING_INVALID');
  requireThat(binding.schema === BINDING && text(binding.workspaceId) && binding.parserPolicy === SHOPIFY_ORDER_RECOVERY_PARSER_POLICY
    && binding.queryPolicy === SHOPIFY_ORDER_READ_POLICY && integer(binding.settingsRevision) && date(binding.startedAt)
    && (binding.sourceGeneration === null || typeof binding.sourceGeneration === 'string' && REF.test(binding.sourceGeneration)), 'BINDING_INVALID');
  const source = binding.source;
  requireThat(keys(source, ['schema', 'workspaceId', 'provider', 'domain', 'connectionId', 'accountId', 'apiVersion', 'sourcePolicy'])
    && source.schema === 'shopify-order-hold/v1' && source.workspaceId === binding.workspaceId && source.provider === 'shopify'
    && text(source.connectionId) && text(source.accountId, 300, true) && typeof source.domain === 'string' && source.domain.length <= 253
    && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(source.domain) && VERSION.test(source.apiVersion)
    && source.sourcePolicy === SHOPIFY_ORDER_READ_POLICY, 'SOURCE_INVALID');
  const expectedWindow = shopifyOrderReadWindow(binding.startedAt);
  requireThat(keys(binding.window, Object.keys(expectedWindow)) && equal(binding.window, expectedWindow), 'WINDOW_INVALID');
  const first = binding.firstSync;
  requireThat(first === null || keys(first, ['startedAt', 'actor', 'identityVerifiedAt']) && date(first.startedAt)
    && text(first.actor, 300) && date(first.identityVerifiedAt), 'FIRST_SYNC_INVALID');
  return binding;
}
export function createShopifyOrderRecoveryBinding(state, integrations, { startedAt = new Date().toISOString() } = {}) {
  const source = shopifyOrderReadBinding(state, integrations), first = state.connectionFirstSync?.shopify;
  // Only verified, unfinished orders are part of this recovery. Historical
  // first-sync records remain unrelated state and must survive unchanged.
  const firstEligible = first && ['pending', 'running', 'failed'].includes(first.areas?.orders)
    && date(first.startedAt) && text(first.actor, 300) && date(first.identityVerifiedAt);
  const binding = { schema: BINDING, workspaceId: state.workspace?.id, source, parserPolicy: SHOPIFY_ORDER_RECOVERY_PARSER_POLICY,
    queryPolicy: SHOPIFY_ORDER_READ_POLICY, settingsRevision: connectionSettings(state, 'shopify').revision,
    sourceGeneration: state.channelData?.shopify?.orderReads?.lastSuccess ?? null, startedAt, window: shopifyOrderReadWindow(startedAt),
    firstSync: firstEligible ? { startedAt: first.startedAt, actor: first.actor, identityVerifiedAt: first.identityVerifiedAt } : null };
  validateBinding(binding); return clone(binding);
}
function validateAdmission(admission) {
  requireThat(keys(admission, ['runId', 'leaseUntil', 'attempt', 'workspaceRevision', 'actorId', 'actorSessionVersion', 'sessionDigest'])
    && text(admission.runId) && date(admission.leaseUntil) && integer(admission.attempt, 1, 5) && typeof admission.workspaceRevision === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(admission.workspaceRevision)
    && text(admission.actorId) && integer(admission.actorSessionVersion, 1) && typeof admission.sessionDigest === 'string' && HASH.test(admission.sessionDigest), 'ADMISSION_INVALID');
}
function validateOrder(order, binding, identities, previousUpdatedAt) {
  requireThat(keys(order, ORDER_KEYS, ['sourceCurrencyOverrides']) && text(order.id) && order.externalId === order.id && order.provider === 'shopify', 'ORDER_INVALID');
  requireThat(!identities.has(order.id), 'DUPLICATE_ORDER'); identities.add(order.id);
  requireThat(['name', 'financialStatus', 'fulfillmentStatus'].every(key => typeof order[key] === 'string')
    && sourceDate(order.createdAt) && sourceDate(order.updatedAt) && (order.cancelledAt === null || sourceDate(order.cancelledAt))
    && (order.customerEmailHash === null || typeof order.customerEmailHash === 'string' && HASH.test(order.customerEmailHash))
    && (order.statusPageUrl === null || typeof order.statusPageUrl === 'string') && Array.isArray(order.paymentGatewayNames)
    && order.paymentGatewayNames.length <= 10 && order.paymentGatewayNames.every(value => typeof value === 'string')
    && (order.currency === null || typeof order.currency === 'string' && /^[A-Z]{3}$/.test(order.currency))
    && order.tax === null && order.refunds === null && COSTS.every(key => order[key] === null), 'ORDER_INVALID');
  for (const key of MONEY) requireThat(order[key] === null || typeof order[key] === 'string' && sourceAmount(order[key]) === order[key], 'MONEY_INVALID');
  const updatedAt = Date.parse(order.updatedAt);
  requireThat(updatedAt >= Date.parse(binding.window.requestedLowerBound) && updatedAt < Date.parse(binding.window.requestedUpperBound)
    && (previousUpdatedAt === null || updatedAt >= previousUpdatedAt), 'ORDER_WINDOW_INVALID');
  requireThat(Array.isArray(order.lineItems) && order.lineItems.length <= 100, 'LINES_INVALID');
  const lineIds = new Set();
  for (const line of order.lineItems) {
    requireThat(keys(line, ['id', 'name', 'sku', 'quantity', 'gross', 'net']) && text(line.id) && !lineIds.has(line.id)
      && typeof line.name === 'string' && typeof line.sku === 'string' && integer(line.quantity), 'LINES_INVALID');
    lineIds.add(line.id);
    for (const key of ['gross', 'net']) requireThat(line[key] === null || typeof line[key] === 'string' && sourceAmount(line[key]) === line[key], 'MONEY_INVALID');
  }
  if (Object.hasOwn(order, 'sourceCurrencyOverrides')) {
    const overrides = order.sourceCurrencyOverrides;
    requireThat(object(overrides) && Object.keys(overrides).length <= 205, 'CURRENCY_INVALID');
    for (const [key, value] of Object.entries(overrides)) {
      const match = /^lineItems\/(0|[1-9]\d?)\/(gross|net)$/.exec(key);
      requireThat((MONEY.includes(key) || match && Number(match[1]) < order.lineItems.length)
        && (value === null || typeof value === 'string' && /^[A-Z]{3}$/.test(value)), 'CURRENCY_INVALID');
    }
  }
  return updatedAt;
}
export function shopifyOrderRecoveryLogicalBytes(stage) {
  return bytes({ ...stage, logicalBytes: 0, status: 'superseded', revision: 99, continued: false }) + 2048 * (stage.admissions.length + stage.pages.length + 1);
}
function validateStage(stage, allowOversize = false) {
  requireThat(keys(stage, ['schema', 'id', 'binding', 'revision', 'status', 'admissions', 'pages', 'after', 'legacyBytes', 'logicalBytes', 'continued'])
    && stage.schema === STAGE && text(stage.id) && integer(stage.revision, 1, 99)
    && ['reading', 'complete', 'failed', 'paused', 'unknown', 'committed', 'superseded'].includes(stage.status)
    && Array.isArray(stage.admissions) && stage.admissions.length >= 1 && stage.admissions.length <= 5
    && Array.isArray(stage.pages) && stage.pages.length <= 10 && typeof stage.continued === 'boolean', 'STAGE_INVALID');
  validateBinding(stage.binding);
  const runIds = new Set(); let attempt = 0;
  for (const admission of stage.admissions) {
    validateAdmission(admission);
    requireThat(!runIds.has(admission.runId) && admission.attempt > attempt && admission.leaseUntil > stage.binding.startedAt, 'ADMISSION_INVALID');
    runIds.add(admission.runId); attempt = admission.attempt;
  }
  requireThat(stage.continued === (stage.admissions.length > 1) && stage.revision >= stage.admissions.length + stage.pages.length, 'STAGE_INVALID');
  const identities = new Set(), cursors = new Set(); let after = null, legacyBytes = 2, nonempty = 0, priorTime = stage.binding.startedAt, previousUpdatedAt = null;
  for (const [index, page] of stage.pages.entries()) {
    requireThat(keys(page, ['schema', 'index', 'after', 'cursor', 'orders', 'legacyBytes', 'evidence', 'capturedAt']) && page.schema === PAGE
      && page.index === index && page.after === after && (page.cursor === null || typeof page.cursor === 'string' && page.cursor.length > 0 && Buffer.byteLength(page.cursor) <= 4096)
      && Array.isArray(page.orders) && page.orders.length <= 50 && integer(page.legacyBytes, 2, 2097152)
      && date(page.capturedAt) && page.capturedAt >= priorTime, 'PAGE_INVALID');
    const evidence = page.evidence;
    requireThat(keys(evidence, ['rows', 'hasNextPage', 'cursorDigest', 'apiVersion']) && evidence.rows === page.orders.length
      && typeof evidence.hasNextPage === 'boolean' && (evidence.hasNextPage || index === stage.pages.length - 1)
      && (!evidence.hasNextPage || page.cursor !== null && page.orders.length > 0)
      && evidence.cursorDigest === (page.cursor === null ? null : shopifyOrderRecoveryFingerprint(JSON.stringify(page.cursor)))
      && (evidence.apiVersion === null || typeof evidence.apiVersion === 'string' && VERSION.test(evidence.apiVersion)), 'EVIDENCE_INVALID');
    requireThat(page.cursor === null || !cursors.has(page.cursor), 'CURSOR_INVALID');
    if (page.cursor !== null) cursors.add(page.cursor);
    if (!page.orders.length) requireThat(page.legacyBytes === 2, 'LEGACY_BYTES_INVALID');
    for (const order of page.orders) previousUpdatedAt = validateOrder(order, stage.binding, identities, previousUpdatedAt);
    legacyBytes += page.legacyBytes - 2; if (page.orders.length) nonempty += 1;
    after = page.cursor; priorTime = page.capturedAt;
  }
  legacyBytes += Math.max(0, nonempty - 1);
  const exhausted = stage.pages.length > 0 && stage.pages.at(-1).evidence.hasNextPage === false;
  requireThat(stage.after === after && stage.legacyBytes === legacyBytes && integer(stage.logicalBytes, 1, allowOversize ? Number.MAX_SAFE_INTEGER : 2097152)
    && stage.logicalBytes === shopifyOrderRecoveryLogicalBytes(stage) && (stage.status !== 'complete' && stage.status !== 'committed' || exhausted)
    && (stage.status !== 'reading' || !exhausted) && !(stage.pages.length === 10 && !exhausted && stage.status !== 'paused' && stage.status !== 'superseded'), 'STAGE_INVALID');
  return stage;
}
export function validateShopifyOrderRecoveryStage(stage) { return validateStage(stage); }
function charged(stage) {
  stage.logicalBytes = shopifyOrderRecoveryLogicalBytes(stage);
  validateStage(stage, true);
  requireThat(stage.logicalBytes <= SHOPIFY_ORDER_RECOVERY_LIMITS.stageBytes, 'STAGE_LIMIT');
  validateShopifyOrderRecoveryStage(stage); return stage;
}
export function createShopifyOrderRecoveryStage({ id, binding, admission }) {
  return charged({ schema: STAGE, id, binding: clone(binding), revision: 1, status: 'reading', admissions: [clone(admission)], pages: [], after: null, legacyBytes: 2, logicalBytes: 0, continued: false });
}
export function resumeShopifyOrderRecoveryStage(stage, admission) {
  validateShopifyOrderRecoveryStage(stage);
  requireThat(['reading', 'failed', 'complete'].includes(stage.status) && stage.admissions.length < 5, 'NOT_RESUMABLE');
  const next = clone(stage); next.admissions.push(clone(admission)); next.revision += 1; next.continued = true;
  next.status = next.pages.at(-1)?.evidence.hasNextPage === false ? 'complete' : 'reading'; return charged(next);
}
export function appendShopifyOrderRecoveryPage(stage, page) {
  validateShopifyOrderRecoveryStage(stage); requireThat(stage.status === 'reading' && stage.pages.length < 10, 'NOT_READING');
  const next = clone(stage); next.pages.push(clone(page)); next.after = page.cursor; next.revision += 1;
  next.status = page.evidence?.hasNextPage === false ? 'complete' : next.pages.length === 10 ? 'paused' : 'reading';
  next.legacyBytes = 2 + next.pages.reduce((sum, value) => sum + value.legacyBytes - 2, 0) + Math.max(0, next.pages.filter(value => value.orders.length).length - 1);
  return charged(next);
}
export function shopifyOrderRecoveryObservation(stage) {
  validateShopifyOrderRecoveryStage(stage);
  requireThat(stage.pages.length > 0, 'OBSERVATION_INVALID');
  return { schema: 'shopify-order-recovery-observation/v1', stageId: stage.id, continued: stage.continued,
    originalStartedAt: stage.binding.startedAt, lastCapturedAt: stage.pages.at(-1).capturedAt,
    pageCaptureTimes: stage.pages.map(page => page.capturedAt), snapshotConsistency: 'unverified' };
}
export function shopifyOrderRecoverySummary(stage) {
  validateShopifyOrderRecoveryStage(stage);
  const { pages, after, ...summary } = clone(stage);
  return { ...summary, pageCount: pages.length, ordersRead: pages.reduce((count, page) => count + page.orders.length, 0),
    lastCapturedAt: pages.at(-1)?.capturedAt ?? null, pageCaptureTimes: pages.map(page => page.capturedAt), snapshotConsistency: 'unverified' };
}
const capabilities = new WeakMap();
export function createShopifyOrderRecoveryCapability({ stage, assertCurrent, appendPage, atomicAppend = false }) {
  validateShopifyOrderRecoveryStage(stage);
  requireThat(['reading', 'complete'].includes(stage.status) && typeof assertCurrent === 'function' && typeof appendPage === 'function' && typeof atomicAppend === 'boolean', 'CAPABILITY_INVALID');
  const capability = Object.freeze({}); capabilities.set(capability, { stage: clone(stage), assertCurrent, appendPage, atomicAppend, claimed: false, busy: false, failed: false }); return capability;
}
function capabilityState(capability) {
  const entry = capabilities.get(capability); requireThat(Boolean(entry), 'CAPABILITY_INVALID'); return entry;
}
export function assertShopifyOrderRecoveryCapability(capability, config) {
  const entry = capabilityState(capability), source = entry.stage.binding.source;
  requireThat(!entry.failed && Date.now() < Date.parse(entry.stage.admissions.at(-1).leaseUntil), 'LEASE_EXPIRED');
  if (config) requireThat(config.workspaceId === source.workspaceId && config.domain === source.domain && (config.apiVersion || '2026-07') === source.apiVersion
    && config.connection?.id === source.connectionId && String(config.connection?.metadata?.shopId || config.connection?.metadata?.accountId || '') === source.accountId, 'SOURCE_CHANGED');
  return true;
}
export function claimShopifyOrderRecoveryCapability(capability, config) {
  const entry = capabilityState(capability); assertShopifyOrderRecoveryCapability(capability, config);
  requireThat(!entry.claimed, 'CAPABILITY_USED'); entry.claimed = true; return clone(entry.stage);
}
export function inspectShopifyOrderRecoveryCapability(capability) { const entry = capabilities.get(capability); return entry ? { stage: clone(entry.stage), claimed: entry.claimed, failed: entry.failed } : null; }
export function getShopifyOrderRecoveryStage(capability) { return inspectShopifyOrderRecoveryCapability(capability)?.stage ?? null; }
export async function authorizeShopifyOrderRecovery(capability, phase, config) {
  const entry = capabilityState(capability); assertShopifyOrderRecoveryCapability(capability, config);
  const result = await entry.assertCurrent({ phase, stage: clone(entry.stage), admission: clone(entry.stage.admissions.at(-1)) });
  requireThat(result !== false, 'AUTHORITY_CHANGED'); assertShopifyOrderRecoveryCapability(capability, config);
}
export async function checkpointShopifyOrderRecoveryPage(capability, page) {
  const entry = capabilityState(capability); assertShopifyOrderRecoveryCapability(capability);
  requireThat(entry.claimed && !entry.busy, 'CAPABILITY_INVALID');
  let next, overflow;
  try { next = appendShopifyOrderRecoveryPage(entry.stage, page); }
  catch (error) {
    if (error.code !== 'SHOPIFY_ORDER_RECOVERY_STAGE_LIMIT') throw error;
    // The whole proposed page was validated before the logical-size check.
    // Let the transaction durably record the capacity pause without appending
    // that page, so restarts cannot silently retry the overflowing traversal.
    overflow = error;
  }
  entry.busy = true;
  try {
    if (!entry.atomicAppend) await authorizeShopifyOrderRecovery(capability, 'append');
    assertShopifyOrderRecoveryCapability(capability);
    const result = await entry.appendPage(clone(page), next ? clone(next) : null);
    if (overflow) throw overflow;
    requireThat(result !== false, 'APPEND_UNCONFIRMED'); entry.stage = next; return clone(next);
  } catch (error) { entry.failed = true; throw error; }
  finally { entry.busy = false; }
}
