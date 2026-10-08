// Retained-state preparation only. Never decrypt, refresh or contact Shopify.
export const MANUAL_CONTENT_TARGET_SCHEMA = 'runvara-manual-content-target/v1';
export const MANUAL_CONTENT_REQUEST_SCHEMA = 'runvara-manual-content-request/v1';
export const MANUAL_CONTENT_SCAN_LIMIT = 10000;
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
export const manualContentError = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const invalid = () => manualContentError('WRITE_TARGET_INVALID', 'The saved content target could not be verified. Refresh and review the connection.');

export function manualContentRecord(value, root = false) {
  if (!plain(value)) throw invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length > 128 || Reflect.ownKeys(value).some(key => typeof key !== 'string'
    && !(root && key.description === 'persisted' && fields[key].enumerable === false && own(fields[key], 'value') && fields[key].value === true))
    || Object.values(fields).some(field => !own(field, 'value'))) throw invalid();
  return value;
}
export function manualContentRows(value, limit = MANUAL_CONTENT_SCAN_LIMIT) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
  for (let i = 0; i < value.length; i++) {
    const field = Object.getOwnPropertyDescriptor(value, i);
    if (!field || !own(field, 'value')) throw invalid();
    manualContentRecord(field.value);
  }
  return value;
}
export function assertManualContentScope(value, workspaceId, depth = 0, budget = { left: 4096 }) {
  if (--budget.left < 0 || depth > 12) throw invalid();
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1024 || Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
    for (let i = 0; i < value.length; i++) {
      const field = Object.getOwnPropertyDescriptor(value, i);
      if (!field || !own(field, 'value')) throw invalid();
      assertManualContentScope(field.value, workspaceId, depth + 1, budget);
    }
    return;
  }
  manualContentRecord(value);
  for (const key of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'workspace', 'tenant']) {
    if (!(key in value)) continue;
    if (!own(value, key)) throw invalid();
    const marker = value[key];
    if (['workspace', 'tenant'].includes(key) && plain(marker)) {
      manualContentRecord(marker);
      if (!own(marker, 'id') || marker.id !== workspaceId) throw invalid();
    } else if (marker !== workspaceId) throw invalid();
  }
  for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    // Ciphertext is opaque and is never hashed, copied or returned by this helper.
    if (key !== 'encryptedCredentials') assertManualContentScope(field.value, workspaceId, depth + 1, budget);
  }
}
export function manualContentWorkspace(state) {
  // Both real stores attach a private, non-enumerable persisted marker. It is
  // not request or account data and must not make every loaded workspace fail.
  manualContentRecord(state, true);
  for (const key of ['workspace', 'users', 'connections', 'connectionSettings', 'connectionWrites', 'products', 'approvals']) {
    if (key in state && !own(state, key)) throw invalid();
  }
  manualContentRecord(state.workspace);
  const workspaceId = state.workspace.id;
  if (!id(workspaceId)) throw invalid();
  // Check top-level markers without walking unrelated business data.
  for (const key of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'tenant']) {
    if (key in state) { if (!own(state, key)) throw invalid(); assertManualContentScope({ [key]: state[key] }, workspaceId); }
  }
  assertManualContentScope(state.workspace, workspaceId);
  return workspaceId;
}
export function assertManualContentActor(state, actor) {
  const workspaceId = manualContentWorkspace(state);
  const users = manualContentRows(state.users, 2000).filter(row => row.id === actor);
  const user = users[0];
  if (!id(actor) || users.length !== 1 || !['owner', 'admin'].includes(user.role) || user.active === false || user.passwordChangeRequired) {
    throw manualContentError('WRITE_ACTOR_CHANGED', 'Your account changed. Sign in and review the request again.', 403);
  }
  assertManualContentScope(user, workspaceId);
  return user;
}
export function validateManualContentTarget(target) {
  try {
    manualContentRecord(target);
    const keys = ['schema', 'connectionId', 'account', 'settingsRevision'];
    if (Reflect.ownKeys(target).length !== keys.length || !keys.every(key => own(target, key))
      || target.schema !== MANUAL_CONTENT_TARGET_SCHEMA || !id(target.connectionId)
      || typeof target.account !== 'string' || target.account.length > 253 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(target.account)
      || !Number.isSafeInteger(target.settingsRevision) || target.settingsRevision < 0) throw invalid();
    return target;
  } catch {
    throw manualContentError('WRITE_TARGET_REVIEW_REQUIRED', 'Refresh the page and deliberately review the exact Shopify content target.');
  }
}
export function resolveManualContentTarget(state) {
  try {
    const workspaceId = manualContentWorkspace(state);
    const records = manualContentRows(state.connections || [], 1000);
    const shopify = records.filter(row => row.provider === 'shopify');
    for (const row of shopify) {
      assertManualContentScope(row, workspaceId);
      if (!id(row.id) || records.filter(other => other.id === row.id).length !== 1) throw invalid();
      if (own(row, 'encryptedCredentials') && row.encryptedCredentials != null
        && (typeof row.encryptedCredentials !== 'string' || row.encryptedCredentials.length > 131072)) throw invalid();
    }
    const candidates = shopify.filter(row => row.encryptedCredentials);
    if (candidates.length !== 1) throw manualContentError('WRITE_TARGET_UNAVAILABLE', candidates.length
      ? 'More than one saved Shopify account can supply credentials. Content preparation needs one unambiguous connection.'
      : 'A saved Shopify connection with product write access is required for content preparation.');
    const connection = candidates[0];
    manualContentRecord(connection.metadata);
    const scopes = connection.metadata.grantedScopes;
    if (!Array.isArray(scopes) || scopes.length > 100 || scopes.some(scope => typeof scope !== 'string' || scope.length > 100)) throw invalid();
    if (!scopes.includes('write_products')) throw manualContentError('WRITE_SCOPE_REQUIRED', 'Shopify product write access has not been confirmed for this exact connection.');
    if (state.connectionSettings) {
      manualContentRecord(state.connectionSettings);
      for (const key of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'workspace', 'tenant']) {
        if (key in state.connectionSettings) { if (!own(state.connectionSettings, key)) throw invalid(); assertManualContentScope({ [key]: state.connectionSettings[key] }, workspaceId); }
      }
      if ('shopify' in state.connectionSettings && !own(state.connectionSettings, 'shopify')) throw invalid();
    }
    const settings = state.connectionSettings?.shopify || {};
    assertManualContentScope(settings, workspaceId);
    if (settings.disconnected || !['approval_gated', 'automatic'].includes(settings.permissionMode)) {
      throw manualContentError('WRITE_NOT_AUTHORISED', 'The exact Shopify connection is read-only. Owner permission is required before preparing content.', 403);
    }
    if (settings.permissionMode === 'automatic' && (!settings.consent || settings.consent.mode !== 'automatic')) {
      throw manualContentError('OWNER_APPROVAL_REQUIRED', 'The owner must explicitly authorise automatic writes.', 403);
    }
    const target = { schema: MANUAL_CONTENT_TARGET_SCHEMA, connectionId: connection.id,
      account: connection.metadata.shopDomain, settingsRevision: settings.revision ?? 0 };
    validateManualContentTarget(target);
    return { available: true, target };
  } catch (error) {
    return { available: false, code: error?.code || 'WRITE_TARGET_INVALID', message: error?.code ? error.message : invalid().message };
  }
}
export function assertManualContentTarget(state, target) {
  validateManualContentTarget(target);
  const current = resolveManualContentTarget(state);
  if (!current.available) throw manualContentError(current.code, current.message, current.code === 'WRITE_NOT_AUTHORISED' ? 403 : 409);
  if (Object.keys(current.target).some(key => target[key] !== current.target[key])) {
    throw manualContentError('WRITE_TARGET_CHANGED', 'The saved Shopify target or settings changed. Refresh and review the exact account again.');
  }
  return state.connections.find(row => row.id === current.target.connectionId && row.provider === 'shopify');
}
