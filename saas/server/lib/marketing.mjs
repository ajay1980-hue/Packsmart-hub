import crypto from 'node:crypto';
import { deriveOperations } from './operations.mjs';
import { hasCataloguePrice } from './profit.mjs';
import { advanceCampaignCreatives, testMarketingProvider } from './marketing-providers.mjs';
import { canvaOAuthReady, readCanvaCredentials, refreshCanvaCredentials } from './marketing-oauth.mjs';
import { decryptCredentials, encryptCredentials } from './security.mjs';
import { CREATIVE_ALLOWANCE_ACTION, createCreativeEffects, knownCreativeJob, newCreativeRequest, summarizeCreativeEffects } from './creative-safety.mjs';

export const MARKETING_MODES = Object.freeze({
  draft: { id: 'draft', name: 'Draft only', description: 'Prepare campaigns and creatives without publishing.' },
  guarded: { id: 'guarded', name: 'Guarded Autopilot', description: 'Prepare campaigns automatically; publishing and spend remain approval-gated.' },
  automatic: { id: 'automatic', name: 'Auto within limits', description: 'Organic publishing may run automatically only after a supported publisher is connected and explicitly authorised. Paid advertising remains approval-gated.' }
});

const nowIso = now => (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
const clean = (value, max = 500) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const validChannels = ['meta', 'google_youtube', 'pinterest', 'tiktok_shop'];
const id = prefix => `${prefix}_${crypto.randomUUID()}`;

export function ensureMarketing(state) {
  const previous = state.marketing && typeof state.marketing === 'object' ? state.marketing : {};
  const settings = previous.settings && typeof previous.settings === 'object' ? previous.settings : {};
  state.marketing = {
    settings: {
      mode: MARKETING_MODES[settings.mode] ? settings.mode : 'guarded',
      enabled: settings.enabled !== false,
      dailyOrganicLimit: Number.isInteger(settings.dailyOrganicLimit) ? Math.max(1, Math.min(8, settings.dailyOrganicLimit)) : 2,
      minMarginPercent: Number.isFinite(Number(settings.minMarginPercent)) ? Math.max(0, Math.min(100, Number(settings.minMarginPercent))) : Number(state.settings?.marginFloor ?? 20),
      minInventory: Number.isFinite(Number(settings.minInventory)) ? Math.max(0, Math.min(1000000, Number(settings.minInventory))) : 5,
      channels: Object.fromEntries(validChannels.map(channel => [channel, settings.channels?.[channel] !== false])),
      autoCreative: settings.autoCreative !== false,
      autoPublishOrganic: settings.autoPublishOrganic === true,
      allowPaidAds: settings.allowPaidAds === true,
      updatedAt: settings.updatedAt || null,
      updatedBy: settings.updatedBy || null
    },
    campaigns: Array.isArray(previous.campaigns) ? previous.campaigns : [],
    creativeCampaignCursor: typeof previous.creativeCampaignCursor === 'string' && previous.creativeCampaignCursor.length <= 200
      ? previous.creativeCampaignCursor : null,
    lastPlannerRunAt: previous.lastPlannerRunAt || null,
    lastCreativeRunAt: previous.lastCreativeRunAt || null,
    providers: previous.providers && typeof previous.providers === 'object' ? previous.providers : {}
  };
  if (state.marketing.settings.mode !== 'automatic') state.marketing.settings.autoPublishOrganic = false;
  return state.marketing;
}

export function updateMarketingSettings(state, body = {}, actor = 'system') {
  const marketing = ensureMarketing(state);
  const next = { ...marketing.settings };
  if (Object.hasOwn(body, 'enabled')) {
    if (typeof body.enabled !== 'boolean') throw Object.assign(new Error('Enabled must be a boolean'), { status: 400, code: 'VALIDATION_FAILED' });
    next.enabled = body.enabled;
  }
  if (Object.hasOwn(body, 'mode')) {
    if (!MARKETING_MODES[body.mode]) throw Object.assign(new Error('Choose a supported marketing mode'), { status: 400, code: 'VALIDATION_FAILED' });
    next.mode = body.mode;
  }
  for (const field of ['dailyOrganicLimit', 'minMarginPercent', 'minInventory']) {
    if (!Object.hasOwn(body, field)) continue;
    const value = Number(body[field]);
    const max = field === 'dailyOrganicLimit' ? 8 : field === 'minMarginPercent' ? 100 : 1000000;
    if (!Number.isFinite(value) || value < 0 || value > max || (field === 'dailyOrganicLimit' && !Number.isInteger(value))) {
      throw Object.assign(new Error(`Invalid ${field}`), { status: 400, code: 'VALIDATION_FAILED' });
    }
    next[field] = value;
  }
  if (Object.hasOwn(body, 'channels')) {
    if (!body.channels || typeof body.channels !== 'object' || Array.isArray(body.channels)) throw Object.assign(new Error('Channels must be an object'), { status: 400, code: 'VALIDATION_FAILED' });
    next.channels = { ...next.channels };
    for (const channel of validChannels) if (Object.hasOwn(body.channels, channel)) {
      if (typeof body.channels[channel] !== 'boolean') throw Object.assign(new Error('Channel settings must be boolean'), { status: 400, code: 'VALIDATION_FAILED' });
      next.channels[channel] = body.channels[channel];
    }
  }
  if (Object.hasOwn(body, 'autoCreative')) {
    if (typeof body.autoCreative !== 'boolean') throw Object.assign(new Error('autoCreative must be boolean'), { status: 400, code: 'VALIDATION_FAILED' });
    next.autoCreative = body.autoCreative;
  }
  if (Object.hasOwn(body, 'autoPublishOrganic')) {
    if (typeof body.autoPublishOrganic !== 'boolean') throw Object.assign(new Error('autoPublishOrganic must be boolean'), { status: 400, code: 'VALIDATION_FAILED' });
    if (body.autoPublishOrganic && next.mode !== 'automatic') throw Object.assign(new Error('Automatic organic publishing requires Auto within limits mode'), { status: 409, code: 'MARKETING_MODE_REQUIRED' });
    next.autoPublishOrganic = body.autoPublishOrganic;
  }
  if (Object.hasOwn(body, 'allowPaidAds')) {
    if (body.allowPaidAds !== false) throw Object.assign(new Error('Paid advertising remains approval-gated'), { status: 409, code: 'PAID_ADS_APPROVAL_REQUIRED' });
    next.allowPaidAds = false;
  }
  next.updatedAt = nowIso();
  next.updatedBy = actor;
  marketing.settings = next;
  return next;
}

function eligibleProducts(state) {
  const marketing = ensureMarketing(state);
  const metrics = deriveOperations(state);
  const minMargin = marketing.settings.minMarginPercent;
  const minInventory = marketing.settings.minInventory;
  return metrics.productRows
    .filter(item => String(item.productStatus || '').toLowerCase() === 'active')
    .filter(item => item.available !== false)
    .filter(item => item.inventory == null || item.inventory >= minInventory)
    .filter(item => item.complete && hasCataloguePrice(item.price) &&
      Number.isFinite(item.contribution) && Number.isFinite(item.margin) && item.margin >= minMargin)
    .filter(item => item.productImage || item.image)
    .sort((a, b) => {
      return Number(b.contribution || 0) - Number(a.contribution || 0);
    });
}

function campaignCopy(product) {
  const title = clean(product.productTitle || product.title, 120);
  const price = hasCataloguePrice(product.price) ? `£${Number(product.price).toFixed(2)}` : null;
  const offer = price ? `${title} from ${price}.` : `${title}.`;
  return {
    headline: title,
    shortCaption: `${offer} Reliable packaging, ready when your business needs it.`,
    longCaption: `${offer} Keep packing simple with dependable business packaging from Packsmart Solutions. Check the current product details, pack quantity and availability before ordering.`,
    videoHook: `Packing orders today? Start with ${title}.`,
    cta: 'Shop Packsmart Solutions',
    hashtags: ['#PacksmartSolutions', '#Packaging', '#SmallBusiness', '#Ecommerce']
  };
}

export function draftMarketingCampaign(state, { now = new Date(), source = 'manual' } = {}) {
  const marketing = ensureMarketing(state);
  if (!marketing.settings.enabled) throw Object.assign(new Error('Marketing Autopilot is turned off'), { status: 409, code: 'MARKETING_AUTOPILOT_OFF' });
  if (marketing.campaigns.length >= 200) throw Object.assign(new Error('Creative history needs a verified archive or owner-reviewed deletion before another campaign can be drafted. Existing drafts and submission evidence will not be discarded.'), { status: 409, code: 'CREATIVE_HISTORY_RETENTION_REQUIRED' });
  const products = eligibleProducts(state);
  if (!products.length) throw Object.assign(new Error('No product currently passes the stock, margin, image and active-product marketing guardrails'), { status: 409, code: 'NO_MARKETING_CANDIDATE' });
  const product = products[0];
  const activeChannels = validChannels.filter(channel => marketing.settings.channels[channel]);
  const campaignId = id('campaign');
  const campaign = {
    id: campaignId,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
    source,
    status: 'draft',
    goal: 'profitable_product_demand',
    product: {
      productId: product.productId,
      variantId: product.id,
      sku: product.sku,
      title: product.productTitle,
      variantTitle: product.title,
      image: product.productImage || product.image || null,
      price: product.price,
      inventory: product.inventory,
      contribution: product.contribution,
      margin: product.margin,
      revenue30d: product.revenue30d
    },
    channels: activeChannels,
    copy: campaignCopy(product),
    creativeRequests: [
      newCreativeRequest({ workspaceId: state.workspace.id, campaignId, provider: 'canva', kind: 'social_post', formats: ['instagram_post', 'facebook_post', 'pinterest_pin', 'youtube_thumbnail'], now: () => new Date(now).getTime() }),
      newCreativeRequest({ workspaceId: state.workspace.id, campaignId, provider: 'runway', kind: 'product_video', formats: ['vertical_video', 'landscape_video'], now: () => new Date(now).getTime() })
    ],
    publish: {
      approvalRequired: true,
      approvalId: null,
      status: 'not_requested',
      autoPublishEligible: marketing.settings.mode === 'automatic' && marketing.settings.autoPublishOrganic === true
    },
    evidence: [
      { type: 'product_margin', id: product.sku, detail: `Margin ${Number(product.margin).toFixed(1)}%; contribution £${Number(product.contribution).toFixed(2)}` },
      { type: 'inventory', id: product.sku, detail: product.inventory == null ? 'Inventory count unavailable; product is marked available.' : `${product.inventory} units recorded` },
      { type: 'sales_signal', id: product.sku, detail: 'Historical product sales attribution and stock cover are unavailable; recorded SKU matches do not establish a catalogue variant assignment.' }
    ]
  };
  // Helpers above normalize state.marketing. Write through its current object,
  // and never evict an existing draft, claim or upstream ID to make room.
  state.marketing.campaigns = [campaign, ...state.marketing.campaigns];
  state.marketing.lastPlannerRunAt = nowIso(now);
  return campaign;
}

export function marketingPlannerCycle(state, options = {}) {
  const marketing = ensureMarketing(state);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!marketing.settings.enabled) return { created: 0, campaign: null, reason: 'MARKETING_AUTOPILOT_OFF' };
  const localDay = now.toISOString().slice(0, 10);
  const existing = marketing.campaigns.find(item => item.createdAt?.slice(0, 10) === localDay && ['draft', 'prepared', 'awaiting_approval', 'scheduled', 'published'].includes(item.status));
  if (existing) {
    marketing.lastPlannerRunAt = nowIso(now);
    return { created: 0, campaign: existing, reason: 'CAMPAIGN_ALREADY_PREPARED_TODAY' };
  }
  const campaign = draftMarketingCampaign(state, { now, source: options.source || 'autopilot' });
  return { created: 1, campaign, reason: null };
}

