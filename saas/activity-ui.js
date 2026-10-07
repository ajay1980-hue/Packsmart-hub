/* Bounded on-demand observations for the signed-in workspace. No billing inference. */
(() => {
  'use strict';
  const OPERATIONS = Object.freeze({ identity_read: 'Account checks', state_read: 'Workspace reads', state_commit: 'Workspace saves', reporting_commit: 'Reporting saves', provider_usage_read: 'AI usage checks', provider_usage_reserve: 'AI usage reservations', provider_usage_settle: 'AI usage recording', job_read: 'Job reads', job_enqueue: 'Jobs queued', job_finish: 'Job completion saves', job_retry: 'Job retry saves', usage_read: 'Usage reads', archive_write: 'History writes', archive_read: 'History reads', reporting_write: 'Reporting writes', other: 'Other recorded requests' });
  const OUTCOMES = Object.freeze({ succeeded: 'Succeeded', http_error: 'Service errors', network_error: 'Connection errors', invalid_response: 'Responses that could not be read', oversized_response: 'Responses over the read limit' });
  const RETRIES = Object.freeze({ upsert_network: 'Retried after a connection problem', primary_statement_cancelled: 'Retried after a cancelled save', primary_network_reconciled: 'Retried after checking an uncertain save' });
  const JOBS = Object.freeze({ succeeded: 'Finished', blocked: 'Blocked', dead_letter: 'Stopped for review', rescheduled: 'Rescheduled', manual_retry: 'Manual retries' });
  const HOT = Object.freeze({ attempted: 'Latest save attempt', confirmed: 'Latest confirmed save', integrityRead: 'Latest saved data check' });
  const RATE_REASONS = Object.freeze({ not_observed: 'No database activity has been observed for this workspace yet.', database_unavailable: 'Database activity tracking is unavailable on this server.', clock_unreliable: 'Timing could not be confirmed, so recent failure and retry checks are unavailable.', counter_overflow: 'The recording limit was reached, so recent failure and retry checks are unavailable.', awaiting_complete_window: 'Waiting for a full five-minute window before checking failures and retries.', incomplete_observations: 'Some observations are missing from the recent window. Failure and retry checks are unavailable.', inflight_token_overflow: 'Some running requests could not be tracked. Failure and retry checks are unavailable.', pending_completions: 'Some requests are still running. Failure and retry checks will be available after a later refresh.', insufficient_completions: 'Fewer than ten requests completed in the window. There is not enough activity to assess failures and retries.', complete_window: 'Failure and retry checks use requests completed in this five-minute window.' });
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const numeric = value => Number.isSafeInteger(value) && value >= 0;
  const count = (value, minimum = false) => numeric(value) ? (minimum ? 'At least ' : '') + String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : 'Unknown';
  const bytes = value => numeric(value) ? count(value) + ' bytes' : 'Unknown';
  const delta = value => Number.isSafeInteger(value) ? (value > 0 ? '+' : value < 0 ? '−' : '') + bytes(Math.abs(value)) : 'Unknown';
  const date = value => typeof value === 'string' && value.length <= 32 && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value + ' (UTC)' : 'Unknown';
  const fixed = (labels, key, fallback) => typeof key === 'string' && Object.hasOwn(labels, key) ? labels[key] : fallback;
  const facts = rows => '<dl class="activity-facts">' + rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('') + '</dl>';
  let api, epoch = 0, controller = null, busy = false, loaded = false, lastInstance = null;
  const context = () => api.getContext();
  const permitted = () => Boolean(context().session && context().workspaceId && ['owner','admin'].includes(context().role));
  const current = token => token.epoch === epoch && token.session === context().session && token.workspaceId === context().workspaceId && permitted() && context().view === 'audit' && $('workspace-activity-panel').open;
  function status(message) { $('workspace-activity-status').textContent = message; }
  function controls() { $('workspace-activity-refresh').disabled = busy || !permitted(); $('workspace-activity-result').setAttribute('aria-busy', String(busy)); }
  function stop() { epoch++; controller?.abort(); controller = null; busy = false; controls(); }
  function clear() { loaded = false; $('workspace-activity-result').replaceChildren(); }
  function reset() {
    if (!api) return;
    stop(); clear(); lastInstance = null; $('workspace-activity-panel').open = false;
    $('workspace-activity-panel').classList.toggle('hidden', !permitted()); status('Open this card to check activity for your workspace.');
  }
  function pause() { if (!api) return; stop(); clear(); $('workspace-activity-panel').open = false; status('Open this card to check again.'); }
  function render(value) {
    if (!object(value) || value.schema !== 'runvara-activity/v1' || value.workspaceId !== context().workspaceId || !object(value.coverage) || value.coverage.scope !== 'process_local_instrumented'
      || !['observed','partial','unavailable','not_observed'].includes(value.coverage.status) || typeof value.instanceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value.instanceId)
      || !object(value.db) || !object(value.hotState) || !object(value.jobs) || !object(value.rateWindow) || !Array.isArray(value.anomalies)) throw new Error('ACTIVITY_RESPONSE_INVALID');
    const coverage = value.coverage, db = value.db, lower = coverage.counterOverflow === true;
    const available = coverage.dbAvailable === true && ['observed','partial'].includes(coverage.status);
    const n = v => available ? count(v, lower) : 'Unknown';
    const changed = lastInstance !== null && lastInstance !== value.instanceId;
    const notices = [];
    if (changed) notices.push('The server has changed or restarted since your last check. Earlier counts are not carried over.');
    if (coverage.status === 'not_observed') notices.push('No activity has been observed for this workspace on this server yet. Unknown values do not mean zero activity.');
    if (coverage.status === 'unavailable' || coverage.dbAvailable !== true) notices.push('Database activity tracking is unavailable here. No database total can be shown.');
    if (coverage.status === 'partial') notices.push('Some activity was not recorded. The figures below cover only the observations that were retained.');
    if (lower) notices.push('Some counters reached the recording limit. Counts shown as “At least” are minimums, not exact totals.');
    if (coverage.inflightReason === 'inflight_token_overflow') notices.push('Some running requests could not be tracked. The number still running is unknown.');
    if (coverage.clockReliable === false) notices.push('Timing could not be confirmed. Treat the recorded times with caution.');
    let html = '<section><h3>Coverage of this check</h3><p class="muted">This covers activity recorded by the server answering this request. Other servers and untracked activity are excluded. Counts reset when this server restarts.</p>' +
      notices.map(text => `<p class="activity-notice">${esc(text)}</p>`).join('') + facts([
        ['Server started', date(value.instanceStartedAt)], ['Workspace observations since', date(value.observedSince)], ['Checked at', date(value.snapshotAt)],
        ['Observations omitted', count(coverage.omittedObservations, lower)], ['Observations not usable', count(coverage.invalidObservations, lower)], ['Requests beyond tracking capacity', count(coverage.inflightOverflow, lower)]
      ]) + '</section>';
    html += '<section><h3>Database activity</h3>' + facts([['Requests started', n(db.attempted)], ['Requests completed', n(db.completed)], ['Succeeded', n(db.succeeded)], ['Failed', n(db.failed)], ['Still running', n(db.inflight)]]) +
      '<p class="muted tiny">These are recorded request attempts. A retry is another request, not a new business action.</p></section>';
    html += '<section><h3>Recorded data sizes</h3><p class="muted tiny">Sizes cover only request and response content measured by the app. They exclude connection overhead and are not a network bill.</p>';
    for (const [field, label] of [['requestBody','Request content'],['responseBody','Response content']]) {
      const body = object(db[field]) ? db[field] : {};
      html += `<h4>${label}</h4>` + facts([['Known size total', available && numeric(body.knownObservations) && body.knownObservations > 0 ? bytes(body.bytes) : 'Unknown'], ['Requests with a measured size', n(body.knownObservations)], ['Requests with an unknown size', n(body.unknownObservations)]]) + (available && numeric(body.unknownObservations) && body.unknownObservations > 0 ? '<p class="muted tiny">Only measured content is included in this size total; other sizes are unknown.</p>' : '');
    }
    html += '</section><section><h3>Workspace snapshot sizes</h3><p class="muted tiny">A save attempt is not proof that data was saved. These snapshot sizes are not total database storage.</p><div class="activity-snapshots">';
    for (const [kind, label] of Object.entries(HOT)) {
      const hot = object(value.hotState[kind]) ? value.hotState[kind] : {}, known = numeric(hot.observations) && hot.observations > 0;
      html += `<article><h4>${label}</h4>` + facts([['Recorded size', known ? bytes(hot.bytes) : 'Unknown'], ['Previous size', known ? bytes(hot.previousBytes) : 'Unknown'], ['Change from previous', known ? delta(hot.deltaBytes) : 'Unknown'], ['Observed at', known ? date(hot.observedAt) : 'Unknown'], ['Observations', count(hot.observations, lower)]]) +
        (kind === 'integrityRead' ? '<p class="muted tiny">Size observed during an existing read of saved workspace data; it does not confirm a new save.</p>' : '') + '</article>';
    }
    html += '</div></section><section><h3>Job events</h3><p class="muted tiny">These are observed events, not unique jobs. One job can produce several events.</p>' + facts(Object.entries(JOBS).map(([field,label])=>[label,count(value.jobs[field],lower)])) + '</section>';
    const rate = value.rateWindow;
    const eligible = available && rate.eligible === true && rate.reason === 'complete_window' && rate.durationMs === 300000 && numeric(rate.completed) && rate.completed >= 10 && coverage.clockReliable === true && !lower;
    html += '<section><h3>Recent completion window</h3><p class="muted">' + esc(eligible ? RATE_REASONS.complete_window : fixed(RATE_REASONS, rate.reason === 'complete_window' ? null : rate.reason, 'The recent activity check is unavailable.')) + '</p>' + facts([
      ['Window starts', date(rate.startedAt)], ['Window ends', date(rate.endedAt)], ['Requests completed', n(rate.completed)], ['Completed with a failure', n(rate.failed)], ['Completed retry requests', n(rate.retried)]
    ]) + '</section><section><h3>Activity notices</h3>';
    const anomalies = [];
    for (const item of value.anomalies.slice(0, 5)) {
      if (!object(item)) continue;
      if (['hot_state_near_limit','hot_state_limit_exceeded'].includes(item.code) && Object.hasOwn(HOT,item.kind) && numeric(item.bytes) && numeric(item.limitBytes)) {
        anomalies.push(`${HOT[item.kind]} ${item.code === 'hot_state_near_limit' ? 'is close to' : 'is at or above'} the workspace size limit: ${bytes(item.bytes)} of ${bytes(item.limitBytes)}.`);
      } else if (eligible && ['db_failure_burst','db_retry_burst'].includes(item.code) && numeric(item.completed) && item.completed === rate.completed) {
        const field = item.code === 'db_failure_burst' ? 'failed' : 'retried';
        if (numeric(item[field]) && item[field] <= item.completed && item[field] === rate[field]) anomalies.push(`${count(item[field])} of ${count(item.completed)} completed requests ${field === 'failed' ? 'failed' : 'were retries'} during the window shown.`);
      }
    }
    html += anomalies.map(text=>`<p class="activity-notice">${esc(text)}</p>`).join('') || `<p class="muted">${eligible ? 'No size, failure or retry alert was recorded for this check.' : 'No size alert was recorded. Failure and retry alerts are unavailable until the completion window can be checked.'}</p>`;
    html += '</section><details class="activity-breakdown"><summary>Request breakdown</summary><h4>By purpose</h4>' + facts(Object.entries(OPERATIONS).map(([field,label])=>[label,n(db.operations?.[field])])) +
      '<h4>By result</h4>' + facts(Object.entries(OUTCOMES).map(([field,label])=>[label,n(db.outcomes?.[field])])) +
      '<h4>Retries recorded</h4>' + facts(Object.entries(RETRIES).map(([field,label])=>[label,n(db.retries?.[field])])) +
      '<h4>By request method</h4>' + facts(['GET','HEAD','POST','PATCH','PUT','DELETE'].map(method=>[method,n(db.methods?.[method])])) + '</details>';
    $('workspace-activity-result').innerHTML = html; lastInstance = value.instanceId; loaded = true;
  }
  async function refresh() {
    if (busy || !permitted() || context().view !== 'audit' || !$('workspace-activity-panel').open) return;
    const token = { epoch, session:context().session, workspaceId:context().workspaceId }, ownController = new AbortController(); controller = ownController;
    busy = true; clear(); controls(); status('Checking recorded activity…');
    try {
      const value = await api.request('/api/activity', { signal:ownController.signal, isCurrent:() => current(token) });
      if (!current(token)) return;
      render(value); status('Activity loaded. Select Refresh when you want a newer check.');
    } catch (error) {
      if (!current(token)) return;
      clear(); status(error.status === 429 ? 'Too many checks in a short time. Wait a minute, then select Refresh.' : error.status === 403 ? 'Only the workspace owner or an admin can read this activity.' : error.status === 401 ? 'Sign in again to check activity.' : 'Activity could not be checked. Select Refresh to try again.');
    } finally { if (current(token)) { controller = null; busy = false; controls(); } }
  }
  function init(value) {
    api = value;
    $('workspace-activity-panel').addEventListener('toggle', () => {
      if (!$('workspace-activity-panel').open) { stop(); return; }
      if (!permitted() || context().view !== 'audit') { pause(); return; }
      if (!loaded) refresh();
    });
    $('workspace-activity-refresh').addEventListener('click', refresh);
    reset();
  }
  window.RunvaraActivity = Object.freeze({ init, reset, pause });
})();
