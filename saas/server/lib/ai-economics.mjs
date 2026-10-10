import crypto from 'node:crypto';

export const AI_PRICING_UPDATED_AT = '2026-09-27';
export const AI_MODEL_CATALOG = Object.freeze({
  deterministic: { provider:'runvara', model:'deterministic', inputPerMillionUsd:0, cachedInputPerMillionUsd:0, outputPerMillionUsd:0, tier:'deterministic' },
  'gpt-5.6-luna': { provider:'openai', model:'gpt-5.6-luna', inputPerMillionUsd:0.20, cachedInputPerMillionUsd:0.02, cacheWritePerMillionUsd:0.25, outputPerMillionUsd:1.20, tier:'economy' },
  'gpt-5.6-terra': { provider:'openai', model:'gpt-5.6-terra', inputPerMillionUsd:2.00, cachedInputPerMillionUsd:0.20, cacheWritePerMillionUsd:2.50, outputPerMillionUsd:12.00, tier:'balanced' },
  'gpt-5.6-sol': { provider:'openai', model:'gpt-5.6-sol', inputPerMillionUsd:4.00, cachedInputPerMillionUsd:0.40, cacheWritePerMillionUsd:5.00, outputPerMillionUsd:20.00, tier:'quality' }
});

const planCeiling = plan => plan === 'starter' ? 'economy' : plan === 'growth' ? 'balanced' : 'quality';
const tierRank = { deterministic:0, economy:1, balanced:2, quality:3 };
const safeNumber = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export function ensureAiEconomics(state) {
  state.aiEconomics = {
    routingMode:'balanced',
    monthlyCostLimitUsd:null,
    pricingUpdatedAt:AI_PRICING_UPDATED_AT,
    ...state.aiEconomics
  };
  if (!['economy','balanced','quality'].includes(state.aiEconomics.routingMode)) state.aiEconomics.routingMode='balanced';
  const limit = state.aiEconomics.monthlyCostLimitUsd;
  state.aiEconomics.monthlyCostLimitUsd = limit === null || limit === '' || limit === undefined ? null : Math.max(0, Math.min(1000000, Number(limit)||0));
  return state.aiEconomics;
}

// Browser responses are a separate contract from lossless server configuration.
// Never spread settings here: governance and future fields remain server-only.
export function publicAiSettings(settings) {
  const read = key => settings && typeof settings === 'object' && !Array.isArray(settings)
    ? Object.getOwnPropertyDescriptor(settings, key)?.value : undefined;
  const routingMode = read('routingMode'), monthlyCostLimitUsd = read('monthlyCostLimitUsd');
  const pricingUpdatedAt = read('pricingUpdatedAt'), updatedAt = read('updatedAt'), updatedBy = read('updatedBy');
  const validDate = typeof pricingUpdatedAt === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(pricingUpdatedAt)
    && Number.isFinite(Date.parse(pricingUpdatedAt)) && new Date(pricingUpdatedAt).toISOString().slice(0, 10) === pricingUpdatedAt;
  const result = {
    routingMode: ['economy', 'balanced', 'quality'].includes(routingMode) ? routingMode : 'balanced',
    monthlyCostLimitUsd: Number.isFinite(monthlyCostLimitUsd) && monthlyCostLimitUsd >= 0 && monthlyCostLimitUsd <= 1000000 ? monthlyCostLimitUsd : null,
    pricingUpdatedAt: validDate ? pricingUpdatedAt : AI_PRICING_UPDATED_AT
  };
  // Match the existing writers' UTC timestamp and 120-character actor bound.
  const validTimestamp = typeof updatedAt === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/.test(updatedAt)
    && Number.isFinite(Date.parse(updatedAt)) && new Date(updatedAt).toISOString() === (updatedAt.includes('.') ? updatedAt : updatedAt.replace('Z', '.000Z'));
  if (updatedAt === null || validTimestamp) result.updatedAt = updatedAt;
  if (updatedBy === null || typeof updatedBy === 'string' && updatedBy.length <= 120 && updatedBy.trim()
    && !/[\u0000-\u001f\u007f]/.test(updatedBy)) result.updatedBy = updatedBy;
  return result;
}

export function configureAiEconomics(state, input, actor='system') {
  const settings=ensureAiEconomics(state);
  if (input.routingMode !== undefined) {
    if (!['economy','balanced','quality'].includes(input.routingMode)) throw Object.assign(new Error('Routing mode must be economy, balanced or quality'),{status:400,code:'AI_ROUTING_MODE_INVALID'});
    settings.routingMode=input.routingMode;
  }
  if (input.monthlyCostLimitUsd !== undefined) {
    if (input.monthlyCostLimitUsd === null || input.monthlyCostLimitUsd === '') settings.monthlyCostLimitUsd=null;
    else {
      const n=Number(input.monthlyCostLimitUsd);
      if (!Number.isFinite(n) || n<0 || n>1000000) throw Object.assign(new Error('Monthly AI cost limit is invalid'),{status:400,code:'AI_COST_LIMIT_INVALID'});
      settings.monthlyCostLimitUsd=Number(n.toFixed(2));
    }
  }
  settings.updatedAt=new Date().toISOString();
  settings.updatedBy=String(actor||'system').slice(0,120);
  return settings;
}