function storedProviderCredentials(state, provider, env = process.env) {
  const record = ensureMarketing(state).providers?.[provider];
  if (record?.status === 'disconnected') return {};
  if (!record?.encryptedCredentials) return {};
  try { return decryptCredentials(record.encryptedCredentials, env.CREDENTIALS_KEY); }
  catch { return {}; }
}

export function marketingRuntimeEnv(state, env = process.env) {
  const canva = storedProviderCredentials(state, 'canva', env);
  const runway = storedProviderCredentials(state, 'runway', env);
  const fallback = state.workspace?.id === String(env.MARKETING_ENV_WORKSPACE_ID || 'packsmart-solutions');
  const records = state.marketing.providers;
  return {
    ...env,
    CANVA_ACCESS_TOKEN: records.canva?.status === 'disconnected' ? undefined : canva.accessToken || (fallback ? env.CANVA_ACCESS_TOKEN : undefined),
    CANVA_BRAND_TEMPLATE_ID: records.canva?.status === 'disconnected' ? undefined : canva.brandTemplateId || (fallback ? env.CANVA_BRAND_TEMPLATE_ID : undefined),
    RUNWAY_API_KEY: records.runway?.status === 'disconnected' ? undefined : runway.apiKey || (fallback ? env.RUNWAY_API_KEY : undefined)
  };
}

