import { creativeDigest, createCreativeEffects, createCreativeLifecycle, isCreativeLifecycle, knownCreativeJob, summarizeCreativeEffects } from './creative-safety.mjs';

const CANVA_BASE = 'https://api.canva.com/rest/v1';
const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1';
const RUNWAY_VERSION = '2024-11-06';

const clean = (value, max = 1200) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

function providerError(provider, message, code = 'PROVIDER_REQUEST_FAILED', status = 502) {
  return Object.assign(new Error(message), { provider, code, status });
}

async function jsonRequest(url, options = {}, { provider, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A redirect can replay a POST outside the exact endpoint claim. Treat the
    // first request's outcome as uncertain instead of following any redirect.
    const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error' });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const detail = [401, 403].includes(response.status) ? `${provider} access requires reconnecting or additional scopes.` : response.status === 429 ? `${provider} is limiting requests. Try again later.` : `${provider} request failed (HTTP ${response.status}).`;
      throw providerError(provider, detail, `${provider.toUpperCase()}_HTTP_${response.status}`, response.status >= 500 ? 502 : 422);
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw providerError(provider, `${provider} request timed out`, `${provider.toUpperCase()}_TIMEOUT`, 504);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function canvaHeaders(env, extra = {}) {
  return { Authorization: `Bearer ${env.CANVA_ACCESS_TOKEN}`, ...extra };
}

function runwayHeaders(env) {
  return {
    Authorization: `Bearer ${env.RUNWAY_API_KEY}`,
    'Content-Type': 'application/json',
    'X-Runway-Version': RUNWAY_VERSION
  };
}

function allowedImageHost(url, env) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  const configured = String(env.MARKETING_ALLOWED_IMAGE_HOSTS || 'cdn.shopify.com')
    .split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  const host = parsed.hostname.toLowerCase();
  return configured.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

async function fetchProductImage(url, env, fetchImpl = fetch) {
  if (!allowedImageHost(url, env)) throw providerError('canva', 'Product image host is not approved for server-side creative generation.', 'MARKETING_IMAGE_HOST_BLOCKED', 422);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw providerError('canva', 'Could not retrieve the product image for Canva.', 'CANVA_PRODUCT_IMAGE_UNAVAILABLE', 422);
    const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) throw providerError('canva', 'Product image is not a supported Canva image type.', 'CANVA_PRODUCT_IMAGE_TYPE', 422);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw providerError('canva', 'Product image is empty or too large for Canva.', 'CANVA_PRODUCT_IMAGE_SIZE', 422);
    return { bytes, type };
  } catch (error) {
    if (error.name === 'AbortError') throw providerError('canva', 'Product image download timed out.', 'CANVA_PRODUCT_IMAGE_TIMEOUT', 504);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function canvaFieldMap(dataset = {}, campaign = {}, assetId = null) {
  const explicit = {};
  const envMap = process.env.CANVA_AUTOFILL_FIELD_MAP;
  if (envMap) {
    try { Object.assign(explicit, JSON.parse(envMap)); } catch {}
  }
  const values = {
    title: campaign.product?.title,
    product_name: campaign.product?.title,
    headline: campaign.copy?.headline,
    caption: campaign.copy?.longCaption,
    description: campaign.copy?.longCaption,
    body: campaign.copy?.longCaption,
    cta: campaign.copy?.cta,
    price: Number.isFinite(Number(campaign.product?.price)) ? `£${Number(campaign.product.price).toFixed(2)}` : '',
    sku: campaign.product?.sku,
    image: assetId,
    product_image: assetId
  };
  const data = {};
  for (const [field, definition] of Object.entries(dataset || {})) {
    const type = definition?.type;
    const normalized = field.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    let semantic = Object.entries(explicit).find(([, mapped]) => mapped === field)?.[0] || null;
    if (!semantic) {
      semantic = Object.keys(values).find(key => normalized === key || normalized.includes(key)) || null;
    }
    if (!semantic) continue;
    const value = values[semantic];
    if (type === 'text' && value !== null && value !== undefined && String(value).trim()) data[field] = { type: 'text', text: clean(value, 2000) };
    if (type === 'image' && assetId) data[field] = { type: 'image', asset_id: assetId };
  }
  return data;
}

function designIdFromResult(result = {}) {
  if (result.design?.id) return result.design.id;
  const url = result.design?.url || '';
  const match = String(url).match(/\/design\/([^/]+)/);
  return match ? match[1] : null;
}

export async function testMarketingProvider(provider, env = process.env, options = {}) {
  if (provider === 'canva') {
    if (!env.CANVA_ACCESS_TOKEN || !env.CANVA_BRAND_TEMPLATE_ID) throw providerError('canva', 'Canva access token and Brand Template are required.', 'CANVA_NOT_CONFIGURED', 409);
    const payload = await jsonRequest(`${CANVA_BASE}/brand-templates/${encodeURIComponent(env.CANVA_BRAND_TEMPLATE_ID)}/dataset`, { headers: canvaHeaders(env) }, { provider: 'canva', fetchImpl: options.fetchImpl });
    const fields = Object.keys(payload.dataset || {});
    if (!fields.length || !Object.values(payload.dataset || {}).some(field => ['text', 'image'].includes(field?.type))) throw providerError('canva', 'Choose a Brand Template with text or image autofill fields.', 'CANVA_TEMPLATE_FIELDS_REQUIRED', 422);
    return { ok: true, provider: 'canva', capability: 'brand_template_autofill', fieldCount: fields.length, fields };
  }
  if (provider === 'runway') {
    if (!env.RUNWAY_API_KEY) throw providerError('runway', 'Runway developer API key is required.', 'RUNWAY_NOT_CONFIGURED', 409);
    const payload = await jsonRequest(`${RUNWAY_BASE}/organization`, { headers: runwayHeaders(env) }, { provider: 'runway', timeoutMs: 15000, fetchImpl: options.fetchImpl });
    if (!Number.isFinite(payload.creditBalance) || !payload.tier?.models) throw providerError('runway', 'Runway did not confirm the API project.', 'RUNWAY_RESPONSE_INVALID', 502);
    const limits = payload.tier.models.product_ad;
    const canSubmit = Boolean(limits && limits.maxConcurrentGenerations !== 0 && limits.maxDailyGenerations !== 0 && payload.creditBalance > 0);
    return { ok: true, provider: 'runway', capability: 'video_generation', creditBalance: payload.creditBalance, canSubmit, limitation: !limits || limits.maxConcurrentGenerations === 0 || limits.maxDailyGenerations === 0 ? 'RUNWAY_PRODUCT_AD_UNAVAILABLE' : payload.creditBalance <= 0 ? 'RUNWAY_API_CREDITS_REQUIRED' : null };

  }
  throw providerError(provider, 'Unsupported marketing provider.', 'MARKETING_PROVIDER_UNKNOWN', 404);
}

const UPSTREAM_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const safeUrl = value => {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null; } catch { return null; }
};
function beforeMutation(lifecycle, phase) {
  if (!isCreativeLifecycle(lifecycle)) throw providerError('creative', 'An exact owner allowance and durable reservation are required before new generation.', 'CREATIVE_ALLOWANCE_REQUIRED', 409);
  if (lifecycle.safety.phases[phase]) return lifecycle.block('CREATIVE_SUBMISSION_ALREADY_CLAIMED', true);
  if (!lifecycle.canAuthorize) return lifecycle.block();
  if (lifecycle.safety.origin !== 'server_created') return lifecycle.block('CREATIVE_LEGACY_DISPATCH_UNVERIFIED', true);
  return null;
}
const credentialBinding = (provider, env) => creativeDigest(provider === 'canva'
  ? [provider, env.CANVA_ACCESS_TOKEN || '', env.CANVA_BRAND_TEMPLATE_ID || '']
  : [provider, env.RUNWAY_API_KEY || '']);
const liveCredentialBinding = (provider, env, options) => credentialBinding(provider,
  typeof options.resolveRuntimeEnv === 'function' ? options.resolveRuntimeEnv(provider) : env);
function sourceBinding(campaign, request) {
  return creativeDigest({ campaignId: campaign.id, requestId: request.id, provider: request.provider,
    stage: request.stage || null, status: request.status, assetId: request.assetId || null, designId: request.designId || null,
    jobId: request.jobId || null, taskId: request.taskId || null,
    product: Object.fromEntries(['title','sku','image','price'].map(key => [key, campaign.product?.[key] ?? null])),
    copy: Object.fromEntries(['videoHook','headline','longCaption','cta'].map(key => [key, campaign.copy?.[key] ?? null])) });
}
async function observe(request, patch, options, phase) {
  if (options.lifecycle) return options.lifecycle.observe(patch, phase);
  Object.assign(request, patch);
  return request;
}
async function poll(request, url, headers, options, interpret) {
  options.lifecycle?.readStarted();
  try {
    const payload = await jsonRequest(url, { headers }, { provider: request.provider, fetchImpl: options.fetchImpl });
    request.lastPollError = null;
    return await interpret(payload);
  } catch (error) {
    if (error.creativePersistenceFailure) throw error;
    // A failed GET cannot erase a known upstream job or authorize another POST.
    if (options.lifecycle) options.lifecycle.readFailed(error);
    else request.lastPollError = /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'CREATIVE_STATUS_READ_FAILED';
    return request;
  }
}

export async function startCanvaCreative(campaign, env = process.env, options = {}) {
  const request = options.request || { provider: 'canva', kind: 'social_post', status: 'pending' };
  if (beforeMutation(options.lifecycle, 'asset_upload')) return request;
  if (!env.CANVA_ACCESS_TOKEN || !env.CANVA_BRAND_TEMPLATE_ID) throw providerError('canva', 'Canva API credentials or brand template are not configured.', 'CANVA_NOT_CONFIGURED', 409);
  if (!campaign.product?.image) throw providerError('canva', 'Campaign has no product image.', 'CANVA_PRODUCT_IMAGE_REQUIRED', 422);
  const image = await fetchProductImage(campaign.product.image, env, options.fetchImpl);
  const metadata = Buffer.from(clean(`${campaign.product.sku || 'product'}-${campaign.product.title || 'creative'}`, 50)).toString('base64');
  const endpoint = `${CANVA_BASE}/asset-uploads`;
  const headers = canvaHeaders(env, { 'Content-Type': 'application/octet-stream', 'Asset-Upload-Metadata': JSON.stringify({ name_base64: metadata }) });
  const bindings = () => ({ payloadDigest: creativeDigest({ imageSha256: creativeDigest(image.bytes), metadata, contentType: headers['Content-Type'] }),
    accountBinding: credentialBinding('canva', env), sourceDigest: sourceBinding(campaign, request) });
  await options.lifecycle.mutate({ phase: 'asset_upload', endpoint, ...bindings(),
    checkBinding: () => ({ ...bindings(), accountBinding: liveCredentialBinding('canva', env, options) }),
    submit: () => jsonRequest(endpoint, { method: 'POST', headers, body: image.bytes }, { provider: 'canva', timeoutMs: 25000, fetchImpl: options.fetchImpl }),
    accepted: upload => ({ provider: 'canva', kind: 'social_post', status: 'in_progress', stage: 'asset_upload',
      jobId: upload.job?.id || null, startedAt: new Date().toISOString(), formats: ['instagram_post', 'facebook_post', 'pinterest_pin', 'youtube_thumbnail'] }) });
  return request;
}

async function continueCanvaCreative(campaign, request, env, options) {
  const phase = request.stage === 'autofill_ready' ? 'autofill' : request.stage === 'export_ready' ? 'export' : null;
  if (!phase) throw providerError('canva', 'The next Canva phase is not confirmed.', 'CANVA_PHASE_UNVERIFIED', 409);
  if (beforeMutation(options.lifecycle, phase)) return request;
  if (!env.CANVA_ACCESS_TOKEN || !env.CANVA_BRAND_TEMPLATE_ID) throw providerError('canva', 'Canva API credentials or brand template are not configured.', 'CANVA_NOT_CONFIGURED', 409);
  let endpoint, body;
  if (phase === 'autofill') {
    if (!UPSTREAM_ID.test(request.assetId || '')) throw providerError('canva', 'The uploaded Canva asset is not confirmed.', 'CANVA_ASSET_ID_MISSING', 409);
    options.lifecycle.readStarted();
    const dataset = await jsonRequest(`${CANVA_BASE}/brand-templates/${encodeURIComponent(env.CANVA_BRAND_TEMPLATE_ID)}/dataset`,
      { headers: canvaHeaders(env) }, { provider: 'canva', fetchImpl: options.fetchImpl });
    const data = canvaFieldMap(dataset.dataset || {}, campaign, request.assetId);
    if (!Object.keys(data).length) throw providerError('canva', 'The Canva template has no matching autofill fields.', 'CANVA_TEMPLATE_FIELDS_REQUIRED', 422);
    endpoint = `${CANVA_BASE}/autofills`;
    body = JSON.stringify({ type: 'create_from_brand_template', brand_template_id: env.CANVA_BRAND_TEMPLATE_ID, title: `Packsmart - ${clean(campaign.product?.title, 120)}`, data });
  } else {
    if (!UPSTREAM_ID.test(request.designId || '')) throw providerError('canva', 'The Canva design is not confirmed.', 'CANVA_DESIGN_ID_MISSING', 409);
    endpoint = `${CANVA_BASE}/exports`;
    body = JSON.stringify({ design_id: request.designId, format: { type: 'png', export_quality: 'pro', lossless: true } });
  }
  const headers = canvaHeaders(env, { 'Content-Type': 'application/json' });
  const bindings = () => ({ payloadDigest: creativeDigest(body), accountBinding: credentialBinding('canva', env), sourceDigest: sourceBinding(campaign, request) });
  await options.lifecycle.mutate({ phase, endpoint, ...bindings(),
    checkBinding: () => ({ ...bindings(), accountBinding: liveCredentialBinding('canva', env, options) }),
    submit: () => jsonRequest(endpoint, { method: 'POST', headers, body }, { provider: 'canva', fetchImpl: options.fetchImpl }),
    accepted: receipt => ({ provider: 'canva', stage: phase, status: 'in_progress', jobId: receipt.job?.id || null, updatedAt: new Date().toISOString() }) });
  return request;
}

export async function refreshCanvaCreative(campaign, request, env = process.env, options = {}) {
  if (!UPSTREAM_ID.test(request?.jobId || '') || !['asset_upload', 'autofill', 'export'].includes(request.stage)) throw providerError('canva', 'Canva creative job is missing a verified job id or phase.', 'CANVA_JOB_INVALID', 409);
  if (!env.CANVA_ACCESS_TOKEN) throw providerError('canva', 'Canva access needs reconnecting.', 'CANVA_AUTH_REQUIRED', 409);
  const phase = request.stage;
  const path = { asset_upload: 'asset-uploads', autofill: 'autofills', export: 'exports' }[phase];
  return poll(request, `${CANVA_BASE}/${path}/${encodeURIComponent(request.jobId)}`, canvaHeaders(env), options, async payload => {
    if (!['pending','queued','in_progress','processing','running','success','failed'].includes(payload.job?.status)) throw providerError('canva', 'Canva did not confirm a job status.', 'CANVA_STATUS_UNVERIFIED', 502);
    if (payload.job?.status === 'failed') return observe(request, { status: 'failed', errorCode: `CANVA_${phase.toUpperCase()}_FAILED`, failureConfirmed: true }, options, phase);
    if (payload.job?.status !== 'success') return request;
    if (phase === 'asset_upload') {
      const assetId = payload.job?.asset?.id;
      if (!UPSTREAM_ID.test(assetId || '')) throw providerError('canva', 'Canva did not confirm the uploaded asset.', 'CANVA_ASSET_ID_MISSING', 502);
      // Save observation alone. A later invocation must separately authorize and
      // claim autofill; this status GET never turns into a hidden next POST.
      return observe(request, { assetId, uploadJobId: request.jobId, stage: 'autofill_ready', status: 'pending', updatedAt: new Date().toISOString() }, options, phase);
    }
    if (phase === 'autofill') {
      const result = payload.job?.result || {}, designId = designIdFromResult(result);
      if (!UPSTREAM_ID.test(designId || '')) throw providerError('canva', 'Canva did not confirm a design identity.', 'CANVA_DESIGN_ID_MISSING', 502);
      return observe(request, { designId, designUrl: safeUrl(result.design?.url), autofillJobId: request.jobId,
        stage: 'export_ready', status: 'pending', updatedAt: new Date().toISOString() }, options, phase);
    }
    const urls = Array.isArray(payload.job?.urls) ? payload.job.urls.slice(0, 16).map(safeUrl).filter(Boolean) : [];
    if (!urls.length) throw providerError('canva', 'Canva did not confirm export output.', 'CANVA_EXPORT_RESULT_UNVERIFIED', 502);
    return observe(request, { status: 'complete', stage: 'complete', assetUrls: urls, completedAt: new Date().toISOString() }, options, phase);
  });
}

export async function startRunwayCreative(campaign, env = process.env, options = {}) {
  const request = options.request || { provider: 'runway', kind: 'product_video', status: 'pending' };
  if (beforeMutation(options.lifecycle, 'generation')) return request;
  if (!env.RUNWAY_API_KEY) throw providerError('runway', 'Runway developer API key is not configured.', 'RUNWAY_NOT_CONFIGURED', 409);
  if (!campaign.product?.image) throw providerError('runway', 'Campaign has no product image.', 'RUNWAY_PRODUCT_IMAGE_REQUIRED', 422);
  const prompt = clean(`${campaign.copy?.videoHook || campaign.copy?.headline || campaign.product.title} Premium practical ecommerce packaging advert for Packsmart Solutions. Show the exact referenced product clearly, clean warehouse and dispatch context, confident business tone, crisp lighting, no invented product claims, no price overlays unless supplied.`, 2000);
  const endpoint = `${RUNWAY_BASE}/recipes/product_ad`;
  const body = JSON.stringify({ version: '2026-07', productImages: [{ uri: campaign.product.image }],
    productInfo: clean(`${campaign.product.title}; SKU ${campaign.product.sku || 'unknown'}`, 500), userConcept: prompt, duration: 10 });
  const headers = runwayHeaders(env);
  const bindings = () => ({ payloadDigest: creativeDigest(body), accountBinding: credentialBinding('runway', env), sourceDigest: sourceBinding(campaign, request) });
  await options.lifecycle.mutate({ phase: 'generation', endpoint, ...bindings(),
    checkBinding: () => ({ ...bindings(), accountBinding: liveCredentialBinding('runway', env, options) }),
    submit: () => jsonRequest(endpoint, { method: 'POST', headers, body }, { provider: 'runway', timeoutMs: 30000, fetchImpl: options.fetchImpl }),
    accepted: payload => ({ provider: 'runway', kind: 'product_video', status: 'in_progress', stage: 'generation', taskId: payload.id || payload.task?.id || null,
      startedAt: new Date().toISOString(), formats: ['vertical_video', 'landscape_video'] }) });
  return request;
}

export async function refreshRunwayCreative(campaign, request, env = process.env, options = {}) {
  if (!UPSTREAM_ID.test(request?.taskId || '')) throw providerError('runway', 'Runway creative task is missing its task id.', 'RUNWAY_TASK_INVALID', 409);
  if (!env.RUNWAY_API_KEY) throw providerError('runway', 'Runway access needs reconnecting.', 'RUNWAY_AUTH_REQUIRED', 409);
  return poll(request, `${RUNWAY_BASE}/tasks/${encodeURIComponent(request.taskId)}`, runwayHeaders(env), options, async payload => {
    const status = String(payload.status || '').toUpperCase();
    if (!['PENDING','QUEUED','RUNNING','THROTTLED','SUCCEEDED','FAILED','CANCELED','CANCELLED'].includes(status)) throw providerError('runway', 'Runway did not confirm a task status.', 'RUNWAY_STATUS_UNVERIFIED', 502);
    if (['FAILED', 'CANCELED', 'CANCELLED'].includes(status)) return observe(request, { status: 'failed', errorCode: 'RUNWAY_GENERATION_FAILED', failureConfirmed: true }, options, 'generation');
    if (status !== 'SUCCEEDED') {
      if (Number.isFinite(payload.progress) && payload.progress >= 0 && payload.progress <= 100) request.progress = payload.progress;
      return request;
    }
    const output = Array.isArray(payload.output) ? payload.output : payload.output ? [payload.output] : [];
    const urls = output.slice(0, 16).map(safeUrl).filter(Boolean);
    if (!urls.length) throw providerError('runway', 'Runway did not confirm an output asset.', 'RUNWAY_RESULT_UNVERIFIED', 502);
    return observe(request, { status: 'complete', stage: 'complete', assetUrls: urls, completedAt: new Date().toISOString() }, options, 'generation');
  });
}

export async function advanceCampaignCreatives(campaign, env = process.env, options = {}) {
  const effects = options.effects || createCreativeEffects();
  let advanced = 0;
  // Never detach or replace this array: durable inner saves must retain deferred
  // requests, publishing settings and every previously accepted upstream ID.
  const requests = campaign.creativeRequests || [];
  const cursor = Number.isSafeInteger(campaign.creativeWorkCursor) && campaign.creativeWorkCursor >= 0
    && campaign.creativeWorkCursor < requests.length ? campaign.creativeWorkCursor : 0;
  // Filter before bounding; completed or disconnected rows cannot hide a saved
  // upstream job. Rotate within each priority so still-running/failed GETs do
  // not monopolize all eight slots on every cycle. The cursor is ordinary
  // scheduling metadata, persisted by inner saves and the caller's final CAS.
  const work = requests.map((request, index) => ({ request, index }))
    .filter(({ request }) => ['canva', 'runway'].includes(request.provider) && ['pending', 'in_progress'].includes(request.status)
      && (!options.eligible || options.eligible(request)))
    .sort((a, b) => Number(knownCreativeJob(b.request)) - Number(knownCreativeJob(a.request))
      || (a.index - cursor + requests.length) % requests.length - (b.index - cursor + requests.length) % requests.length)
    .slice(0, 8);
  for (const { request, index } of work) {
    campaign.creativeWorkCursor = (index + 1) % requests.length;
    if (request.safety?.origin !== 'server_created' || request.jobId || request.taskId) effects.historicalExposureUnknown = true;
    const prior = [request.status, request.stage, request.jobId, request.taskId].join(':');
    let lifecycle;
    try {
      if (options.state) lifecycle = createCreativeLifecycle({ state: options.state, campaign, request, effects,
        persist: options.persist, durableStore: options.durableStore, authorizePhase: options.authorizePhase, now: options.now });
      const step = { ...options, request, lifecycle };
      if (knownCreativeJob(request)) {
        if (request.provider === 'canva') await refreshCanvaCreative(campaign, request, env, step);
        else await refreshRunwayCreative(campaign, request, env, step);
      } else if (request.status === 'in_progress') {
        if (lifecycle) lifecycle.block('CREATIVE_UPSTREAM_ID_UNVERIFIED', true);
        else { effects.blockedSubmissions++; effects.historicalExposureUnknown = true; request.blockReason = 'CREATIVE_UPSTREAM_ID_UNVERIFIED'; }
      } else if (request.provider === 'canva') {
        if (['autofill_ready', 'export_ready'].includes(request.stage)) await continueCanvaCreative(campaign, request, env, step);
        else await startCanvaCreative(campaign, env, step);
      } else await startRunwayCreative(campaign, env, step);
    } catch (cause) {
      if (cause.creativePersistenceFailure) { cause.creativeEffects = summarizeCreativeEffects(effects); throw cause; }
      request.blockReason = /^[A-Z0-9_]{1,80}$/.test(cause.code || '') ? cause.code : 'CREATIVE_PREPARATION_FAILED';
      request.ownerAction = 'Resolve the recorded creative prerequisite before any new submission. Existing provider job IDs are retained.';
      effects.blockedSubmissions++;
    }
    if ([request.status, request.stage, request.jobId, request.taskId].join(':') !== prior) advanced++;
  }
  const statuses = (campaign.creativeRequests || []).map(item => item.status);
  if (statuses.length && statuses.every(status => status === 'complete')) campaign.status = 'prepared';
  else if (statuses.some(status => status === 'in_progress')) campaign.status = 'creative_generation';
  else if ((campaign.creativeRequests || []).some(item => item.blockReason || item.status === 'failed')) campaign.status = 'creative_attention';
  if (advanced) campaign.updatedAt = new Date().toISOString();
  const blocked = requests.find(item => item.blockReason);
  const failedRead = requests.some(item => item.lastPollError);
  const providerFailed = requests.some(item => item.failureConfirmed && item.status === 'failed');
  return { campaign, advanced, effects: summarizeCreativeEffects(effects),
    reason: failedRead ? 'CREATIVE_STATUS_READ_FAILED' : providerFailed ? 'CREATIVE_PROVIDER_JOB_FAILED' : blocked?.blockReason || null };
}

export async function listCanvaBrandTemplates(env = process.env, continuation = '') {
  if (!env.CANVA_ACCESS_TOKEN) throw providerError('canva', 'Sign into Canva first.', 'CANVA_AUTH_REQUIRED', 409);
  const url = new URL(`${CANVA_BASE}/brand-templates`);
  url.searchParams.set('dataset', 'non_empty');
  if (continuation) url.searchParams.set('continuation', String(continuation).slice(0, 2000));
  const payload = await jsonRequest(url.toString(), { headers: canvaHeaders(env) }, { provider: 'canva' });
  return { items: (payload.items || []).map(item => ({ id: item.id, title: item.title || item.name || item.id })), continuation: payload.continuation || null };
}