function requestedTier(jobType,payload={}) {
  if (['connection_sync','connection_doctor'].includes(jobType)) return 'deterministic';
  if (jobType === 'marketing_plan') return 'economy';
  const command=String(payload.command||'').toLowerCase();
  if (/full audit|strategy|forecast|complex|deep|everything|business health/.test(command)) return 'quality';
  return 'balanced';
}

function modelForTier(tier) {
  if (tier === 'quality') return AI_MODEL_CATALOG['gpt-5.6-sol'];
  if (tier === 'balanced') return AI_MODEL_CATALOG['gpt-5.6-terra'];
  if (tier === 'economy') return AI_MODEL_CATALOG['gpt-5.6-luna'];
  return AI_MODEL_CATALOG.deterministic;
}

export function routeAiWork(state,{jobType,payload={}}={}) {
  const settings=ensureAiEconomics(state);
  const plan=state?.subscription?.plan||'starter';
  const ceiling=planCeiling(plan);
  let tier=requestedTier(jobType,payload);
  if (tier !== 'deterministic') {
    const mode=settings.routingMode;
    if (mode === 'economy') tier='economy';
    else if (mode === 'quality' && tierRank[tier] < tierRank.quality) tier='quality';
    if (tierRank[tier] > tierRank[ceiling]) tier=ceiling;
  }
  const model=modelForTier(tier);
  return { provider:model.provider, model:model.model, tier:model.tier, pricingUpdatedAt:AI_PRICING_UPDATED_AT, plannedOnly:true };
}

export function estimateAiCostUsd(modelName,usage={}) {
  const model=AI_MODEL_CATALOG[modelName]||AI_MODEL_CATALOG.deterministic;
  const input=safeNumber(usage.inputTokens), cached=Math.min(input,safeNumber(usage.cachedInputTokens));
  const cacheWrite=Math.min(input-cached,safeNumber(usage.cacheWriteTokens)), output=safeNumber(usage.outputTokens);
  const uncached=Math.max(0,input-cached-cacheWrite);
  const longContext=input>272000;
  const inputMultiplier=longContext?2:1, outputMultiplier=longContext?1.5:1;
  return Number((((uncached/1e6)*model.inputPerMillionUsd + (cached/1e6)*model.cachedInputPerMillionUsd + (cacheWrite/1e6)*(model.cacheWritePerMillionUsd||model.inputPerMillionUsd))*inputMultiplier + (output/1e6)*model.outputPerMillionUsd*outputMultiplier).toFixed(8));
}

export function normalizeAiUsage({workspaceId,jobId=null,taskType,provider='openai',model,inputTokens=0,cachedInputTokens=0,cacheWriteTokens=0,outputTokens=0,requestId=null,occurredAt=new Date().toISOString()}) {
  const chosen=AI_MODEL_CATALOG[model];
  if (!chosen || chosen.provider !== provider) throw Object.assign(new Error('Unknown AI model pricing record'),{status:400,code:'AI_MODEL_UNKNOWN'});
  const usage={inputTokens:Math.floor(safeNumber(inputTokens)),cachedInputTokens:Math.floor(safeNumber(cachedInputTokens)),cacheWriteTokens:Math.floor(safeNumber(cacheWriteTokens)),outputTokens:Math.floor(safeNumber(outputTokens))};
  if (usage.cachedInputTokens + usage.cacheWriteTokens > usage.inputTokens) throw Object.assign(new Error('Cached and cache-write input cannot exceed input tokens'),{status:400,code:'AI_USAGE_INVALID'});
  return {
    id:`ai_usage_${crypto.randomUUID()}`, workspaceId, jobId, taskType:String(taskType||'unknown').slice(0,80),
    provider, model, ...usage, estimatedCostUsd:estimateAiCostUsd(model,usage),
    requestId:requestId ? String(requestId).slice(0,180) : null, occurredAt
  };
}

export function publicModelCatalog() {
  return Object.values(AI_MODEL_CATALOG).map(item=>({...item,pricingUpdatedAt:AI_PRICING_UPDATED_AT}));
}

export function planMonthlyValueGbp(state) {
  if (state?.workspace?.id === 'packsmart-solutions' || state?.subscription?.plan === 'customer-zero') return { amount:0, source:'internal' };
  const explicit=Number(state?.subscription?.monthlyAmountGbp);
  if (Number.isFinite(explicit) && explicit >= 0) return { amount:Number(explicit.toFixed(2)), source:'billing' };
  const listed={starter:29,growth:79,pro:149}[state?.subscription?.plan];
  return { amount:Number(listed||0), source:listed?'indicative_list_price':'unknown' };
}
