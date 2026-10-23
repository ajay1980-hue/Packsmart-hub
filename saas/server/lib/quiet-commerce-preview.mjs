import { evidenceInWorkspace } from './business-evidence-scope.mjs';
import { ECONOMICS_FIELDS } from './profit.mjs';

// A projection of one exact saved snapshot. No hydration, joins, estimates or I/O.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const label = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : null;
function recorded(value, integer = false) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text.length <= 40 && (integer ? /^-?\d+$/ : /^-?\d+(?:\.\d+)?$/).test(text) && Number.isFinite(Number(text)) ? text : null;
}
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
export function quietCommercePreview(auth) {
  const { state, session } = auth, workspaceId = session.workspaceId;
  const owned = row => evidenceInWorkspace(row, workspaceId);
  const users = Array.isArray(state?.users) ? state.users.filter(row => row?.id === session.sub) : [];
  if (!owned(state) || !owned(state.workspace) || state.workspace.id !== workspaceId || users.length !== 1 || !owned(users[0])) {
    throw Object.assign(new Error('Saved commerce scope is unavailable'), { status: 403, code: 'COMMERCE_PREVIEW_SCOPE_INVALID' });
  }
  if (users[0].role !== 'owner') throw Object.assign(new Error('Existing workspace owner access required'), { status: 403, code: 'ROLE_DENIED' });
  if (users[0].passwordChangeRequired !== false) throw Object.assign(new Error('Complete password setup before viewing saved commerce'), { status: 403, code: 'PASSWORD_CHANGE_REQUIRED' });
  const products = Array.isArray(state.products) ? state.products : [];
  const rows = [], costs = [];
  let partial = !Array.isArray(state.products), inspected = 0;
  outer: for (const product of products) {
    if (++inspected > 1000) { partial = true; break; }
    if (!owned(product)) { partial = true; continue; }
    const variants = Array.isArray(product.variants) && product.variants.length ? product.variants : [product];
    for (const variant of variants) {
      if (rows.length >= 100) { partial = true; break outer; }
      if (!owned(variant)) { partial = true; continue; }
      rows.push({ product: label(product.title), variant: variant === product ? null : label(variant.title),
        id: label(variant.id), sku: label(variant.sku), stock: recorded(variant.inventory, true),
        price: recorded(variant.price), currency: currency(Object.hasOwn(variant, 'currency') ? variant.currency : product.currency) });
    }
  }
  if (!object(state.economics)) partial = true;
  else { let inspectedCosts = 0; for (const [key, entry] of Object.entries(state.economics)) {
    if (++inspectedCosts > 1000) { partial = true; break; }
    if (costs.length >= 100) { partial = true; break; }
    if (!owned(entry) || key.length > 300) { partial = true; continue; }
    // Keep the exact key; do not infer SKU/variant assignment or fill missing costs.
    costs.push({ key: label(key, 300), currency: currency(entry.currency),
      amounts: Object.fromEntries(ECONOMICS_FIELDS.map(field => [field, recorded(entry[field])])) });
  } }
  return { schema: 'runvara-quiet-commerce-preview/v1', maintenance: true,
    workspace: { id: workspaceId, name: label(state.workspace.name) },
    workspaceUpdatedAt: label(state.workspace.updatedAt, 80), partial, rows, costs };
}
