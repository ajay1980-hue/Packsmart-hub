import { createHash } from 'node:crypto';
import { unitEconomics } from './profit.mjs';
import { projectCurrentOutcomeReferences } from './business-outcomes.mjs';
import { deriveQualifiedOutcomeGroups } from './impact-engine.mjs';
import { inspectRetainedGraphRow, retainedCollection, projectRetainedRequests } from './retained-request-graph.mjs';
export { RETAINED_REQUEST_GRAPH_BYTES } from './retained-request-graph.mjs';

// This is an on-demand projection of the existing tenant snapshot. It does not
// persist a second graph, migrate records, call providers, or infer identities
// from names, titles, email addresses, campaign names, or generated SKU fallbacks.
const DEFAULTS = Object.freeze({ recordLimit: 100, nestedLimit: 25, scanLimit: 4000, nodeLimit: 600, edgeLimit: 1200, unknownLimit: 100 });
const MAXIMUMS = Object.freeze({ recordLimit: 500, nestedLimit: 100, scanLimit: 10000, nodeLimit: 2000, edgeLimit: 4000, unknownLimit: 500 });
const SUMMARY_MAXIMUMS = Object.freeze({ recordLimit: 8, nestedLimit: 5, scanLimit: 250, nodeLimit: 150, edgeLimit: 250, unknownLimit: 20 });
export const REVIEWED_OUTCOME_GRAPH_BYTES = Object.freeze({ summary: 16 * 1024, detail: 128 * 1024 });
const CHANNELS = new Set(['shopify', 'ebay', 'meta', 'tiktok_shop', 'pinterest', 'google_youtube', 'whatsapp_business', 'amazon']);
const STATUSES = new Set(['active', 'inactive', 'archived', 'draft', 'open', 'pending', 'approved', 'rejected', 'dismissed', 'resolved', 'requires_approval', 'requires approval', 'planned', 'in progress', 'running', 'completed', 'measured', 'closed', 'failed', 'blocked', 'prepared', 'awaiting_approval', 'scheduled', 'published', 'unpublished', 'paid', 'refunded', 'partially_refunded', 'unpaid', 'fulfilled', 'unfulfilled', 'succeeded', 'executed', 'not_connected']);
const METRICS = ['incrementalRevenue', 'incrementalContribution', 'contributionProtected', 'costAvoided', 'minutesSaved'];
const REVIEWED_RELATIONS = new Set(['measurement_recorded_for_experiment', 'publication_recorded_request', 'publication_recorded_approval']);
const OUTPUT_REASONS = new Set(['edge_limit', 'target_outside_projection', 'output_byte_limit']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => (typeof value === 'string' && value.trim() && value.length <= 2048) || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;
const status = value => typeof value === 'string' && STATUSES.has(value.toLowerCase()) ? value.toLowerCase() : 'unknown';
const channel = value => CHANNELS.has(value) ? value : null;
const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
const digest = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

function scopeError(required = false) {
  return Object.assign(new Error(required ? 'Workspace identity is required' : 'Workspace identity mismatch'), { status: required ? 400 : 403, code: required ? 'WORKSPACE_REQUIRED' : 'WORKSPACE_MISMATCH' });
}

function limitsFor(options, summary) {
  return Object.fromEntries(Object.entries(DEFAULTS).map(([name, fallback]) => {
    const maximum = summary ? SUMMARY_MAXIMUMS[name] : MAXIMUMS[name];
    const value = Number(options[name]);
    return [name, Math.max(1, Math.min(maximum, Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback))];
  }));
}

/**
 * Source references contain structural JSON pointers and opaque identity hashes,
 * never raw record IDs. Dictionary keys are represented by keyHash; locate the
 * authoritative key by hashing [workspaceId, 'economics-key', key]. Array pointers
 * address this snapshot; identityHash survives reordering for unique source IDs.
 * Duplicate IDs are kept separate with occurrence ordinals, not silently merged.
 */
function project(state, options, summaryOnly) {
  const workspaceId = identifier(state?.workspace?.id);
  if (!workspaceId || workspaceId.length > 256) throw scopeError(true);
  const assertScope = record => {
    if (!object(record)) return;
    for (const value of [record.workspaceId, record.tenantId, record.workspace_id, record.tenant_id, record.workspace?.id]) {
      if (value !== undefined && value !== null && value !== workspaceId) throw scopeError();
    }
    if (options.inspectCurrentOutcomes === true) for (const key of ['workspace', 'tenant']) {
      if (record[key] !== undefined && record[key] !== null && (object(record[key]) ? record[key].id : record[key]) !== workspaceId) throw scopeError();
    }
  };
  assertScope(state);
  assertScope(options);
  if (options.inspectCurrentOutcomes === true) assertScope(state.workspace);
  for (const value of [state.marketing, state.revenueEngine, state.ebay, state.channelData, state.channelData?.shopify]) assertScope(value);

  const limits = limitsFor(options, summaryOnly);
  const nodes = [], edges = [], unknownMappings = [];
  const nodeMap = new Map(), edgeIds = new Set(), unknownIds = new Set(), omittedNodes = new Set(), occurrences = new Map();
  const sources = new Map(), indices = new Map(), byType = {}, byRelation = {}, unknownByReason = {}, unknownByNode = new Map();
  let scanned = 0, droppedEdges = 0, unknownTotal = 0;
  const source = (collection, pointer, row, field = null) => ({
    workspaceId, collection, pointer,
    ...(identifier(row?.id) || identifier(row?.externalId) ? { identityHash: digest([workspaceId, collection, identifier(row.id) || identifier(row.externalId)]) } : {}),
    ...(field ? { field } : {})
  });
  const atField = (ref, field) => ({ ...ref, field });
  const sourceIdentity = ref => [ref.collection, ref.identityHash || ref.keyHash || ref.pointer, ref.field || null];
  const metadata = collection => {
    if (!sources.has(collection)) sources.set(collection, { collection, available: 0, scanned: 0, invalid: 0, truncated: false, totalKnown: true });
    return sources.get(collection);
  };
  function readArray(value, collection, pointer, limit = limits.recordLimit) {
    const rows = Array.isArray(value) ? value : [];
    const meta = metadata(collection);
    if (value !== null && value !== undefined && !Array.isArray(value)) meta.invalid++;
    meta.available += rows.length;
    const count = Math.min(rows.length, limit, Math.max(0, limits.scanLimit - scanned));
    if (count < rows.length) meta.truncated = true;
    const result = [];
    for (let index = 0; index < count; index++) {
      scanned++; meta.scanned++;
      const guarded = ['businessObjectives', 'connectionWrites', 'approvals'].includes(collection);
      const descriptor = guarded ? Object.getOwnPropertyDescriptor(rows, index) : null;
      let row = guarded ? descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null : rows[index];
      if (!object(row)) { meta.invalid++; continue; }
      if (guarded) {
        try { row = inspectRetainedGraphRow(row, workspaceId, collection, { shallow: true }); }
        catch (error) { if (error.code === 'WORKSPACE_MISMATCH') throw error; meta.invalid++; continue; }
      }
      assertScope(row);
      result.push({ row, ref: source(collection, `${pointer}/${index}`, row) });
    }
    return result;
  }
  function unknown(node, relation, reason, ref) {
    if (!node) return;
    const id = `mapping_${digest([workspaceId, node.id, relation, reason, sourceIdentity(ref)])}`;
    if (unknownIds.has(id)) return;
    unknownIds.add(id);
    unknownTotal++;
    if (!unknownByNode.has(node.id)) unknownByNode.set(node.id, {});
    const nodeReasons = unknownByNode.get(node.id); nodeReasons[reason] = (nodeReasons[reason] || 0) + 1;
    unknownByReason[reason] = (unknownByReason[reason] || 0) + 1;
    if (unknownMappings.length < limits.unknownLimit) unknownMappings.push({
      id,
      subjectId: node.id, relation, reason, sourceRef: ref
    });
  }
  function addNode(type, identity, ref, attributes = {}) {
    const id = `${type}_${digest([workspaceId, type, identity])}`;
    if (nodeMap.has(id)) return nodeMap.get(id);
    if (nodes.length >= limits.nodeLimit) { omittedNodes.add(id); return null; }
    const node = { id, type, sourceRef: ref, attributes };
    nodes.push(node); nodeMap.set(id, node); byType[type] = (byType[type] || 0) + 1;
    return node;
  }
  function record(type, entry, { provider = null, parent = null } = {}) {
    const rawId = identifier(entry.row.id) || identifier(entry.row.externalId);
    const identity = [entry.ref.collection, provider, parent?.id || null, rawId || entry.ref.pointer];
    const key = JSON.stringify([type, identity]);
    const occurrence = occurrences.get(key) || 0;
    occurrences.set(key, occurrence + 1);
    const node = addNode(type, [...identity, occurrence], entry.ref, { status: status(entry.row.status), ...(provider ? { channel: provider } : {}), identity: rawId ? 'recorded-id' : 'snapshot-position' });
    if (!rawId) unknown(node, 'identity', 'missing_record_id', entry.ref);
    if (occurrence) unknown(node, 'identity', 'duplicate_record_id', entry.ref);
    const descriptor = { ...entry, node, provider };
    if (!indices.has(type)) indices.set(type, new Map());
    const index = indices.get(type);
    for (const value of new Set([identifier(entry.row.id), identifier(entry.row.externalId)].filter(Boolean))) {
      if (!index.has(value)) index.set(value, []);
      index.get(value).push(descriptor);
    }
    return descriptor;
  }
  function edge(from, to, relation, ref, basis = 'explicit-reference') {
    if (!from) return;
    if (!to) { unknown(from, relation, 'target_outside_projection', ref); return; }
    const id = `edge_${digest([workspaceId, from.id, to.id, relation, sourceIdentity(ref)])}`;
    if (edgeIds.has(id)) return true;
    edgeIds.add(id);
    if (edges.length >= limits.edgeLimit) { droppedEdges++; return; }
    edges.push({ id, from: from.id, to: to.id, relation, provenance: { basis, sourceRef: ref } });
    byRelation[relation] = (byRelation[relation] || 0) + 1;
    return true;
  }
  const top = {
    products: readArray(state.products, 'products', '/products'),
    suppliers: readArray(state.suppliers, 'suppliers', '/suppliers'),
    listings: readArray(state.ebay?.listings, 'ebay.listings', '/ebay/listings'),
    drafts: readArray(state.ebay?.drafts, 'ebay.drafts', '/ebay/drafts'),
    orders: readArray(state.orders, 'orders', '/orders'),
    customers: readArray(state.channelData?.shopify?.customers, 'channelData.shopify.customers', '/channelData/shopify/customers'),
    campaigns: readArray(state.marketing?.campaigns, 'marketing.campaigns', '/marketing/campaigns'),
    opportunities: readArray(state.opportunities, 'opportunities', '/opportunities'),
    approvals: readArray(retainedCollection(state, 'approvals'), 'approvals', '/approvals'),
    objectives: readArray(retainedCollection(state, 'businessObjectives'), 'businessObjectives', '/businessObjectives'),
    writes: readArray(retainedCollection(state, 'connectionWrites'), 'connectionWrites', '/connectionWrites'),
    work: readArray(state.workRecords, 'workRecords', '/workRecords'),
    experiments: readArray(state.revenueEngine?.experiments, 'revenueEngine.experiments', '/revenueEngine/experiments')
  };
  // Top-level rows share the root scan reservation before inspecting nested
  // retained history. Nested validation has the SAME remaining scan allowance;
  // its bounded fields/UTF-8 preflight never widens collection scans.
  for (const name of ['businessObjectives', 'connectionWrites', 'approvals']) {
    const value = retainedCollection(state, name);
    if (value === undefined || value === null) metadata(name).totalKnown = false;
  }
  const validationMeta = metadata('retainedRequests.validation');
  const consumeRetainedValidation = () => {
    if (scanned >= limits.scanLimit) {
      validationMeta.truncated = true; validationMeta.totalKnown = false;
      throw Object.assign(new Error('Retained validation scan limit'), { code: 'RETAINED_GRAPH_SCAN_LIMIT' });
    }
    scanned++; validationMeta.scanned++; validationMeta.available++;
  };
  for (const [key, collection] of [['objectives', 'businessObjectives'], ['writes', 'connectionWrites'], ['approvals', 'approvals']]) {
    top[key] = top[key].filter(entry => {
      try {
        entry.row = inspectRetainedGraphRow(entry.row, workspaceId, collection, { consume: consumeRetainedValidation, nestedLimit: limits.nestedLimit });
        return true;
      } catch (error) {
        if (error.code === 'WORKSPACE_MISMATCH') throw error;
        metadata(collection).invalid++;
        if (error.code === 'RETAINED_GRAPH_SCAN_LIMIT') metadata(collection).truncated = true;
        return false;
      }
    });
  }
  const economies = new Map();
  const economicsMeta = metadata('economics');
  const economics = object(state.economics) ? state.economics : {};
  if (state.economics !== null && state.economics !== undefined && !object(state.economics)) economicsMeta.invalid++;
  // Do not allocate Object.keys/entries for an arbitrarily large cost dictionary.
  for (const key in economics) {
    if (!Object.hasOwn(economics, key)) continue;
    if (economicsMeta.scanned >= limits.recordLimit || scanned >= limits.scanLimit) {
      economicsMeta.truncated = true; economicsMeta.totalKnown = false; break;
    }
    economicsMeta.available++; economicsMeta.scanned++; scanned++;
    const row = economics[key];
    if (!object(row) || !identifier(key)) { economicsMeta.invalid++; continue; }
    assertScope(row);
    const ref = { workspaceId, collection: 'economics', pointer: '/economics', keyHash: digest([workspaceId, 'economics-key', key]) };
    const costs = unitEconomics({}, row);
    const node = addNode('economics', key, ref, { complete: costs.complete, missingFields: costs.missingFields, contribution: null });
    economies.set(key, { row, node, ref, usedAsSku: false });
  }

  function toChannel(node, provider, ref, relation = 'recorded_on_channel') {
    if (!provider) { unknown(node, relation, 'missing_or_unsupported_channel', ref); return; }
    edge(node, addNode('channel', provider, ref, { channel: provider }), relation, ref, 'recorded-provider');
  }
  function toSku(node, raw, ref) {
    const sku = identifier(raw);
    if (!sku) { unknown(node, 'uses_sku', 'missing_sku', ref); return null; }
    const skuNode = addNode('sku', sku, ref, { identity: 'exact-recorded-sku', productEquivalenceVerified: false });
    edge(node, skuNode, 'uses_sku', ref, 'exact-recorded-sku');
    return { sku, node: skuNode };
  }
  function toEconomics(node, sku, fallbackId, ref) {
    const key = [sku, fallbackId].find(value => value && Object.hasOwn(economics, value) && object(economics[value]));
    if (!key) { unknown(node, 'has_economics', 'missing_economics', ref); return; }
    assertScope(economics[key]);
    const target = economies.get(key);
    if (!target) { unknown(node, 'has_economics', 'target_outside_projection', ref); return; }
    edge(node, target.node, 'has_economics', ref, key === sku ? 'exact-economics-sku-key' : 'recorded-variant-id-fallback');
    if (key === sku) target.usedAsSku = true;
  }

  top.suppliers.forEach(entry => record('supplier', entry));
  const products = top.products.map(entry => record('product', entry, { provider: channel(entry.row.provider) }));
  // Reserve references across all source families before expanding catalogue or
  // order children, so large catalogues do not hide every approval and outcome.
  const listings = [...top.listings, ...top.drafts].map(entry => record('listing', entry, { provider: 'ebay' }));
  const orders = top.orders.map(entry => record('order', entry, { provider: channel(entry.row.provider) }));
  const campaigns = top.campaigns.map(entry => record('campaign', entry));
  const opportunities = top.opportunities.map(entry => record('opportunity', entry));
  const approvals = top.approvals.map(entry => record('approval', entry));
  const objectives = top.objectives.map(entry => record('objective', entry));
  const writes = top.writes.map(entry => record('connection_write', entry));
  const work = top.work.map(entry => record('work', entry));
  const experiments = top.experiments.map(entry => record('experiment', entry));
  const skuVariants = new Map();
  for (const product of products) {
    toChannel(product.node, product.provider, atField(product.ref, 'provider'));
    for (const entry of readArray(product.row.variants, 'products.variants', `${product.ref.pointer}/variants`, limits.nestedLimit)) {
      const variant = record('variant', entry, { provider: product.provider, parent: product.node });
      edge(product.node, variant.node, 'has_variant', entry.ref, 'recorded-containment');
      const sku = toSku(variant.node, entry.row.sku, atField(entry.ref, 'sku'));
      if (sku) {
        if (!skuVariants.has(sku.sku)) skuVariants.set(sku.sku, []);
        skuVariants.get(sku.sku).push(variant);
      }
      toEconomics(variant.node, sku?.sku, identifier(entry.row.id) || identifier(entry.row.externalId), entry.ref);
    }
  }
  if (metadata('products').truncated) {
    metadata('products.variants').truncated = true;
    metadata('products.variants').totalKnown = false;
  }
  for (const rows of skuVariants.values()) if (rows.length > 1) for (const item of rows) unknown(item.node, 'unique_sku_identity', 'shared_sku_not_unique_variant', atField(item.ref, 'sku'));

  for (const item of listings) {
    toChannel(item.node, 'ebay', item.ref);
    const sku = toSku(item.node, item.row.sku, atField(item.ref, 'sku'));
    toEconomics(item.node, sku?.sku, null, item.ref);
    if (!identifier(item.row.productId) && !identifier(item.row.variantId)) unknown(item.node, 'catalogue_mapping', 'no_explicit_product_or_variant_reference', item.ref);
  }
  const completeIndex = type => {
    const collections = { product: ['products'], variant: ['products', 'products.variants'], supplier: ['suppliers'], order: ['orders'], campaign: ['marketing.campaigns'], opportunity: ['opportunities'], approval: ['approvals'], experiment: ['revenueEngine.experiments'], work: ['workRecords'] }[type] || [];
    return collections.every(name => !metadata(name).truncated && !metadata(name).invalid);
  };
  function reference(node, type, rawId, ref, relation, provider = null, required = false, relationship = null) {
    const unresolved = reason => { unknown(node, relation, reason, ref); if (relationship) Object.assign(relationship, { status: 'unresolved', reason }); };
    const id = identifier(rawId);
    if (!id) { if (required) unresolved('missing_reference'); return; }
    const matches = (indices.get(type)?.get(id) || []).filter(item => !provider || item.provider === provider);
    if (matches.length > 1) { unresolved('ambiguous_reference'); return; }
    if (!completeIndex(type)) { unresolved('target_index_incomplete'); return; }
    if (!matches.length) { unresolved('unresolved_reference'); return; }
    if (relationship && (status(matches[0].row.status) === 'archived' || matches[0].row.archived === true || matches[0].row.archivedAt)) { unresolved('archived_reference'); return; }
    const added = edge(node, matches[0].node, relation, ref);
    if (relationship) Object.assign(relationship, added ? { status: 'resolved', reason: null, targetNodeId: matches[0].node.id }
      : { status: 'unresolved', reason: matches[0].node ? 'edge_limit' : 'target_outside_projection' });
    return matches[0];
  }
  for (const item of listings) {
    reference(item.node, 'product', item.row.productId, atField(item.ref, 'productId'), 'lists_product');
    reference(item.node, 'variant', item.row.variantId, atField(item.ref, 'variantId'), 'lists_variant');
  }

  function customerNode(rawId, provider, kind, ref) {
    const value = identifier(rawId);
    if (!value || !provider) return null;
    return addNode('customer', [provider, kind, value], ref, { channel: provider, identity: kind, pseudonymous: true, crossChannelIdentityVerified: false });
  }
  for (const entry of top.customers) {
    const node = customerNode(entry.row.id, 'shopify', 'provider-customer-id', atField(entry.ref, 'id'));
    if (node) toChannel(node, 'shopify', entry.ref);
  }
  for (const order of orders) {
    toChannel(order.node, order.provider, atField(order.ref, 'provider'));
    const field = ['customerId', 'buyerId', 'buyerUsername', 'customerEmailHash'].find(name => identifier(order.row[name]));
    const customer = field && customerNode(order.row[field], order.provider, field === 'customerId' ? 'provider-customer-id' : field === 'customerEmailHash' ? 'recorded-email-hash' : field, atField(order.ref, field));
    if (customer) edge(order.node, customer, 'placed_by_customer', atField(order.ref, field), 'recorded-customer-identifier');
    else unknown(order.node, 'placed_by_customer', 'missing_customer_identifier_or_channel', order.ref);
    for (const entry of readArray(order.row.lineItems, 'orders.lineItems', `${order.ref.pointer}/lineItems`, limits.nestedLimit)) {
      const line = record('order_line', entry, { provider: order.provider, parent: order.node });
      edge(order.node, line.node, 'contains_order_line', entry.ref, 'recorded-containment');
      // mapEbayOrder currently stores line.sku || line.legacyItemId as `sku`.
      // Retained rows have no discriminator: matching that value to a catalogue
      // SKU or cost key would falsely turn a listing ID into product identity.
      if (order.provider === 'ebay') {
        unknown(line.node, 'uses_sku', 'unverified_provider_sku_provenance', atField(entry.ref, 'sku'));
        unknown(line.node, 'has_economics', 'unverified_provider_sku_provenance', entry.ref);
      } else {
        const sku = toSku(line.node, entry.row.sku, atField(entry.ref, 'sku'));
        toEconomics(line.node, sku?.sku, null, entry.ref);
      }
      reference(line.node, 'product', entry.row.productId, atField(entry.ref, 'productId'), 'references_product', order.provider);
      reference(line.node, 'variant', entry.row.variantId, atField(entry.ref, 'variantId'), 'references_variant', order.provider);
      if (!identifier(entry.row.productId) && !identifier(entry.row.variantId)) unknown(line.node, 'catalogue_mapping', 'sku_only_not_verified_product_identity', entry.ref);
    }
  }
  if (metadata('orders').truncated) { metadata('orders.lineItems').truncated = true; metadata('orders.lineItems').totalKnown = false; }

  for (const item of campaigns) {
    const product = object(item.row.product) ? item.row.product : {};
    assertScope(product); assertScope(item.row.publish);
    reference(item.node, 'product', product.productId, atField(item.ref, 'product.productId'), 'promotes_product', null, true);
    const variant = reference(item.node, 'variant', product.variantId, atField(item.ref, 'product.variantId'), 'promotes_variant');
    // Campaign planning uses flattenProducts, which can synthesize an SKU.
    // Only a matching real SKU on the explicitly referenced variant is evidence.
    if (identifier(product.sku)) {
      if (variant && identifier(variant.row.sku) === identifier(product.sku)) toSku(item.node, variant.row.sku, atField(variant.ref, 'sku'));
      else unknown(item.node, 'uses_sku', 'campaign_sku_not_verified_in_catalogue', atField(item.ref, 'product.sku'));
    }
    reference(item.node, 'approval', item.row.publish?.approvalId, atField(item.ref, 'publish.approvalId'), 'requires_approval');
    const channels = Array.isArray(item.row.channels) ? item.row.channels : [];
    const count = Math.min(channels.length, limits.nestedLimit, Math.max(0, limits.scanLimit - scanned));
    const meta = metadata('marketing.campaigns.channels');
    meta.available += channels.length; meta.scanned += count; scanned += count;
    if (count < channels.length) meta.truncated = true;
    for (let index = 0; index < count; index++) toChannel(item.node, channel(channels[index]), atField(item.ref, `channels.${index}`), 'targets_channel');
  }

  function evidenceReferences(item) {
    for (const entry of readArray(item.row.evidence, `${item.ref.collection}.evidence`, `${item.ref.pointer}/evidence`, limits.nestedLimit)) {
      const type = { product: 'product', variant: 'variant', order: 'order', opportunity: 'opportunity', approval: 'approval', experiment: 'experiment', work: 'work' }[entry.row.type];
      if (type) reference(item.node, type, entry.row.id, entry.ref, 'has_evidence_for', null, true);
      if (entry.row.type === 'economics') {
        const key = identifier(entry.row.id);
        if (key && economies.has(key)) edge(item.node, economies.get(key).node, 'has_evidence_for', entry.ref, 'explicit-economics-key');
        else unknown(item.node, 'has_evidence_for', key && Object.hasOwn(economics, key) ? 'target_outside_projection' : 'unresolved_reference', entry.ref);
      }
      if (item.node?.type === 'work') outcome(item, object(entry.row.impact) ? entry.row.impact : entry.row, object(entry.row.impact) ? { ...entry.ref, pointer: `${entry.ref.pointer}/impact` } : entry.ref, item.row.status === 'COMPLETED');
    }
  }
  function outcome(item, raw, ref, terminal) {
    if (!object(raw)) return;
    assertScope(raw);
    const metricFields = METRICS.filter(field => numeric(raw[field]));
    if (!metricFields.length) return;
    const legacyReviewed = raw.verified === true || raw.status === 'verified';
    const relativePath = ref.pointer.startsWith(item.ref.pointer) ? ref.pointer.slice(item.ref.pointer.length) : ref.pointer;
    // These retained snapshot fields have no committed outcome/current-head
    // proof. A recorded review and terminal source status cannot qualify them.
    // Keep the legacy booleans for consumers, but never promote them to results.
    const node = addNode('outcome', [item.node?.id || item.ref.pointer, relativePath, ref.field || null], ref, {
      verified: false, realised: false, qualified: false, qualification: 'legacy_unqualified',
      legacyReviewed, terminalSource: Boolean(terminal), metricFields
    });
    edge(item.node, node, 'has_recorded_outcome', ref, 'recorded-measurement');
  }
  for (const item of [...opportunities, ...approvals, ...work, ...experiments]) {
    const payload = object(item.row.payload) ? item.row.payload : {};
    assertScope(payload);
    for (const [field, type, relation] of [
      ['opportunityId', 'opportunity', 'references_opportunity'], ['approvalId', 'approval', 'requires_approval'],
      ['experimentId', 'experiment', 'evaluated_by_experiment'], ['campaignId', 'campaign', 'references_campaign']
    ]) {
      if (identifier(item.row[field])) reference(item.node, type, item.row[field], atField(item.ref, field), relation);
      if (identifier(payload[field])) reference(item.node, type, payload[field], atField(item.ref, `payload.${field}`), relation);
    }
    evidenceReferences(item);
    if (item.node?.type === 'experiment') {
      const field = ['impact', 'result', 'outcome'].find(name => object(item.row[name]));
      if (field) outcome(item, item.row[field], { ...item.ref, pointer: `${item.ref.pointer}/${field}` }, ['completed', 'measured', 'closed'].includes(status(item.row.status)));
    }
    if (item.node?.type === 'approval') {
      const field = ['impact', 'executionImpact'].find(name => object(item.row[name]));
      if (field) outcome(item, item.row[field], { ...item.ref, pointer: `${item.ref.pointer}/${field}` }, item.row.status === 'approved' && ['completed', 'succeeded', 'executed'].includes(status(item.row.executionStatus)));
    }
  }
  for (const item of economies.values()) {
    reference(item.node, 'supplier', item.row.supplierId, atField(item.ref, 'supplierId'), 'sourced_from_supplier', null, true);
    if (!item.usedAsSku) unknown(item.node, 'sku_mapping', 'no_recorded_sku_match', item.ref);
  }
  const retainedProjection = projectRetainedRequests({ workspaceId, summaryOnly, objectives, writes, approvals,
    metadata, edge, unknown, digest, atField, now: options.now || new Date().toISOString() });
  const retainedRequests = retainedProjection.projection;
  let reviewedOutcomes = null, currentProjection = null;
  const retainedCollections = ['businessObjectives', 'connectionWrites', 'approvals'];
  function updateRetainedCoverage() {
    retainedRequests.counts.projectedObjectives = retainedRequests.objectives.length;
    retainedRequests.counts.projectedRequests = retainedRequests.records.length;
    retainedRequests.counts.resolvedApprovalLinks = retainedRequests.records.filter(row => row.approval.status === 'resolved').length;
    retainedRequests.counts.resolvedObjectiveLinks = retainedRequests.records.filter(row => row.objective.status === 'resolved').length;
    retainedRequests.omitted.objectives = metadata('businessObjectives').available - retainedRequests.objectives.length;
    retainedRequests.omitted.requests = metadata('connectionWrites').available - retainedRequests.records.length;
    retainedRequests.omitted.relationships = retainedRequests.omitted.requests * 2 + retainedRequests.records.reduce((total, row) => total
      + [row.approval, row.objective].filter(link => ['edge_limit', 'target_outside_projection', 'output_byte_limit'].includes(link.reason)).length, 0);
    const displayedIds = new Set(retainedRequests.records.map(row => row.nodeId));
    const total = [...displayedIds].reduce((count, nodeId) => count + Object.values(unknownByNode.get(nodeId) || {}).reduce((a, b) => a + b, 0), 0);
    retainedRequests.omitted.mappings = total - unknownMappings.filter(row => displayedIds.has(row.subjectId)).length;
    retainedRequests.coverage.complete = retainedCollections.every(name => metadata(name).totalKnown && !metadata(name).truncated && !metadata(name).invalid)
      && Object.values(retainedRequests.omitted).every(value => value === 0);
    retainedRequests.status = retainedRequests.coverage.complete ? 'available' : 'incomplete';
  }
  function removeProjectedNode(nodeId) {
    const index = nodes.findIndex(node => node.id === nodeId);
    if (index < 0) return;
    const [node] = nodes.splice(index, 1); nodeMap.delete(nodeId); omittedNodes.add(nodeId); byType[node.type]--;
    for (let index = edges.length - 1; index >= 0; index--) if (edges[index].from === nodeId || edges[index].to === nodeId) {
      byRelation[edges[index].relation]--; edges.splice(index, 1);
    }
    for (let index = unknownMappings.length - 1; index >= 0; index--) if (unknownMappings[index].subjectId === nodeId) unknownMappings.splice(index, 1);
    for (const [reason, count] of Object.entries(unknownByNode.get(nodeId) || {})) {
      unknownTotal -= count; unknownByReason[reason] -= count; if (!unknownByReason[reason]) delete unknownByReason[reason];
    }
    unknownByNode.delete(nodeId);
    // Byte trimming can remove an already-linked retained node. Preserve a
    // precise output-limit reason, never a dangling resolved reference.
    for (const row of retainedRequests.records) for (const key of ['approval', 'objective']) {
      if (row[key].targetNodeId !== nodeId) continue;
      row[key] = { status: 'unresolved', reason: 'output_byte_limit' };
      const subject = nodeMap.get(row.nodeId);
      unknown(subject, key === 'approval' ? 'request_recorded_approval' : 'request_recorded_objective', 'output_byte_limit', subject?.sourceRef);
    }
    for (const row of reviewedOutcomes?.records || []) for (const [key, relation, field] of [
      ['requestRelationship', 'publication_recorded_request', 'links.action'], ['approvalRelationship', 'publication_recorded_approval', 'links.approval']]) {
      if (row[key].targetNodeId !== nodeId) continue;
      row[key] = { status: 'unresolved', reason: 'output_byte_limit', snapshotContentCompared: false };
      const subject = nodeMap.get(row.nodeId);
      unknown(subject, relation, 'output_byte_limit', subject && { ...subject.sourceRef, identityHash: row.versionRef, field });
    }
  }
  function trimRetainedRecord() {
    const removed = retainedRequests.records.pop() || retainedRequests.objectives.pop();
    if (!removed) return false;
    removeProjectedNode(removed.nodeId); updateRetainedCoverage(); return true;
  }
  updateRetainedCoverage();
  while (Buffer.byteLength(JSON.stringify(retainedRequests), 'utf8') > retainedRequests.limits.byteLimit && trimRetainedRecord()) { /* bounded opaque DTO */ }
  // Nested collections have known totals only for the parent rows inspected.
  for (const meta of sources.values()) {
    const parent = [...sources.values()].find(candidate => meta.collection.startsWith(`${candidate.collection}.`) && candidate.truncated);
    if (parent) { meta.totalKnown = false; meta.truncated = true; }
  }
  const retainedGraphComplete = retainedRequests.coverage.complete && [...sources.values()].every(item => !item.truncated && !item.invalid)
    && omittedNodes.size === 0 && droppedEdges === 0 && unknownTotal === unknownMappings.length;
  if (options.inspectCurrentOutcomes === true) {
    const now = options.now || new Date().toISOString();
    let qualified = null;
    let unavailableReason = ['OUTCOME_STORAGE_UNAVAILABLE', 'OUTCOME_READ_UNAVAILABLE', 'OUTCOME_RESPONSE_TOO_LARGE', 'OUTCOME_PUBLICATION_INVALID', 'OUTCOME_COVERAGE_UNAVAILABLE'].includes(options.outcomeUnavailableReason)
      ? options.outcomeUnavailableReason : 'COMMITTED_OUTCOME_PROOF_INVALID_OR_UNAVAILABLE';
    try {
      currentProjection = projectCurrentOutcomeReferences(options.outcomeSnapshot?.versions, { workspaceId, now,
        publicationBoundary: options.outcomeSnapshot?.publicationBoundary });
      // Qualify the entire selected snapshot before any graph/output truncation.
      // Otherwise removing a conflicting observation could revive an unsafe sum.
      qualified = deriveQualifiedOutcomeGroups(workspaceId, { outcomeSnapshot: options.outcomeSnapshot, now });
    } catch (error) { if (error.code === 'WORKSPACE_MISMATCH') throw error; }
    const complete = Boolean(currentProjection?.coverage.complete && qualified?.outcomeCoverage.complete);
    const qualifiedIds = new Set((complete ? qualified.qualifiedOutcomeGroups : []).flatMap(group => group.outcomeIds));
    const time = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
    const revision = identifier(options.workspaceSnapshot?.revision);
    reviewedOutcomes = {
      status: currentProjection ? complete ? 'available' : 'incomplete' : 'unavailable',
      unavailableReason: currentProjection ? complete ? null : 'COMMITTED_OUTCOME_SNAPSHOT_INCOMPLETE' : unavailableReason,
      snapshots: { workspace: { revisionRef: revision ? `workspace_revision_${digest([workspaceId, revision])}` : null,
        readCompletedAt: time(options.workspaceSnapshot?.readCompletedAt) },
      outcomes: { id: currentProjection ? `outcome_snapshot_${digest([workspaceId, currentProjection.publicationSnapshotId])}` : null,
        readCompletedAt: currentProjection ? time(options.outcomeReadCompletedAt) : null }, independent: true },
      counts: { currentHeadsRead: currentProjection?.counts.currentHeadsRead ?? null,
        publishedHeads: currentProjection?.counts.publishedHeads ?? null, withdrawnHeads: currentProjection?.counts.withdrawnHeads ?? null,
        projectedRecords: 0, resolvedExperimentLinks: 0, unresolvedExperimentLinks: 0,
        resolvedRequestLinks: 0, unresolvedRequestLinks: 0, resolvedApprovalLinks: 0, unresolvedApprovalLinks: 0,
        qualifiedMeasurements: complete ? qualified.qualifiedOutcomeCount : null },
      coverage: { publicationHeadsComplete: complete, retainedGraphComplete, projectionComplete: false, completeLifetimeHistoryClaimed: false },
      omitted: { records: 0, relationships: 0, groups: 0, mappings: 0 }, records: [],
      groups: (complete ? qualified.qualifiedOutcomeGroups : []).map(group => ({
        id: `reviewed_group_${digest([workspaceId, group.id])}`, metric: group.metric, definitionVersion: group.definitionVersion,
        method: group.method, currency: group.currency, window: { ...group.window }, measuredCount: group.measuredCount,
        knownZeroCount: group.knownZeroCount, negativeCount: group.negativeCount, positiveCount: group.positiveCount,
        amount: group.amount, amountStatus: group.amountStatus })),
      limits: { byteLimit: REVIEWED_OUTCOME_GRAPH_BYTES[summaryOnly ? 'summary' : 'detail'] },
      safeguards: { causalAttribution: false, forecastingAuthorized: false, learningAuthorized: false, executionAuthorized: false,
        currentDraftCompared: false, snapshotContentCompared: false, immutableExecutionProof: false, goalProgressEstablished: false,
        atomicSnapshot: false, continuouslyCurrent: false, lifetimeHistoryClaimed: false }
    };
    if (currentProjection) {
      const rows = currentProjection.records, meta = metadata('reviewedOutcomes.current');
      meta.available = rows.length;
      const count = Math.min(rows.length, limits.recordLimit, Math.max(0, limits.scanLimit - scanned));
      meta.scanned = count; scanned += count; meta.truncated = count < rows.length;
      for (let index = 0; index < count; index++) {
        const row = rows[index];
        const versionRef = `reviewed_version_${digest([workspaceId, row.versionId, row.digest])}`;
        const ref = { workspaceId, collection: 'runvara_business_outcome_heads', pointer: `/current/${index}`,
          identityHash: digest([workspaceId, 'reviewed-outcome', row.outcomeId]), snapshotRef: reviewedOutcomes.snapshots.outcomes.id };
        const qualifiedGroupIncluded = qualifiedIds.has(row.outcomeId);
        const node = addNode('reviewed_outcome', row.outcomeId, ref, { status: row.status, versionRef,
          measurementComplete: row.measurementComplete, qualifiedGroupIncluded,
          qualification: row.status === 'withdrawn' ? 'withdrawn' : row.measurementComplete ? 'owner_attested_measurement' : 'unqualified_measurement' });
        if (!node) continue;
        const relationship = { status: 'unresolved', reason: null };
        reference(node, 'experiment', row.source.experimentId,
          { ...ref, identityHash: digest([workspaceId, row.outcomeId, row.versionId, row.digest]), field: 'source.experimentId' },
          'measurement_recorded_for_experiment', null, true, relationship);
        const publishedRelationship = (found, relation, field) => {
          const refForVersion = { ...ref, identityHash: digest([workspaceId, row.outcomeId, row.versionId, row.digest]), field };
          const unresolved = reason => {
            unknown(node, relation, reason, refForVersion);
            return { status: 'unresolved', reason, snapshotContentCompared: false };
          };
          if (row.actionReferenceReason) return unresolved(row.actionReferenceReason);
          if (!row.actionReferences) return { status: 'not_recorded', reason: null, snapshotContentCompared: false };
          if (found.reason) return unresolved(found.reason);
          if (!found.item.node || !nodeMap.has(found.item.node.id)) return unresolved('target_outside_projection');
          return edge(node, found.item.node, relation, refForVersion, 'recorded-publication-reference')
            ? { status: 'resolved', reason: null, snapshotContentCompared: false, targetNodeId: found.item.node.id }
            : unresolved('edge_limit');
        };
        const targets = row.actionReferences ? retainedProjection.resolvePublicationTargets(row.actionReferences) : null;
        const requestRelationship = publishedRelationship(targets?.request, 'publication_recorded_request', 'links.action');
        const approvalRelationship = publishedRelationship(targets?.approval, 'publication_recorded_approval', 'links.approval');
        reviewedOutcomes.records.push({ nodeId: node.id, versionRef, status: row.status, measurementComplete: row.measurementComplete,
          qualifiedGroupIncluded, relationship, requestRelationship, approvalRelationship });
      }
    }
  }
  const sourceCoverage = [...sources.values()];
  const truncated = sourceCoverage.some(item => item.truncated) || omittedNodes.size > 0 || droppedEdges > 0 || unknownTotal > unknownMappings.length;
  const result = {
    schema: 'runvara-business-graph/v1', mode: summaryOnly ? 'summary' : 'detail', workspaceId,
    persistence: { mode: 'projection-of-authoritative-persisted-records', separateGraphStored: false, sourceOfTruth: 'existing-workspace-state', writesPerformed: 0, note: 'References are rebuilt from the retained tenant snapshot on demand; this response is not a separately persisted graph or a complete history of provider data.' },
    summary: { nodes: nodes.length, edges: edges.length, nodesByType: byType, edgesByRelation: byRelation, unknownMappings: unknownTotal, unknownByReason,
      recordedOutcomeRecords: byType.outcome || 0,
      legacyReviewedOutcomeRecords: nodes.filter(item => item.type === 'outcome' && item.attributes.legacyReviewed).length,
      verifiedOutcomeRecords: 0, countsAreProjectionOnly: true, outcomeCountsAreSourceRecords: true },
    outcomeCoverage: { publicationProofAvailable: false, complete: false, unavailableReason: 'COMMITTED_OUTCOME_SNAPSHOT_NOT_SUPPLIED', completeLifetimeHistoryClaimed: false,
      note: 'Outcome nodes are unqualified legacy source records. Recorded reviews and terminal statuses do not establish realised commercial results. This projection does not read current committed outcome heads; a zero verified count does not establish that no qualified outcomes exist.' },
    coverage: { truncated, complete: retainedRequests.coverage.complete && !truncated && sourceCoverage.every(item => !item.invalid), scannedRecords: scanned, droppedNodes: omittedNodes.size, droppedEdges, omittedUnknownMappings: unknownTotal - unknownMappings.length, sources: sourceCoverage, scope: 'retained-records-in-this-workspace', ordering: 'source-array-order; duplicate-ID ordinals are snapshot-local', note: 'Missing mappings and truncated indexes never establish a relationship. Shared SKU evidence does not establish product equivalence; channel evidence does not establish campaign attribution.' },
    limits, retainedRequests,
    safeguards: { tenantScope: workspaceId, readOnly: true, externalWrites: false, providerRequests: false, rawSourceRecordsIncluded: false, rawCustomerIdentityIncluded: false, rawRecordIdsIncluded: false, credentialsIncluded: false, promptBodiesIncluded: false, inferredProductEquivalence: false, inferredCampaignAttribution: false, unknownProfitConvertedToZero: false }
  };
  if (reviewedOutcomes) {
    result.reviewedOutcomes = reviewedOutcomes;
    result.persistence.sourceOfTruth = 'existing-workspace-state-and-separate-committed-outcome-heads';
    result.persistence.note = 'References are rebuilt from independent retained workspace and bounded current-outcome snapshots on explicit inspection. This is neither an atomic snapshot nor complete lifetime history.';
    result.outcomeCoverage = { publicationProofAvailable: Boolean(currentProjection), complete: reviewedOutcomes.coverage.publicationHeadsComplete,
      unavailableReason: reviewedOutcomes.unavailableReason, completeLifetimeHistoryClaimed: false,
      note: 'Current heads are explicitly inspected separately from retained workspace state. Legacy source records remain unqualified; zero projected records does not establish zero tenant outcomes.' };
    const currentRelationshipCount = (currentProjection?.records || []).reduce((total, row) => total + 1 + (row.actionReferences || row.actionReferenceReason ? 2 : 0), 0);
    const updateCurrentCoverage = () => {
      const records = reviewedOutcomes.records;
      reviewedOutcomes.counts.projectedRecords = records.length;
      reviewedOutcomes.counts.resolvedExperimentLinks = records.filter(row => row.relationship.status === 'resolved').length;
      reviewedOutcomes.counts.unresolvedExperimentLinks = records.length - reviewedOutcomes.counts.resolvedExperimentLinks;
      for (const [name, key] of [['Request', 'requestRelationship'], ['Approval', 'approvalRelationship']]) {
        reviewedOutcomes.counts[`resolved${name}Links`] = records.filter(row => row[key].status === 'resolved').length;
        reviewedOutcomes.counts[`unresolved${name}Links`] = records.filter(row => row[key].status === 'unresolved').length;
      }
      reviewedOutcomes.omitted.records = (currentProjection?.records.length || 0) - records.length;
      // Every omitted current record has its experiment reference plus the
      // recorded pair (including a rejected partial pair), not three invented
      // relationships for an explicitly unlinked publication.
      reviewedOutcomes.omitted.relationships = currentRelationshipCount - records.reduce((total, row) => total + 1 + (row.requestRelationship.status !== 'not_recorded' ? 2 : 0), 0)
        + records.reduce((total, row) => total + [row.relationship, row.requestRelationship, row.approvalRelationship].filter(link => OUTPUT_REASONS.has(link.reason)).length, 0);
      const currentIds = new Set(records.map(row => row.nodeId));
      const currentUnknowns = records.reduce((total, row) => total + Object.values(unknownByNode.get(row.nodeId) || {}).reduce((a, b) => a + b, 0), 0);
      reviewedOutcomes.omitted.mappings = currentUnknowns - unknownMappings.filter(row => currentIds.has(row.subjectId)).length;
      reviewedOutcomes.coverage.projectionComplete = Boolean(currentProjection) && Object.values(reviewedOutcomes.omitted).every(value => value === 0);
      result.summary.nodes = nodes.length; result.summary.edges = edges.length;
      result.summary.unknownMappings = unknownTotal;
      result.summary.currentHeadRecordsRead = reviewedOutcomes.counts.currentHeadsRead;
      result.summary.projectedReviewedOutcomeRecords = records.length;
      result.coverage.droppedNodes = omittedNodes.size;
      result.coverage.omittedUnknownMappings = unknownTotal - unknownMappings.length;
      if (reviewedOutcomes.omitted.records || reviewedOutcomes.omitted.groups) { result.coverage.truncated = true; result.coverage.complete = false; }
      const meta = sources.get('reviewedOutcomes.current');
      if (meta && reviewedOutcomes.omitted.records) meta.truncated = true;
    };
    // Conservatively account for ALL graph metadata plus the complete added
    // envelope and added detail rows, including repeated refs and omission counts.
    // This is an extension bound, not a whole legacy graph response byte cap.
    const extensionBytes = () => Buffer.byteLength(JSON.stringify({ ...result,
      ...(summaryOnly ? {} : { nodes: nodes.filter(node => node.type === 'reviewed_outcome'), edges: edges.filter(row => REVIEWED_RELATIONS.has(row.relation)), unknownMappings: unknownMappings.filter(row => REVIEWED_RELATIONS.has(row.relation)) }) }), 'utf8');
    updateCurrentCoverage();
    while (extensionBytes() > reviewedOutcomes.limits.byteLimit && trimRetainedRecord()) {
      reviewedOutcomes.coverage.retainedGraphComplete = false;
      updateCurrentCoverage();
    }
    while (extensionBytes() > reviewedOutcomes.limits.byteLimit && (reviewedOutcomes.groups.length || reviewedOutcomes.records.length)) {
      if (reviewedOutcomes.groups.length) { reviewedOutcomes.groups.pop(); reviewedOutcomes.omitted.groups++; }
      else {
        const removed = reviewedOutcomes.records.pop();
        removeProjectedNode(removed.nodeId);
      }
      updateCurrentCoverage();
    }
    if (retainedRequests.omitted.objectives || retainedRequests.omitted.requests) { result.coverage.truncated = true; result.coverage.complete = false; }
    // Bounded fixed metadata remains below the envelope even without row data.
    if (extensionBytes() > reviewedOutcomes.limits.byteLimit) throw Object.assign(new Error('Reviewed outcome extension exceeded its byte limit'), { code: 'OUTCOME_GRAPH_SIZE_LIMIT', status: 503 });
  }
  return summaryOnly ? result : { ...result, nodes, edges, unknownMappings };
}

export function deriveBusinessGraph(state = {}, options = {}) {
  return project(state, object(options) ? options : {}, false);
}

export function deriveBusinessGraphSummary(state = {}, options = {}) {
  return project(state, object(options) ? options : {}, true);
}
