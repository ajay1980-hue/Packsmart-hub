const CANVA_BASE = 'https://api.canva.com/rest/v1';
const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1';
const RUNWAY_VERSION = '2024-11-06';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = (value, max = 1200) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

function providerError(provider, message, code = 'PROVIDER_REQUEST_FAILED', status = 502) {
  return Object.assign(new Error(message), { provider, code, status });
}

async function jsonRequest(url, options = {}, { provider, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const detail = clean(payload?.message || payload?.error?.message || payload?.error || response.statusText, 400);
      throw providerError(provider, detail || `${provider} request failed`, `${provider.toUpperCase()}_HTTP_${response.status}`, response.status >= 500 ? 502 : 422);
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

async function fetchProductImage(url, env) {
  if (!allowedImageHost(url, env)) throw providerError('canva', 'Product image host is not approved for server-side creative generation.', 'MARKETING_IMAGE_HOST_BLOCKED', 422);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
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

export async function startCanvaCreative(campaign, env = process.env) {
  if (!env.CANVA_ACCESS_TOKEN || !env.CANVA_BRAND_TEMPLATE_ID) throw providerError('canva', 'Canva API credentials or brand template are not configured.', 'CANVA_NOT_CONFIGURED', 409);
  if (!campaign.product?.image) throw providerError('canva', 'Campaign has no product image.', 'CANVA_PRODUCT_IMAGE_REQUIRED', 422);
  const image = await fetchProductImage(campaign.product.image, env);
  const metadata = Buffer.from(clean(`${campaign.product.sku || 'product'}-${campaign.product.title || 'creative'}`, 50)).toString('base64');
  const upload = await jsonRequest(`${CANVA_BASE}/asset-uploads`, {
    method: 'POST',
    headers: canvaHeaders(env, {
      'Content-Type': 'application/octet-stream',
      'Asset-Upload-Metadata': JSON.stringify({ name_base64: metadata })
    }),
    body: image.bytes
  }, { provider: 'canva', timeoutMs: 25000 });
  return { provider: 'canva', kind: 'social_post', status: 'in_progress', stage: 'asset_upload', jobId: upload.job?.id || null, startedAt: new Date().toISOString(), formats: ['instagram_post', 'facebook_post', 'pinterest_pin', 'youtube_thumbnail'] };
}

export async function refreshCanvaCreative(campaign, request, env = process.env) {
  if (!request?.jobId) throw providerError('canva', 'Canva creative job is missing its job id.', 'CANVA_JOB_INVALID', 409);
  if (request.stage === 'asset_upload') {
    const payload = await jsonRequest(`${CANVA_BASE}/asset-uploads/${encodeURIComponent(request.jobId)}`, { headers: canvaHeaders(env) }, { provider: 'canva' });
    if (payload.job?.status === 'failed') throw providerError('canva', payload.job?.error?.message || 'Canva image upload failed.', 'CANVA_ASSET_UPLOAD_FAILED', 422);
    if (payload.job?.status !== 'success') return request;
    const assetId = payload.job?.asset?.id;
    if (!assetId) throw providerError('canva', 'Canva did not return an uploaded asset id.', 'CANVA_ASSET_ID_MISSING', 502);
    const datasetPayload = await jsonRequest(`${CANVA_BASE}/brand-templates/${encodeURIComponent(env.CANVA_BRAND_TEMPLATE_ID)}/dataset`, { headers: canvaHeaders(env) }, { provider: 'canva' });
    const data = canvaFieldMap(datasetPayload.dataset || {}, campaign, assetId);
    if (!Object.keys(data).length) throw providerError('canva', 'The Canva brand template has no matching autofill fields. Tag fields such as headline, caption, cta, price and product_image.', 'CANVA_TEMPLATE_FIELDS_REQUIRED', 422);
    const autofill = await jsonRequest(`${CANVA_BASE}/autofills`, {
      method: 'POST',
      headers: canvaHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ type: 'create_from_brand_template', brand_template_id: env.CANVA_BRAND_TEMPLATE_ID, title: `Packsmart - ${clean(campaign.product?.title, 120)}`, data })
    }, { provider: 'canva' });
    return { ...request, stage: 'autofill', jobId: autofill.job?.id, assetId, updatedAt: new Date().toISOString() };
  }
  if (request.stage === 'autofill') {
    const payload = await jsonRequest(`${CANVA_BASE}/autofills/${encodeURIComponent(request.jobId)}`, { headers: canvaHeaders(env) }, { provider: 'canva' });
    if (payload.job?.status === 'failed') throw providerError('canva', payload.job?.error?.message || 'Canva autofill failed.', 'CANVA_AUTOFILL_FAILED', 422);
    if (payload.job?.status !== 'success') return request;
    const result = payload.job?.result || {};
    const designId = designIdFromResult(result);
    if (!designId) return { ...request, status: 'complete', stage: 'complete', designUrl: result.design?.url || null, updatedAt: new Date().toISOString() };
    const exported = await jsonRequest(`${CANVA_BASE}/exports`, {
      method: 'POST',
      headers: canvaHeaders(env, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ design_id: designId, format: { type: 'png', export_quality: 'pro', lossless: true } })
    }, { provider: 'canva' });
    return { ...request, stage: 'export', jobId: exported.job?.id, designId, designUrl: result.design?.url || null, updatedAt: new Date().toISOString() };
  }
  if (request.stage === 'export') {
    const payload = await jsonRequest(`${CANVA_BASE}/exports/${encodeURIComponent(request.jobId)}`, { headers: canvaHeaders(env) }, { provider: 'canva' });
    if (payload.job?.status === 'failed') throw providerError('canva', payload.job?.error?.message || 'Canva export failed.', 'CANVA_EXPORT_FAILED', 422);
    if (payload.job?.status !== 'success') return request;
    return { ...request, status: 'complete', stage: 'complete', assetUrls: payload.job?.urls || [], completedAt: new Date().toISOString() };
  }
  return request;
}

