import crypto from 'node:crypto';
import { AI_MODEL_CATALOG } from './ai-economics.mjs';
import { OPERATOR_BRIEF_ADAPTER, OPERATOR_BRIEF_SHAPE, OPERATOR_BRIEF_ENDPOINT,
  briefDigest, briefSafeCode, briefUsageReceipt, briefExecutionAllowed, operatorBriefPolicy, validBriefJob } from './operator-brief-policy.mjs';

const truthy = value => ['1','true','yes','on'].includes(String(value || '').toLowerCase());
const safeText = (value, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const DENIALS = new Set(['AI_LOGICAL_CALL_EXISTS', 'AI_JOB_LEASE_INVALID', 'AI_ROUTE_EXPIRED',
  'AI_GOVERNANCE_NOT_CONFIGURED', 'AI_ACCOUNTING_BASELINE_UNVERIFIED', 'AI_PROVIDER_NOT_ALLOWED',
  'AI_PROVIDER_OVERRUN_BLOCKED', 'AI_POLICY_LIMIT_INVALID', 'AI_PRICING_UNVERIFIED', 'AI_PRICING_EXPIRED',
  'AI_COST_BOUND_INVALID', 'AI_BUDGET_EXCEEDED', 'AI_ADMISSION_EVIDENCE_EXPIRED', 'AI_ADMISSION_WINDOW_CHANGED']);
const exactCost = value => Number.isSafeInteger(value) && value >= 0
  || typeof value === 'string' && /^(?:0|[1-9][0-9]{0,59})$/.test(value);
const effects = () => ({ submissionAttempts: 0, confirmedSubmissions: 0, uncertainSubmissions: 0,
  reservationId: null, usageStatus: 'uncertain', costStatus: 'unknown', accountedCostMicros: null, currency: 'USD' });

function outputText(body) {
  if (typeof body?.output_text === 'string') return safeText(body.output_text, 2500);
  if (!Array.isArray(body?.output)) return '';
  return safeText(body.output.slice(0, 20).flatMap(item => Array.isArray(item?.content) ? item.content.slice(0, 20) : [])
    .filter(item => item?.type === 'output_text' && typeof item.text === 'string')
    .map(item => safeText(item.text, 2500)).filter(Boolean).join('\n'), 2500);
}

function requestBody(workspaceId, route, command, run, outputTokens) {
  // Preserve bounded deterministic findings, with their existing currency.
  // Never add full datasets, customer identities or arbitrary nested payloads.
  const deterministic = {
    summary: safeText(run?.summary, 5000),
    priorities: (Array.isArray(run?.priorities) ? run.priorities : []).slice(0, 8)
      .map(item => ({ agentId: safeText(item?.agentId, 80), action: safeText(item?.action, 1000) })),
    urgentRisks: (Array.isArray(run?.urgentRisks) ? run.urgentRisks : []).slice(0, 8)
      .map(item => ({ code: safeText(item?.code, 80), severity: safeText(item?.severity, 30),
        affected: typeof item?.affected === 'number' && Number.isFinite(item.affected) ? item.affected : null })),
    workStatus: safeText(run?.workStatus, 80) || 'COMPLETED'
  };
  const input = ['User request: ' + safeText(command, 1000), 'Verified deterministic Runvara findings:', JSON.stringify(deterministic),
    'Write a concise operator brief using only these findings. Do not invent metrics, actions, external results, or approvals. Do not claim an action was executed. Keep the final brief under 180 words.'].join('\n');
  return JSON.stringify({ model: route.model,
    instructions: 'You are Runvara Operator Brief. Summarise only supplied verified findings. You are read-only and must never claim to perform external actions.',
    input, max_output_tokens: outputTokens, reasoning: { effort: route.tier === 'quality' ? 'medium' : 'low' }, store: false,
    safety_identifier: crypto.createHash('sha256').update(workspaceId).digest('hex').slice(0, 32), prompt_cache_key: 'runvara-operator-brief-v1' });
}

async function responseJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('Missing provider response');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 262144) { await reader.cancel(); throw new Error('Provider response exceeds bound'); }
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

