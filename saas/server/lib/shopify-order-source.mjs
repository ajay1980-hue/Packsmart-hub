import { createHash } from 'node:crypto';
import { evidenceInWorkspace } from './business-evidence-scope.mjs';

export const SHOPIFY_ORDER_SOURCE_LIMITS = Object.freeze({ pages: 10, pageSize: 50, linesPerOrder: 100,
  manifests: 8, manifestBytes: 4096, manifestMapBytes: 16384, metadataBytes: 262144,
  encodingGrowthBytes: 131072, stateBytes: 2097152, commitReserveBytes: 32768, reportingBytes: 2097152,
  amountLength: 33, integerDigits: 24, decimalPlaces: 6, cursorBytes: 4096 });
// Request evidence is versioned independently of the unchanged source-money
// representation and manifest container. Historical v1 references remain valid.
const READ_SCHEMA = 'shopify-order-read/v1', WINDOW_SCHEMA = 'shopify-order-read/v2', MAP_SCHEMA = 'shopify-order-reads/v1';
const REF = /^sor[12]:[a-f0-9]{64}$/;
const VERSION = /^20\d\d-(01|04|07|10)$/;
const CURRENCY = /^[A-Z]{3}$/;
const MONEY_FIELDS = Object.freeze({ total: 'totalPriceSet', currentTotal: 'currentTotalPriceSet', currentTax: 'currentTotalTaxSet', discounts: 'currentTotalDiscountsSet', shippingCharged: 'currentShippingPriceSet' });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const scope = (value, workspaceId, depth = 0) => depth <= 5 && object(value) && evidenceInWorkspace(value, workspaceId)
  && ['workspace', 'tenant'].every(key => !own(value, key) || !object(value[key]) || scope(value[key], workspaceId, depth + 1));
const fieldKey = key => own(MONEY_FIELDS, key) || /^lineItems\/(?:0|[1-9]\d?)\/(?:gross|net)$/.test(key);
const sourceRecord = order => ({ id: order.id, externalId: order.externalId, provider: order.provider,
  createdAt: order.createdAt, updatedAt: order.updatedAt, cancelledAt: order.cancelledAt,
  financialStatus: order.financialStatus, fulfillmentStatus: order.fulfillmentStatus, currency: order.currency,
  money: Object.fromEntries(Object.keys(MONEY_FIELDS).map(key => [key, order[key]])),
  currencyOverrides: order.sourceCurrencyOverrides || {},
  lines: order.lineItems.map(line => ({ id: line.id, sku: line.sku, quantity: line.quantity, gross: line.gross, net: line.net })) });

