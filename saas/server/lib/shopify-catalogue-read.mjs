import { evidenceInWorkspace } from './business-evidence-scope.mjs';

const LIMITS = Object.freeze({ products: 50, variants: 100, idLength: 256, cursorBytes: 4096, scopeDepth: 5 });
const SCOPE_KEYS = ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'workspace', 'tenant'];
const plain = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalidPage = () => Object.assign(new Error('Shopify catalogue page is incomplete or invalid; existing catalogue retained'), {
  code: 'SHOPIFY_CATALOGUE_PAGE_INVALID', status: 502
});
const variantLimit = () => Object.assign(new Error('Variant coverage is incomplete; existing catalogue retained'), {
  code: 'SHOPIFY_VARIANT_COVERAGE_LIMIT', status: 502
});

// Only read own data properties. Parsed JSON has these; synthetic accessors and
// inherited values cannot supply missing identities or pagination metadata.
function field(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw invalidPage();
  return descriptor?.value;
}

function inspectScope(value, workspaceId, depth = 0) {
  if (!plain(value) || depth > LIMITS.scopeDepth) throw invalidPage();
  const markers = Object.create(null);
  for (const key of SCOPE_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const marker = field(value, key);
    if ((key === 'workspace' || key === 'tenant') && marker !== null && typeof marker === 'object') {
      inspectScope(marker, workspaceId, depth + 1);
      markers[key] = { id: field(marker, 'id') };
    } else markers[key] = marker;
  }
  // This rejects explicit conflicting/malformed markers. Marker absence is not
  // proof of Shopify account membership, tenant ownership, or source provenance.
  if (!evidenceInWorkspace(markers, workspaceId)) throw invalidPage();
}

function nodes(value, limit) {
  if (!Array.isArray(value) || value.length > limit) throw invalidPage();
  const rows = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw invalidPage();
    rows.push(field(value, index));
  }
  return rows;
}

function identity(value, resource) {
  return typeof value === 'string' && value.length <= LIMITS.idLength && value === value.trim()
    && (resource === 'Product' ? /^gid:\/\/shopify\/Product\/[0-9]+$/ : /^gid:\/\/shopify\/ProductVariant\/[0-9]+$/).test(value);
}

function cursor(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= LIMITS.cursorBytes
    && Buffer.byteLength(value, 'utf8') <= LIMITS.cursorBytes;
}

// Validation starts after the existing response.json() decoder; these local
// collection bounds do not bound the size or decoding cost of the HTTP body.
// Caller-owned sets are read-only, including when a later record is rejected.
export function inspectShopifyCataloguePage(data, {
  workspaceId, after = null, seenProductIds = new Set(), seenVariantIds = new Set(), seenCursors = new Set()
} = {}) {
  if (!(seenProductIds instanceof Set) || !(seenVariantIds instanceof Set) || !(seenCursors instanceof Set)
    || after !== null && !cursor(after)) throw invalidPage();
  inspectScope(data, workspaceId);
  const connection = field(data, 'products');
  inspectScope(connection, workspaceId);
  const pageInfo = field(connection, 'pageInfo');
  inspectScope(pageInfo, workspaceId);
  const hasNextPage = field(pageInfo, 'hasNextPage');
  if (typeof hasNextPage !== 'boolean') throw invalidPage();
  const endCursor = field(pageInfo, 'endCursor');
  if (endCursor !== undefined && endCursor !== null && !cursor(endCursor)) throw invalidPage();
  if (hasNextPage && (!cursor(endCursor) || endCursor === after || seenCursors.has(endCursor))) throw invalidPage();
  const products = nodes(field(connection, 'nodes'), LIMITS.products);
  if (hasNextPage && !products.length) throw invalidPage();
  const productIds = new Set(), variantIds = new Set();
  for (const product of products) {
    inspectScope(product, workspaceId);
    const productId = field(product, 'id');
    if (!identity(productId, 'Product') || productIds.has(productId) || seenProductIds.has(productId)) throw invalidPage();
    productIds.add(productId);
    const variants = field(product, 'variants');
    inspectScope(variants, workspaceId);
    const variantPageInfo = field(variants, 'pageInfo');
    inspectScope(variantPageInfo, workspaceId);
    const variantsContinue = field(variantPageInfo, 'hasNextPage');
    if (variantsContinue === true) throw variantLimit();
    if (variantsContinue !== false) throw invalidPage();
    for (const variant of nodes(field(variants, 'nodes'), LIMITS.variants)) {
      inspectScope(variant, workspaceId);
      const variantId = field(variant, 'id');
      if (!identity(variantId, 'ProductVariant') || variantIds.has(variantId) || seenVariantIds.has(variantId)) throw invalidPage();
      variantIds.add(variantId);
    }
  }
  return { nodes: products, productIds: [...productIds], variantIds: [...variantIds], hasNextPage,
    nextCursor: hasNextPage ? endCursor : null };
}
