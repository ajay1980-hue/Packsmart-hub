import { claimAutomation, detectExceptions, detectOpportunities, dueRules, ensureControl, finishAutomation } from './control.mjs';
import { addAudit } from './events.mjs';
import { deriveOperations, ebayComparisonAvailable } from './operations.mjs';
import { automaticConnectionAreas, beginConnectionSync, finishConnectionSync, connectionSettings, connectionDue, pendingConnectionReadExhausted, CONNECTORS, isShopifyOrderSourceFailure, shopifyOrderReadBinding, isShopifyOrderReadBindingCurrent, isShopifyOrderReadAdmissionCurrent, shopifyOrderReadHold, shopifyOrderReadBudgetExhausted, shopifyOrderReadPolicyBlocked, orderReadHeld } from './connection-centre.mjs';
import { marketingCreativeCycle, marketingPlannerCycle } from './marketing.mjs';
import { runConnectionDoctor } from './connection-doctor.mjs';
import { runWebIntelligence } from './web-intelligence.mjs';
import { assertEbayReadAdmission, ebayErrorCooldown, ebayReadCooldown, ebayReadDeferred, mergeEbayReadCooldown } from './ebay-read-cooldown.mjs';

const authFailure = error => /AUTH|CREDENTIAL|TOKEN_EXPIRED|REFRESH_FAILED/.test(String(error?.code || error || ''));
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(String(error?.code || '')) ? error.code : 'READ_FAILED';
const providerEffectRule = ruleId => ['marketingCreativeWorker', 'marketRadar'].includes(ruleId);
const creativeCountKeys = ['providerReads', 'submissionAttempts', 'confirmedSubmissions', 'uncertainSubmissions', 'blockedSubmissions'];

// Copy only the worker's safe effect contract. Missing completion evidence is
// unknown, including after interruption; a zero-spend claim is not evidence.
function copyCreativeEffects(value) {
  const source = value && typeof value === 'object' ? value : {};
  const validCounts = creativeCountKeys.every(key => Number.isSafeInteger(source[key]) && source[key] >= 0);
  const effects = Object.fromEntries(creativeCountKeys.map(key => [key, Number.isSafeInteger(source[key]) && source[key] >= 0 ? source[key] : 0]));
  effects.historicalExposureUnknown = source.historicalExposureUnknown !== false;
  effects.externalWrites = effects.confirmedSubmissions > 0 ? true
    : effects.submissionAttempts > 0 || effects.uncertainSubmissions > 0 || source.externalWrites !== false || !validCounts ? null : false;
  const noCost = validCounts && source.externalWrites === false && source.costStatus === 'not_incurred' && source.spend === 0 && !effects.historicalExposureUnknown
    && effects.submissionAttempts === 0 && effects.confirmedSubmissions === 0 && effects.uncertainSubmissions === 0;
  effects.spend = noCost ? 0 : null;
  effects.costStatus = noCost ? 'not_incurred' : 'unknown';
  return effects;
}

function recordCreativeEffects(run, value) {
  run.effects = copyCreativeEffects(value);
  Object.assign(run, { spend: run.effects.spend, externalWrites: run.effects.externalWrites, costStatus: run.effects.costStatus });
  return run.effects;
}

function summarizeCycleEffects(runs) {
  const creative = runs.filter(run => providerEffectRule(run.ruleId));
  // Firecrawl scrape is a chargeable provider POST, not a free read-only job.
  // Other read-only automation cycles retain their existing response contract.
  if (!creative.length) return { spend: 0, externalWrites: false };
  const effects = Object.fromEntries(creativeCountKeys.map(key => [key, creative.reduce((total, run) => total + run.effects[key], 0)]));
  effects.historicalExposureUnknown = creative.some(run => run.effects.historicalExposureUnknown);
  effects.externalWrites = creative.some(run => run.externalWrites === true) ? true : creative.some(run => run.externalWrites === null) ? null : false;
  effects.costStatus = creative.some(run => run.costStatus === 'unknown') ? 'unknown' : 'not_incurred';
  effects.spend = effects.costStatus === 'unknown' ? null : creative.reduce((total, run) => total + run.spend, 0);
  return { spend: effects.spend, externalWrites: effects.externalWrites, costStatus: effects.costStatus, effects };
}

