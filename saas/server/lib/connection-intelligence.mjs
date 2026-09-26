import { CONNECTORS, connectionCentre, connectionSettings } from './connection-centre.mjs';
import { META_READ_SCOPES, META_CATALOG_SCOPES } from './meta-capabilities.mjs';

export const customerChannels = ['shopify', 'ebay', 'meta', 'tiktok_shop', 'google_youtube', 'pinterest'];
export const recordFor = (state, provider) => state.connections?.find(item => item.provider === (provider === 'ebay' ? 'ebay_oauth' : provider));
export const safeFailureCode = error => /^[A-Z0-9_]{1,80}$/.test(String(error?.code || '')) ? error.code : 'CONNECTION_READ_FAILED';

// Capabilities come from the existing connector registry. Readiness is evaluated
// on every request, so approved/configured providers need no customer-side patch.
export function providerReadiness(state, integrations, { operator = false } = {}) {
  return Object.entries(CONNECTORS).map(([id, definition]) => {
    const oauthReady = Boolean(integrations.oauthReady?.(id, state));
    const restrictionMessage = oauthReady ? null : id === 'tiktok_shop'
      ? 'TikTok access is being prepared while Runvara awaits provider approval and activation. Your shop and existing data are safe. Request access to register your interest.'
      : `${definition.name} access is being prepared. You can request access or skip this channel for now.`;
    return { id, displayName: definition.name, oauthReady, customerConnectAvailable: oauthReady,
      providerSetupPending: !oauthReady, supportedMarkets: null,
      supportedReadAreas: [...definition.areas], supportedWriteAreas: [...definition.writes],
      refreshSupported: Boolean(integrations.refreshSupported?.(state, id)), reconnectSupported: oauthReady,
      approvalRequirements: definition.writes.length ? 'Owner consent and existing action approvals apply.' : 'No channel writes are implemented.',
      restrictionMessage,
      ...(operator ? { callbackReady: /^https:\/\//.test(integrations.env?.APP_PUBLIC_URL || ''),
        configurationStatus: oauthReady ? 'enabled' : 'pending',
        providerApprovalStatus: oauthReady ? 'Configured by operator; individual account eligibility is checked at sign-in.' : 'Approval or configuration pending',
        setupMessage: oauthReady ? 'Customer sign-in is enabled. No secret values are exposed.' : id === 'tiktok_shop' ? 'TikTok Partner/Developer approval and approved app credentials are required. Existing customer OAuth code is ready.' : 'Complete provider approval and the existing application configuration, then enable this connector.' } : {}) };
  });
}

export function expectedReadScopes(provider, areas) {
  if (provider === 'shopify') return [...new Set([...(areas.some(a => ['products','variants','prices'].includes(a)) ? ['read_products'] : []), ...(areas.includes('inventory') ? ['read_inventory'] : []), ...(areas.includes('orders') ? ['read_orders'] : []), ...(areas.includes('customers') ? ['read_customers'] : [])])];
  if (provider === 'meta') return [...META_READ_SCOPES, ...(areas.some(a => ['catalogs','products','inventory','prices'].includes(a)) ? META_CATALOG_SCOPES : [])];
  if (provider === 'google_youtube') return ['https://www.googleapis.com/auth/youtube.readonly'];
  if (provider === 'pinterest') return ['user_accounts:read', ...areas.map(a => `${a}:read`)];
  return []; // eBay/TikTok grants are checked by their existing read adapters.
}

