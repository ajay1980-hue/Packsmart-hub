import { claimAutomation, detectExceptions, detectOpportunities, dueRules, ensureControl, finishAutomation } from './control.mjs';
import { addAudit } from './events.mjs';
import { deriveOperations } from './operations.mjs';

const authFailure = error => /AUTH|CREDENTIAL|TOKEN_EXPIRED|REFRESH_FAILED/.test(String(error?.code || error || ''));
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(String(error?.code || '')) ? error.code : 'READ_FAILED';

export async function monitoredSync(state, integrations, provider, { automatic = false, retry = true } = {}) {
  const previous = state.integrationStatus?.[provider] || {};
  const now = new Date().toISOString();
  if (automatic && authFailure(previous.lastError)) throw Object.assign(new Error('Owner must repair authentication'), { code: 'AUTH_REPAIR_REQUIRED' });
  let attempts = 0;
  while (true) {
    attempts++;
    try {
      const result = await integrations[provider === 'shopify' ? 'syncShopify' : 'syncEbay'](state);
      const status = { ...result, lastAttemptAt: now, lastFailureAt: result.lastFailureAt || previous.lastFailureAt || null, attempts };
      state.integrationStatus = { ...state.integrationStatus, [provider]: status };
      return status;
    } catch (error) {
      const transient = error.upstreamStatus === 429 || error.upstreamStatus >= 500 || ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name);
      if (retry && attempts < 2 && transient && !authFailure(error)) { await new Promise(resolve => setTimeout(resolve, 300)); continue; }
      const code = safeCode(error);
      state.integrationStatus = { ...state.integrationStatus, [provider]: { ...previous, status: authFailure(error) ? 'auth_expired' : 'error',
        detail: 'Read sync failed; last known data was retained.', lastSyncAt: previous.lastSyncAt || null, lastFailureAt: now, lastAttemptAt: now, lastError: code, attempts } };
      const connection = provider === 'shopify' ? integrations.shopifyConnection?.(state) : integrations.ebayConnection?.(state);
      if (connection) { connection.status = state.integrationStatus[provider].status; connection.lastError = code; }
      throw Object.assign(new Error('Read sync failed'), { code, upstreamStatus: error.upstreamStatus });
    }
  }
}

export function createScheduler({ store, integrations, withWorkspaceLock, currentBrief, enabled = true, intervalMs = 60000 }) {
  let timer = null, running = false, stopped = false;
  const status = { lastTickAt: null, lastError: null, running: false };

  async function runWorkspace(workspaceId, { manual = false, now = new Date() } = {}) {
    return withWorkspaceLock(workspaceId, async () => {
      const state = await store.get(workspaceId);
      if (!state) return { skipped: true, reason: 'WORKSPACE_NOT_FOUND' };
      ensureControl(state);
      const expired = state.automationRuns.filter(run => run.status === 'IN PROGRESS' && Date.parse(run.leaseUntil) <= now.getTime());
      for (const run of expired) finishAutomation(state, run, { errorCode: 'WORKER_INTERRUPTED', blocked: true, evidence: [{ type: 'expired_lease', id: run.id, detail: 'No completion evidence before the worker lease expired.' }] });
      const rules = dueRules(state, now);
      if (!rules.length) {
        if (expired.length) await store.save(workspaceId, state);
        return { skipped: true, reason: state.autopilot.enabled ? 'FREQUENCY_OR_PERMISSION_LIMIT' : 'AUTOPILOT_OFF' };
      }
      const runs = rules.map(rule => claimAutomation(state, rule.id, now));
      // Commit the claim before any work. PostgREST compare-and-save allows only
      // one replica to acquire this workspace's due runs, including at redeploy.
      await store.save(workspaceId, state);
      for (const run of runs) {
        try {
          let evidence;
          if (run.ruleId === 'channelSync') {
            const providers = [];
            if (integrations.shopifyRefreshAvailable(state)) providers.push('shopify');
            if (integrations.ebayConfigured(state)) providers.push('ebay');
            if (!providers.length) throw Object.assign(new Error('No connected source'), { code: 'NO_CONNECTED_SOURCE' });
            const outcomes = await Promise.allSettled(providers.map(provider => monitoredSync(state, integrations, provider, { automatic: !manual })));
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
            if (!state.ebay?.health || state.ebay?.coverage?.offersAvailable === false || state.ebay?.coverage?.inventoryAvailable === false) throw Object.assign(new Error('Marketplace coverage unavailable'), { code: 'COVERAGE_UNAVAILABLE' });
            evidence = [{ type: 'channel_comparison', id: 'ebay', detail: JSON.stringify(Object.fromEntries(Object.entries(state.ebay.health).map(([key, value]) => [key, Array.isArray(value) ? value.length : value]))) }];
          } else {
            const d = deriveOperations(state);
            if (!d.products && !d.orders30d) throw Object.assign(new Error('No recorded business data'), { code: 'NO_RECORDED_DATA' });
            const findings = detectExceptions(state, 'autopilot');
            evidence = [{ type: 'business_monitor', id: run.ruleId, detail: `${d.variants} variants and ${d.orders30d} recent orders checked; ${findings.detected} active conditions.` }];
          }
          finishAutomation(state, run, { evidence });
        } catch (error) {
          finishAutomation(state, run, { errorCode: safeCode(error), blocked: authFailure(error) || /UNAVAILABLE|NO_/.test(safeCode(error)), evidence: [{ type: 'monitor_failure', id: run.id, detail: safeCode(error) }] });
        }
      }
      detectExceptions(state, 'autopilot');
      state.autopilot.lastRunAt = new Date().toISOString();
      addAudit(state, { type: 'autopilot_cycle_finished', actor: 'autopilot', detail: { runIds: runs.map(run => run.id), spend: 0, externalWrites: false } });
      await store.save(workspaceId, state);
      return { skipped: false, runs, spend: 0, externalWrites: false };
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
