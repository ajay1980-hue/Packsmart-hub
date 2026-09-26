import { CONNECTORS, beginConnectionSync, connectionSettings, connectionDue } from './connection-centre.mjs';
import { addAudit } from './events.mjs';
import { classifyConnectionIssue, recordFor, safeFailureCode } from './connection-intelligence.mjs';

const iso = () => new Date().toISOString();
const transient = error => error?.upstreamStatus === 429 || error?.upstreamStatus >= 500 || /RATE_LIMIT|TIMEOUT|ETIMEDOUT|ECONNRESET/.test(error?.code || '') || ['AbortError','TimeoutError','TypeError'].includes(error?.name);
function event(state, provider, type, detail = {}) {
  addAudit(state, { type: `connection_doctor_${type}`, actor: 'connection-doctor', detail: { provider, externalWrites: false, ...detail } });
}

export function queueFirstSync(state, provider, actor) {
  const settings = connectionSettings(state, provider);
  state.connectionFirstSync = { ...state.connectionFirstSync, [provider]: {
    status: 'queued', actor, identityVerifiedAt: recordFor(state, provider)?.lastCheckedAt || null,
    startedAt: iso(), previousSuccessfulSyncAt:state.integrationStatus?.[provider]?.lastSuccessfulSyncAt || null, areas: Object.fromEntries(settings.areas.map(area => [area, 'pending'])), failures: {},
    validation: 'pending', defaults: 'read_only', completedAt: null
  } };
  const previous = state.onboardingJourney || {};
  state.onboardingJourney = { ...previous, platforms: [...new Set([...(previous.platforms || []), provider])],
    permissionReviews: { ...previous.permissionReviews, [provider]: settings.revision }, revision: (previous.revision || 0) + 1 };
  // A fresh, user-authorised connection resets the bounded retry state.
  state.connectionDoctor = { ...state.connectionDoctor, [provider]: {} };
}

export function validateImportedData(state, provider) {
  const groups = provider === 'shopify' ? { products: (state.products || []).filter(p => p.provider === provider), orders: (state.orders || []).filter(o => o.provider === provider) }
    : provider === 'ebay' ? { listings: state.ebay?.listings || [], orders: (state.orders || []).filter(o => o.provider === provider) }
    : state.channelData?.[provider] || {};
  const counts = {}, problems = [];
  for (const [area, rows] of Object.entries(groups)) {
    if (!Array.isArray(rows)) continue;
    counts[area] = rows.length;
    const seen = new Set();
    for (const row of rows) {
      const id = row.id ?? row.externalId;
      // Older eBay bridge records can be SKU-keyed. Never delete historical data.
      const key = id ?? row.sku;
      if (key == null || key === '' || seen.has(String(key))) { problems.push(area); break; }
      seen.add(String(key));
    }
  }
  if (provider === 'google_youtube' && Array.isArray(groups.channels) && !groups.channels.length) problems.push('channels');
  if (provider === 'meta' && Array.isArray(groups.accounts) && !groups.accounts.length) problems.push('accounts');
  if (provider === 'shopify') for (const product of groups.products) {
    const ids = (product.variants || []).map(variant => variant.id);
    if (ids.some(id => id == null || id === '') || new Set(ids).size !== ids.length) problems.push('variants');
  }
  if (provider === 'shopify') counts.variants = groups.products.reduce((sum, p) => sum + (p.variants?.length || 0), 0);
  return { ok: problems.length === 0, counts, problemAreas: [...new Set(problems)], checkedAt: iso() };
}

function readGroups(provider, areas) {
  if (provider === 'shopify') return [areas.filter(a => ['products','variants','inventory','prices'].includes(a)), ...areas.filter(a => ['orders','customers'].includes(a)).map(a => [a])].filter(a => a.length);
  // eBay already preserves independent read coverage inside its existing adapter.
  if (provider === 'ebay' || provider === 'meta' || provider === 'tiktok_shop') return [areas];
  return areas.map(area => [area]);
}

