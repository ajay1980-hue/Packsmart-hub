import { CONNECTORS, connectionSettings, connectionError } from './connection-centre.mjs';
import { addAudit } from './events.mjs';

export function onboardingJourney(state) {
  const saved = state.onboardingJourney || {};
  const selected = saved.platforms || Object.keys(CONNECTORS).filter(provider => (state.connections || []).some(record => record.provider === (provider === 'ebay' ? 'ebay_oauth' : provider) && record.encryptedCredentials));
  const platforms = selected.map(provider => {
    const settings = connectionSettings(state, provider);
    const record = (state.connections || []).find(item => item.provider === (provider === 'ebay' ? 'ebay_oauth' : provider));
    const health = state.integrationStatus?.[provider] || {};
    const connected = !settings.disconnected && Boolean(record?.encryptedCredentials || (provider === 'ebay' && health.account));
    const tested = connected && Boolean(record?.lastCheckedAt) && !['auth_expired','error'].includes(record?.status);
    const firstSync = state.connectionFirstSync?.[provider];
    const imported = connected && Boolean(health.lastSuccessfulSyncAt || (state.connectionSyncs || []).find(run => run.provider === provider && run.status === 'completed'));
    const reviewed = saved.permissionReviews?.[provider] === settings.revision;
    const coverage = state.ebay?.coverage;
    // Eligibility for optional advertising must not undo a verified commerce
    // setup. Keep the warning visible; all other read/auth failures still block.
    const marketingEligibilityOnly = provider === 'ebay' && record?.status === 'connected' &&
      coverage?.ordersAvailable === true && coverage?.unavailableSurfaces?.length === 1 &&
      coverage.unavailableSurfaces[0] === 'marketing' &&
      coverage.readDiagnostics?.marketing?.errorIds?.map(String).includes('35077') &&
      (health.lastError === 'Some eBay read data is currently unavailable: marketing.' || firstSync?.status === 'partial' && Object.keys(firstSync.failures).length === 1 && firstSync.failures.promotions && (!health.lastError || health.lastError === 'CONNECTION_READ_FAILED'));
    const needsAttention = Boolean(health.lastError || firstSync && firstSync.status !== 'completed');
    return { provider, connected, tested, imported, reviewed, permissionMode: settings.permissionMode, needsAttention,
      firstSync: firstSync || null,
      blocksSetup: needsAttention && !marketingEligibilityOnly };
  });
  const complete = Boolean(saved.platforms?.length) && platforms.every(item => item.tested && item.imported && item.reviewed && !item.blocksSetup);
  return { revision: saved.revision || 0, businessReviewedAt: saved.businessReviewedAt || null, controlsReviewedAt: saved.controlsReviewedAt || null,
    preferences: { goal:'visibility', automation:'recommended', approval:'always', stockThreshold:20, customerRecords:false, marketing:false, ...saved.preferences },
    recommendedAt: saved.recommendedAt || null, platforms, complete, completedAt: complete ? saved.completedAt || null : null };
}
export function saveOnboardingJourney(state, body, user) {
  if (!['owner','admin'].includes(user.role)) throw connectionError('Ask a workspace owner or admin to complete setup.', 'OWNER_APPROVAL_REQUIRED', 403);
  const previous = state.onboardingJourney || {};
  if (body.revision !== (previous.revision || 0)) throw connectionError('Setup changed. Refresh and try again.', 'CONNECTION_CONFLICT', 409);
  const next = structuredClone(previous);
  if (body.businessName !== undefined) {
    const name = String(body.businessName || '').trim();
    if (name.length < 2 || name.length > 120) throw connectionError('Enter a business name of 2–120 characters.');
    state.workspace.name = name;
    next.businessReviewedAt = new Date().toISOString();
  }
  if (body.reviewControls === true) next.controlsReviewedAt = new Date().toISOString();
  if (body.platforms !== undefined) {
    if (!Array.isArray(body.platforms) || body.platforms.length > Object.keys(CONNECTORS).length || body.platforms.some(key => !Object.hasOwn(CONNECTORS, key))) throw connectionError('Choose supported platforms, or skip them for now.');
    next.platforms = [...new Set(body.platforms)];
  }
  if (body.preferences !== undefined) {
    const value = body.preferences;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw connectionError('Check your business preferences.');
    const allowed = { goal:['visibility','stock','growth'], automation:['recommended','manual'], approval:['always'] };
    for (const [key, choices] of Object.entries(allowed)) if (value[key] !== undefined && !choices.includes(value[key])) throw connectionError('Choose one of the available setup options.');
    if (value.stockThreshold !== undefined && (!Number.isInteger(value.stockThreshold) || value.stockThreshold < 0 || value.stockThreshold > 100000)) throw connectionError('Choose a stock alert threshold from 0 to 100000.');
    for (const key of ['customerRecords','marketing']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw connectionError('Choose whether this feature is needed.');
    next.preferences = { ...next.preferences, ...Object.fromEntries(['goal','automation','approval','stockThreshold','customerRecords','marketing'].filter(key => Object.hasOwn(value,key)).map(key => [key,value[key]])) };
    if (value.stockThreshold !== undefined) state.settings = { ...state.settings, lowStockThreshold:value.stockThreshold };
    if (value.automation !== undefined) for (const provider of next.platforms || []) {
      const settings = connectionSettings(state,provider);
      state.connectionSettings = {...state.connectionSettings,[provider]:{...settings,autoSync:value.automation !== 'manual',managedReadSchedule:true,revision:settings.revision + 1}};
      if (settings.permissionMode === 'read_only') next.permissionReviews = {...next.permissionReviews,[provider]:settings.revision + 1};
    }
    // These are preferences, not provider permission grants or publishing consent.
  }
  if (body.useRecommended === true) {
    next.preferences = { goal:'visibility', automation:'recommended', approval:'always', stockThreshold:20, customerRecords:false, marketing:false, ...next.preferences };
    next.recommendedAt = new Date().toISOString();
    next.permissionReviews ||= {};
    for (const provider of next.platforms || []) {
      const settings = connectionSettings(state, provider);
      // Existing write decisions and selected areas are not silently replaced.
      if (settings.permissionMode === 'read_only') next.permissionReviews[provider] = settings.revision;
      if (!state.connectionSettings?.[provider]) state.connectionSettings = { ...state.connectionSettings, [provider]: { ...settings, autoSync:next.preferences.automation !== 'manual', managedReadSchedule:true } };
    }
  }
  if (body.reviewPermissions) {
    if (!next.platforms?.includes(body.reviewPermissions)) throw connectionError('Choose this platform first.');
    next.permissionReviews = { ...next.permissionReviews, [body.reviewPermissions]: connectionSettings(state, body.reviewPermissions).revision };
  }
  next.revision = (previous.revision || 0) + 1;
  state.onboardingJourney = next;
  if (body.finish && !onboardingJourney(state).complete) { state.onboardingJourney = previous; throw connectionError('Complete the connection tests, imports and permission reviews before finishing setup.', 'ONBOARDING_INCOMPLETE', 409); }
  if (body.finish) next.completedAt = new Date().toISOString();
  addAudit(state, { type: body.finish ? 'onboarding_completed' : 'onboarding_updated', actor: user.id, detail: { platforms: next.platforms || [], permissionReview: body.reviewPermissions || null } });
  return onboardingJourney(state);
}