export function shopifyOrderSourceError(reason = 'INVALID') {
  return Object.assign(new Error('Shopify order source evidence is incomplete; previous orders were retained.'), {
    code: `SHOPIFY_ORDER_SOURCE_${reason}`, status: 422, nonRetryable: true
  });
}
export function assertShopifySourceScope(value, workspaceId) {
  if (!scope(value, workspaceId)) throw shopifyOrderSourceError('SCOPE_MISMATCH');
}
export function validateRetainedShopifyOrderState(state) {
  const workspaceId = state?.workspace?.id;
  assertShopifySourceScope(state, workspaceId); assertShopifySourceScope(state.workspace, workspaceId);
  if (state.orders !== undefined && !Array.isArray(state.orders)) throw shopifyOrderSourceError('RETAINED_ORDER_INVALID');
  const ids = new Set(), sourceIds = new Set();
  for (const order of state.orders || []) {
    if (!object(order)) throw shopifyOrderSourceError('RETAINED_ORDER_INVALID');
    assertShopifySourceScope(order, workspaceId);
    if (order.provider === 'shopify') {
      const sourceId = own(order, 'externalId') ? order.externalId : order.id;
      if (!validId(order.id) || !validId(sourceId)) throw shopifyOrderSourceError('RETAINED_IDENTITY_INVALID');
      if (ids.has(order.id) || sourceIds.has(sourceId)) throw shopifyOrderSourceError('RETAINED_DUPLICATE');
      ids.add(order.id); sourceIds.add(sourceId);
    }
    if (Array.isArray(order.lineItems)) for (const line of order.lineItems) assertShopifySourceScope(line, workspaceId);
  }
}
export function sourceAmount(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > SHOPIFY_ORDER_SOURCE_LIMITS.amountLength || !/^[+-]?(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/.test(value)
    || (value.replace(/^[+-]/, '').split('.')[0].replace(/^0+/, '') || '0').length > SHOPIFY_ORDER_SOURCE_LIMITS.integerDigits) throw shopifyOrderSourceError('AMOUNT_UNSUPPORTED');
  return value;
}
function readMoney(value, workspaceId) {
  if (value === undefined || value === null) return { amount: null, currency: null };
  assertShopifySourceScope(value, workspaceId);
  if (value.shopMoney === undefined || value.shopMoney === null) return { amount: null, currency: null };
  assertShopifySourceScope(value.shopMoney, workspaceId);
  const currency = value.shopMoney.currencyCode;
  if (currency !== undefined && currency !== null && (typeof currency !== 'string' || !CURRENCY.test(currency))) throw shopifyOrderSourceError('CURRENCY_INVALID');
  return { amount: sourceAmount(value.shopMoney.amount), currency: currency ?? null };
}
export function captureShopifyOrderMoney(raw, workspaceId) {
  assertShopifySourceScope(raw, workspaceId);
  if (!validId(raw.id)) throw shopifyOrderSourceError('IDENTITY_INVALID');
  assertShopifySourceScope(raw.lineItems, workspaceId);
  assertShopifySourceScope(raw.lineItems.pageInfo, workspaceId);
  if (raw.lineItems.pageInfo.hasNextPage !== false || !Array.isArray(raw.lineItems.nodes) || raw.lineItems.nodes.length > SHOPIFY_ORDER_SOURCE_LIMITS.linesPerOrder) throw shopifyOrderSourceError('LINES_INCOMPLETE');
  const money = Object.fromEntries(Object.entries(MONEY_FIELDS).map(([field, source]) => [field, readMoney(raw[source], workspaceId)]));
  const currency = money.currentTotal.currency;
  const overrides = {};
  const checkCurrency = (key, value) => { if (value !== currency) overrides[key] = value; };
  for (const [field, pair] of Object.entries(money)) checkCurrency(field, pair.currency);
  const lineIds = new Set();
  const lines = raw.lineItems.nodes.map((line, index) => {
    assertShopifySourceScope(line, workspaceId);
    if (!validId(line.id) || lineIds.has(line.id)) throw shopifyOrderSourceError('LINE_IDENTITY_INVALID');
    lineIds.add(line.id);
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 0) throw shopifyOrderSourceError('LINE_QUANTITY_INVALID');
    const gross = readMoney(line.originalTotalSet, workspaceId), net = readMoney(line.discountedTotalSet, workspaceId);
    checkCurrency(`lineItems/${index}/gross`, gross.currency); checkCurrency(`lineItems/${index}/net`, net.currency);
    return { gross: gross.amount, net: net.amount };
  });
  return { values: { ...Object.fromEntries(Object.entries(money).map(([field, pair]) => [field, pair.amount])),
    currency, tax: null, refunds: null }, lines, ...(Object.keys(overrides).length ? { sourceCurrencyOverrides: overrides } : {}) };
}
export function inspectShopifyOrderPage(data, workspaceId, after, cursorSet) {
  assertShopifySourceScope(data, workspaceId);
  assertShopifySourceScope(data.orders, workspaceId);
  const connection = data.orders;
  assertShopifySourceScope(connection.pageInfo, workspaceId);
  if (!Array.isArray(connection.nodes) || connection.nodes.length > SHOPIFY_ORDER_SOURCE_LIMITS.pageSize || typeof connection.pageInfo.hasNextPage !== 'boolean') throw shopifyOrderSourceError('PAGINATION_INVALID');
  const cursor = connection.pageInfo.endCursor;
  if (cursor !== undefined && cursor !== null && (typeof cursor !== 'string' || !cursor || Buffer.byteLength(cursor) > SHOPIFY_ORDER_SOURCE_LIMITS.cursorBytes)) throw shopifyOrderSourceError('CURSOR_INVALID');
  if (connection.pageInfo.hasNextPage && (!cursor || cursor === after || cursorSet.has(cursor))) throw shopifyOrderSourceError('CURSOR_NOT_ADVANCING');
  if (cursor) cursorSet.add(cursor);
  return { nodes: connection.nodes, hasNextPage: connection.pageInfo.hasNextPage, cursor: cursor || null,
    cursorDigest: cursor ? digest(cursor) : null };
}
export function sourceResponseVersion(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !VERSION.test(value)) throw shopifyOrderSourceError('RESPONSE_VERSION_INVALID');
  return value;
}

