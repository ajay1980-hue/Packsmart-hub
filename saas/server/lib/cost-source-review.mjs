import crypto from 'node:crypto';
import { types } from 'node:util';
import { ECONOMICS_FIELDS, hasAmount } from './profit.mjs';

// Saved, mutable operator attestations only. Nothing in this module reads a
// credential, calls a provider, changes state, or grants execution authority.
export const COST_SOURCE_REVIEW_SCHEMA = 'runvara-cost-source-review/v1';
export const COST_SOURCE_REVIEW_MAX_BYTES = 2048;
export const COST_SOURCE_HISTORY_MAX_BYTES = 65536;
export const COST_SOURCE_COMPONENTS = Object.freeze(ECONOMICS_FIELDS.filter(field => field !== 'marginFloor'));
const COMPONENTS = COST_SOURCE_COMPONENTS;
const OWN = (value, key) => Object.hasOwn(value, key);
const SECRET = /(?:credential|password|token|secret|api[_-]?key)/i;
const MARKERS = ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'workspace', 'tenant'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const NOTICE = 'Source identifiers are mutable owner/admin attestations about saved costs. They are not verified invoices, live Shopify provenance, tax advice, profit evidence, or permission to execute. Unknown facts and all existing holds remain unchanged.';

function fail(code = 'COST_SOURCE_INVALID', message = 'The saved cost source could not be verified. Refresh and review the saved target.', status = 409) {
  throw Object.assign(new Error(message), { code, status });
}
function object(value, limit = 128, root = false) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > limit) fail('COST_SOURCE_SCAN_LIMIT', 'Saved source data exceeds the review scan limit. Nothing was removed.');
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string') {
      if (root && key.description === 'persisted' && !field.enumerable && OWN(field, 'value') && field.value === true) continue;
      fail();
    }
    // Inspect the descriptor, never the value, for credential fields.
    if (!OWN(field, 'value') || !field.enumerable) fail();
  }
  for (const key in value) if (!OWN(value, key)) fail();
  return value;
}
function exact(value, keys, code = 'COST_SOURCE_INPUT_INVALID') {
  object(value);
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every(key => OWN(value, key))) fail(code, 'Choose the exact saved variant and supported source fields.', 400);
  return value;
}
function rows(value, limit) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit
    || Reflect.ownKeys(value).length !== value.length + 1) fail('COST_SOURCE_SCAN_LIMIT', 'Saved source data exceeds the review scan limit or has an unsupported shape. Nothing was removed.');
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, index);
    if (!field || !OWN(field, 'value')) fail();
  }
  return value;
}
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const skuValid = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const gid = (value, type) => typeof value === 'string' && new RegExp(`^gid://shopify/${type}/[1-9][0-9]{0,29}$`).test(value);
const domain = value => typeof value === 'string' && value.length <= 253 && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value);
const accountId = value => value === null || identifier(value) || gid(value, 'Shop');
const date = value => value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function scope(value, workspaceId, budget, skip = []) {
  if (value === null || typeof value !== 'object') return;
  if (--budget.left < 0 || budget.depth > 12) fail('COST_SOURCE_SCAN_LIMIT');
  if (Array.isArray(value)) {
    rows(value, 50000);
    budget.depth++;
    for (const item of value) scope(item, workspaceId, budget);
    budget.depth--;
    return;
  }
  object(value);
  for (const key of MARKERS) {
    if (!OWN(value, key)) continue;
    const marker = value[key];
    if (['workspace', 'tenant'].includes(key) && marker && typeof marker === 'object') {
      object(marker);
      if (!OWN(marker, 'id') || marker.id !== workspaceId) fail('COST_SOURCE_SCOPE_INVALID');
    } else if (marker !== workspaceId) fail('COST_SOURCE_SCOPE_INVALID');
  }
  for (const key of Object.keys(value)) {
    if (SECRET.test(key) || skip.includes(key)) continue;
    const child = value[key];
    if (child && typeof child === 'object') {
      budget.depth++;
      scope(child, workspaceId, budget);
      budget.depth--;
    }
  }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const serialize = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(serialize(value)).digest('hex');
const equal = (left, right) => serialize(left) === serialize(right);
const clone = value => JSON.parse(serialize(value));
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

function workspace(state) {
  object(state, 256, true);
  for (const key of ['workspace', 'users', 'products']) if (!OWN(state, key)) fail();
  for (const key of ['economics', 'connections', 'costHistory']) if (key in state && !OWN(state, key)) fail();
  object(state.workspace);
  if (!OWN(state.workspace, 'id') || !identifier(state.workspace.id)) fail('COST_SOURCE_SCOPE_INVALID');
  const workspaceId = state.workspace.id;
  for (const key of MARKERS.filter(key => key !== 'workspace')) {
    if (OWN(state, key)) scope({ [key]: state[key] }, workspaceId, { left: 1000, depth: 0 });
  }
  scope(state.workspace, workspaceId, { left: 1000, depth: 0 });
  return workspaceId;
}
function actorFor(state, actor, workspaceId) {
  exact(actor, ['workspaceId', 'userId', 'sessionVersion']);
  if (actor.workspaceId !== workspaceId || !identifier(actor.userId) || !Number.isSafeInteger(actor.sessionVersion) || actor.sessionVersion < 1) fail('COST_SOURCE_ACTOR_CHANGED', 'Sign in again as a workspace owner or admin.', 403);
  const users = rows(state.users, 2000); let matches = [];
  for (const user of users) { object(user); if (!OWN(user, 'id')) fail(); if (user.id === actor.userId) matches.push(user); }
  if (matches.length !== 1) fail('COST_SOURCE_ACTOR_CHANGED', 'Sign in again as a workspace owner or admin.', 403);
  const user = matches[0]; scope(user, workspaceId, { left: 1000, depth: 0 });
  if (!OWN(user, 'role') || !['owner', 'admin'].includes(user.role) || (OWN(user, 'active') && user.active !== true)
    || (OWN(user, 'passwordChangeRequired') && user.passwordChangeRequired !== false)
    || (OWN(user, 'sessionVersion') ? user.sessionVersion : 1) !== actor.sessionVersion) fail('COST_SOURCE_ACTOR_CHANGED', 'Your account or session changed. Sign in again as a workspace owner or admin.', 403);
  return { workspaceId, userId: actor.userId, sessionVersion: actor.sessionVersion, role: user.role };
}
function selectorFor(selector) {
  exact(selector, ['productId', 'variantId', 'sku']);
  if (!gid(selector.productId, 'Product') || !gid(selector.variantId, 'ProductVariant') || !skuValid(selector.sku)) fail('COST_SOURCE_TARGET_INVALID');
  return { productId: selector.productId, variantId: selector.variantId, sku: selector.sku };
}
function identityIndex(state, workspaceId) {
  const products = rows(state.products, 500), productIds = new Set(), variantIds = new Set();
  const bySku = new Map(), byProduct = new Map(); let count = 0;
  const budget = { left: 200000, depth: 0 };
  for (const product of products) {
    object(product); scope(product, workspaceId, budget, ['variants']);
    if (!OWN(product, 'id') || typeof product.id !== 'string' || productIds.has(product.id)) fail('COST_SOURCE_TARGET_AMBIGUOUS');
    productIds.add(product.id);
    byProduct.set(product.id, product);
    if ('variants' in product && !OWN(product, 'variants')) fail();
    const variants = rows(product.variants ?? [], 50000);
    if ((count += variants.length) > 50000) fail('COST_SOURCE_SCAN_LIMIT');
    for (const variant of variants) {
      object(variant); scope(variant, workspaceId, budget);
      if (!OWN(variant, 'id') || typeof variant.id !== 'string' || variantIds.has(variant.id)) fail('COST_SOURCE_TARGET_AMBIGUOUS');
      variantIds.add(variant.id);
      if (!OWN(variant, 'sku') || typeof variant.sku !== 'string') fail('COST_SOURCE_TARGET_INVALID');
      // Whitespace aliases collide too; only an exact SKU may be selected.
      const key = variant.sku.trim(), matches = bySku.get(key) ?? [];
      matches.push({ product, variant }); bySku.set(key, matches);
    }
  }
  const connections = rows(state.connections ?? [], 1000), ids = new Set(), candidates = [];
  for (const connection of connections) {
    object(connection);
    if (!OWN(connection, 'id') || !OWN(connection, 'provider') || !identifier(connection.id) || ids.has(connection.id)) fail('COST_SOURCE_ACCOUNT_AMBIGUOUS');
    ids.add(connection.id);
    if (connection.provider === 'shopify') candidates.push(connection);
  }
  if (candidates.length !== 1) fail('COST_SOURCE_ACCOUNT_UNAVAILABLE', 'One unambiguous saved Shopify account is required to identify this attestation.');
  const connection = candidates[0];
  // Scope only public metadata. Credentials and grants are never consulted.
  scope(connection, workspaceId, { left: 1000, depth: 0 }, ['metadata']);
  if (!OWN(connection, 'metadata')) fail('COST_SOURCE_ACCOUNT_UNAVAILABLE');
  object(connection.metadata);
  scope(connection.metadata, workspaceId, { left: 1000, depth: 0 }, ['grantedScopes']);
  const metadata = connection.metadata;
  for (const key of ['shopDomain', 'shopId', 'accountId']) if (key in metadata && !OWN(metadata, key)) fail('COST_SOURCE_ACCOUNT_UNAVAILABLE');
  const savedAccountId = metadata.shopId ?? metadata.accountId ?? null;
  if (!OWN(metadata, 'shopDomain') || !domain(metadata.shopDomain) || !accountId(savedAccountId)
    || (metadata.shopId != null && metadata.accountId != null && metadata.shopId !== metadata.accountId)) fail('COST_SOURCE_ACCOUNT_UNAVAILABLE', 'The saved Shopify account identity is incomplete or conflicting.');
  return { bySku, byProduct, connectionId: connection.id, account: metadata.shopDomain, accountId: savedAccountId };
}
function targetFor(index, selector, workspaceId) {
  const matches = index.bySku.get(selector.sku) ?? [], match = matches[0];
  if (matches.length !== 1 || match.product.id !== selector.productId || match.variant.id !== selector.variantId || match.variant.sku !== selector.sku) fail('COST_SOURCE_TARGET_AMBIGUOUS', 'Choose one exact Shopify variant with a unique saved SKU.');
  if (!OWN(match.product, 'provider') || match.product.provider !== 'shopify' || (OWN(match.variant, 'provider') && match.variant.provider !== 'shopify')
    || (OWN(match.product, 'externalId') && match.product.externalId !== selector.productId)
    || (OWN(match.variant, 'externalId') && match.variant.externalId !== selector.variantId)
    || (OWN(match.variant, 'productId') && match.variant.productId !== selector.productId)) fail('COST_SOURCE_TARGET_INVALID');
  for (const source of [match.product, match.variant]) {
    if ((OWN(source, 'connectionId') && source.connectionId !== index.connectionId)
      || (OWN(source, 'shopDomain') && source.shopDomain !== index.account)
      || (OWN(source, 'accountId') && source.accountId !== index.accountId)
      || (OWN(source, 'shopId') && source.shopId !== index.accountId)) fail('COST_SOURCE_SCOPE_INVALID');
  }
  return { workspaceId, ...selector, connectionId: index.connectionId, account: index.account, accountId: index.accountId };
}
function validateTarget(target, workspaceId) {
  exact(target, ['workspaceId', 'productId', 'variantId', 'sku', 'connectionId', 'account', 'accountId']);
  selectorFor({ productId: target.productId, variantId: target.variantId, sku: target.sku });
  if (target.workspaceId !== workspaceId || !identifier(target.connectionId) || !domain(target.account) || !accountId(target.accountId)) fail('COST_SOURCE_SCOPE_INVALID');
}
function costSnapshot(economics) {
  object(economics);
  const result = {};
  for (const field of [...COMPONENTS, 'supplierVatRecoverable']) {
    if (!OWN(economics, field)) continue;
    const value = economics[field];
    if (field === 'supplierVatRecoverable') {
      if (![true, false, null, ''].includes(value)) fail('COST_SOURCE_COST_INVALID');
    } else if (!(value === null || typeof value === 'string' && value.length <= 128 || typeof value === 'number' && Number.isFinite(value))) fail('COST_SOURCE_COST_INVALID');
    result[field] = value;
  }
  return result;
}
function basisFor(basis, costs) {
  exact(basis, ['currency', 'taxBasis', 'effectiveFrom', 'effectiveUntil', 'sources']);
  if (!(basis.currency === null || typeof basis.currency === 'string' && /^[A-Z]{3}$/.test(basis.currency))
    || !['unknown', 'net', 'gross', 'mixed'].includes(basis.taxBasis) || !date(basis.effectiveFrom) || !date(basis.effectiveUntil)
    || (basis.effectiveFrom !== null && basis.effectiveUntil !== null && basis.effectiveFrom > basis.effectiveUntil)) fail('COST_SOURCE_INPUT_INVALID', 'Use a currency code, supported tax basis, and valid date range, or leave unknown facts blank.', 400);
  rows(basis.sources, COMPONENTS.length);
  if (!basis.sources.length) fail('COST_SOURCE_INPUT_INVALID', 'Add at least one source identifier for an explicitly saved cost.', 400);
  const seen = new Set();
  const sources = basis.sources.map(source => {
    exact(source, ['component', 'kind', 'identifier', 'issuedOn']);
    if (!COMPONENTS.includes(source.component) || seen.has(source.component) || !['invoice', 'statement', 'estimate'].includes(source.kind)
      || typeof source.identifier !== 'string' || source.identifier.length < 1 || source.identifier.length > 80
      || source.identifier !== source.identifier.trim() || !/^[A-Za-z0-9 ._/#()-]+$/.test(source.identifier)
      || !/[A-Za-z0-9]/.test(source.identifier) || /(?:www\.|[A-Za-z0-9-]+\.[A-Za-z]{2,}(?:\/|$))/i.test(source.identifier)
      || !date(source.issuedOn)) fail('COST_SOURCE_INPUT_INVALID', 'Use one short safe identifier per supported cost. URLs, email addresses, and document bodies are not accepted.', 400);
    if (!OWN(costs, source.component) || !hasAmount(costs[source.component])) fail('COST_SOURCE_COST_UNKNOWN', 'Save an explicit finite cost, including zero when known, before attaching its source.', 400);
    seen.add(source.component);
    return { component: source.component, kind: source.kind, identifier: source.identifier, issuedOn: source.issuedOn };
  }).sort((left, right) => COMPONENTS.indexOf(left.component) - COMPONENTS.indexOf(right.component));
  return { currency: basis.currency, taxBasis: basis.taxBasis, effectiveFrom: basis.effectiveFrom, effectiveUntil: basis.effectiveUntil, sources };
}
const revision = (actor, target, costs, previous) => digest({ schema: COST_SOURCE_REVIEW_SCHEMA, actor, target, costs, previous });
const requestDigest = record => digest({ requestId: record.requestId, sourceRevision: record.sourceRevision, target: record.target,
  actor: record.actor, basis: record.basis });
function validateRecord(record, workspaceId) {
  exact(record, ['schema', 'id', 'requestId', 'sourceRevision', 'requestDigest', 'target', 'costs', 'basis', 'actor', 'previousId', 'recordedAt']);
  if (record.schema !== COST_SOURCE_REVIEW_SCHEMA || typeof record.requestId !== 'string' || !UUID.test(record.requestId) || record.requestId !== record.requestId.toLowerCase() || record.id !== `cost_source_${record.requestId}`
    || typeof record.sourceRevision !== 'string' || !DIGEST.test(record.sourceRevision) || typeof record.requestDigest !== 'string' || !DIGEST.test(record.requestDigest) || !iso(record.recordedAt)
    || !(record.previousId === null || typeof record.previousId === 'string' && UUID.test(record.previousId.slice(12)) && record.previousId.startsWith('cost_source_'))) fail('COST_SOURCE_HISTORY_INVALID');
  validateTarget(record.target, workspaceId);
  exact(record.actor, ['workspaceId', 'userId', 'sessionVersion', 'role']);
  if (record.actor.workspaceId !== workspaceId || !identifier(record.actor.userId) || !Number.isSafeInteger(record.actor.sessionVersion) || record.actor.sessionVersion < 1 || !['owner', 'admin'].includes(record.actor.role)) fail('COST_SOURCE_HISTORY_INVALID');
  object(record.costs);
  if (Object.keys(record.costs).some(key => ![...COMPONENTS, 'supplierVatRecoverable'].includes(key))) fail('COST_SOURCE_HISTORY_INVALID');
  costSnapshot(record.costs);
  if (!equal(basisFor(record.basis, record.costs), record.basis) || requestDigest(record) !== record.requestDigest) fail('COST_SOURCE_HISTORY_INVALID');
  if (bytes(record) > COST_SOURCE_REVIEW_MAX_BYTES) fail('COST_SOURCE_REVIEW_TOO_LARGE', 'A saved source review exceeds 2 KiB. No history was removed.');
}
function sourceMaterial(state, workspaceId) {
  const economics = object(state.economics ?? {}, 50000), latest = new Map(), events = [], records = new Map(), requests = new Set();
  for (const sku of Object.keys(economics)) {
    const row = object(economics[sku]);
    if (!OWN(row, 'sourceBasis')) continue;
    validateRecord(row.sourceBasis, workspaceId);
    if (row.sourceBasis.target.sku !== sku) fail('COST_SOURCE_HISTORY_INVALID');
    latest.set(sku, row.sourceBasis);
  }
  const history = rows(state.costHistory ?? [], 5000);
  const eventIds = new Set();
  for (const event of history) {
    object(event);
    if (typeof event.id !== 'string' || eventIds.has(event.id)) fail('COST_SOURCE_HISTORY_INVALID');
    eventIds.add(event.id);
    if (OWN(event, 'before')) object(event.before);
    if (OWN(event, 'after')) object(event.after);
    if (OWN(event, 'changedFields')) rows(event.changedFields, 128);
    const sourceEvent = event.changedFields?.includes('sourceBasis') || OWN(event.before ?? {}, 'sourceBasis') || OWN(event.after ?? {}, 'sourceBasis');
    if (!sourceEvent) continue;
    exact(event, ['id', 'sku', 'changedBy', 'changedFields', 'before', 'after', 'createdAt']);
    exact(event.before, ['sourceBasis']); exact(event.after, ['sourceBasis']);
    if (!equal(event.changedFields, ['sourceBasis'])) fail('COST_SOURCE_HISTORY_INVALID');
    const record = event.after.sourceBasis;
    validateRecord(record, workspaceId);
    if (records.has(record.id) || requests.has(record.requestId) || event.id !== `cost_source_event_${record.requestId}`
      || event.sku !== record.target.sku || event.changedBy !== record.actor.userId || event.createdAt !== record.recordedAt
      || event.before.sourceBasis !== record.previousId) fail('COST_SOURCE_HISTORY_INVALID');
    records.set(record.id, record); requests.add(record.requestId); events.push(event);
  }
  const heads = new Map();
  for (const event of [...events].reverse()) {
    const record = event.after.sourceBasis, previous = heads.get(event.sku) ?? null;
    if (record.previousId !== (previous?.id ?? null) || revision(record.actor, record.target, record.costs, previous) !== record.sourceRevision) fail('COST_SOURCE_HISTORY_INVALID', 'The retained correction chain is incomplete or inconsistent. Nothing was removed.');
    heads.set(event.sku, record);
  }
  if (heads.size !== latest.size) fail('COST_SOURCE_HISTORY_INVALID');
  for (const [sku, record] of latest) if (!heads.has(sku) || !equal(heads.get(sku), record)) fail('COST_SOURCE_HISTORY_INVALID');
  const material = { latest: [...latest.values()], history: events };
  const usedBytes = bytes(material);
  if (usedBytes > COST_SOURCE_HISTORY_MAX_BYTES) fail('COST_SOURCE_HISTORY_FULL', 'Retained source reviews and corrections exceed 64 KiB. Nothing was removed; review storage before adding another correction.');
  return { economics, latest, records, events, usedBytes };
}
function preparedState(state, actor) {
  const workspaceId = workspace(state), checkedActor = actorFor(state, actor, workspaceId);
  return { workspaceId, actor: checkedActor, index: identityIndex(state, workspaceId), material: sourceMaterial(state, workspaceId) };
}
function snapshot(state, selector, actor, prepared = preparedState(state, actor)) {
  const { workspaceId, actor: checkedActor, index, material } = prepared, selected = selectorFor(selector);
  const target = targetFor(index, selected, workspaceId);
  if (!OWN(material.economics, selected.sku)) fail('COST_SOURCE_COST_UNKNOWN', 'Save costs for this exact SKU before reviewing their sources.', 400);
  const economics = material.economics[selected.sku];
  scope(economics, workspaceId, { left: 10000, depth: 0 }, ['sourceBasis']);
  if (Object.keys(economics).some(key => SECRET.test(key))) fail('COST_SOURCE_COST_INVALID');
  const costs = costSnapshot(economics), previous = material.latest.get(selected.sku) ?? null;
  jsonClone(economics);
  return { target, actor: checkedActor, costs, economics, previous, material, sourceRevision: revision(checkedActor, target, costs, previous) };
}
function currentFor(record, snapshot) {
  const staleReasons = [];
  if (!equal(record.target, snapshot.target)) staleReasons.push('saved_target_changed');
  if (!equal(record.costs, snapshot.costs)) staleReasons.push('saved_costs_changed');
  return { record: clone(record), stale: staleReasons.length > 0, staleReasons };
}
function nowIso(now) {
  const value = now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(value.getTime())) fail('COST_SOURCE_INPUT_INVALID', 'Use a valid review time.', 400);
  return value.toISOString();
}

export function costSourceReviewContext(state, selector, actor, { now } = {}) {
  nowIso(now);
  const workspaceId = workspace(state), checkedActor = actorFor(state, actor, workspaceId), selected = selectorFor(selector);
  const material = sourceMaterial(state, workspaceId);
  const budget = { reviewMaxBytes: COST_SOURCE_REVIEW_MAX_BYTES, retainedMaxBytes: COST_SOURCE_HISTORY_MAX_BYTES,
    retainedBytes: material.usedBytes, remainingBytes: COST_SOURCE_HISTORY_MAX_BYTES - material.usedBytes };
  let value;
  try { value = snapshot(state, selected, actor, { workspaceId, actor: checkedActor, index: identityIndex(state, workspaceId), material }); }
  catch (error) {
    const history = material.events.map(event => event.after.sourceBasis).filter(record => record.target.sku === selected.sku
      && record.target.productId === selected.productId && record.target.variantId === selected.variantId);
    if (!history.length) throw error;
    return { schema: COST_SOURCE_REVIEW_SCHEMA, target: clone(history[0].target), sourceRevision: null, writable: false,
      costs: Object.fromEntries(COMPONENTS.map(field => [field, null])), costSnapshot: null,
      current: { record: clone(history[0]), stale: true, staleReasons: ['target_unavailable'] }, history: clone(history), budget,
      notice: `${NOTICE} The current target cannot be resolved; only its retained correction history is shown.` };
  }
  return { schema: COST_SOURCE_REVIEW_SCHEMA, target: clone(value.target), sourceRevision: value.sourceRevision, writable: true,
    costs: Object.fromEntries(COMPONENTS.map(field => [field, OWN(value.costs, field) && hasAmount(value.costs[field]) ? Number(value.costs[field]) : null])),
    costSnapshot: clone(value.costs),
    current: value.previous ? currentFor(value.previous, value) : null,
    history: value.material.events.filter(event => event.sku === value.target.sku).map(event => clone(event.after.sourceBasis)),
    budget, notice: NOTICE };
}

export function prepareCostSourceReview(state, input, actor, { now } = {}) {
  exact(input, ['productId', 'variantId', 'sku', 'sourceRevision', 'requestId', 'basis']);
  if (typeof input.requestId !== 'string' || !UUID.test(input.requestId) || typeof input.sourceRevision !== 'string' || !DIGEST.test(input.sourceRevision)) fail('COST_SOURCE_INPUT_INVALID', 'Refresh the review and use a UUID request identifier.', 400);
  const requestId = input.requestId.toLowerCase();
  const value = snapshot(state, { productId: input.productId, variantId: input.variantId, sku: input.sku }, actor);
  const recorded = value.material.records.get(`cost_source_${requestId}`);
  if (recorded) {
    const historicalBasis = basisFor(input.basis, recorded.costs);
    if (recorded.sourceRevision !== input.sourceRevision || !equal(recorded.actor, value.actor) || !equal(recorded.basis, historicalBasis)
      || recorded.target.productId !== input.productId || recorded.target.variantId !== input.variantId || recorded.target.sku !== input.sku) fail('COST_SOURCE_REQUEST_CONFLICT', 'This request identifier already belongs to a different source review.');
    return { duplicate: true, record: clone(recorded), economics: jsonClone(value.economics), historyEvent: null,
      current: value.previous?.id === recorded.id && !currentFor(recorded, value).stale };
  }
  if (input.sourceRevision !== value.sourceRevision) fail('COST_SOURCE_STALE', 'The saved costs, account, prior review, or session changed. Refresh and review them again.');
  const basis = basisFor(input.basis, value.costs);
  if (value.previous && !currentFor(value.previous, value).stale && equal(value.previous.basis, basis)) {
    return { duplicate: true, record: clone(value.previous), economics: jsonClone(value.economics), historyEvent: null, current: true };
  }
  const record = { schema: COST_SOURCE_REVIEW_SCHEMA, id: `cost_source_${requestId}`, requestId,
    sourceRevision: value.sourceRevision, requestDigest: '', target: value.target, costs: value.costs, basis, actor: value.actor,
    previousId: value.previous?.id ?? null, recordedAt: nowIso(now) };
  record.requestDigest = requestDigest(record);
  if (bytes(record) > COST_SOURCE_REVIEW_MAX_BYTES) fail('COST_SOURCE_REVIEW_TOO_LARGE', 'This source review exceeds 2 KiB. Use fewer, shorter identifiers.', 413);
  const historyEvent = { id: `cost_source_event_${requestId}`, sku: input.sku, changedBy: value.actor.userId,
    changedFields: ['sourceBasis'], before: { sourceBasis: record.previousId }, after: { sourceBasis: record }, createdAt: record.recordedAt };
  const latest = new Map(value.material.latest); latest.set(input.sku, record);
  if (bytes({ latest: [...latest.values()], history: [historyEvent, ...value.material.events] }) > COST_SOURCE_HISTORY_MAX_BYTES) fail('COST_SOURCE_HISTORY_FULL', 'This correction would exceed the 64 KiB retained-source budget. Existing reviews are preserved; review storage before adding another correction.', 413);
  return { duplicate: false, record: clone(record), economics: { ...jsonClone(value.economics), sourceBasis: clone(record) }, historyEvent: clone(historyEvent), current: true };
}

// Bounded diagnostic sidecar, intentionally outside content proposal digests.
// A catalogue/account/history failure must not break existing content review.
export function productCostSourceReviews(state, productId, actor, { now } = {}) {
  const base = { schema: 'runvara-product-cost-sources/v1', available: false, productId: gid(productId, 'Product') ? productId : null,
    reviews: [], notice: NOTICE };
  try {
    nowIso(now);
    if (!gid(productId, 'Product')) fail('COST_SOURCE_TARGET_INVALID');
    const prepared = preparedState(state, actor), product = prepared.index.byProduct.get(productId);
    if (!product || product.provider !== 'shopify') fail('COST_SOURCE_TARGET_INVALID');
    const variants = rows(product.variants ?? [], 100);
    if (!variants.length) fail('COST_SOURCE_TARGET_UNAVAILABLE');
    const reviews = variants.map(variant => {
      // Every projected reference must meet the public selector contract. An
      // unsupported sibling makes this optional whole-product view unavailable;
      // omitting it would imply a complete variant set that was never reviewed.
      const reference = selectorFor({ productId, variantId: variant.id, sku: variant.sku });
      try {
        const value = snapshot(state, reference, actor, prepared), record = value.previous;
        if (!record) return { ...reference, status: 'unrecorded', current: false };
        const current = currentFor(record, value);
        return { ...reference, status: current.stale ? 'stale' : 'current', current: !current.stale, recordId: record.id,
          staleReasons: current.staleReasons, basis: clone(record.basis), reviewer: clone(record.actor), recordedAt: record.recordedAt };
      } catch (error) { return { ...reference, status: 'unavailable', current: false, code: error.code || 'COST_SOURCE_INVALID' }; }
    });
    const result = { ...base, available: true, reviews };
    if (bytes(result) > 16384) fail('COST_SOURCE_PROJECTION_TOO_LARGE', 'The saved cost source summary exceeds its display budget. Open an individual variant review.');
    return result;
  } catch (error) { return { ...base, code: error.code || 'COST_SOURCE_INVALID' }; }
}

// Generic member/viewer DTOs keep ordinary saved fields, never source identifiers.
// Dedicated owner/admin review endpoints are the only source-review disclosure.
function jsonClone(value, depth = 0, stripSources = false, budget = { left: 200000 }) {
  if (--budget.left < 0) fail('COST_SOURCE_SCAN_LIMIT');
  if (depth > 20) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') fail();
  if (Array.isArray(value)) return rows(value, 50000).map(item => jsonClone(item, depth + 1, stripSources, budget));
  object(value, 50000);
  return Object.fromEntries(Object.keys(value).filter(key => !stripSources || key !== 'sourceBasis').map(key => [key, jsonClone(value[key], depth + 1, stripSources, budget)]));
}
export function publicEconomicsSources(economics = {}) {
  // Map keys are SKU data, even when a SKU happens to be "sourceBasis".
  // Only fields inside each economics row are private source envelopes.
  object(economics, 50000);
  const budget = { left: 200000 };
  return Object.fromEntries(Object.keys(economics).map(sku => [sku, jsonClone(economics[sku], 1, true, budget)]));
}
export function publicCostSourceHistory(history = []) {
  return rows(history, 50000).flatMap(event => {
    object(event);
    const result = jsonClone(event, 0, true);
    if (OWN(event, 'changedFields')) {
      const fields = rows(event.changedFields, 128);
      result.changedFields = fields.filter(field => field !== 'sourceBasis');
      if (fields.includes('sourceBasis') && result.changedFields.length === 0) return [];
    }
    return [result];
  });
}