export function createAiProvider({ env = process.env, store, fetchImpl = fetch, now = Date.now } = {}) {
  const configuration = () => {
    const apiKey = String(env.OPENAI_API_KEY || '').trim();
    return { apiKey, enabled: truthy(env.RUNVARA_OPENAI_ENABLED) && apiKey.length >= 20,
      endpoint: String(env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '') + '/responses',
      outputTokens: env.RUNVARA_AI_MAX_OUTPUT_TOKENS === undefined ? 500 : Number(env.RUNVARA_AI_MAX_OUTPUT_TOKENS) };
  };
  async function monthlyUsage(workspaceId, time = new Date()) {
    return store.aiUsageSummary(workspaceId, new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), 1)).toISOString(),
      new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth() + 1, 1)).toISOString());
  }

  async function enhanceCommander({ workspaceId, jobId, jobContext, route: proposedRoute, command, run, state }) {
    const route = Object.freeze({ provider: proposedRoute?.provider, model: proposedRoute?.model, tier: proposedRoute?.tier });
    const outcome = effects();
    const result = (reason, extra = {}) => ({ used: false, reason, route, effects: { ...outcome }, ...extra });
    const config = configuration();
    if (!config.enabled) return result('PROVIDER_NOT_CONFIGURED');
    if (route?.provider !== 'openai' || !AI_MODEL_CATALOG[route?.model] || AI_MODEL_CATALOG[route.model].provider !== 'openai') return result('ROUTE_NOT_SUPPORTED');
    if (store?.provider !== 'supabase' || typeof store.reserveProviderUsage !== 'function'
      || typeof store.settleProviderUsage !== 'function' || typeof store.getOperatorBriefContext !== 'function') return result('AI_USAGE_DURABLE_STORE_REQUIRED');
    if (!validBriefJob(jobContext, workspaceId, jobId, now())) return result('AI_JOB_LEASE_INVALID');
    if (!briefExecutionAllowed({ agentOpsEnabled: state?.agentOps?.enabled, agentOpsPaused: state?.agentOps?.paused,
      commanderEnabled: state?.agentSettings?.commander?.enabled })) return result('AI_WORKER_POLICY_BLOCKED');
    const job = Object.freeze({ ...jobContext });
    const policy = operatorBriefPolicy({ state, workspaceId, model: route.model, outputTokens: config.outputTokens, endpoint: config.endpoint, now: now() });
    if (!policy.allowed) return result(policy.reason);
    if (Date.parse(job.createdAt) < policy.jobNotBefore) return result('AI_LEGACY_JOB_DISPATCH_UNVERIFIED');
    const deadline = Math.min(policy.validUntil, Date.parse(job.leaseUntil));
    const body = requestBody(workspaceId, route, command, run, config.outputTokens);
    if (Buffer.byteLength(body) > 65536) return result('AI_REQUEST_BYTES_EXCEEDED');
    const accountDigest = briefDigest(config.apiKey);
    const requestFingerprint = briefDigest({ workspaceId, jobId, shape: OPERATOR_BRIEF_SHAPE, provider: 'openai',
      adapterId: OPERATOR_BRIEF_ADAPTER, model: route.model, endpoint: config.endpoint, accountDigest,
      bodyDigest: briefDigest(body), policyFingerprint: policy.fingerprint,
      inputTokenBound: policy.inputTokenBound, outputTokenBound: policy.outputTokenBound });
    const reservationInput = Object.freeze({ jobId, workerId: job.workerId, jobAttempt: job.attempt,
      callKey: `${jobId}:${OPERATOR_BRIEF_SHAPE}`, requestFingerprint, provider: 'openai', adapterId: OPERATOR_BRIEF_ADAPTER,
      model: route.model, inputTokenBound: policy.inputTokenBound, outputTokenBound: policy.outputTokenBound,
      pricingVersion: policy.pricingVersion, routeValidUntil: new Date(deadline).toISOString() });
    let reservation;
    try { reservation = await store.reserveProviderUsage(workspaceId, reservationInput); }
    catch (error) {
      const reason = briefSafeCode(error?.code, 'AI_USAGE_RESERVATION_UNCERTAIN');
      if (!['AI_USAGE_DURABLE_STORE_REQUIRED', 'AI_USAGE_INPUT_INVALID', 'AI_USAGE_MIGRATION_REQUIRED', 'AI_USAGE_NOT_CONFIGURED'].includes(reason)) {
        Object.assign(outcome, { usageStatus: 'uncertain', costStatus: 'unknown', accountedCostMicros: null });
      }
      return result(reason);
    }
    if (reservation?.dispatchAllowed !== true) {
      if (reservation?.dispatchAllowed !== false || !DENIALS.has(reservation.reason)) {
        Object.assign(outcome, { usageStatus: 'uncertain', costStatus: 'unknown', accountedCostMicros: null });
        return result('AI_USAGE_RESPONSE_INVALID');
      }
      if (reservation?.reason === 'AI_LOGICAL_CALL_EXISTS') Object.assign(outcome, {
        reservationId: reservation.reservationId || null, usageStatus: reservation.status || 'uncertain', costStatus: 'unknown', accountedCostMicros: null });
      return result(briefSafeCode(reservation?.reason, 'AI_USAGE_RESPONSE_INVALID'));
    }
    const validAck = typeof reservation.reservationId === 'string' && ID.test(reservation.reservationId)
      && reservation.status === 'held' && reservation.currency === 'USD' && reservation.reservedRequests === 1
      && reservation.reservedInputTokens === policy.inputTokenBound && reservation.reservedOutputTokens === policy.outputTokenBound
      && reservation.reservedTotalTokens === policy.inputTokenBound + policy.outputTokenBound
      && Number.isSafeInteger(reservation.reservedCostMicros) && reservation.reservedCostMicros >= 0
      && typeof reservation.windowStart === 'string' && /^[0-9]{4}-(?:0[1-9]|1[0-2])-01$/.test(reservation.windowStart)
      && reservation.pricingVersion === policy.pricingVersion;
    Object.assign(outcome, { reservationId: validAck ? reservation.reservationId : null, usageStatus: 'held', costStatus: 'unknown', accountedCostMicros: null });
    if (!validAck) return result('AI_USAGE_RESPONSE_INVALID');
    const reservationId = reservation.reservationId;
    // Once admitted, every failure retains the hold. No retry, refund, alternate
    // provider, or new logical key is inferred from an unavailable read/receipt.
    let context;
    try { context = await store.getOperatorBriefContext(workspaceId, jobId); }
    catch { return result('AI_USAGE_CONTEXT_UNAVAILABLE'); }
    const liveJob = context?.job;
    if (!briefExecutionAllowed(context?.executionPolicy)) return result('AI_WORKER_POLICY_BLOCKED');
    if (context?.workspaceId !== workspaceId || !validBriefJob(liveJob, workspaceId, jobId, now())
      || liveJob.workerId !== job.workerId || liveJob.attempt !== job.attempt || liveJob.leaseUntil !== job.leaseUntil
      || liveJob.createdAt !== job.createdAt || Date.parse(liveJob.createdAt) < policy.jobNotBefore
      || liveJob.provider !== 'openai' || liveJob.model !== route.model) return result('AI_JOB_LEASE_INVALID');
    const current = configuration();
    const livePolicy = operatorBriefPolicy({ state: { workspace: { id: context.workspaceId }, aiEconomics: context.aiEconomics },
      workspaceId, model: route.model, outputTokens: current.outputTokens, endpoint: current.endpoint, now: now() });
    if (!current.enabled || !livePolicy.allowed || livePolicy.fingerprint !== policy.fingerprint
      || current.endpoint !== config.endpoint || briefDigest(current.apiKey) !== accountDigest
      || requestBody(workspaceId, route, command, run, current.outputTokens) !== body) return result('AI_ADMISSION_CONTEXT_CHANGED');
    const settleUncertain = async reason => {
      outcome.uncertainSubmissions = 1; outcome.usageStatus = 'uncertain';
      try { await store.settleProviderUsage(workspaceId, { reservationId, requestFingerprint, outcome: 'uncertain', receipt: { jobId, errorCode: reason } }); }
      catch { /* A durable held reservation already preserves the full exposure. */ }
      return result(reason);
    };
    if (!validBriefJob(jobContext, workspaceId, jobId, now())
      || jobContext.workerId !== job.workerId || jobContext.attempt !== job.attempt || jobContext.leaseUntil !== job.leaseUntil
      || jobContext.createdAt !== job.createdAt
      || now() >= deadline) return result('AI_ADMISSION_EVIDENCE_EXPIRED');
    outcome.submissionAttempts = 1;
    let response, responseBody;
    try {
      response = await fetchImpl(config.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
        body, redirect: 'error', signal: AbortSignal.timeout(45000) });
      if (!response.ok || response.redirected !== false || response.url !== OPERATOR_BRIEF_ENDPOINT) return settleUncertain('AI_PROVIDER_RECEIPT_UNVERIFIED');
      responseBody = await responseJson(response);
    } catch { return settleUncertain('AI_PROVIDER_OUTCOME_UNCERTAIN'); }
    const receipt = briefUsageReceipt(responseBody, route.model, policy.cacheWriteMode, jobId);
    if (!receipt) return settleUncertain('AI_PROVIDER_USAGE_UNVERIFIED');
    outcome.confirmedSubmissions = 1;
    let settlement;
    try { settlement = await store.settleProviderUsage(workspaceId, { reservationId, requestFingerprint, outcome: 'complete', receipt }); }
    catch { outcome.usageStatus = 'uncertain'; return result('AI_USAGE_SETTLEMENT_UNCERTAIN'); }
    if (settlement?.reservationId !== reservationId || !['settled', 'overrun'].includes(settlement.status)
      || !exactCost(settlement.accountedCostMicros)) { outcome.usageStatus = 'uncertain'; return result('AI_USAGE_SETTLEMENT_UNCERTAIN'); }
    Object.assign(outcome, { usageStatus: settlement.status, costStatus: 'accounted', accountedCostMicros: settlement.accountedCostMicros });
    const usage = { ...receipt, accountedCostMicros: settlement.accountedCostMicros, currency: 'USD' };
    delete usage.jobId;
    const summary = responseBody.status === 'completed' && !responseBody.error ? outputText(responseBody) : '';
    if (!summary) return result('AI_RESPONSE_TEXT_UNAVAILABLE', { usage });
    return { used: true, route, summary, usage, requestId: receipt.providerRequestId, effects: { ...outcome } };
  }
  return { get enabled() { return configuration().enabled; }, enhanceCommander, monthlyUsage };
}
