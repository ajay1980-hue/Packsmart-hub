import crypto from 'node:crypto';
import { deriveOperations } from './operations.mjs';

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
    lastCreativeRunAt: previous.lastCreativeRunAt || null
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

export function marketingProviderStatus(env = process.env) {
  return {
    canva: {
      name: 'Canva',
      planTarget: 'Pro',
      configured: Boolean(env.CANVA_ACCESS_TOKEN && env.CANVA_BRAND_TEMPLATE_ID),
      needs: ['CANVA_ACCESS_TOKEN', 'CANVA_BRAND_TEMPLATE_ID'].filter(key => !env[key]),
      capability: 'Brand-template creative generation'
    },
    runway: {
      name: 'Runway',
      planTarget: 'Pro',
      configured: Boolean(env.RUNWAY_API_KEY),
      needs: env.RUNWAY_API_KEY ? [] : ['RUNWAY_API_KEY'],
      capability: 'Product video generation'
    }
  };
}

export function marketingSnapshot(state, env = process.env) {
  const marketing = ensureMarketing(state);
  const providers = marketingProviderStatus(env);
  const pending = marketing.campaigns.filter(item => ['draft', 'prepared', 'awaiting_approval', 'scheduled'].includes(item.status));
  return {
    settings: marketing.settings,
    modes: Object.values(MARKETING_MODES),
    providers,
    campaigns: marketing.campaigns.slice(0, 50),
    pendingCampaigns: pending.length,
    lastPlannerRunAt: marketing.lastPlannerRunAt,
    lastCreativeRunAt: marketing.lastCreativeRunAt,
    automaticPublishingReady: marketing.settings.mode === 'automatic' && marketing.settings.autoPublishOrganic && false,
    automaticPublishingNote: 'Channel publishing remains approval-gated until a supported publisher is connected, tested and explicitly authorised.'
  };
}