export function saveMarketingProvider(state, provider, credentials, env = process.env, actor = 'system') {
  const marketing = ensureMarketing(state);
  if (!['canva','runway'].includes(provider)) throw Object.assign(new Error('Unsupported marketing provider'), { status: 404, code: 'MARKETING_PROVIDER_UNKNOWN' });
  if (!env.CREDENTIALS_KEY || String(env.CREDENTIALS_KEY).length < 32) throw Object.assign(new Error('Credential encryption is unavailable'), { status: 503, code: 'CREDENTIAL_ENCRYPTION_REQUIRED' });
  let cleanCredentials;
  if (provider === 'canva') {
    const accessToken = String(credentials?.accessToken || '').trim();
    const brandTemplateId = clean(credentials?.brandTemplateId, 200);
    if (accessToken.length < 20 || accessToken.length > 8192 || /[\r\n]/.test(accessToken)) throw Object.assign(new Error('Enter a valid Canva access token'), { status: 400, code: 'CANVA_TOKEN_INVALID' });
    if (!brandTemplateId) throw Object.assign(new Error('Choose a Canva Brand Template before connecting'), { status: 400, code: 'CANVA_TEMPLATE_REQUIRED' });
    cleanCredentials = { ...storedProviderCredentials(state, 'canva', env), accessToken, brandTemplateId, mode: 'manual', refreshToken: null, expiresAt: null };
  } else {
    const apiKey = String(credentials?.apiKey || '').trim();
    if (apiKey.length < 20 || apiKey.length > 8192 || /[\r\n]/.test(apiKey)) throw Object.assign(new Error('Enter a valid Runway API key'), { status: 400, code: 'RUNWAY_KEY_INVALID' });
    cleanCredentials = { apiKey };
  }
  const previous = marketing.providers?.[provider] || {};
  marketing.providers[provider] = {
    ...previous,
    encryptedCredentials: encryptCredentials(cleanCredentials, env.CREDENTIALS_KEY),
    status: 'configured',
    configuredAt: previous.configuredAt || nowIso(),
    updatedAt: nowIso(),
    updatedBy: actor,
    lastTestAt: null,
    lastTestStatus: null,
    lastError: null
  };
  return marketing.providers[provider];
}