export function shopifyOrderReadWindow(startedAt) {
  if (!validDate(startedAt)) throw shopifyOrderSourceError('WINDOW_INVALID');
  const requestedLowerBound = new Date(Date.parse(startedAt) - 90 * 86400000).toISOString().slice(0, 10) + 'T00:00:00.000Z';
  if (!validDate(requestedLowerBound) || requestedLowerBound >= startedAt) throw shopifyOrderSourceError('WINDOW_INVALID');
  return Object.freeze({ requestedLowerBound, requestedUpperBound: startedAt, sortKey: 'UPDATED_AT', reverse: false,
    query: `updated_at:>='${requestedLowerBound}' AND updated_at:<'${startedAt}'` });
}
function requestPolicyValid(manifest) {
  if (manifest.schema === READ_SCHEMA) return typeof manifest.query === 'string' && /^created_at:>=\d{4}-\d\d-\d\d$/.test(manifest.query) && manifest.requestedUpperBound === null
    && ['requestedLowerBound', 'sortKey', 'reverse'].every(key => !own(manifest, key));
  if (manifest.schema !== WINDOW_SCHEMA) return false;
  const window = shopifyOrderReadWindow(manifest.startedAt);
  return Object.entries(window).every(([key, value]) => manifest[key] === value);
}
const manifestReference = manifest => `${manifest.schema === WINDOW_SCHEMA ? 'sor2' : 'sor1'}:${digest(manifest)}`;