export function classifyConnectionIssue(state, provider, now = new Date()) {
  const status = state.integrationStatus?.[provider] || {}, record = recordFor(state, provider);
  const code = String(state.connectionAuthAttention?.[provider]?.code || status.lastError || record?.lastError || '');
  const first = state.connectionFirstSync?.[provider];
  const failures = Object.values(first?.failures || {});
  const combined = [code, ...failures.map(item => item.code)].join(' ');
  const name = CONNECTORS[provider].name;
  const issue = (kind, severity, message, action = null, repair = null) => ({ kind, severity, message, action, repair });
  if (/ACCOUNT_MISMATCH|ACCOUNT_UNCONFIRMED/.test(combined)) return issue('account_mismatch', 'critical', `The selected ${name} account could not be verified. Existing data is safe.`, { action: 'reconnect', label: `Reconnect the expected ${name} account` });
  if (/AUTH|CREDENTIAL|TOKEN_EXPIRED|REFRESH_FAILED|ACCESS_DENIED/.test(combined) || status.status === 'auth_expired') return issue('reconnect_required', 'critical', `${name} access needs renewing. Previously imported data is safe.`, { action: 'reconnect', label: `Reconnect ${name}` });
  if (provider === 'ebay' && state.ebay?.coverage?.readDiagnostics?.marketing?.errorIds?.map(String).includes('35077')) return issue('provider_restriction', 'important', 'eBay has not enabled Promoted Listings for this seller. Available commerce reads can continue; reconnecting will not remove this restriction.', { action: 'open', label: 'Review available eBay data' });
  if (/ELIGIB|REGION|VERIFICATION|PROVIDER_APPROVAL|RESTRICTED|POLICY/.test(combined)) return issue('provider_restriction', 'important', `${name} has restricted this account or feature. Your data is safe. Runvara cannot override the provider’s eligibility rules.`, { action: 'open', label: 'Review available features' });
  if (/PERMISSION|SCOPE/.test(combined)) return issue('missing_scope', 'important', `${name} has not granted access to some selected data. Your existing data is safe.`, { action: 'reconnect', label: `Review ${name} access` });
  if (/ASSET_REQUIRED/.test(combined)) return issue('missing_asset', 'important', 'Choose an authorised Page or catalogue before reading this data.', { action: 'open', label: 'Choose your account assets' });
  const runs = (state.connectionSyncs || []).filter(r => r.provider === provider);
  if (runs.some(r => r.status === 'running' && Date.parse(r.leaseUntil) <= now.getTime()) || code === 'WORKER_INTERRUPTED') return issue('interrupted', 'important', 'A previous read was interrupted. Your imported data is safe; Runvara can resume it.', null, 'read');
  const diagnostics = provider === 'ebay' ? Object.values(state.ebay?.coverage?.readDiagnostics || {}) : [];
  const upstream = Number(status.upstreamStatus || failures.find(f => f.upstreamStatus)?.upstreamStatus || diagnostics.find(d => d.httpStatus === 429 || d.httpStatus >= 500)?.httpStatus);
  if (/RATE_LIMIT/.test(combined) || upstream === 429) return issue('rate_limit', 'important', `${name} is limiting requests. Runvara will wait before retrying. Your data is safe.`, null, 'read');
  if (upstream >= 500) return issue('provider_unavailable', 'important', `${name} returned a temporary service error. Runvara will retry; your existing data is safe.`, null, 'read');
  if (status.transient || failures.some(f => f.transient) || /TIMEOUT|ETIMEDOUT|ECONNRESET/.test(combined)) return issue('temporary_read_failure', 'important', 'A read was temporarily interrupted. Runvara will retry safely.', null, 'read');
  if (code || first?.status === 'partial' || first?.status === 'failed') return issue('read_failure', 'important', 'Some selected data could not be refreshed. Successful imports and previous data are retained.', { action: 'sync', label: 'Retry selected data' });
  return null;
}