export function disconnectMarketingProvider(state, provider, actor = 'system', env = process.env) {
  const marketing = ensureMarketing(state);
  if (!['canva','runway'].includes(provider)) throw Object.assign(new Error('Unsupported marketing provider'), { status: 404, code: 'MARKETING_PROVIDER_UNKNOWN' });
  const previous = marketing.providers?.[provider] || {};
  const old = provider === 'canva' ? storedProviderCredentials(state, 'canva', env) : {};
  const application = old.clientId && old.clientSecret ? encryptCredentials({ clientId: old.clientId, clientSecret: old.clientSecret, brandTemplateId: old.brandTemplateId }, env.CREDENTIALS_KEY) : null;
  marketing.providers[provider] = { encryptedCredentials: application, status: 'disconnected', configuredAt: previous.configuredAt || null, updatedAt: nowIso(), updatedBy: actor, lastTestAt: previous.lastTestAt || null, lastTestStatus: 'disconnected', lastError: null };
  return marketing.providers[provider];
}

export async function testStoredMarketingProvider(state, provider, env = process.env, options = {}) {
  const marketing = ensureMarketing(state);
  const record = marketing.providers[provider] ||= {};
  try {
    if (record.status === 'disconnected') throw Object.assign(new Error('Reconnect this provider first.'), { code: 'PROVIDER_DISCONNECTED' });
    if (provider === 'canva') await refreshCanvaCredentials(state, env, options);
    const result = await testMarketingProvider(provider, marketingRuntimeEnv(state, env), options);
    Object.assign(record, { status: result.limitation ? 'degraded' : 'connected', lastTestAt: nowIso(), lastTestStatus: 'passed', lastError: null, health: result });
    return result;
  } catch (error) {
    const code = /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'PROVIDER_REQUEST_FAILED';
    const status = /HTTP_5|HTTP_429|TIMEOUT|UNAVAILABLE|REQUEST_FAILED/.test(code) ? 'degraded' : 'action_required';
    Object.assign(record, { status, lastTestAt: nowIso(), lastTestStatus: 'failed', lastError: code });
    return { ok: false, provider, code, error: status === 'degraded' ? 'Provider is temporarily unavailable. Test again later.' : 'Provider setup requires attention. Reconnect or check the template and API permissions.' };
  }
}

