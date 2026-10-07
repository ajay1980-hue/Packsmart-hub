import crypto from 'node:crypto';
import { addAudit } from './events.mjs';
import { META_WRITES, META_ORDER_RESTRICTION } from './meta-capabilities.mjs';

// One capability registry for the existing IntegrationService, UI and scheduler.
// Areas describe implemented reads, not the provider's theoretical API features.
export const CONNECTORS = Object.freeze({
  shopify: { name: 'Shopify', areas: ['products', 'variants', 'inventory', 'prices', 'orders', 'customers'], defaults: ['products', 'variants', 'inventory', 'prices', 'orders'], writes: ['product_content', 'internal_note', 'product_tags_add', 'product_tags_remove'] },
  ebay: { name: 'eBay', areas: ['products', 'inventory', 'prices', 'orders', 'promotions'], defaults: ['products', 'inventory', 'prices', 'orders', 'promotions'], writes: [] },
  meta: { name: 'Facebook & Instagram', areas: ['accounts', 'catalogs', 'products', 'inventory', 'prices', 'posts'], defaults: ['accounts'], writes: META_WRITES },
  tiktok_shop: { name: 'TikTok Shop', areas: ['shops', 'products', 'variants', 'inventory', 'prices', 'orders'], defaults: ['shops', 'products', 'variants', 'inventory', 'prices', 'orders'], writes: [] },
  google_youtube: { name: 'Google & YouTube', areas: ['channels'], defaults: ['channels'], writes: [] },
  pinterest: { name: 'Pinterest', areas: ['boards', 'pins'], defaults: ['boards', 'pins'], writes: [] },
  whatsapp_business: { name: 'WhatsApp Business', areas: [], defaults: [], writes: [] },
  amazon: { name: 'Amazon', areas: [], defaults: [], writes: [] }
});
export const PERMISSION_MODES = ['read_only', 'approval_gated', 'automatic'];
export const connectionError = (message, code = 'CONNECTION_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
export function connector(provider) {
  const definition = Object.hasOwn(CONNECTORS, provider) && CONNECTORS[provider];
  if (!definition) throw connectionError('This channel is not supported.', 'CONNECTOR_NOT_FOUND', 404);
  return definition;
}
export function connectionSettings(state, provider) {
  const definition = connector(provider), saved = state.connectionSettings?.[provider] || {};
  return { revision: 0, disconnected: false, autoSync: true, frequencyMinutes: 30, areas: definition.defaults.slice(), permissionMode: 'read_only', ...saved };
}
export const isShopifyOrderSourceFailure = (provider, code) => provider === 'shopify' && /^SHOPIFY_ORDER_SOURCE_[A-Z0-9_]+$/.test(String(code || ''));
export const SHOPIFY_ORDER_READ_POLICY = 'shopify-orders-v2:90-day-updated-window:10-pages:50-orders:100-lines';
const LEGACY_SHOPIFY_ORDER_READ_POLICY = 'shopify-orders-v1:90-day-created:10-pages:50-orders:100-lines';
const recognizedShopifyOrderReadPolicy = policy => [LEGACY_SHOPIFY_ORDER_READ_POLICY, SHOPIFY_ORDER_READ_POLICY].includes(policy);
// Bind failures to the source contract without making a query-policy migration
// a fresh source. Token rotation and moving query bounds are not source identity.
export function shopifyOrderReadBinding(state, integrations = null, config = undefined) {
  if (config === undefined && integrations?.shopifyConfig) {
    try { config = integrations.shopifyConfig(state); } catch { return null; }
  }
  const connection = config && Object.hasOwn(config, 'connection') ? config.connection : (state.connections || []).find(item => item.provider === 'shopify');
  const text = value => value === undefined || value === null ? '' : typeof value === 'string' && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  const binding = { schema: 'shopify-order-hold/v1', workspaceId: text(state.workspace?.id), provider: 'shopify',
    domain: text(config?.domain || connection?.metadata?.shopDomain || integrations?.env?.SHOPIFY_STORE_DOMAIN)?.toLowerCase() ?? null,
    connectionId: text(connection?.id), accountId: text(connection?.metadata?.shopId || connection?.metadata?.accountId),
    apiVersion: text(config?.apiVersion || integrations?.env?.SHOPIFY_ADMIN_API_VERSION || '2026-07'),
    sourcePolicy: SHOPIFY_ORDER_READ_POLICY };
  return binding.workspaceId && Object.values(binding).every(value => value !== null) ? Object.freeze(binding) : null;
}
// Admission is strict: a read must still belong to the exact configuration and
// policy that started it. Conservative hold matching below is not admission.
export function isShopifyOrderReadAdmissionCurrent(state, binding, integrations = null) {
  if (!validShopifyOrderReadBinding(binding)) return false;
  const current = shopifyOrderReadBinding(state, integrations);
  if (!current) return false;
  return Object.keys(current).every(key => current[key] === binding[key]);
}
function validShopifyOrderReadBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const keys = ['schema', 'workspaceId', 'provider', 'domain', 'connectionId', 'accountId', 'apiVersion', 'sourcePolicy'];
  if (Reflect.ownKeys(binding).length !== keys.length || !keys.every(key => Object.hasOwn(binding, key))) return false;
  const fields = Object.getOwnPropertyDescriptors(binding);
  if (!keys.every(key => Object.hasOwn(fields[key], 'value') && typeof fields[key].value === 'string'
    && fields[key].value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(fields[key].value))) return false;
  return binding.schema === 'shopify-order-hold/v1' && binding.provider === 'shopify' && Boolean(binding.workspaceId);
}
function shopifyOrderSourceReplaced(previous, current, integrations) {
  if (!validShopifyOrderReadBinding(previous) || !validShopifyOrderReadBinding(current)
    || previous.workspaceId !== current.workspaceId
    || !recognizedShopifyOrderReadPolicy(previous.sourcePolicy) || !recognizedShopifyOrderReadPolicy(current.sourcePolicy)) return false;
  const identityFields = ['domain', 'connectionId', 'accountId', ...(integrations?.shopifyConfig || integrations?.env ? ['apiVersion'] : [])];
  return identityFields.some(key => previous[key] && current[key] && previous[key] !== current[key]);
}
// A persisted protection remains applicable unless a known source identity is
// positively replaced. v1 -> v2, unknown policies, unavailable configuration,
// and missing/enriched metadata cannot silently release a hold or retry budget.
export function isShopifyOrderReadBindingCurrent(state, binding, integrations = null) {
  if (!validShopifyOrderReadBinding(binding) || binding.workspaceId !== state.workspace?.id) return false;
  return !shopifyOrderSourceReplaced(binding, shopifyOrderReadBinding(state, integrations), integrations);
}
export function shopifyOrderReadHold(state, provider, integrations = null) {
  if (provider !== 'shopify') return null;
  const status = state.integrationStatus?.shopify || {};
  return isShopifyOrderSourceFailure(provider, status.orderReadHold?.code) && isShopifyOrderReadBindingCurrent(state, status.orderReadHold.binding, integrations) ? status.orderReadHold : null;
}
export function orderReadHeld(state, provider, areas = connectionSettings(state, provider).areas, integrations = null) {
  return Boolean(areas.includes('orders') && shopifyOrderReadHold(state, provider, integrations));
}
export function connectionDoctorState(state, provider, integrations = null) {
  const doctor = state.connectionDoctor?.[provider] || {};
  // A source replacement gets its own read budget; refresh-token rotation is
  // deliberately outside the stable binding and cannot release consumed work.
  // Losing/enriching an identity field is not proof of a different source.
  const previous = doctor.orderReadBinding;
  const current = provider === 'shopify' && validShopifyOrderReadBinding(previous) ? shopifyOrderReadBinding(state, integrations) : null;
  if (shopifyOrderSourceReplaced(previous, current, integrations)) {
    return { ...doctor, attempts: 0, exhausted: false, nextRetryAt: null, orderReadBinding: null };
  }
  return doctor;
}
export function completeShopifyOrderReadBudget(state, integrations, admittedBinding) {
  const doctor = state.connectionDoctor?.shopify;
  if (!doctor?.orderReadBinding || !isShopifyOrderReadAdmissionCurrent(state, admittedBinding, integrations) || shopifyOrderReadHold(state, 'shopify', integrations)) return;
  Object.assign(doctor, { attempts: 0, exhausted: false, nextRetryAt: null });
  delete doctor.orderReadBinding;
}
function unknownShopifyOrderReadPolicy(doctor) {
  const binding = doctor.orderReadBinding;
  return Boolean(binding && (!validShopifyOrderReadBinding(binding) || !recognizedShopifyOrderReadPolicy(binding.sourcePolicy)));
}
// An unrecognized persisted contract cannot authorize automatic orders, even
// with attempts left. Keep the original budget intact for explicit recovery;
// products-only work and token refresh do not spend or release that budget.
export function shopifyOrderReadPolicyBlocked(state, integrations, areas = connectionSettings(state, 'shopify').areas) {
  return areas.includes('orders') && unknownShopifyOrderReadPolicy(connectionDoctorState(state, 'shopify', integrations));
}
export function shopifyOrderReadBudgetExhausted(state, integrations, areas = connectionSettings(state, 'shopify').areas) {
  const doctor = connectionDoctorState(state, 'shopify', integrations);
  return Boolean(doctor.orderReadBinding && (doctor.exhausted === true || !Number.isSafeInteger(doctor.attempts) || doctor.attempts < 0 || doctor.attempts >= 5
    || areas.includes('orders') && unknownShopifyOrderReadPolicy(doctor)));
}
export function validateAreas(provider, value) {
  const areas = connector(provider).areas;
  if (!Array.isArray(value) || !value.length || value.length > areas.length || value.some(item => !areas.includes(item))) throw connectionError('Choose at least one supported sync area.', 'SYNC_AREAS_INVALID');
  return [...new Set(value)];
}
export function saveConnectionSettings(state, provider, body, user) {
  const previous = connectionSettings(state, provider);
  if (body.revision !== previous.revision) throw connectionError('These settings changed. Refresh the page and try again.', 'CONNECTION_CONFLICT', 409);
  const next = { ...previous };
  if (Object.hasOwn(body, 'areas')) next.areas = validateAreas(provider, body.areas);
  if (Object.hasOwn(body, 'autoSync')) {
    if (typeof body.autoSync !== 'boolean') throw connectionError('Choose whether automatic sync is on or off.');
    next.autoSync = body.autoSync;
  }
  if (Object.hasOwn(body, 'frequencyMinutes')) {
    if (![15, 30, 60, 180, 360, 1440].includes(body.frequencyMinutes)) throw connectionError('Choose a supported sync frequency.');
    next.frequencyMinutes = body.frequencyMinutes;
  }
  if (Object.hasOwn(body, 'permissionMode')) {
    if (!PERMISSION_MODES.includes(body.permissionMode)) throw connectionError('Choose a supported permission setting.');
    if (body.permissionMode !== 'read_only' && !connector(provider).writes.length) throw connectionError('Write actions are not implemented for this channel. Automatic read syncing is available separately.', 'WRITE_UNSUPPORTED', 422);
    if (body.permissionMode !== previous.permissionMode) {
      if (user.role !== 'owner') throw connectionError('Only the workspace owner can change write permissions.', 'OWNER_APPROVAL_REQUIRED', 403);
      if (body.permissionMode !== 'read_only' && body.confirmPermission !== `${provider}:${body.permissionMode}`) throw connectionError('Confirm the change to write permissions.', 'PERMISSION_CONFIRMATION_REQUIRED');
      next.permissionMode = body.permissionMode;
      next.consent = { actor: user.id, at: new Date().toISOString(), mode: next.permissionMode };
      addAudit(state, { type: 'connection_permissions_changed', actor: user.id, detail: { provider, from: previous.permissionMode, to: next.permissionMode, sensitiveActionsRequireApproval: true } });
    }
  }
  if (provider === 'meta') for (const [key, group] of [['metaPageIds','pages'],['metaCatalogIds','catalogs']]) {
    if (!Object.hasOwn(body,key)) continue;
    const available = state.connections?.find(item => item.provider === 'meta')?.metadata?.assets?.[group] || [];
    if (!Array.isArray(body[key]) || body[key].length > 20 || body[key].some(id => typeof id !== 'string' || !available.some(item => item.id === id))) throw connectionError('Choose only assets available to this workspace’s Meta connection.', 'META_ASSET_REQUIRED', 409);
    next[key] = [...new Set(body[key])];
    addAudit(state, { type: 'connection_assets_selected', actor: user.id, detail: { provider, kind: group, ids: next[key] } });
  }
  next.revision++; next.updatedAt = new Date().toISOString();
  state.connectionSettings = { ...state.connectionSettings, [provider]: next };
  addAudit(state, { type: 'connection_sync_settings_changed', actor: user.id, detail: { provider, autoSync: next.autoSync, frequencyMinutes: next.frequencyMinutes, areas: next.areas } });
  return next;
}
export function activateConnection(state, provider, actor) {
  const previous = connectionSettings(state, provider);
  state.connectionSettings = { ...state.connectionSettings, [provider]: { ...previous, disconnected: false, permissionMode: 'read_only', consent: null, revision: previous.revision + 1 } };
  if (previous.permissionMode !== 'read_only') addAudit(state, { type: 'connection_permissions_reset', actor, detail: { provider, reason: 'Connection replaced; owner consent must be renewed.' } });
}
export function disconnectConnection(state, provider, body, actor, integrations) {
  if (body.confirm !== provider) throw connectionError('Confirm which channel you want to disconnect.', 'DISCONNECT_CONFIRMATION_REQUIRED');
  const settings = connectionSettings(state, provider);
  if (body.revision !== settings.revision) throw connectionError('This connection changed. Review it before disconnecting.', 'CONNECTION_CONFLICT', 409);
  // The eBay Manager itself and its saved bridge remain intact. The channel
  // tombstone also prevents environment credentials or that bridge reactivating it.
  const credentialProvider = provider === 'ebay' ? 'ebay_oauth' : provider;
  for (const record of state.connections || []) if (record.provider === credentialProvider) {
    record.encryptedCredentials = null; record.status = 'disconnected'; record.lastError = null; record.updatedAt = new Date().toISOString();
  }
  state.connectionSettings = { ...state.connectionSettings, [provider]: { ...settings, disconnected: true, autoSync: false, permissionMode: 'read_only', consent: null, revision: settings.revision + 1 } };
  state.oauthChallenges = (state.oauthChallenges || []).filter(item => item.provider !== provider);
  state.integrationStatus = { ...state.integrationStatus, [provider]: { ...state.integrationStatus?.[provider], status: 'disconnected', lastError: null, detail: 'Disconnected from Runvara. Previously imported data is retained.' } };
  integrations?.clearConnectionCache?.(state, provider);
  addAudit(state, { type: 'connection_disconnected', actor, detail: { provider, importedDataRetained: true, existingManagerPreserved: provider === 'ebay' } });
}
export function recoveryFor(provider, status = {}, coverage = {}, orderHold = undefined) {
  const name = connector(provider).name, code = String(status.lastError || '');
  if (orderHold === null && isShopifyOrderSourceFailure(provider, code)) return null;
  if (isShopifyOrderSourceFailure(provider, (orderHold === undefined ? status.orderReadHold : orderHold)?.code) || orderHold === undefined && isShopifyOrderSourceFailure(provider, code)) return { message: 'Shopify order data could not be accepted because its structure or size needs review. Existing data is retained. Automatic order reads are paused; review the source and retry orders manually when ready.', action: 'sync', label: 'Retry orders after review' };
  if (provider === 'meta' && code === 'META_ASSET_REQUIRED') return { message: 'Choose your Pages and catalogues in this panel, then try syncing again.', action: 'open', label: 'Review selected assets' };
  if (provider === 'ebay' && coverage.readDiagnostics?.marketing?.errorIds?.map(String).includes('35077')) return { message: 'eBay says this account is not currently eligible for Promoted Listings. Check your seller level and recent sales activity in eBay Seller Hub. If you believe you qualify, contact eBay support. Reconnecting will not resolve this eligibility restriction. Order imports can continue; automatic marketing retries are paused.', action: 'sync', label: 'Check again after eBay review' };
  if (provider === 'ebay' && coverage.readDiagnostics?.marketing?.stage === 'ads') return { message: 'Campaigns were imported, but eBay could not return adverts for every campaign. Other sync areas keep their own status. Review affected campaigns in eBay and retry; reconnecting is only needed if access has expired.', action: 'sync', label: 'Retry marketing reads' };
  if (/RATE_LIMITED/.test(code)) return { message: `${name} is limiting requests. Wait a few minutes, then try syncing again.`, action: 'sync', label: 'Retry sync' };
  if (/ACCOUNT_MISMATCH/.test(code)) return { message: `A different ${name} account was returned. Reconnect the account already used by this workspace.`, action: 'reconnect', label: `Reconnect ${name}` };
  if (/CUSTOMER_PERMISSION/.test(code)) return { message: 'Shopify has not granted customer access. Reconnect with customer records selected, or turn off customers in your sync areas.', action: 'reconnect', label: 'Review Shopify access' };
  if (/AUTH|CREDENTIAL|TOKEN|ACCESS_DENIED|PERMISSION/.test(code) || status.status === 'auth_expired') return { message: `Your ${name} connection needs reconnecting. Sign in again to renew access.`, action: 'reconnect', label: `Reconnect ${name}` };
  if (code === 'WORKER_INTERRUPTED') return { message: 'The last sync was interrupted. Your previously imported data is safe.', action: 'sync', label: 'Retry sync' };
  if (code || ['error', 'degraded'].includes(status.status)) return { message: `Some ${name} data could not be refreshed. Your previous data is safe. Try again; if it still fails, reconnect.`, action: 'sync', label: 'Retry sync' };
  if (provider === 'ebay' && coverage.fullCatalogueAvailable === false) return { message: 'Orders are connected. Some older eBay listings are managed separately, so Runvara cannot compare your complete catalogue yet. Open your existing eBay Manager to manage those listings.', action: 'manager', label: 'Open existing Manager' };
  return null;
}
export function beginConnectionSync(state, provider, { areas, automatic = false, actor = 'system', integrations = null } = {}) {
  const selected = validateAreas(provider, areas || connectionSettings(state, provider).areas);
  if (automatic && orderReadHeld(state, provider, selected, integrations)) throw Object.assign(connectionError('Shopify order source needs review. Existing data is retained.', shopifyOrderReadHold(state, provider, integrations).code, 422), { nonRetryable: true });
  if (automatic && provider === 'shopify' && shopifyOrderReadPolicyBlocked(state, integrations, selected)) throw Object.assign(connectionError('Automatic Shopify order reads need review before another attempt.', 'SHOPIFY_ORDER_RETRY_EXHAUSTED', 409), { nonRetryable: true });
  state.connectionSyncs ||= [];
  const now = Date.now();
  for (const run of state.connectionSyncs.filter(item => item.provider === provider && item.status === 'running')) {
    if (Date.parse(run.leaseUntil) > now) throw connectionError('A sync is already running for this channel.', 'SYNC_IN_PROGRESS', 409);
    Object.assign(run, { status: 'failed', completedAt: new Date(now).toISOString(), errorCode: 'WORKER_INTERRUPTED' });
  }
  if (connectionSettings(state, provider).disconnected) throw connectionError('Connect this channel before syncing.', 'CONNECTION_DISCONNECTED', 409);
  const run = { id: `sync_${crypto.randomUUID()}`, provider, areas: selected, automatic, actor, status: 'running', stage: 'Reading selected data', startedAt: new Date(now).toISOString(), leaseUntil: new Date(now + 10 * 60000).toISOString() };
  state.connectionSyncs.unshift(run);
  // Supabase archives before trimming on save; never discard unarchived runs here.
  return run;
}
export function finishConnectionSync(state, run, result, error) {
  const partial = Boolean(result?.lastError || result?.status === 'degraded');
  Object.assign(run, { status: error ? 'failed' : partial ? 'partial' : 'completed', stage: error ? 'Needs attention' : partial ? 'Some data needs attention' : 'Finished', completedAt: new Date().toISOString(), errorCode: error?.code || null });
  if (!error && !partial) {
    state.integrationStatus[run.provider].lastSuccessfulSyncAt = run.completedAt;
    state.integrationStatus[run.provider].areaSuccessAt = { ...state.integrationStatus[run.provider].areaSuccessAt, ...Object.fromEntries(run.areas.map(area => [area, run.completedAt])) };
  }
  addAudit(state, { type: 'connection_sync_finished', actor: run.actor, detail: { provider: run.provider, runId: run.id, areas: run.areas, status: run.status, errorCode: run.errorCode } });
}
export function connectionDue(state, provider, now = new Date(), integrations = null) {
  const settings = connectionSettings(state, provider), status = state.integrationStatus?.[provider] || {};
  if (orderReadHeld(state, provider, settings.areas, integrations)) return false;
  if (settings.disconnected || !settings.autoSync || !settings.areas.length || /AUTH|CREDENTIAL|TOKEN|ACCESS_DENIED|PERMISSION|ACCOUNT_MISMATCH/.test(String(status.lastError || ''))) return false;
  const doctor = connectionDoctorState(state, provider, integrations);
  if (state.connectionAuthAttention?.[provider]) return false;
  if (doctor?.exhausted || provider === 'shopify' && shopifyOrderReadBudgetExhausted(state, integrations, settings.areas)
    || Date.parse(doctor?.nextRetryAt) > now.getTime() || Date.parse(status.retryAt) > now.getTime()) return false;
  const recent = (state.connectionSyncs || []).find(run => run.provider === provider);
  if (recent?.status === 'running' && Date.parse(recent.leaseUntil) > now.getTime()) return false;
  const at = Date.parse(recent?.startedAt || status.lastAttemptAt || status.lastSyncAt || '');
  return !Number.isFinite(at) || now.getTime() - at >= settings.frequencyMinutes * 60000;
}
export function connectionCentre(state, integrations) {
  return Object.entries(CONNECTORS).map(([id, definition]) => {
    const settings = connectionSettings(state, id), health = state.integrationStatus?.[id] || {};
    const record = id === 'ebay' ? integrations.ebayConnection?.(state) : (state.connections || []).find(item => item.provider === id);
    const configured = !settings.disconnected && (id === 'shopify' ? integrations.shopifyConfigured?.(state) : id === 'ebay' ? integrations.ebayConfigured?.(state) : Boolean(record?.encryptedCredentials));
    const recovery = recoveryFor(id, health, id === 'ebay' ? state.ebay?.coverage || {} : {}, id === 'shopify' ? shopifyOrderReadHold(state, id, integrations) : undefined);
    const status = settings.disconnected ? 'disconnected' : !configured ? 'not_configured' : recovery?.action === 'reconnect' ? 'action_required' : recovery ? 'degraded' : ['connected', 'configured'].includes(health.status || record?.status) ? (health.status === 'connected' ? 'connected' : 'action_required') : 'action_required';
    const history = (state.connectionSyncs || []).filter(run => run.provider === id).slice(0, 30).map(run => ({ ...run, ...(run.status === 'running' && Date.parse(run.leaseUntil) <= Date.now() ? { status: 'failed', stage: 'Interrupted — retry sync', errorCode: 'WORKER_INTERRUPTED' } : {}) }));
    const products = id === 'shopify' ? (state.products || []).filter(product => product.provider === 'shopify') : id === 'ebay' ? state.ebay?.listings || [] : [];
    const readData = state.channelData?.[id] || {};
    const counts = { ...(id === 'shopify' || id === 'ebay' ? { products: products.length, orders: null } : {}), ...(id === 'shopify' ? { variants: products.reduce((sum, product) => sum + (product.variants?.length || 0), 0), customers: state.channelData?.shopify?.customers?.length || 0 } : {}), ...Object.fromEntries(Object.entries(readData).filter(([,value]) => Array.isArray(value)).map(([key,value]) => [key,value.length])) };
    if (id === 'shopify' || id === 'ebay') counts.orders = Array.isArray(state.orders) && state.orders.every(row => row && typeof row === 'object' && !Array.isArray(row)) ? state.orders.filter(order => order.provider === id).length : null;
    const granted = record?.metadata?.grantedScopes || [];
    return { id, name: definition.name, status, configured, settings, identity: record?.metadata?.shopDomain || record?.metadata?.account || health.account || null,
      readDiagnostics: id === 'ebay' ? Object.fromEntries(Object.entries(state.ebay?.coverage?.readDiagnostics || {}).map(([surface, entry]) => [surface, { code: entry.code, httpStatus: entry.httpStatus, stage: entry.stage === 'ads' ? 'ads' : 'campaigns', failedCampaigns: (entry.failedCampaigns || []).map(item => ({campaignId: String(item.campaignId), status: item.status, httpStatus:item.httpStatus})), errorIds: (entry.errorIds || []).map(String).filter(id => /^\d{1,12}$/.test(id)), at: entry.at }])) : {},
      grantedScopes: granted, accessExpiresAt: integrations.connectionAccessExpiry?.(record) || null,
      lastFailedSyncAt: history.find(run => ['failed', 'partial'].includes(run.status))?.completedAt || history.find(run => ['failed', 'partial'].includes(run.status))?.startedAt || null,
      audit: (state.audit || []).filter(event => event.detail?.provider === id).slice(0, 30).map(({ id, type, createdAt }) => ({ id, type, createdAt })),
      areas: definition.areas, counts, recovery: configured ? recovery : null, history, progress: history.find(run => run.status === 'running') || null,
      lastSuccessfulSyncAt: state.connectionFirstSync?.[id] && state.connectionFirstSync[id].status !== 'completed' ? state.connectionFirstSync[id].previousSuccessfulSyncAt : health.lastSuccessfulSyncAt || history.find(run => run.status === 'completed')?.completedAt || (!history.length && !health.lastError ? health.lastSyncAt : null) || null, lastCheckedAt: record?.lastCheckedAt || null,
      oauthReady: Boolean(integrations.oauthReady?.(id, state)),
      customerSetup: integrations.oauthReady?.(id, state) ? 'one_click_oauth' : 'provider_setup_pending',
      customerManagedSetup: true,
      refreshSupported: Boolean(configured && integrations.refreshSupported?.(state, id)),
      writes: definition.writes, writeAccessGranted: id === 'shopify' ? granted.includes('write_products') : id === 'meta' && granted.some(scope => ['catalog_management','pages_manage_posts','instagram_content_publish'].includes(scope)),
      ...(id === 'meta' ? { meta: { assets: record?.metadata?.assets || {pages:[],catalogs:[]}, grantedScopes: granted, data: readData, orderRestriction: META_ORDER_RESTRICTION, discovery: record?.metadata?.discovery || null } } : {}),
      supportRequested: Boolean(settings.supportRequestedAt),
      availability: definition.areas.length ? 'available' : 'awaiting_provider_approval',
      coverageNote: id === 'ebay' && state.ebay?.source === 'ebay-oauth-readonly' ? 'Product, inventory and price reads cover listings created through eBay’s Inventory service. Your existing Manager handles other listings.' : id === 'meta' ? 'Sync selected catalogues, products, stock and Page posts. Product changes and Facebook/Instagram publishing require explicit owner permission and approval of each change. Native Meta checkout orders have been retired; website orders come through your checkout connection.' : id === 'google_youtube' ? 'Connect YouTube channels. Google Merchant product feeds and advertising are not available in this release.' : id === 'pinterest' ? 'Connect boards and Pins. Advertising and catalogue publishing are not available in this release.' : id === 'tiktok_shop' ? 'Reads all shops you authorise, their product and stock records, and order summaries from the last 90 days.' : null };
  });
}