export async function runFirstSync(state, provider, { integrations, readSync, save, retryFailedOnly = false }) {
  const first = state.connectionFirstSync?.[provider];
  if (!first || !first.identityVerifiedAt || connectionSettings(state, provider).disconnected) return;
  const areas = Object.keys(first.areas).filter(a => !retryFailedOnly || first.areas[a] !== 'completed');
  first.status = 'running';
  await save();
  for (const group of readGroups(provider, areas)) {
    if (!group.length) continue;
    for (const area of group) first.areas[area] = 'running';
    const run = beginConnectionSync(state, provider, { areas: group, actor: first.actor || 'connection-doctor' });
    await save(); // durable lease before any read; CAS and the workspace lock protect it
    try {
      const result = await readSync(state, integrations, provider, { run, retry: false });
      const failed = result.failedAreas || (result.degradedSurfaces || []).flatMap(surface => surface === 'marketing' ? ['promotions'] : ['inventory','offers'].includes(surface) ? ['products','inventory','prices'] : [surface]);
      for (const area of group) {
        const bad = failed.includes(area) || (result.lastError && !failed.length);
        first.areas[area] = bad ? 'failed' : 'completed';
        if (bad) first.failures[area] = { code: safeFailureCode({code:result.lastError}), upstreamStatus: result.upstreamStatus || null, transient: Boolean(result.transient) };
        else delete first.failures[area];
      }
    } catch (error) {
      for (const area of group) { first.areas[area] = 'failed'; first.failures[area] = { code: safeFailureCode(error), upstreamStatus: error.upstreamStatus || null, transient: transient(error) }; }
      // A rejected credential/identity or rate limit must stop further provider calls.
      if (/AUTH|CREDENTIAL|ACCOUNT_MISMATCH|RATE_LIMIT/.test(error.code || '') || error.upstreamStatus === 429) {
        for (const area of areas.filter(a => first.areas[a] === 'pending')) { first.areas[area] = 'failed'; first.failures[area] = { ...first.failures[group[0]] }; }
        break;
      }
    }
    await save();
  }
  first.validation = validateImportedData(state, provider);
  const successful = Object.keys(first.areas).filter(area => first.areas[area] === 'completed');
  const failed = Object.keys(first.failures);
  first.status = failed.length || !first.validation.ok ? successful.length ? 'partial' : 'failed' : 'completed';
  first.completedAt = iso();
  const previous = state.integrationStatus?.[provider] || {};
  if (failed.length) {
    const priority = Object.values(first.failures).find(f => /AUTH|CREDENTIAL|ACCOUNT_MISMATCH/.test(f.code)) || Object.values(first.failures)[0];
    state.integrationStatus[provider] = { ...previous, status: successful.length ? 'degraded' : 'error', lastError: priority.code, lastFailureAt: first.completedAt,
      failedAreas: failed, transient: priority.transient, upstreamStatus: priority.upstreamStatus, lastSuccessfulSyncAt:first.previousSuccessfulSyncAt };
  } else if (first.validation.ok) state.integrationStatus[provider] = { ...previous, status: 'connected', lastError: null, failedAreas: [], transient: false, upstreamStatus: null, lastSuccessfulSyncAt: first.completedAt };
  const message = first.status === 'completed' ? `${CONNECTORS[provider].name} first sync completed. Your business data is ready.` : `${CONNECTORS[provider].name} imported ${successful.length} data areas. ${failed.length ? `Retry needed: ${failed.join(', ')}.` : 'Some imported records need review.'} Successful imports are safe.`;
  addAudit(state, { type: 'connection_first_sync_finished', actor: first.actor, detail: { provider, status: first.status, successfulAreas: successful, failedAreas: failed, counts: first.validation.counts, message, priority: first.status === 'completed' ? 'informational' : 'important', externalWrites: false } });
  await save();
  return first;
}