function manifestValid(manifest, ref, workspaceId) {
  try {
    if (!object(manifest) || !scope(manifest, workspaceId) || !requestPolicyValid(manifest) || manifest.workspaceId !== workspaceId || manifest.provider !== 'shopify'
      || typeof manifest.requestDomain !== 'string' || manifest.requestDomain.length > 253 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(manifest.requestDomain)
      || !VERSION.test(manifest.requestedApiVersion) || manifest.sourceAccountId !== null || manifest.currentScopes !== 'not_observed'
      || !validDate(manifest.startedAt) || !validDate(manifest.finishedAt) || manifest.startedAt > manifest.finishedAt
      || manifest.first !== 50 || manifest.pageLimit !== 10 || manifest.lineLimit !== 100 || manifest.moneyBasis !== 'shopMoney'
      || typeof manifest.recordsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.recordsDigest)
      || manifest.queryExhaustion !== 'observed_exhausted' || manifest.sourcePeriod !== 'unverified' || manifest.allReturnedLinePagesExhausted !== true
      || !Array.isArray(manifest.pages) || !manifest.pages.length || manifest.pages.length > 10
      || !Number.isSafeInteger(manifest.ordersRead) || !Number.isSafeInteger(manifest.linesRead) || manifest.linesRead < 0 || manifest.linesRead > manifest.ordersRead * 100
      || bytes(manifest) > SHOPIFY_ORDER_SOURCE_LIMITS.manifestBytes) return false;
    let count = 0;
    for (const [index, page] of manifest.pages.entries()) {
      if (!scope(page, workspaceId) || !Number.isSafeInteger(page.rows) || page.rows < 0 || page.rows > 50 || page.hasNextPage !== (index < manifest.pages.length - 1)
        || !(page.cursorDigest === null || typeof page.cursorDigest === 'string' && /^[a-f0-9]{64}$/.test(page.cursorDigest))
        || (page.hasNextPage && !page.cursorDigest) || !(page.apiVersion === null || typeof page.apiVersion === 'string' && VERSION.test(page.apiVersion))) return false;
      count += page.rows;
    }
    return count === manifest.ordersRead && typeof ref === 'string' && REF.test(ref) && ref === manifestReference(manifest);
  } catch { return false; }
}
const preparedReads = new WeakMap();
export function prepareShopifyOrderRead(config, orders, pages, { query, startedAt, finishedAt = new Date().toISOString(), legacyBytes, window }) {
  const manifest = { schema: window === undefined ? READ_SCHEMA : WINDOW_SCHEMA, workspaceId: config.workspaceId, provider: 'shopify', requestDomain: config.domain,
    requestedApiVersion: config.apiVersion || '2026-07', sourceAccountId: null, currentScopes: 'not_observed', query,
    ...(window === undefined ? { requestedUpperBound: null } : { requestedLowerBound: window?.requestedLowerBound,
      requestedUpperBound: window?.requestedUpperBound, sortKey: window?.sortKey, reverse: window?.reverse }),
    startedAt, finishedAt, first: 50, pageLimit: 10, lineLimit: 100, ordersRead: orders.length,
    linesRead: orders.reduce((total, order) => total + order.lineItems.length, 0), recordsDigest: digest(orders.map(sourceRecord)), pages,
    allReturnedLinePagesExhausted: true, queryExhaustion: 'observed_exhausted', sourcePeriod: 'unverified', moneyBasis: 'shopMoney' };
  const ref = manifestReference(manifest);
  if (!manifestValid(manifest, ref, config.workspaceId)) throw shopifyOrderSourceError('MANIFEST_INVALID');
  const result = { orders: orders.map(order => ({ ...order, sourceReadRef: ref })), manifest, ref, legacyBytes };
  preparedReads.set(result, { ordersDigest: digest(result.orders), legacyBytes, ref });
  return result;
}
function validOverrides(order) {
  if (!own(order, 'sourceCurrencyOverrides')) return true;
  const overrides = order.sourceCurrencyOverrides;
  return object(overrides) && Object.keys(overrides).length <= 205 && Object.entries(overrides).every(([key, value]) => fieldKey(key)
    && (value === null || typeof value === 'string' && CURRENCY.test(value))
    && (!key.startsWith('lineItems/') || Number(key.split('/')[1]) < (Array.isArray(order.lineItems) ? order.lineItems.length : 0)));
}
function validSourceOrder(order) {
  try {
    return object(order) && order.provider === 'shopify' && typeof order.sourceReadRef === 'string' && REF.test(order.sourceReadRef) && validOverrides(order)
      && (order.currency === null || typeof order.currency === 'string' && CURRENCY.test(order.currency))
      && Object.keys(MONEY_FIELDS).every(field => sourceAmount(order[field]) === (order[field] ?? null)) && order.tax == null && order.refunds == null
      && Array.isArray(order.lineItems) && order.lineItems.length <= 100
      && order.lineItems.every(line => object(line) && sourceAmount(line.gross) === (line.gross ?? null) && sourceAmount(line.net) === (line.net ?? null));
  } catch { return false; }
}
export function inspectShopifyOrderSource(state, order, workspaceId) {
  const captured = object(order) && (own(order, 'sourceReadRef') || own(order, 'sourceCurrencyOverrides'));
  if (!captured) return { format: 'legacy', scopeValid: true, manifestStatus: 'not_applicable', fingerprint: 'legacy', currencyFor: () => order?.currency ?? null };
  let fingerprint = null;
  try { const metadata = { ref: order.sourceReadRef, currencies: order.sourceCurrencyOverrides }; if (bytes(metadata) <= SHOPIFY_ORDER_SOURCE_LIMITS.metadataBytes) fingerprint = digest(metadata); } catch {}
  const overridesScoped = !own(order, 'sourceCurrencyOverrides') || scope(order.sourceCurrencyOverrides, workspaceId);
  const valid = validSourceOrder(order);
  const result = { format: valid ? 'source' : 'invalid', scopeValid: overridesScoped, manifestStatus: 'unavailable', fingerprint,
    currencyFor: field => valid && fieldKey(field) ? (own(order.sourceCurrencyOverrides || {}, field) ? order.sourceCurrencyOverrides[field] : order.currency) : null };
  const container = state?.channelData?.shopify?.orderReads;
  if (!container) return result;
  if (!scope(state.channelData, workspaceId) || !scope(state.channelData.shopify, workspaceId) || !scope(container, workspaceId)) return { ...result, scopeValid: false, manifestStatus: 'invalid' };
  if (container.schema !== MAP_SCHEMA || !object(container.manifests) || Object.keys(container.manifests).length > 8) return { ...result, manifestStatus: 'invalid' };
  if (!scope(container.manifests, workspaceId)) return { ...result, scopeValid: false, manifestStatus: 'invalid' };
  try { if (bytes(container) > SHOPIFY_ORDER_SOURCE_LIMITS.manifestMapBytes) return { ...result, manifestStatus: 'invalid' }; }
  catch { return { ...result, manifestStatus: 'invalid' }; }
  const manifest = container.manifests[order.sourceReadRef];
  if (!manifest) return result;
  if (!scope(manifest, workspaceId)) return { ...result, scopeValid: false, manifestStatus: 'invalid' };
  if (Array.isArray(manifest.pages) && manifest.pages.some(page => object(page) && !scope(page, workspaceId))) return { ...result, scopeValid: false, manifestStatus: 'invalid' };
  return { ...result, manifestStatus: manifestValid(manifest, order.sourceReadRef, workspaceId) ? 'retained' : 'invalid' };
}
export function orderFinancialMirrorRow(workspaceId, order, now = new Date().toISOString()) {
  const source = validSourceOrder(order) ? { total: order.total, sourceFormat: READ_SCHEMA, sourceCurrency: order.currency,
    ...(own(order, 'sourceCurrencyOverrides') ? { sourceCurrencyOverrides: order.sourceCurrencyOverrides } : {}) } : {};
  return { workspace_id: workspaceId, order_id: order.id, provider: order.provider || 'shopify', financial_data: {
    currentTotal: order.currentTotal, discounts: order.discounts, refunds: order.refunds, tax: order.tax, currentTax: order.currentTax,
    shippingCharged: order.shippingCharged, actualShippingCost: order.actualShippingCost, paymentFees: order.paymentFees,
    channelFees: order.channelFees, advertisingCost: order.advertisingCost, otherVariableCosts: order.otherVariableCosts,
    paymentGatewayNames: order.paymentGatewayNames || [], ...source }, line_items: order.lineItems || [], updated_at: order.updatedAt || now };
}
export function orderReportingCurrency(order) {
  if (!validSourceOrder(order)) return order.currency || 'GBP';
  return own(order.sourceCurrencyOverrides || {}, 'total') ? order.sourceCurrencyOverrides.total : order.currency;
}
function validateManifestMap(container, workspaceId) {
  if (container === undefined || container === null) return {};
  if (!scope(container, workspaceId) || container.schema !== MAP_SCHEMA || !scope(container.manifests, workspaceId) || Object.keys(container.manifests).length > 8
    || bytes(container) > SHOPIFY_ORDER_SOURCE_LIMITS.manifestMapBytes
    || Object.entries(container.manifests).some(([ref, manifest]) => !manifestValid(manifest, ref, workspaceId))) throw shopifyOrderSourceError('RETAINED_METADATA_INVALID');
  return container.manifests;
}
function assertReportingAmounts(orders) {
  for (const order of orders) {
    if (validSourceOrder(order) && order.total === null) throw shopifyOrderSourceError('REPORTING_AMOUNT_UNAVAILABLE');
    if (validSourceOrder(order) && orderReportingCurrency(order) === null) throw shopifyOrderSourceError('REPORTING_CURRENCY_UNAVAILABLE');
    const numeric = Number(order.total);
    if (!Number.isFinite(numeric)) continue; // Preserve existing legacy mirror behavior; captured fields are validated above.
    const absolute = Math.abs(numeric);
    if (absolute >= 1e12) throw shopifyOrderSourceError('REPORTING_AMOUNT_RANGE');
    const encoded = String(absolute);
    if (encoded.includes('e')) continue; // Only tiny values remain after the range check; their explicitly lossy cent projection fits.
    const [whole, fraction = ''] = encoded.split('.');
    const cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)) + (Number(fraction[2] || 0) >= 5 ? 1n : 0n);
    if (cents > 99999999999999n) throw shopifyOrderSourceError('REPORTING_AMOUNT_RANGE');
  }
}
export function stageShopifyOrderRead(candidate, read, previousState) {
  const workspaceId = candidate?.workspace?.id;
  assertShopifySourceScope(candidate, workspaceId); assertShopifySourceScope(candidate.workspace, workspaceId);
  validateRetainedShopifyOrderState(candidate);
  const prepared = preparedReads.get(read);
  if (!prepared || read.manifest.workspaceId !== workspaceId || !manifestValid(read.manifest, read.ref, workspaceId)
    || read.ref !== prepared.ref || read.legacyBytes !== prepared.legacyBytes || !Number.isSafeInteger(read.legacyBytes) || read.legacyBytes < 2
    || read.orders.length !== read.manifest.ordersRead || read.orders.some(order => order.sourceReadRef !== read.ref || !validSourceOrder(order))
    || digest(read.orders) !== prepared.ordersDigest) throw shopifyOrderSourceError('READ_INVALID');
  for (const container of [candidate.channelData, candidate.channelData?.shopify]) if (container !== undefined && container !== null) assertShopifySourceScope(container, workspaceId);
  const prior = previousState.channelData?.shopify?.orderReads;
  const existing = validateManifestMap(prior, workspaceId);
  const referenced = new Set(candidate.orders.filter(object).map(order => order.sourceReadRef).filter(Boolean));
  const entries = [[read.ref, read.manifest], ...Object.entries(existing).filter(([ref]) => ref !== read.ref)
    .sort(([left, a], [right, b]) => Number(referenced.has(right)) - Number(referenced.has(left)) || b.finishedAt.localeCompare(a.finishedAt))];
  const container = { schema: MAP_SCHEMA, workspaceId, manifests: {}, lastSuccess: read.ref,
    lastAttempt: { status: 'complete', at: read.manifest.finishedAt, retryable: false } };
  for (const [ref, manifest] of entries) {
    if (Object.keys(container.manifests).length >= 8) break;
    const next = { ...container, manifests: { ...container.manifests, [ref]: manifest } };
    if (bytes(next) <= SHOPIFY_ORDER_SOURCE_LIMITS.manifestMapBytes) container.manifests[ref] = manifest;
  }
  if (!container.manifests[read.ref]) throw shopifyOrderSourceError('MANIFEST_LIMIT');
  candidate.channelData = { ...candidate.channelData, shopify: { ...candidate.channelData?.shopify, orderReads: container } };
  let metadataBytes = bytes(container);
  for (const order of candidate.orders) {
    if (!object(order)) throw shopifyOrderSourceError('RETAINED_ORDER_INVALID');
    if (order.provider === 'shopify') assertShopifySourceScope(order, workspaceId);
    const metadata = Object.fromEntries(['sourceReadRef', 'sourceCurrencyOverrides'].filter(key => own(order, key)).map(key => [key, order[key]]));
    if (Object.keys(metadata).length) metadataBytes += bytes(metadata);
  }
  if (metadataBytes > SHOPIFY_ORDER_SOURCE_LIMITS.metadataBytes) throw shopifyOrderSourceError('METADATA_LIMIT');
  const growth = Math.max(0, bytes(read.orders) - read.legacyBytes) + Math.max(0, bytes(container) - (prior ? bytes(prior) : 0));
  if (!Number.isFinite(growth) || growth > SHOPIFY_ORDER_SOURCE_LIMITS.encodingGrowthBytes) throw shopifyOrderSourceError('ENCODING_LIMIT');
  // Detached candidate only. Reserve bounded room for the caller's existing
  // completion/audit/revision metadata; the store's final 2 MiB guard stays intact.
  if (bytes(candidate) >= SHOPIFY_ORDER_SOURCE_LIMITS.stateBytes - SHOPIFY_ORDER_SOURCE_LIMITS.commitReserveBytes) throw shopifyOrderSourceError('STATE_LIMIT');
  assertReportingAmounts(candidate.orders);
  if (bytes(candidate.orders.map(order => orderFinancialMirrorRow(workspaceId, order, read.manifest.finishedAt))) > SHOPIFY_ORDER_SOURCE_LIMITS.reportingBytes) throw shopifyOrderSourceError('REPORTING_LIMIT');
  return { metadataBytes, encodingGrowthBytes: growth, candidateBytes: bytes(candidate) };
}
export function recordShopifyOrderReadFailure(state, error, at = new Date().toISOString(), binding = null) {
  if (!String(error?.code || '').startsWith('SHOPIFY_ORDER_SOURCE_') || !binding || binding.workspaceId !== state.workspace?.id || binding.provider !== 'shopify') return;
  state.integrationStatus = { ...state.integrationStatus, shopify: { ...state.integrationStatus?.shopify,
    orderReadHold: { code: error.code, at, binding }, orderReadAttempt: { status: 'incomplete', code: error.code, at, retryable: false } } };
}