export async function monitoredSync(state, integrations, provider, { automatic = false, retry = true, areas, run } = {}) {
  const automaticEbay = provider === 'ebay' && (automatic || run?.automatic);
  assertEbayReadAdmission(state, provider, { automatic: automaticEbay });
  const previous = state.integrationStatus?.[provider] || {};
  const previousOrderHold = shopifyOrderReadHold(state, provider, integrations);
  const orderBinding = provider === 'shopify' ? shopifyOrderReadBinding(state, integrations) : null;
  const now = new Date().toISOString();
  if (automatic && orderReadHeld(state, provider, run?.areas || areas || connectionSettings(state, provider).areas, integrations)) throw Object.assign(new Error('Shopify order source needs review. Existing data is retained.'), { code: previousOrderHold.code, status: 422, nonRetryable: true });
  if ((automatic || run?.automatic) && provider === 'shopify' && shopifyOrderReadPolicyBlocked(state, integrations, run?.areas || areas || connectionSettings(state, provider).areas)) throw Object.assign(new Error('Automatic Shopify order reads need review before another attempt.'), { code: 'SHOPIFY_ORDER_RETRY_EXHAUSTED', status: 409, nonRetryable: true });
  if ((automatic || automaticEbay) && authFailure(previous.lastError)) throw Object.assign(new Error('Owner must repair authentication'), { code: 'AUTH_REPAIR_REQUIRED' });
  if (automatic && !connectionSettings(state, provider).autoSync) return previous;
  run ||= beginConnectionSync(state, provider, { automatic, areas, integrations });
  areas = run.areas;
  let attempts = 0;
  while (true) {
    attempts++;
    try {
      assertEbayReadAdmission(state, provider, { automatic: automaticEbay });
      const result = integrations.syncProvider ? await integrations.syncProvider(state, provider, { automatic: automatic || automaticEbay, areas }) : await integrations[provider === 'shopify' ? 'syncShopify' : 'syncEbay'](state, { automatic: automatic || automaticEbay, areas });
      const status = { ...previous, ...result, failedAreas:result.failedAreas || [], transient: Boolean(result.transient), upstreamStatus: result.upstreamStatus || null, retryAt: null, lastAttemptAt: now, lastFailureAt: result.lastFailureAt || previous.lastFailureAt || null, attempts };
      if (provider === 'ebay') Object.assign(status, mergeEbayReadCooldown([previous, result, ebayReadCooldown(state)]));
      // Only a successful explicit orders read may clear an order-source hold.
      if (provider === 'shopify' && !areas.includes('orders') && previousOrderHold && isShopifyOrderReadBindingCurrent(state, previousOrderHold.binding, integrations)) status.orderReadHold = previousOrderHold;
      state.integrationStatus = { ...state.integrationStatus, [provider]: status };
      finishConnectionSync(state, run, status);
      return status;
    } catch (error) {
      if (provider === 'ebay' && error.cooldownDeferred) throw error;
      const sourceFailure = isShopifyOrderSourceFailure(provider, error.code);
      const nonRetryable = sourceFailure;
      const transient = !nonRetryable && (error.upstreamStatus === 429 || error.upstreamStatus >= 500 || ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name));
      // Rate limits are durable scheduled retries, never a tight retry loop.
      const rateLimited = !nonRetryable && (error.upstreamStatus === 429 || /RATE_LIMIT/.test(error.code || ''));
      const errorCooldown = provider === 'ebay' ? ebayErrorCooldown(error) : null;
      if (retry && attempts < 2 && transient && !rateLimited && !errorCooldown?.retryAt && !errorCooldown?.retryReviewRequired && !authFailure(error)) { await new Promise(resolve => setTimeout(resolve, 300)); continue; }
      const code = safeCode(error);
      const failedBinding = error.orderReadBinding === undefined ? orderBinding : error.orderReadBinding;
      if (sourceFailure && !isShopifyOrderReadAdmissionCurrent(state, failedBinding, integrations)) {
        finishConnectionSync(state, run, null, { code });
        throw Object.assign(new Error('Shopify configuration changed during the failed read; no hold was installed.'), { code, status: 422, nonRetryable: true, holdDisposition: 'configuration_changed' });
      }
      const ebayCooldown = provider === 'ebay' ? mergeEbayReadCooldown([previous, ebayReadCooldown(state), errorCooldown]) : null;
      state.integrationStatus = { ...state.integrationStatus, [provider]: { ...previous, status: authFailure(error) ? 'auth_expired' : 'error',
        detail: 'Read sync failed; last known data was retained.', lastSyncAt: previous.lastSyncAt || null, lastFailureAt: now, lastAttemptAt: now, lastError: code, attempts,
        ...(sourceFailure ? { orderReadHold: { code, at: now, binding: failedBinding }, orderReadAttempt: { status: 'incomplete', code, at: now, retryable: false } } : {}),
        transient: transient || rateLimited, upstreamStatus: error.upstreamStatus || null,
        retryAt: provider === 'ebay' ? ebayCooldown.retryAt : rateLimited ? new Date(Date.now() + Math.max(60000, Math.min(86400000, Number(error.retryAfterMs) || 60000))).toISOString() : null } };
      if (provider === 'ebay') Object.assign(state.integrationStatus.ebay, ebayCooldown);
      const connection = provider === 'shopify' ? integrations.shopifyConnection?.(state) : provider === 'ebay' ? integrations.ebayConnection?.(state) : state.connections?.find(c => c.provider === provider);
      if (connection) { connection.status = state.integrationStatus[provider].status; connection.lastError = code; }
      finishConnectionSync(state, run, null, { code });
      throw Object.assign(new Error('Read sync failed'), { code, upstreamStatus: error.upstreamStatus, retryAfterMs: error.retryAfterMs, name: error.name, ...(provider === 'ebay' ? ebayReadCooldown(state) : {}), ...(sourceFailure ? { status: 422, orderReadBinding: failedBinding } : {}), ...(nonRetryable ? { nonRetryable: true } : {}) });
    }
  }
}

