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
    const imported = connected && Boolean(health.lastSuccessfulSyncAt || (state.connectionSyncs || []).find(run => run.provider === provider && run.status === 'completed'));
    const reviewed = saved.permissionReviews?.[provider] === settings.revision;
    const coverage = state.ebay?.coverage;
    // Eligibility for optional advertising must not undo a verified commerce
    // setup. Keep the warning visible; all other read/auth failures still block.
    const marketingEligibilityOnly = provider === 'ebay' && record?.status === 'connected' &&
      coverage?.ordersAvailable === true && coverage?.unavailableSurfaces?.length === 1 &&
      coverage.unavailableSurfaces[0] === 'marketing' &&
      coverage.readDiagnostics?.marketing?.errorIds?.map(String).includes('35077') &&
      health.lastError === 'Some eBay read data is currently unavailable: marketing.';
    const needsAttention = Boolean(health.lastError);
    return { provider, connected, tested, imported, reviewed, permissionMode: settings.permissionMode, needsAttention,
      blocksSetup: needsAttention && !marketingEligibilityOnly };
  });
  const complete = Boolean(saved.platforms?.length) && platforms.every(item => item.tested && item.imported && item.reviewed && !item.blocksSetup);
  return { revision: saved.revision || 0, businessReviewedAt: saved.businessReviewedAt || null, controlsReviewedAt: saved.controlsReviewedAt || null, platforms, complete, completedAt: complete ? saved.completedAt || null : null };
}
export function saveOnboardingJourney(state, body, user) {
  if (user.role !== 'owner') throw connectionError('Only the business owner can complete setup.', 'OWNER_APPROVAL_REQUIRED', 403);
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
    if (!Array.isArray(body.platforms) || !body.platforms.length || body.platforms.length > Object.keys(CONNECTORS).length || body.platforms.some(key => !Object.hasOwn(CONNECTORS, key))) throw connectionError('Choose at least one supported platform.');
    next.platforms = [...new Set(body.platforms)];
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
