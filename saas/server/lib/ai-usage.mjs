import crypto from 'node:crypto';

const PLAN_ALLOWANCES = Object.freeze({
  starter: 500,
  growth: 2500,
  pro: 10000,
  'customer-zero': 100000
});

const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const nowIso = now => (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
const monthKey = now => nowIso(now).slice(0, 7);

function integerEnv(env, key, fallback, { min = 0, max = 100000000 } = {}) {
  const value = Number(env?.[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function safeText(value, max = 160) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function planAllowance(plan, env = process.env) {
  const normalized = safeText(plan || 'starter', 40).toLowerCase();
  const key = `AI_CREDITS_PLAN_${normalized.replace(/[^a-z0-9]+/g, '_').toUpperCase()}`;
  return integerEnv(env, key, PLAN_ALLOWANCES[normalized] ?? PLAN_ALLOWANCES.starter);
}

export function ensureAiUsage(state, env = process.env) {
  const previous = state.aiUsage && typeof state.aiUsage === 'object' ? state.aiUsage : {};
  const ledger = Array.isArray(previous.ledger) ? previous.ledger : [];
  const plan = state.subscription?.plan || 'starter';
  state.aiUsage = {
    currency: 'GBP',
    plan,
    includedCredits: planAllowance(plan, env),
    topUpCredits: Number.isFinite(Number(previous.topUpCredits)) ? Math.max(0, Math.round(Number(previous.topUpCredits))) : 0,
    ledger: ledger.slice(0, 5000),
    updatedAt: previous.updatedAt || null
  };
  return state.aiUsage;
}

export function quoteCreativeCredits(request = {}, env = process.env) {
  const provider = safeText(request.provider, 40).toLowerCase();
  const kind = safeText(request.kind, 80).toLowerCase();
  if (provider === 'canva') {
    return {
      provider,
      operation: kind || 'social_post',
      credits: integerEnv(env, 'AI_CREDITS_CANVA_SOCIAL_POST', 8, { min: 1 }),
      estimatedProviderCostMinor: integerEnv(env, 'AI_PROVIDER_COST_CANVA_SOCIAL_POST_PENCE', 0)
    };
  }
  if (provider === 'runway') {
    return {
      provider,
      operation: kind || 'product_video',
      credits: integerEnv(env, 'AI_CREDITS_RUNWAY_PRODUCT_VIDEO', 60, { min: 1 }),
      estimatedProviderCostMinor: integerEnv(env, 'AI_PROVIDER_COST_RUNWAY_PRODUCT_VIDEO_PENCE', 0)
    };
  }
  return {
    provider: provider || 'unknown',
    operation: kind || 'creative_generation',
    credits: integerEnv(env, 'AI_CREDITS_DEFAULT_CREATIVE', 10, { min: 1 }),
    estimatedProviderCostMinor: 0
  };
}

function cycleEntries(usage, now = new Date()) {
  const cycle = monthKey(now);
  return usage.ledger.filter(entry => String(entry.createdAt || '').slice(0, 7) === cycle);
}

export function aiUsageSnapshot(state, env = process.env, now = new Date()) {
  const usage = ensureAiUsage(state, env);
  const entries = cycleEntries(usage, now);
  const settled = entries.filter(entry => entry.status === 'settled');
  const reserved = entries.filter(entry => entry.status === 'reserved');
  const spentCredits = settled.reduce((sum, entry) => sum + Number(entry.credits || 0), 0);
  const reservedCredits = reserved.reduce((sum, entry) => sum + Number(entry.credits || 0), 0);
  const allowanceCredits = usage.includedCredits + usage.topUpCredits;
  const remainingCredits = Math.max(0, allowanceCredits - spentCredits - reservedCredits);
  const estimatedProviderCostMinor = settled.reduce((sum, entry) => sum + Number(entry.actualProviderCostMinor ?? entry.estimatedProviderCostMinor ?? 0), 0);
  const saleValuePerCreditMinor = integerEnv(env, 'AI_CREDIT_SALE_VALUE_PENCE', 0);
  const recognizedAiRevenueMinor = saleValuePerCreditMinor > 0 ? spentCredits * saleValuePerCreditMinor : null;
  const estimatedGrossMarginMinor = recognizedAiRevenueMinor === null ? null : recognizedAiRevenueMinor - estimatedProviderCostMinor;

  return {
    cycle: monthKey(now),
    currency: usage.currency,
    plan: usage.plan,
    allowanceCredits,
    spentCredits,
    reservedCredits,
    remainingCredits,
    topUpCredits: usage.topUpCredits,
    estimatedProviderCostMinor,
    recognizedAiRevenueMinor,
    estimatedGrossMarginMinor,
    recent: usage.ledger.slice(0, 50)
  };
}

export function reserveAiCredits(state, input = {}, env = process.env, now = new Date()) {
  const usage = ensureAiUsage(state, env);
  const credits = Math.max(1, Math.round(Number(input.credits || 0)));
  const snapshot = aiUsageSnapshot(state, env, now);
  if (snapshot.remainingCredits < credits) {
    throw Object.assign(new Error(`AI credit allowance exceeded. ${snapshot.remainingCredits} credits remain; ${credits} are required.`), {
      status: 409,
      code: 'AI_CREDITS_EXHAUSTED',
      remainingCredits: snapshot.remainingCredits,
      requiredCredits: credits
    });
  }
  const entry = {
    id: id('aiuse'),
    workspaceId: state.workspace?.id || null,
    userId: input.userId || null,
    campaignId: input.campaignId || null,
    requestKey: input.requestKey || null,
    provider: safeText(input.provider, 40),
    operation: safeText(input.operation, 80),
    credits,
    status: 'reserved',
    estimatedProviderCostMinor: Math.max(0, Math.round(Number(input.estimatedProviderCostMinor || 0))),
    actualProviderCostMinor: null,
    providerReference: null,
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {},
    createdAt: nowIso(now),
    settledAt: null,
    releasedAt: null
  };
  usage.ledger.unshift(entry);
  usage.ledger = usage.ledger.slice(0, 5000);
  usage.updatedAt = nowIso(now);
  return entry;
}

function usageEntry(state, entryId, env) {
  const usage = ensureAiUsage(state, env);
  return usage.ledger.find(entry => entry.id === entryId) || null;
}

export function settleAiCredits(state, entryId, input = {}, env = process.env, now = new Date()) {
  const entry = usageEntry(state, entryId, env);
  if (!entry) throw Object.assign(new Error('AI usage reservation not found'), { status: 404, code: 'AI_USAGE_NOT_FOUND' });
  if (entry.status === 'settled') return entry;
  if (entry.status !== 'reserved') throw Object.assign(new Error('AI usage reservation is not active'), { status: 409, code: 'AI_USAGE_NOT_RESERVED' });
  entry.status = 'settled';
  entry.actualProviderCostMinor = input.actualProviderCostMinor === null || input.actualProviderCostMinor === undefined
    ? entry.estimatedProviderCostMinor
    : Math.max(0, Math.round(Number(input.actualProviderCostMinor || 0)));
  entry.providerReference = safeText(input.providerReference, 200) || null;
  entry.settledAt = nowIso(now);
  ensureAiUsage(state, env).updatedAt = entry.settledAt;
  return entry;
}

export function releaseAiCredits(state, entryId, input = {}, env = process.env, now = new Date()) {
  const entry = usageEntry(state, entryId, env);
  if (!entry) return null;
  if (entry.status !== 'reserved') return entry;
  entry.status = 'released';
  entry.releaseReason = safeText(input.reason || 'provider_request_not_started', 200);
  entry.releasedAt = nowIso(now);
  ensureAiUsage(state, env).updatedAt = entry.releasedAt;
  return entry;
}

export function addAiTopUpCredits(state, credits, actor = 'system', env = process.env, now = new Date()) {
  const usage = ensureAiUsage(state, env);
  const amount = Math.round(Number(credits));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) {
    throw Object.assign(new Error('Top-up credits must be a positive whole number'), { status: 400, code: 'VALIDATION_FAILED' });
  }
  usage.topUpCredits += amount;
  usage.updatedAt = nowIso(now);
  usage.ledger.unshift({
    id: id('aitopup'),
    workspaceId: state.workspace?.id || null,
    userId: actor,
    provider: 'runvara',
    operation: 'credit_top_up',
    credits: 0,
    topUpCredits: amount,
    status: 'settled',
    estimatedProviderCostMinor: 0,
    actualProviderCostMinor: 0,
    metadata: {},
    createdAt: usage.updatedAt,
    settledAt: usage.updatedAt
  });
  usage.ledger = usage.ledger.slice(0, 5000);
  return usage;
}