export async function startRunwayCreative(campaign, env = process.env) {
  if (!env.RUNWAY_API_KEY) throw providerError('runway', 'Runway developer API key is not configured.', 'RUNWAY_NOT_CONFIGURED', 409);
  if (!campaign.product?.image) throw providerError('runway', 'Campaign has no product image.', 'RUNWAY_PRODUCT_IMAGE_REQUIRED', 422);
  const prompt = clean(`${campaign.copy?.videoHook || campaign.copy?.headline || campaign.product.title} Premium practical ecommerce packaging advert for Packsmart Solutions. Show the exact referenced product clearly, clean warehouse and dispatch context, confident business tone, crisp lighting, no invented product claims, no price overlays unless supplied.`, 2000);
  const payload = await jsonRequest(`${RUNWAY_BASE}/recipes/product_ad`, {
    method: 'POST',
    headers: runwayHeaders(env),
    body: JSON.stringify({
      version: '2026-07',
      productImages: [{ uri: campaign.product.image }],
      productInfo: clean(`${campaign.product.title}; SKU ${campaign.product.sku || 'unknown'}`, 500),
      userConcept: prompt,
      duration: 10
    })
  }, { provider: 'runway', timeoutMs: 30000 });
  const taskId = payload.id || payload.task?.id;
  if (!taskId) throw providerError('runway', 'Runway did not return a generation task id.', 'RUNWAY_TASK_ID_MISSING', 502);
  return { provider: 'runway', kind: 'product_video', status: 'in_progress', stage: 'generation', taskId, startedAt: new Date().toISOString(), formats: ['vertical_video', 'landscape_video'] };
}

export async function refreshRunwayCreative(campaign, request, env = process.env) {
  if (!request?.taskId) throw providerError('runway', 'Runway creative task is missing its task id.', 'RUNWAY_TASK_INVALID', 409);
  const payload = await jsonRequest(`${RUNWAY_BASE}/tasks/${encodeURIComponent(request.taskId)}`, { headers: runwayHeaders(env) }, { provider: 'runway' });
  const status = String(payload.status || '').toUpperCase();
  if (['FAILED', 'CANCELED', 'CANCELLED'].includes(status)) throw providerError('runway', clean(payload.failure || payload.failureCode || payload.error || 'Runway video generation failed.', 500), 'RUNWAY_GENERATION_FAILED', 422);
  if (status !== 'SUCCEEDED') return { ...request, progress: payload.progress ?? request.progress, updatedAt: new Date().toISOString() };
  const output = Array.isArray(payload.output) ? payload.output : payload.output ? [payload.output] : [];
  return { ...request, status: 'complete', stage: 'complete', assetUrls: output.filter(Boolean), completedAt: new Date().toISOString() };
}

export async function advanceCampaignCreatives(campaign, env = process.env) {
  const next = [];
  for (const request of campaign.creativeRequests || []) {
    try {
      if (request.provider === 'canva') {
        if (request.status === 'pending') next.push(await startCanvaCreative(campaign, env));
        else if (request.status === 'in_progress') next.push(await refreshCanvaCreative(campaign, request, env));
        else next.push(request);
      } else if (request.provider === 'runway') {
        if (request.status === 'pending') next.push(await startRunwayCreative(campaign, env));
        else if (request.status === 'in_progress') next.push(await refreshRunwayCreative(campaign, request, env));
        else next.push(request);
      } else next.push(request);
    } catch (error) {
      next.push({ ...request, status: 'failed', errorCode: error.code || 'PROVIDER_REQUEST_FAILED', error: clean(error.message, 500), failedAt: new Date().toISOString() });
    }
  }
  campaign.creativeRequests = next;
  const statuses = next.map(item => item.status);
  if (statuses.length && statuses.every(status => status === 'complete')) campaign.status = 'prepared';
  else if (statuses.some(status => status === 'in_progress')) campaign.status = 'creative_generation';
  else if (statuses.some(status => status === 'failed') && !statuses.some(status => status === 'in_progress')) campaign.status = 'creative_attention';
  campaign.updatedAt = new Date().toISOString();
  return campaign;
}