export async function saveCanvaTemplate(state, brandTemplateId, env, options = {}) {
  ensureMarketing(state);
  await refreshCanvaCredentials(state, env, options);
  const old = readCanvaCredentials(state, env);
  const template = clean(brandTemplateId, 200);
  if (!template) throw Object.assign(new Error('Choose a Brand Template.'), { code: 'CANVA_TEMPLATE_REQUIRED', status: 400 });
  const runtime = marketingRuntimeEnv(state, env);
  const result = await testMarketingProvider('canva', { ...runtime, CANVA_BRAND_TEMPLATE_ID: template });
  const record = state.marketing.providers.canva ||= {};
  record.encryptedCredentials = encryptCredentials({ ...old, brandTemplateId: template }, env.CREDENTIALS_KEY);
  Object.assign(record, { status: 'connected', health: result, lastTestAt: nowIso(), lastTestStatus: 'passed', lastError: null });
  return result;
}

export async function marketingCreativeCycle(state, { env = process.env, persist, durableStore = false,
  authorizePhase, campaignId = null, fetchImpl = fetch, now = Date.now } = {}) {
  const effects = createCreativeEffects();
  ensureMarketing(state);
  const noWork = reason => ({ advanced: 0, campaign: null, reason, effects: summarizeCreativeEffects(effects) });
  if (!state.marketing.settings.enabled || !state.marketing.settings.autoCreative) return noWork('AUTO_CREATIVE_OFF');
  const campaigns = state.marketing.campaigns;
  const previousIndex = campaigns.findIndex(item => item.id === state.marketing.creativeCampaignCursor);
  const nextIndex = previousIndex < 0 ? 0 : (previousIndex + 1) % campaigns.length;
  // Rotate a separate worklist, never the saved campaign array. A campaign
  // whose upstream job stays RUNNING or whose GET keeps failing must share the
  // existing one-campaign cycle with other accepted jobs.
  const ordered = campaignId ? campaigns : [...campaigns.slice(nextIndex), ...campaigns.slice(0, nextIndex)];
  const candidates = ordered.filter(item => (!campaignId || item.id === campaignId)
    && ['draft', 'creative_generation', 'creative_attention'].includes(item.status)
    && (item.creativeRequests || []).some(request => ['pending', 'in_progress'].includes(request.status)));
  if (!candidates.length) return noWork('NO_CREATIVE_WORK');
  // A newly blocked draft must not starve observation of older accepted jobs.
  const canObserve = (request, runtime, providers) => {
    if (!knownCreativeJob(request)) return false;
    const record = state.marketing.providers[request.provider], info = providers[request.provider];
    if (record?.status === 'disconnected' || info?.status === 'disconnected') return false;
    if (info?.status === 'action_required') {
      const templateOnly = request.provider === 'canva' && ['CANVA_TEMPLATE_FIELDS_REQUIRED','CANVA_TEMPLATE_REQUIRED','CANVA_BRAND_TEMPLATE_REQUIRED'].includes(record?.lastError)
        && (!info.expiresAt || info.expiresAt > now() || info.refreshSupported);
      if (!templateOnly) return false;
    }
    return Boolean(request.provider === 'canva' ? runtime.CANVA_ACCESS_TOKEN : runtime.RUNWAY_API_KEY);
  };
  const initialRuntime = marketingRuntimeEnv(state, env), initialProviders = marketingProviderStatus(state, env);
  const canRead = request => canObserve(request, initialRuntime, initialProviders);
  const campaign = candidates.find(item => (item.creativeRequests || []).some(canRead))
    || candidates.find(item => (item.creativeRequests || []).some(request => request.status === 'pending' && state.marketing.providers[request.provider]?.status !== 'disconnected'))
    || candidates[0];
  if (!campaignId) state.marketing.creativeCampaignCursor = campaign.id;
  effects.historicalExposureUnknown = (campaign.creativeRequests || []).some(request => request.safety?.origin !== 'server_created'
    || request.jobId || request.taskId || Object.values(request.safety?.phases || {}).some(phase => ['dispatching','uncertain','accepted','completed'].includes(phase?.status)));
  const needsCanvaRead = (campaign.creativeRequests || []).some(request => request.provider === 'canva' && knownCreativeJob(request));
  const countedFetch = async (url, options = {}) => {
    // Existing OAuth refresh is credential maintenance, not a creative status
    // read or generation submission. Do not mislabel its POST as a GET.
    if (String(options.method || 'GET').toUpperCase() === 'GET') effects.providerReads++;
    return fetchImpl(url, options);
  };
  try {
    if (needsCanvaRead && state.marketing.providers.canva?.encryptedCredentials && state.marketing.providers.canva.status !== 'disconnected') {
      await refreshCanvaCredentials(state, env, { persist, fetchImpl: countedFetch });
    }
  } catch (error) {
    if (error.code === 'STATE_CONFLICT' || /PERSISTENCE|SUPABASE/.test(error.code || '')) {
      error.creativeEffects = summarizeCreativeEffects({ ...effects, historicalExposureUnknown: true });
      throw error;
    }
    Object.assign(state.marketing.providers.canva, { status: /UNAVAILABLE/.test(error.code || '') ? 'degraded' : 'action_required', lastError: error.code || 'CANVA_AUTH_REQUIRED', lastTestStatus: 'failed' });
  }
  // No allowance issuer is installed by production routes. Missing permission
  // causes no health/balance probe and never silently activates generation.
  if (typeof authorizePhase === 'function') {
    const runtime = marketingRuntimeEnv(state, env);
    for (const provider of ['canva', 'runway']) {
      const pending = campaign.creativeRequests?.some(request => request.provider === provider && request.status === 'pending');
      const configured = provider === 'canva' ? runtime.CANVA_ACCESS_TOKEN && runtime.CANVA_BRAND_TEMPLATE_ID : runtime.RUNWAY_API_KEY;
      const record = state.marketing.providers[provider];
      if (pending && configured && record?.status !== 'disconnected'
        && (!record?.lastTestAt || Date.parse(record.lastTestAt) < now() - 3600000)) {
        await testStoredMarketingProvider(state, provider, env, { persist, fetchImpl: countedFetch });
      }
    }
  }
  const runtimeEnv = marketingRuntimeEnv(state, env);
  const providers = marketingProviderStatus(state, env);
  const eligible = request => {
    const record = state.marketing.providers[request.provider];
    if (record?.status === 'disconnected') return false;
    if (knownCreativeJob(request)) {
      // Status reads need current credentials, not a template or permission for
      // another generation. A zero Runway generation balance does not hide a job.
      return canObserve(request, runtimeEnv, providers);
    }
    if (typeof authorizePhase !== 'function') return true; // local, explicit allowance blocker only
    return providers[request.provider]?.configured && !['action_required', 'disconnected'].includes(providers[request.provider]?.status)
      && !(request.provider === 'runway' && state.marketing.providers.runway?.health?.canSubmit === false);
  };
  // Re-read live state after the acknowledged phase claim. The snapshot passed
  // to adapters is what prepared their HTTP headers; it must not conceal a
  // disconnect, credential replacement, or disabled worker during persistence.
  const resolveRuntimeEnv = provider => {
    const latest = marketingProviderStatus(state, env)[provider];
    if (!state.marketing.settings.enabled || !state.marketing.settings.autoCreative || !latest?.configured
      || ['action_required', 'disconnected'].includes(latest.status)
      || (provider === 'runway' && state.marketing.providers.runway?.health?.canSubmit === false)) {
      throw Object.assign(new Error('Creative dispatch prerequisites changed'), { code: 'CREATIVE_INPUT_CHANGED' });
    }
    return marketingRuntimeEnv(state, env);
  };
  const advanced = await advanceCampaignCreatives(campaign, runtimeEnv, { state, persist, durableStore,
    authorizePhase, eligible, resolveRuntimeEnv, fetchImpl, now, effects });
  // Runtime/status helpers normalize state.marketing, so write through the
  // current object rather than the obsolete pre-normalization local reference.
  if (advanced.advanced) state.marketing.lastCreativeRunAt = new Date(now()).toISOString();
  const reason = advanced.reason || (!advanced.advanced && !advanced.effects.providerReads ? 'CREATIVE_PROVIDER_NOT_AVAILABLE' : null);
  const ownerActions = { CREATIVE_ALLOWANCE_REQUIRED: CREATIVE_ALLOWANCE_ACTION,
    CREATIVE_STATUS_READ_FAILED: 'The existing provider job could not be checked. Its ID is retained; retry the status check rather than submitting it again.',
    CREATIVE_PROVIDER_JOB_FAILED: 'The provider reports that the existing job failed. Review its result and costs before creating a separately authorized request.',
    CREATIVE_PROVIDER_NOT_AVAILABLE: 'Repair the existing provider connection to check its saved job. New generation still requires an approved allowance.' };
  return { ...advanced, reason, ownerAction: ownerActions[reason] || null };
}