// Called only under the existing workspace lock. This module has no publishing,
// stock, pricing, deletion, financial, approval-execution or OAuth-start path.
export async function runConnectionDoctor(state, { integrations, readSync, save, now = new Date() }) {
  let changed = false;
  for (const provider of Object.keys(CONNECTORS)) {
    const settings = connectionSettings(state, provider), record = recordFor(state, provider);
    if (settings.disconnected || !record?.encryptedCredentials || !CONNECTORS[provider].areas.length) continue;
    const first = state.connectionFirstSync?.[provider];
    const issue = classifyConnectionIssue(state, provider, now);
    const commerceOnly = provider === 'ebay' && issue?.kind === 'provider_restriction' && state.ebay?.coverage?.readDiagnostics?.marketing?.errorIds?.map(String).includes('35077');
    const doctor = state.connectionDoctor?.[provider] || {};
    const signature = issue?.kind || null;
    if (signature !== (doctor.issue || null)) {
      if (issue) {
        event(state, provider, 'issue_detected', { kind: issue.kind });
        event(state, provider, 'issue_classified', { kind: issue.kind, priority: issue.severity, message: issue.message });
        if (issue.kind === 'provider_unavailable') event(state, provider, 'provider_outage', { evidence: 'provider_http_5xx' });
        if (issue.action) event(state, provider, 'user_action_required', { message: issue.message + ' ' + issue.action.label + '.', priority: issue.severity });
      } else if (doctor.issue === 'provider_unavailable') event(state, provider, 'provider_recovery', { message: `${CONNECTORS[provider].name} reads are available again. No action required.` });
      doctor.issue = signature; changed = true;
    }
    state.connectionDoctor = { ...state.connectionDoctor, [provider]: doctor };
    if (issue && !issue.repair && !commerceOnly) continue;
    if (commerceOnly && !settings.areas.some(area => area !== 'promotions')) continue;
    const running = (state.connectionSyncs || []).some(r => r.provider === provider && r.status === 'running' && Date.parse(r.leaseUntil) > now.getTime());
    if (running || Date.parse(doctor.leaseUntil) > now.getTime() || Date.parse(doctor.nextRetryAt) > now.getTime() || Date.parse(state.integrationStatus?.[provider]?.retryAt) > now.getTime() || doctor.exhausted) continue;
    const expiry = Date.parse(integrations.connectionAccessExpiry?.(record) || '');
    const refresh = Number.isFinite(expiry) && expiry - now.getTime() <= 15 * 60000 && integrations.refreshSupported?.(state, provider);
    const resume = first && ['queued','running'].includes(first.status);
    const scheduled = settings.managedReadSchedule && settings.autoSync && connectionDue(state, provider, now);
    const repairRead = settings.autoSync && issue?.repair === 'read';
    if (!refresh && !resume && !scheduled && !repairRead) continue;
    const action = refresh ? 'refresh' : resume ? 'first_sync' : 'read';
    doctor.leaseUntil = new Date(now.getTime() + 10 * 60000).toISOString();
    doctor.lastAttemptAt = now.toISOString();
    event(state, provider, 'repair_attempted', { action });
    await save();
    changed = true;
    try {
      if (refresh) {
        const oldStatus = structuredClone(state.integrationStatus?.[provider] || {});
        await integrations.testConnection(state, provider, { refresh: true });
        // A token check cannot erase an outstanding read failure.
        if (oldStatus.lastError) state.integrationStatus[provider] = oldStatus;
      } else {
        if (issue?.kind === 'interrupted') for (const run of state.connectionSyncs || []) if (run.provider === provider && run.status === 'running' && Date.parse(run.leaseUntil) <= now.getTime()) Object.assign(run, { status:'failed', completedAt:now.toISOString(), errorCode:'WORKER_INTERRUPTED' });
        if (first && first.status !== 'completed' && !commerceOnly) await runFirstSync(state, provider, { integrations, readSync, save, retryFailedOnly: true });
        else {
          const areas = commerceOnly ? settings.areas.filter(a => a !== 'promotions') : settings.areas;
          if (!areas.length) continue;
          const run = beginConnectionSync(state, provider, { automatic:true, actor:'connection-doctor', areas });
          await save();
          await readSync(state, integrations, provider, { automatic:true, run, retry:false });
        }
        if (state.integrationStatus?.[provider]?.lastError) throw Object.assign(new Error('Read still needs attention'), { code: 'PARTIAL_READ' });
      }
      const recoveredOutage = doctor.issue === 'provider_unavailable';
      Object.assign(doctor, { attempts:0, nextRetryAt:null, exhausted:false, lastSuccessAt:iso(), issue: refresh || commerceOnly ? doctor.issue : null });
      event(state, provider, 'repair_success', { action, message: (issue && !commerceOnly) || refresh ? `Runvara detected and repaired your ${CONNECTORS[provider].name} connection. No action required.` : null });
      if (recoveredOutage && !refresh) event(state, provider, 'provider_recovery', { message:`${CONNECTORS[provider].name} reads recovered. No action required.` });
    } catch (error) {
      if (error.code === 'STATE_CONFLICT' || /PERSISTENCE|SUPABASE/.test(error.code || '')) throw error;
      doctor.attempts = (doctor.attempts || 0) + 1;
      doctor.exhausted = doctor.attempts >= 5;
      const backoff = Math.min(3600000, 60000 * 2 ** (doctor.attempts - 1));
      doctor.nextRetryAt = new Date(now.getTime() + Math.max(backoff, Math.min(86400000, Number(error.retryAfterMs) || 0), Date.parse(state.integrationStatus?.[provider]?.retryAt) - now.getTime() || 0)).toISOString();
      event(state, provider, 'repair_failure', { action, code:safeFailureCode(error), nextRetryAt:doctor.nextRetryAt });
      if (refresh) state.integrationStatus = { ...state.integrationStatus, [provider]: { ...state.integrationStatus?.[provider], lastError:safeFailureCode(error), upstreamStatus:error.upstreamStatus || null, transient:transient(error) } };
      if (doctor.exhausted) event(state, provider, 'user_action_required', { priority:'critical', message:`Repeated ${CONNECTORS[provider].name} read retries failed. Existing data is safe. Retry this connection from the Connection Centre.` });
    } finally { doctor.leaseUntil = null; }
    await save();
  }
  if (changed) await save();
  return { changed, externalWrites:false };
}