export function connectionHealth(state, channel, readiness, { now = new Date(), persistence = {}, scheduler = {} } = {}) {
  const record = recordFor(state, channel.id), settings = channel.settings;
  const expected = expectedReadScopes(channel.id, settings.areas);
  const granted = record?.metadata?.grantedScopes;
  const missing = Array.isArray(granted) && granted.length ? expected.filter(scope => !granted.includes(scope) && !granted.includes(scope.replace(/^read_/, 'write_'))) : [];
  const last = Date.parse(channel.lastSuccessfulSyncAt || '');
  const stale = settings.autoSync && Number.isFinite(last) && now.getTime() - last > Math.max(2 * settings.frequencyMinutes, 60) * 60000;
  const expiry = Date.parse(channel.accessExpiresAt || '');
  const expiresSoon = Number.isFinite(expiry) && expiry - now.getTime() < 24 * 3600000;
  let issue = classifyConnectionIssue(state, channel.id, now);
  let status = 'Healthy', message = 'Access and the last completed read are healthy.', action = null;
  if (settings.disconnected) { status = 'Disconnected'; message = 'This channel is disconnected. Previously imported data is retained.'; action = {action:'connect',label:`Connect ${channel.name}`}; }
  else if (!channel.configured) { status = readiness.oauthReady ? 'Disconnected' : 'Setup pending'; message = readiness.restrictionMessage || 'Connect this account to begin reading your business data.'; action = {action:readiness.oauthReady?'connect':'setup-request',label:readiness.oauthReady?`Connect ${channel.name}`:'Request access'}; }
  else if (issue) { status = ['reconnect_required','account_mismatch','missing_scope'].includes(issue.kind) ? 'Reconnect required' : issue.kind === 'provider_unavailable' ? 'Provider unavailable' : 'Degraded'; message = issue.message; action = issue.action; }
  else if (missing.length) { status = 'Attention needed'; message = 'Some selected data may need additional access. Review access before enabling those reads.'; action = {action:'reconnect',label:`Review ${channel.name} access`}; }
  else if (channel.id === 'google_youtube' && Array.isArray(state.channelData?.google_youtube?.channels) && !state.channelData.google_youtube.channels.length) { status = 'Attention needed'; message = 'Google sign-in succeeded, but this account has no authorised YouTube channel.'; action = {action:'reconnect',label:'Connect the account with your YouTube channel'}; }
  else if (channel.id === 'meta' && record?.metadata?.assets?.pages?.length === 0) { status = 'Attention needed'; message = 'Facebook sign-in succeeded, but no business Page was returned. Existing data is safe.'; action = {action:'reconnect',label:'Reconnect and select your Facebook Page'}; }
  else if (expiresSoon && !readiness.refreshSupported) { status = 'Reconnect required'; message = 'Your saved access is expiring. Sign in again to keep data up to date.'; action = {action:'reconnect',label:`Reconnect ${channel.name}`}; }
  else if (stale) { status = 'Attention needed'; message = 'Your imported data is older than the expected sync interval. Previous data is safe.'; action = {action:'sync',label:'Refresh your data'}; }
  else if (!channel.lastSuccessfulSyncAt) { status = 'Attention needed'; message = channel.progress ? 'Runvara is reading your selected data.' : 'The account is connected. Its first read has not completed yet.'; action = channel.progress ? null : {action:'sync',label:'Start first read'}; }
  else if (expiresSoon) { status = 'Attention needed'; message = 'Access expires soon. Runvara will attempt a safe renewal.'; }
  const doctor = state.connectionDoctor?.[channel.id];
  if (doctor?.exhausted && issue?.repair) { status = 'Attention needed'; message = 'Repeated safe retries could not restore this read. Your existing data is safe.'; action = {action:'sync',label:'Retry this connection'}; }
  if (persistence.primaryPersistence === false) { status = 'Degraded'; message = 'Runvara cannot confirm that recent changes are saved. Existing saved data is retained; support needs to restore storage.'; action = {action:'open',label:'Check again shortly'}; }
  else if (channel.configured && scheduler.lastError && status === 'Healthy') { status = 'Attention needed'; message = 'Automatic checks need attention. Your saved data is safe; you can refresh it manually while Runvara recovers.'; action = {action:'sync',label:'Refresh your data'}; }
  return { status, message, action, severity: status === 'Healthy' ? 'informational' : issue?.severity || 'important',
    cause: issue?.kind || (status === 'Setup pending' ? 'provider_setup_pending' : null),
    authentication: issue && ['reconnect_required','account_mismatch'].includes(issue.kind) ? 'attention' : record?.lastCheckedAt ? 'verified' : 'not_verified',
    expectedScopes: expected, grantedScopes: granted || [], scopeEvidence: Array.isArray(granted) && granted.length ? 'reported' : 'not_reported', missingScopes: missing,
    accessExpiresAt: channel.accessExpiresAt, lastConnectionTestAt: channel.lastCheckedAt,
    lastSuccessfulSyncAt: channel.lastSuccessfulSyncAt, lastFailedSyncAt: channel.lastFailedSyncAt, dataFreshness: stale ? 'stale' : Number.isFinite(last) ? 'current' : 'not_measured',
    activeReads: channel.history.filter(r => r.status === 'running').length,
    failedAreas: Object.keys(state.connectionFirstSync?.[channel.id]?.failures || {}),
    nextRetryAt: doctor?.nextRetryAt || null, webhookHealth: 'not_monitored',
    persistenceHealth: persistence.primaryPersistence === false ? 'degraded' : persistence.primaryPersistence ? 'healthy' : 'not_measured',
    schedulerHealth: scheduler.lastError ? 'attention' : scheduler.lastTickAt ? 'running' : 'not_measured', schedulerLastTickAt: scheduler.lastTickAt || null };
}

export function recommendations(state, channels) {
  const connected = channels.filter(c => c.configured), areas = new Set(connected.flatMap(c => c.settings.areas));
  return [
    ['channel_health', 'Connection health monitoring', connected.length > 0],
    ['expiry', 'Connection expiry warnings', connected.length > 0],
    ['sync_failures', 'Sync failure alerts', connected.length > 0],
    ['lowStockAlerts', 'Low-stock alerts', areas.has('inventory')],
    ['freshness', 'Stale inventory warnings', areas.has('inventory')],
    ['customerReplyDrafts', 'Order monitoring', areas.has('orders')],
    ['dailyOpsBrief', 'Daily business brief', connected.some(c => c.lastSuccessfulSyncAt)],
    ['marketing_approval', 'Marketing approval queue', state.onboardingJourney?.preferences?.marketing === true]
  ].filter(([, , available]) => available).map(([id, title]) => ({ id, title, enabled: ['channel_health','expiry','sync_failures','freshness'].includes(id) || Boolean(state.autopilot?.enabled && state.automations?.[id] && state.autopilot?.rules?.[id]?.permitted), externalWrites: false }));
}

export function intelligentConnections(state, integrations, context = {}) {
  const registry = providerReadiness(state, integrations);
  return connectionCentre(state, integrations).map(channel => {
    const readiness = registry.find(r => r.id === channel.id);
    return { ...channel, readiness, health: connectionHealth(state, channel, readiness, context), firstSync: state.connectionFirstSync?.[channel.id] || null };
  });
}

export function doctorNotifications(state) {
  // Events use the existing audit_events archive-before-trim path; only summaries
  // are projected here. No second history collection or database table is needed.
  const seen = new Set();
  return (state.audit || []).filter(e => e.type.startsWith('connection_doctor_') || e.type === 'connection_first_sync_finished').filter(e => {
    if (!e.detail?.message || seen.has(e.detail.provider)) return false;
    seen.add(e.detail.provider); return true;
  }).slice(0, 8).map(e => ({ id: e.id, provider: e.detail.provider, message: e.detail.message, priority: e.detail.priority || 'informational', createdAt: e.createdAt }));
}