export function marketingProviderStatus(state = {}, env = process.env) {
  const runtime = marketingRuntimeEnv(state, env);
  const records = ensureMarketing(state).providers || {};
  const canvaConfigured = Boolean(runtime.CANVA_ACCESS_TOKEN && runtime.CANVA_BRAND_TEMPLATE_ID);
  const runwayConfigured = Boolean(runtime.RUNWAY_API_KEY);
  const statusFor = (provider, configured) => {
    const record = records[provider] || {};
    if (record.status === 'disconnected') return 'disconnected';
    if (['action_required', 'degraded'].includes(record.status)) return record.status;
    if (!configured) return 'not_configured';
    if (record.lastTestStatus !== 'passed') return 'configured';
    return Date.parse(record.lastTestAt) < Date.now() - 24 * 60 * 60 * 1000 ? 'degraded' : 'connected';
  };
  const credentials = storedProviderCredentials(state, 'canva', env);
  const canvaStatus = credentials.expiresAt && credentials.expiresAt <= Date.now() && !credentials.refreshToken ? 'action_required' : statusFor('canva', canvaConfigured);
  return {
    canva: {
      id: 'canva', name: 'Canva', planTarget: 'Pro', configured: canvaConfigured, status: canvaStatus,
      source: records.canva?.encryptedCredentials ? 'workspace' : canvaConfigured ? 'environment' : null,
      needs: ['accessToken', 'brandTemplateId'].filter(key => key === 'accessToken' ? !runtime.CANVA_ACCESS_TOKEN : !runtime.CANVA_BRAND_TEMPLATE_ID),
      capability: 'Brand-template creative generation', lastTestAt: records.canva?.lastTestAt || null, lastError: records.canva?.lastError || null,
      oauthReady: canvaOAuthReady(state, env), tokenMode: credentials.mode || 'manual', refreshSupported: Boolean(credentials.refreshToken), expiresAt: credentials.expiresAt || null, lastRefreshAt: records.canva?.lastRefreshAt || null,
      brandTemplateId: runtime.CANVA_BRAND_TEMPLATE_ID || null,
      recovery: canvaStatus === 'connected' ? null : 'Sign into Canva, choose an autofill Brand Template, then test the connection.'
    },
    runway: {
      id: 'runway', name: 'Runway', planTarget: 'Developer API', configured: runwayConfigured, status: statusFor('runway', runwayConfigured),
      source: records.runway?.encryptedCredentials ? 'workspace' : runwayConfigured ? 'environment' : null,
      needs: runwayConfigured ? [] : ['apiKey'], capability: 'Product video generation', lastTestAt: records.runway?.lastTestAt || null, lastError: records.runway?.lastError || null,
      creditBalance: records.runway?.health?.creditBalance ?? null, canSubmit: records.runway?.health?.canSubmit ?? false,
      recovery: records.runway?.health?.limitation === 'RUNWAY_API_CREDITS_REQUIRED' ? 'The API project needs credits. Runway Pro credits are separate. Runvara will not buy credits.' : records.runway?.health?.limitation === 'RUNWAY_PRODUCT_AD_UNAVAILABLE' ? 'Enable product-ad generation in the Runway API project.' : null
    }
  };
}