export function createScheduler({ store, integrations, withWorkspaceLock, currentBrief, env = process.env, enabled = true, intervalMs = 60000, creativeCycle = marketingCreativeCycle, webCycle = runWebIntelligence }) {
  let timer = null, running = false, stopped = false;
  const status = { lastTickAt: null, lastError: null, running: false };

  async function runWorkspace(workspaceId, { manual = false, now = new Date() } = {}) {
    return withWorkspaceLock(workspaceId, async () => {
      const state = await (store.getForScheduler ? store.getForScheduler(workspaceId) : store.get(workspaceId));
      if (!state) return { skipped: true, reason: 'WORKSPACE_NOT_FOUND' };
      ensureControl(state);
      await runConnectionDoctor(state, { integrations, readSync: monitoredSync, save: () => store.save(workspaceId, state), now });
      const expired = state.automationRuns.filter(run => run.status === 'IN PROGRESS' && Date.parse(run.leaseUntil) <= now.getTime());
      for (const run of expired) {
        const effects = providerEffectRule(run.ruleId) ? recordCreativeEffects(run, run.effects) : null;
        finishAutomation(state, run, { errorCode: 'WORKER_INTERRUPTED', blocked: true, evidence: [{ type: 'expired_lease', id: run.id, detail: 'No completion evidence before the worker lease expired.', ...(effects ? { effects: { ...effects } } : {}) }] });
      }
      let rules = dueRules(state, now, integrations);
      const providers = [];
      if (rules.some(rule => rule.id === 'channelSync')) {
        for (const provider of Object.keys(CONNECTORS)) {
          const configured = provider === 'shopify' ? integrations.shopifyRefreshAvailable(state) : provider === 'ebay' ? integrations.ebayConfigured(state) : Boolean(integrations.syncProvider && state.connections?.some(item => item.provider === provider && item.encryptedCredentials));
          const legacyFirstRun = !state.connectionSettings?.[provider] && !state.connectionSyncs?.some(item => item.provider === provider);
          const exhaustedOrderBudget = provider === 'shopify' && shopifyOrderReadBudgetExhausted(state, integrations);
          if (configured && !(provider === 'ebay' && ebayReadDeferred(state, now.getTime(), true)) && automaticConnectionAreas(state,provider).length && !pendingConnectionReadExhausted(state, provider, integrations) && !orderReadHeld(state, provider, automaticConnectionAreas(state,provider), integrations) && !exhaustedOrderBudget && (legacyFirstRun || connectionDue(state, provider, now, integrations))) providers.push(provider);
        }
      }
      // A legacy workspace can have no saved per-channel settings. Do not claim
      // and save a recurring no-op cycle solely because held orders are due.
      if (!providers.length && (ebayReadDeferred(state, now.getTime(), true) || Object.keys(CONNECTORS).some(provider => pendingConnectionReadExhausted(state, provider, integrations)) || orderReadHeld(state, 'shopify', undefined, integrations) || !automaticConnectionAreas(state,'shopify').length || shopifyOrderReadBudgetExhausted(state, integrations))) rules = rules.filter(rule => rule.id !== 'channelSync');
      if (!rules.length) {
        if (expired.length) await store.save(workspaceId, state);
        return { skipped: true, reason: state.autopilot.enabled ? 'FREQUENCY_OR_PERMISSION_LIMIT' : 'AUTOPILOT_OFF' };
      }
      const runs = rules.map(rule => claimAutomation(state, rule.id, now, integrations));
      for (const run of runs) if (providerEffectRule(run.ruleId)) recordCreativeEffects(run);
      const syncRuns = new Map(providers.map(provider => [provider, beginConnectionSync(state, provider, { automatic: true, actor: 'autopilot', integrations })]));
      // Commit the claim before any work. PostgREST compare-and-save allows only
      // one replica to acquire this workspace's due runs, including at redeploy.
      await store.save(workspaceId, state);
      for (const run of runs) {
        try {
          let evidence;
          if (run.ruleId === 'channelSync') {
            if (!providers.length) { finishAutomation(state, run, { evidence: [{ type: 'sync_schedule', id: run.id, detail: 'No channel is due; individual sync settings were respected.' }] }); continue; }
            const outcomes = await Promise.allSettled(providers.map(provider => monitoredSync(state, integrations, provider, { automatic: !manual, run: syncRuns.get(provider) })));
            evidence = outcomes.map((result, index) => ({ type: 'integration_read', id: providers[index], detail: result.status === 'fulfilled' ? result.value.status : safeCode(result.reason), at: new Date().toISOString() }));
            const failed = outcomes.find(result => result.status === 'rejected');
            if (failed) { finishAutomation(state, run, { evidence, errorCode: safeCode(failed.reason), blocked: authFailure(failed.reason) }); continue; }
            const partial = outcomes.find(result => result.status === 'fulfilled' && (result.value.lastError || ['degraded', 'error', 'auth_expired'].includes(result.value.status)));
            if (partial) { finishAutomation(state, run, { evidence, errorCode: 'SOURCE_COVERAGE_INCOMPLETE', blocked: true }); continue; }
          } else if (run.ruleId === 'dailyOpsBrief') {
            const brief = currentBrief(state);
            evidence = [{ type: 'daily_brief', id: brief.id, detail: brief.summary }];
          } else if (['seoChecks', 'priceRecommendations'].includes(run.ruleId)) {
            const findings = detectOpportunities(state, 'autopilot');
            evidence = [{ type: 'opportunity_scan', id: run.id, detail: `${findings.detected} evidence-backed opportunities; ${findings.created} new records.` }];
          } else if (run.ruleId === 'channelMismatchAlerts') {
            if (!ebayComparisonAvailable(state.ebay)) throw Object.assign(new Error('Full marketplace coverage unavailable'), { code: 'COVERAGE_UNAVAILABLE' });
            evidence = [{ type: 'channel_comparison', id: 'ebay', detail: JSON.stringify(Object.fromEntries(Object.entries(state.ebay.health).map(([key, value]) => [key, Array.isArray(value) ? value.length : value]))) }];
          } else if (run.ruleId === 'marketingPlanner') {
            const result = marketingPlannerCycle(state, { now, source: 'autopilot' });
            evidence = [{ type: 'marketing_campaign', id: result.campaign?.id || run.id, detail: result.created ? `Prepared campaign for ${result.campaign.product.title}; publishing remains approval-gated.` : result.reason }];
          } else if (run.ruleId === 'marketingCreativeWorker') {
            const result = await creativeCycle(state, { env, persist: () => store.save(workspaceId, state), durableStore: store.provider === 'supabase' });
            const effects = recordCreativeEffects(run, result.effects);
            const reason = !result.effects ? 'CREATIVE_EFFECTS_UNAVAILABLE' : result.reason ? safeCode({ code: result.reason }) : null;
            run.reason = reason;
            evidence = [{ type: 'marketing_creative', id: result.campaign?.id || run.id,
              detail: `${effects.providerReads} provider reads; ${effects.submissionAttempts} submission attempts; ${effects.confirmedSubmissions} confirmed; ${effects.uncertainSubmissions} uncertain; ${effects.blockedSubmissions} blocked.${reason ? ` ${reason}.` : ''}`,
              reason, effects: { ...effects } }];
            if (reason === 'CREATIVE_STATUS_READ_FAILED' || reason === 'CREATIVE_PROVIDER_JOB_FAILED') {
              finishAutomation(state, run, { evidence, errorCode: reason });
              continue;
            }
            if (effects.blockedSubmissions > 0 || effects.uncertainSubmissions > 0 || reason === 'CREATIVE_ALLOWANCE_REQUIRED' || reason === 'CREATIVE_EFFECTS_UNAVAILABLE' || reason === 'CREATIVE_PROVIDER_NOT_AVAILABLE') {
              finishAutomation(state, run, { evidence, errorCode: reason || (effects.uncertainSubmissions > 0 ? 'CREATIVE_OUTCOME_UNKNOWN' : 'CREATIVE_SUBMISSION_BLOCKED'), blocked: true });
              continue;
            }
          } else if (run.ruleId === 'marketRadar') {
            const result = await webCycle(state, { env, actor: 'autopilot' });
            const effects = recordCreativeEffects(run, result.effects);
            const reason = !result.effects ? 'WEB_SCAN_EFFECTS_UNAVAILABLE' : result.reason ? safeCode({ code: result.reason }) : null;
            run.reason = reason;
            evidence = [{ type: 'web_intelligence', id: run.id,
              detail: `${result.scanned || 0} verified scans; ${effects.submissionAttempts} provider submission attempts; ${effects.blockedSubmissions} blocked.${reason ? ` ${reason}.` : ''}`,
              reason, effects: { ...effects } }];
            if (effects.blockedSubmissions > 0 || effects.uncertainSubmissions > 0
              || reason === 'WEB_SCAN_ALLOWANCE_REQUIRED' || reason === 'WEB_SCAN_EFFECTS_UNAVAILABLE') {
              finishAutomation(state, run, { evidence, errorCode: reason || 'WEB_SCAN_BLOCKED', blocked: true });
              continue;
            }
            if (result.failed > 0 || reason === 'WEB_SCAN_RESPONSE_UNVERIFIED' || reason === 'WEB_SCAN_SOURCE_UNVERIFIED') {
              finishAutomation(state, run, { evidence, errorCode: reason || 'WEB_SCAN_FAILED' });
              continue;
            }
          } else {
            const d = deriveOperations(state);
            if (!d.products && !d.orders30d) throw Object.assign(new Error('No recorded business data'), { code: 'NO_RECORDED_DATA' });
            const findings = detectExceptions(state, 'autopilot');
            evidence = [{ type: 'business_monitor', id: run.ruleId, detail: `${d.variants} variants and ${d.orders30d} recent orders checked; ${findings.detected} active conditions.` }];
          }
          finishAutomation(state, run, { evidence });
        } catch (error) {
          const effects = providerEffectRule(run.ruleId) ? recordCreativeEffects(run, run.ruleId === 'marketRadar' ? error.webEffects : error.creativeEffects) : null;
          finishAutomation(state, run, { errorCode: safeCode(error), blocked: authFailure(error) || /UNAVAILABLE|NO_/.test(safeCode(error)) || Boolean(effects?.blockedSubmissions), evidence: [{ type: 'monitor_failure', id: run.id, detail: safeCode(error), ...(effects ? { effects: { ...effects } } : {}) }] });
        }
      }
      detectExceptions(state, 'autopilot');
      state.autopilot.lastRunAt = new Date().toISOString();
      const effects = summarizeCycleEffects(runs);
      addAudit(state, { type: 'autopilot_cycle_finished', actor: 'autopilot', detail: { runIds: runs.map(run => run.id), ...effects } });
      await store.save(workspaceId, state);
      return { skipped: false, runs, ...effects };
    });
  }

  async function tick() {
    if (running || stopped) return;
    running = true; status.running = true;
    try {
      status.lastError = null;
      const ids = await store.listWorkspaceIds();
      for (const id of ids) {
        if (stopped) break;
        try { await runWorkspace(id); }
        catch (error) {
          if (error.code !== 'STATE_CONFLICT') {
            status.lastError = safeCode(error);
            console.error(JSON.stringify({ event: 'autopilot_workspace_failed', workspaceId: id, code: safeCode(error), table: error.table || null, httpStatus: error.httpStatus || null, databaseCode: error.databaseCode || null, payloadBytes: error.payloadBytes || null }));
          }
        }
      }
      status.lastTickAt = new Date().toISOString();
    } catch (error) { status.lastError = safeCode(error); }
    finally { running = false; status.running = false; }
  }
  function start() { if (!enabled || timer) return; stopped = false; timer = setInterval(() => { void tick(); }, intervalMs); timer.unref(); void tick(); }
  function stop() { stopped = true; clearInterval(timer); timer = null; }
  return { runWorkspace, tick, start, stop, status };
}
