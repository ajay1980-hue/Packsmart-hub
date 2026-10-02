import crypto from 'node:crypto';
import { deriveOperations } from './operations.mjs';
import { advanceCampaignCreatives, testMarketingProvider } from './marketing-providers.mjs';
import { decryptCredentials, encryptCredentials } from './security.mjs';

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
    .filter(item => item.complete && Number(item.margin) >= minMargin)
    .filter(item => item.productImage || item.image)
    .sort((a, b) => {
      const revenue = Number(b.revenue30d || 0) - Number(a.revenue30d || 0);
      if (revenue) return revenue;
      return Number(b.contribution || 0) - Number(a.contribution || 0);
    });
}

function campaignCopy(product) {
  const title = clean(product.productTitle || product.title, 120);
  const price = Number.isFinite(Number(product.price)) ? `£${Number(product.price).toFixed(2)}` : null;
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
  const products = eligibleProducts(state);
  if (!products.length) throw Object.assign(new Error('No product currently passes the stock, margin, image and active-product marketing guardrails'), { status: 409, code: 'NO_MARKETING_CANDIDATE' });
  const product = products[0];
  const activeChannels = validChannels.filter(channel => marketing.settings.channels[channel]);
  const campaign = {
    id: id('campaign'),
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
      { provider: 'canva', kind: 'social_post', status: 'pending', formats: ['instagram_post', 'facebook_post', 'pinterest_pin', 'youtube_thumbnail'] },
      { provider: 'runway', kind: 'product_video', status: 'pending', formats: ['vertical_video', 'landscape_video'] }
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
      { type: 'sales_signal', id: product.sku, detail: `${product.units30d || 0} units / £${Number(product.revenue30d || 0).toFixed(2)} recorded revenue in 30 days` }
    ]
  };
  marketing.campaigns.unshift(campaign);
  marketing.campaigns = marketing.campaigns.slice(0, 200);
  marketing.lastPlannerRunAt = nowIso(now);
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
  if (!record?.encryptedCredentials) return {};
  try { return decryptCredentials(record.encryptedCredentials, env.CREDENTIALS_KEY); }
  catch { return {}; }
}

export function marketingRuntimeEnv(state, env = process.env) {
  const canva = storedProviderCredentials(state, 'canva', env);
  const runway = storedProviderCredentials(state, 'runway', env);
  return {
    ...env,
    CANVA_ACCESS_TOKEN: canva.accessToken || env.CANVA_ACCESS_TOKEN,
    CANVA_BRAND_TEMPLATE_ID: canva.brandTemplateId || env.CANVA_BRAND_TEMPLATE_ID,
    RUNWAY_API_KEY: runway.apiKey || env.RUNWAY_API_KEY
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
    cleanCredentials = { accessToken, brandTemplateId };
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
    lastTestAt: previous.lastTestAt || null,
    lastTestStatus: previous.lastTestStatus || null,
    lastError: null
  };
  return marketing.providers[provider];
}

export function disconnectMarketingProvider(state, provider, actor = 'system') {
  const marketing = ensureMarketing(state);
  if (!['canva','runway'].includes(provider)) throw Object.assign(new Error('Unsupported marketing provider'), { status: 404, code: 'MARKETING_PROVIDER_UNKNOWN' });
  const previous = marketing.providers?.[provider] || {};
  marketing.providers[provider] = { status: 'disconnected', configuredAt: previous.configuredAt || null, updatedAt: nowIso(), updatedBy: actor, lastTestAt: previous.lastTestAt || null, lastTestStatus: 'disconnected', lastError: null };
  return marketing.providers[provider];
}

export async function testStoredMarketingProvider(state, provider, env = process.env) {
  const runtime = marketingRuntimeEnv(state, env);
  const result = await testMarketingProvider(provider, runtime);
  const record = ensureMarketing(state).providers?.[provider] || {};
  Object.assign(record, { status: result.ok ? 'connected' : 'action_required', lastTestAt: nowIso(), lastTestStatus: result.ok ? 'passed' : 'failed', lastError: result.ok ? null : result.code || 'PROVIDER_TEST_FAILED' });
  ensureMarketing(state).providers[provider] = record;
  return result;
}

export async function marketingCreativeCycle(state, { env = process.env } = {}) {
  const marketing = ensureMarketing(state);
  if (!marketing.settings.enabled || !marketing.settings.autoCreative) return { advanced: 0, campaign: null, reason: 'AUTO_CREATIVE_OFF' };
  const runtimeEnv = marketingRuntimeEnv(state, env);
  const providers = marketingProviderStatus(state, env);
  const campaign = marketing.campaigns.find(item =>
    ['draft', 'creative_generation', 'creative_attention'].includes(item.status) &&
    (item.creativeRequests || []).some(request =>
      request.status === 'in_progress' ||
      (request.status === 'pending' && providers[request.provider]?.configured)
    )
  );
  if (!campaign) return { advanced: 0, campaign: null, reason: 'NO_CREATIVE_WORK' };
  await advanceCampaignCreatives(campaign, runtimeEnv);
  marketing.lastCreativeRunAt = nowIso();
  return { advanced: 1, campaign, reason: null };
}

export function marketingProviderStatus(state = {}, env = process.env) {
  const runtime = marketingRuntimeEnv(state, env);
  const records = ensureMarketing(state).providers || {};
  const canvaConfigured = Boolean(runtime.CANVA_ACCESS_TOKEN && runtime.CANVA_BRAND_TEMPLATE_ID);
  const runwayConfigured = Boolean(runtime.RUNWAY_API_KEY);
  return {
    canva: {
      id: 'canva', name: 'Canva', planTarget: 'Pro', configured: canvaConfigured,
      status: canvaConfigured ? (records.canva?.lastTestStatus === 'failed' ? 'action_required' : records.canva?.lastTestStatus === 'passed' ? 'connected' : 'configured') : 'not_configured',
      source: records.canva?.encryptedCredentials ? 'workspace' : canvaConfigured ? 'environment' : null,
      needs: ['accessToken', 'brandTemplateId'].filter(key => key === 'accessToken' ? !runtime.CANVA_ACCESS_TOKEN : !runtime.CANVA_BRAND_TEMPLATE_ID),
      capability: 'Brand-template creative generation', lastTestAt: records.canva?.lastTestAt || null, lastError: records.canva?.lastError || null
    },
    runway: {
      id: 'runway', name: 'Runway', planTarget: 'Pro', configured: runwayConfigured,
      status: runwayConfigured ? (records.runway?.lastTestStatus === 'failed' ? 'action_required' : records.runway?.lastTestStatus === 'passed' ? 'connected' : 'configured') : 'not_configured',
      source: records.runway?.encryptedCredentials ? 'workspace' : runwayConfigured ? 'environment' : null,
      needs: runtime.RUNWAY_API_KEY ? [] : ['apiKey'],
      capability: 'Product video generation', lastTestAt: records.runway?.lastTestAt || null, lastError: records.runway?.lastError || null
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