export function marketingPublishingReadiness(state) {
  const marketing = ensureMarketing(state);
  const connections = Array.isArray(state.connections) ? state.connections : [];
  const active = new Map(connections.filter(item => item?.status === 'connected').map(item => [item.provider, item]));
  const channels = {
    meta: {
      connected: active.has('meta'),
      publisherImplemented: false,
      reason: active.has('meta') ? 'Connection is healthy; organic publishing adapter still needs explicit implementation and test.' : 'Connect Meta first.'
    },
    google_youtube: {
      connected: active.has('google_youtube'),
      publisherImplemented: false,
      reason: active.has('google_youtube') ? 'Read access is connected; upload/publishing scope and adapter are not enabled.' : 'Connect Google/YouTube first.'
    },
    pinterest: {
      connected: active.has('pinterest'),
      publisherImplemented: false,
      reason: active.has('pinterest') ? 'Read access is connected; pin publishing scope and adapter are not enabled.' : 'Connect Pinterest first.'
    },
    tiktok_shop: {
      connected: active.has('tiktok_shop'),
      publisherImplemented: false,
      reason: active.has('tiktok_shop') ? 'Shop connection is healthy; social publishing is a separate TikTok capability.' : 'Connect TikTok Shop first.'
    }
  };
  const implemented = Object.entries(channels).filter(([channel, item]) => marketing.settings.channels[channel] && item.publisherImplemented);
  return {
    ready: marketing.settings.mode === 'automatic' && marketing.settings.autoPublishOrganic && implemented.length > 0,
    enabledChannels: Object.keys(channels).filter(channel => marketing.settings.channels[channel]),
    channels
  };
}

export function marketingSnapshot(state, env = process.env) {
  const marketing = ensureMarketing(state);
  const providers = marketingProviderStatus(state, env);
  const publishing = marketingPublishingReadiness(state);
  const pending = marketing.campaigns.filter(item => ['draft', 'prepared', 'awaiting_approval', 'scheduled'].includes(item.status));
  return {
    settings: marketing.settings,
    modes: Object.values(MARKETING_MODES),
    providers,
    campaigns: marketing.campaigns.slice(0, 50),
    pendingCampaigns: pending.length,
    lastPlannerRunAt: marketing.lastPlannerRunAt,
    lastCreativeRunAt: marketing.lastCreativeRunAt,
    publishing,
    automaticPublishingReady: publishing.ready,
    automaticPublishingNote: publishing.ready
      ? 'Automatic organic publishing is enabled only on explicitly implemented and authorised publishers.'
      : 'Channel publishing remains approval-gated until a supported publisher is connected, tested and explicitly authorised.'
  };
}
