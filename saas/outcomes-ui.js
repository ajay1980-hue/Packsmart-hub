/* On-demand business results. Server-committed publications are the only result authority. */
(() => {
  'use strict';
  const LIMIT = 20;
  let api, generation = 0, scope = null, session = null, selected = null, overview = null;
  let pending = null, stale = false, busy = new Set(), controllers = new Set();
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const bounded = (value, max = 1000) => String(value ?? '').slice(0, max);
  const unknown = value => value === null || value === undefined || value === '' ? 'Unknown' : bounded(value);
  const amount = value => `${unknown(value?.amount)} ${value?.currency || '(currency unknown)'}`;
  const windowText = value => value ? `${unknown(value.startsAt)} → ${unknown(value.endsAt)} (UTC, end exclusive)` : 'Unknown';
  const role = () => api.getContext().role;
  const canPrepare = () => ['owner', 'admin'].includes(role());
  const key = c => `${c.workspaceId || ''}:${c.userId || ''}`;
  const context = () => api.getContext();
  const active = ticket => ticket.generation === generation && ticket.scope === key(context()) && ticket.session === context().session && context().view === 'revenue-engine' && $('business-outcomes-panel').open;
  const ticket = () => ({ generation, scope: key(context()), session: context().session });
  function status(text, error = false) { $('business-outcomes-status').textContent = text; $('business-outcomes-status').classList.toggle('outcome-error', error); }
  function invalidate() { generation++; controllers.forEach(c => c.abort()); controllers.clear(); for (const name of busy) if (!['save', 'publish'].includes(name)) busy.delete(name); }
  function controls() {
    $('business-outcomes-refresh').disabled = busy.has('overview');
    $('business-outcomes-load').disabled = busy.has('detail') || busy.has('save') || busy.has('publish');
    $('business-outcomes-experiment').disabled = busy.has('save') || busy.has('publish') || Boolean(pending?.attempted);
    $('business-outcomes-form').querySelectorAll('input,select,textarea,button').forEach(el => { el.disabled = !canPrepare() || busy.has('save') || busy.has('publish') || stale || Boolean(pending?.attempted); });
    $('business-outcomes-review').querySelectorAll('button,input,textarea').forEach(el => { el.disabled = busy.has('publish'); });
    if (pending?.attempted && $('business-outcomes-reason')) $('business-outcomes-reason').disabled = true;
    const confirm = $('business-outcomes-confirm'); if (confirm) confirm.disabled = busy.has('publish') || !$('business-outcomes-attest').checked;
    $('business-outcomes-detail').querySelectorAll('[data-outcome-action]').forEach(el => { el.disabled = stale || busy.has('save') || busy.has('publish') || Boolean(pending?.attempted); });
  }
  function facts(value) {
    const rows = [ ['Incremental contribution', amount(value)], ['Measurement window', windowText(value?.window)],
      ['Coverage', `${value?.coverage?.status || 'unknown'} · ${unknown(value?.coverage?.observedCount)} / ${unknown(value?.coverage?.expectedCount)}`],
      ['Method', value?.method?.kind || 'unknown'], ['Observed at (UTC)', unknown(value?.provenance?.observedAt)],
      ['Scope', 'Whole business; overlapping windows are not additive'], ['Attribution to Runvara', 'Unestablished'] ];
    return '<dl class="outcome-facts">' + rows.map(([label, text]) => `<div><dt>${esc(label)}</dt><dd>${esc(text)}</dd></div>`).join('') + '</dl>';
  }
  function publicationCard(publication, index) {
    const { head, version } = publication;
    return `<article class="outcome-record"><h4>${head.status === 'withdrawn' ? 'Withdrawn' : 'Owner-verified measurement'} · version ${esc(version.revision)}</h4><p class="muted tiny">Experiment ${esc(bounded(version.source?.experimentId, 180))}</p>${facts(version)}<p class="muted tiny">${head.status === 'withdrawn' ? 'Excluded from measured results.' : 'Owner attestation; not independently verified. No forecast or ROI claim.'}</p><button type="button" class="secondary" data-outcome-evidence="${index}">Read retained source evidence</button><div data-outcome-evidence-result="${index}"></div></article>`;
  }
  function validPublication(value) {
    return value?.head?.workspaceId === context().workspaceId && value?.version?.workspaceId === context().workspaceId && value.head.versionId === value.version.versionId && value.head.digest === value.version.digest && typeof value.version.versionId === 'string' && value.version.versionId.length <= 180;
  }
  function renderOverview() {
    if (!overview) return;
    const summary = overview.summary || {}, groups = Array.isArray(summary.groups) ? summary.groups : [], current = overview.current;
    $('business-outcomes-summary').innerHTML = `<p class="muted">${summary.coverage?.complete === true ? 'Current committed selection loaded.' : 'Selection is incomplete; totals are withheld.'} This is not a lifetime-history total.</p>` +
      groups.slice(0, LIMIT).map(group => `<article class="outcome-record"><h4>${esc(group.currency || 'Currency unknown')} · ${esc(group.method?.kind || group.method || 'Method unknown')}</h4><p>${esc(windowText(group.window))}</p><strong>${esc(summary.coverage?.complete === true && group.amountStatus === 'measured_sum' ? amount(group) : 'No additive total')}</strong><p class="muted tiny">${esc(group.amountStatus || 'unknown')} · ${esc(unknown(group.measuredCount))} measurements</p></article>`).join('') +
      (!groups.length ? '<p class="empty-state">No qualified comparable result group is available.</p>' : '') +
      (groups.length > LIMIT ? `<p>Showing ${LIMIT} of ${groups.length} result groups.</p>` : '') +
      (Array.isArray(summary.exclusions) && summary.exclusions.length ? '<p class="muted">Some measurements are excluded: ' + summary.exclusions.slice(0, LIMIT).map(row => esc(bounded(row.code, 100))).join(', ') + '.</p>' : '') +
      '<h3>Current publications</h3>' + current.slice(0, LIMIT).map(publicationCard).join('') +
      (!current.length ? '<p class="empty-state">No published business results yet. Prepare a measurement below.</p>' : '') +
      (current.length > LIMIT ? `<p>Showing ${LIMIT} of ${current.length} publications. Select an experiment below for its current result.</p>` : '');
  }
  async function read(name, path, apply) {
    if (busy.has(name)) return;
    const t = ticket(), controller = new AbortController(); controllers.add(controller); busy.add(name); controls();
    try { const result = await api.request(path, { signal: controller.signal }); if (active(t)) apply(result); }
    catch (error) { if (active(t)) status(error.status === 401 ? 'Sign in again to read business results.' : 'Could not load business results. Refresh explicitly to try again.', true); }
    finally { controllers.delete(controller); if (active(t)) { busy.delete(name); controls(); } }
  }
  function loadOverview() {
    status('Loading committed business results…');
    return read('overview', '/api/business-outcomes', result => {
      if (result.workspaceId !== context().workspaceId || !Array.isArray(result.current) || result.current.some(p => !validPublication(p))) throw new Error('Mismatched business results');
      overview = result; renderOverview(); status('Loaded on request. Amounts retain their recorded currency and window.');
    });
  }
  function dateInput(value) { return value ? String(value).replace(/Z$/, '') : ''; }
  function populateForm() {
    const f = $('business-outcomes-form'), m = selected?.measurement;
    const values = { amount: m?.amount ?? '', currency: m?.currency ?? '', startsAt: dateInput(m?.window?.startsAt), endsAt: dateInput(m?.window?.endsAt), observedAt: dateInput(m?.provenance?.observedAt), coverageStatus: m?.coverage?.status || 'unknown', observedCount: m?.coverage?.observedCount ?? '', expectedCount: m?.coverage?.expectedCount ?? '', method: m?.method?.kind || 'unknown', description: m?.report?.description || '', costsComplete: m?.report?.costsComplete === true ? 'true' : m?.report?.costsComplete === false ? 'false' : '' };
    for (const [name, value] of Object.entries(values)) f.elements[name].value = value;
    f.classList.toggle('hidden', !canPrepare()); controls();
  }
  function renderDetail() {
    const d = selected; if (!d) { $('business-outcomes-detail').replaceChildren(); $('business-outcomes-form').classList.add('hidden'); return; }
    const m = d.measurement, publication = d.currentPublication;
    const blockers = Array.isArray(d.assessment?.blockers) ? d.assessment.blockers : [];
    let html = `<h3>${esc(bounded(d.experiment.title || d.experiment.id, 180))}</h3><p class="muted">${m ? `Saved draft revision ${esc(m.revision)}` : 'No typed measurement saved.'} · Legacy verification does not qualify this measurement.</p>`;
    if (m) html += facts(m) + `<p>Cost completeness: ${m.report?.costsComplete === true ? 'Complete (reported)' : m.report?.costsComplete === false ? 'Incomplete' : 'Unknown'}</p><p class="outcome-description">${esc(bounded(m.report?.description))}</p>`;
    html += `<p>${d.assessment?.readyForOwnerVerification === true ? 'Ready for explicit owner review.' : 'Draft is unqualified.'}</p>` + (blockers.length ? '<ul>' + blockers.slice(0, LIMIT).map(b => `<li>${esc(bounded(b.code, 100))}</li>`).join('') + '</ul>' : '');
    if (publication) html += `<div class="outcome-current"><h4>Current ${publication.head.status === 'withdrawn' ? 'withdrawn' : 'published'} result · version ${esc(publication.version.revision)}</h4>${facts(publication.version)}<p class="muted tiny">A later draft does not change this immutable result.</p><button type="button" class="secondary" data-outcome-source-current>Read current result source evidence</button><div id="business-outcomes-current-source"></div></div>`;
    if (role() === 'owner') {
      const withdrawn = publication?.head.status === 'withdrawn';
      const newer = !publication || m?.revision > publication.version.source.measurementRevision;
      if (m && d.assessment?.readyForOwnerVerification === true && newer && !withdrawn) html += `<button type="button" class="primary" data-outcome-action="${publication ? 'correct' : 'publish'}">Review ${publication ? 'correction' : 'publication'}</button>`;
      if (publication?.head.status === 'published') html += '<button type="button" class="secondary" data-outcome-action="withdraw">Review withdrawal</button>';
      if (withdrawn) html += '<p class="muted">This result was withdrawn. Reinstatement is not supported.</p>';
    } else html += '<p class="muted">Only the owner can verify, correct or withdraw a published result.</p>';
    $('business-outcomes-detail').innerHTML = html; controls();
  }
  function loadDetail() {
    if (busy.has('detail') || busy.has('save') || busy.has('publish')) return;
    const id = $('business-outcomes-experiment').value; if (!id) return status('Choose an experiment.');
    if (pending?.attempted) return status('Resolve the pending publication with the same retry identity before changing this measurement.', true);
    generation++; controllers.forEach(c => c.abort()); controllers.clear(); busy.clear(); pending = null; renderReview();
    selected = null; renderDetail(); status('Loading the selected experiment…');
    return read('detail', '/api/business-outcomes/experiments/' + encodeURIComponent(id), result => {
      if (result.workspaceId !== context().workspaceId || result.experiment?.id !== id || (result.measurement && (result.measurement.workspaceId !== result.workspaceId || result.measurement.experimentId !== id)) || (result.currentPublication && !validPublication(result.currentPublication))) throw new Error('Mismatched experiment');
      selected = result; stale = false; renderDetail(); populateForm(); status('Experiment loaded. Edit a draft or review the saved measurement.');
    });
  }
  function measurementInput() {
    const f = $('business-outcomes-form'), get = name => f.elements[name].value.trim();
    const count = name => { const v = get(name); if (v === '') return null; if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error('Coverage counts must be nonnegative whole numbers.'); return Number(v); };
    const utc = name => { const v = get(name); if (!v) return null; const d = new Date(v + 'Z'); if (!Number.isFinite(d.getTime())) throw new Error('Enter a valid UTC date and time.'); return d.toISOString(); };
    const startsAt = utc('startsAt'), endsAt = utc('endsAt');
    if (Boolean(startsAt) !== Boolean(endsAt)) throw new Error('Supply both UTC window dates, or leave both unknown.');
    return { expectedRevision: selected.measurement?.revision || 0, amount: get('amount') || null, currency: get('currency') || null,
      window: startsAt ? { startsAt, endsAt } : null, coverage: { status: get('coverageStatus'), observedCount: count('observedCount'), expectedCount: count('expectedCount') },
      method: { kind: get('method') }, observedAt: utc('observedAt'), report: { description: get('description'), costsComplete: get('costsComplete') === '' ? null : get('costsComplete') === 'true' } };
  }
  async function save(event) {
    event.preventDefault(); if (!selected || !canPrepare() || stale || pending?.attempted || busy.has('save') || busy.has('publish')) return;
    let body; try { body = measurementInput(); } catch (error) { status(error.message, true); return; }
    pending = null; renderReview(); const t = ticket(), id = selected.experiment.id, controller = new AbortController(); controllers.add(controller);
    busy.add('save'); controls(); status('Saving typed measurement…');
    try {
      const result = await api.request('/api/business-outcomes/experiments/' + encodeURIComponent(id) + '/measurement', { method: 'PUT', body: JSON.stringify(body), signal: controller.signal });
      if (!active(t)) return;
      if (result.workspaceId !== context().workspaceId || result.measurement?.experimentId !== id) throw new Error('Unexpected measurement response');
      selected = { ...selected, ...result }; renderDetail(); populateForm(); status('Draft saved. It is not a published result.');
    } catch (error) { if (active(t)) { stale = true; status(error.status === 409 ? 'The measurement changed. Refresh the experiment before editing again.' : 'Save was not confirmed. Refresh the experiment before making another change.', true); } }
    finally { controllers.delete(controller); if (t.scope === scope && t.session === session) { busy.delete('save'); if (!active(t)) stale = true; controls(); } }
  }
  function review(action) {
    if (!selected || stale || role() !== 'owner' || busy.has('save') || busy.has('publish') || pending) return;
    const p = selected.currentPublication, m = selected.measurement;
    if (action === 'withdraw' ? p?.head.status !== 'published' : !m || selected.assessment?.readyForOwnerVerification !== true || p?.head.status === 'withdrawn') return;
    const source = action === 'withdraw' ? p.version.source : { measurementRevision: m.revision, measurementDigest: m.digest };
    const id = window.crypto?.randomUUID?.(); if (!id) return status('Secure publication identity is unavailable. Refresh in a supported secure browser.', true);
    pending = { action, attempted: false, uncertain: false, facts: action === 'withdraw' ? p.version : m,
      payload: { publicationId: id, action, experimentId: selected.experiment.id, expectedWorkspaceRevision: selected.workspaceRevision,
        expectedMeasurementRevision: source.measurementRevision, expectedMeasurementDigest: source.measurementDigest,
        expectedHeadVersionId: p?.head.versionId || null, expectedHeadDigest: p?.head.digest || null, withdrawalReason: null } };
    renderReview(); $('business-outcomes-review').scrollIntoView({ block: 'nearest' });
  }
  function renderReview() {
    const root = $('business-outcomes-review'); root.classList.toggle('hidden', !pending); if (!pending) { root.replaceChildren(); controls(); return; }
    const p = pending;
    root.innerHTML = `<h3>Review ${esc(p.action)}</h3>${facts(p.facts)}<p>Measurement revision ${esc(p.payload.expectedMeasurementRevision)}. ${p.action === 'withdraw' ? 'This withdraws the published result only. A later measurement draft is preserved.' : 'You are attesting to the saved measured facts and complete costs. This does not prove Runvara caused the result.'}</p>` +
      (p.action === 'withdraw' ? `<label>Withdrawal reason<select id="business-outcomes-reason" ${p.attempted ? 'disabled' : ''}>${[['','Choose a reason'],['incorrect_measurement','Incorrect measurement'],['duplicate_observation','Duplicate observation'],['incorrect_scope','Incorrect scope'],['evidence_retracted','Evidence retracted']].map(([value,label]) => `<option value="${value}" ${p.payload.withdrawalReason === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>` : `<p>Costs: ${p.facts.report?.costsComplete === true ? 'Complete (reported)' : 'Unknown'}</p><p class="outcome-description">${esc(bounded(p.facts.report?.description))}</p>`) +
      `<label class="outcome-attest"><input id="business-outcomes-attest" type="checkbox">I reviewed these exact details and ${p.action === 'withdraw' ? 'want to withdraw this result' : 'attest that this measurement and its costs are complete'}.</label>` +
      (p.uncertain ? '<p class="outcome-error">The response was uncertain. No automatic retry occurred. Retry uses the same publication identity and the same reviewed details.</p>' : '') +
      `<div class="outcome-actions"><button id="business-outcomes-confirm" class="primary" type="button" disabled>${p.uncertain ? 'Retry same reviewed action' : 'Confirm ' + esc(p.action)}</button><button id="business-outcomes-cancel" class="secondary" type="button">${p.attempted ? 'Close review (keep pending action)' : 'Cancel'}</button></div>`;
    controls();
  }
  async function publish() {
    if (!pending || busy.has('publish') || role() !== 'owner' || !$('business-outcomes-attest')?.checked) return;
    const p = pending;
    if (p.action === 'withdraw' && !p.attempted) { p.payload.withdrawalReason = $('business-outcomes-reason').value.trim(); if (!p.payload.withdrawalReason) return status('Give a reason for this withdrawal.', true); }
    p.attempted = true; const t = ticket(), controller = new AbortController(); controllers.add(controller); busy.add('publish'); controls(); status('Submitting the reviewed action…');
    try {
      const result = await api.request('/api/business-outcomes/publish', { method: 'POST', body: JSON.stringify(p.payload), signal: controller.signal });
      if (!active(t)) { p.uncertain = true; return; }
      if (!validPublication(result.publication) || result.publication.head.publicationId !== p.payload.publicationId) throw new Error('Publication response did not match the reviewed action');
      pending = null; stale = true; renderReview(); status(result.isCurrent === false ? 'This action is recorded but has since been superseded. Refresh the experiment and results.' : 'Reviewed action recorded. Refresh the experiment and results to load current committed state.');
    } catch (error) {
      if ([400,403,404,409,413,422].includes(error.status)) { if (pending !== p || t.scope !== scope || t.session !== session) return; pending = null; stale = true; if (active(t)) { renderReview(); status('The action was not accepted. Refresh the experiment and review its current details before trying again.', true); } }
      else { p.uncertain = true; if (active(t)) { renderReview(); status('Publication was not confirmed. Retry only the same reviewed action.', true); } }
    } finally { controllers.delete(controller); if (t.scope === scope && t.session === session) { busy.delete('publish'); controls(); } }
  }
  function evidence(publication, target, button) {
    const name = 'source:' + publication.version.versionId; if (busy.has(name) || button.dataset.loaded) return;
    button.disabled = true;
    return read(name, '/api/business-outcomes/versions/' + encodeURIComponent(publication.version.versionId), result => {
      if (result.source !== 'immutable_business_outcome_version' || result.currentStatus !== 'not_checked' || !validPublication(result.publication) || result.publication.version.versionId !== publication.version.versionId || result.publication.version.digest !== publication.version.digest || result.sourceMeasurement?.digest !== publication.version.source.measurementDigest || result.sourceMeasurement?.workspaceId !== context().workspaceId) throw new Error('Evidence mismatch');
      const m = result.sourceMeasurement;
      target.innerHTML = `<h4>Retained immutable source</h4><p class="muted tiny">Historical evidence; current status has not been rechecked. Owner/admin recorded report, not independent source verification.</p>${facts(m)}<p>Costs: ${m.report?.costsComplete === true ? 'Complete (reported)' : 'Unknown'}</p><p class="outcome-description">${esc(bounded(m.report?.description))}</p>`;
      button.dataset.loaded = 'true'; button.textContent = 'Retained source loaded';
    }).finally(() => { if (button.isConnected && !button.dataset.loaded) button.disabled = false; });
  }
  function reset() {
    if (!api) return;
    const sameSession = scope === key(context()) && session === context().session;
    const retained = sameSession && pending?.attempted ? pending : null;
    invalidate(); if (!sameSession) busy.clear(); scope = key(context()); session = context().session; selected = null; overview = null; pending = retained; stale = false;
    $('business-outcomes-panel').open = false; $('business-outcomes-summary').replaceChildren(); renderDetail(); renderReview();
    const experiments = context().experiments || [];
    $('business-outcomes-experiment').innerHTML = '<option value="">Choose an experiment</option>' + experiments.slice(0, 100).map(e => `<option value="${esc(e.id)}">${esc(bounded(e.title || e.id, 180))}</option>`).join('');
    status('Open this panel to load committed results. No background checks.'); controls();
  }
  function pause() {
    if (!api) return;
    invalidate(); if (pending?.attempted) pending.uncertain = true; else pending = null;
    $('business-outcomes-panel').open = false; renderReview(); controls();
  }
  function init(value) {
    api = value;
    $('business-outcomes-panel').addEventListener('toggle', () => {
      if (!$('business-outcomes-panel').open) { invalidate(); if (pending?.attempted) pending.uncertain = true; else pending = null; renderReview(); return; }
      if (scope !== key(context()) || session !== context().session) { reset(); return; }
      if (context().view !== 'revenue-engine') return;
      if (pending) renderReview(); if (!overview) loadOverview(); controls();
    });
    $('business-outcomes-refresh').addEventListener('click', loadOverview);
    $('business-outcomes-load').addEventListener('click', loadDetail);
    $('business-outcomes-experiment').addEventListener('change', () => { if (pending?.attempted) return; invalidate(); pending = null; selected = null; renderDetail(); renderReview(); status('Select Load experiment to read current details.'); });
    $('business-outcomes-form').addEventListener('submit', save);
    $('business-outcomes-form').addEventListener('input', () => { if (!pending?.attempted) { pending = null; renderReview(); } });
    $('business-outcomes-panel').addEventListener('click', event => {
      const action = event.target.closest('[data-outcome-action]'); if (action) review(action.dataset.outcomeAction);
      if (event.target.id === 'business-outcomes-cancel') { if (!pending?.attempted) { pending = null; renderReview(); } else { $('business-outcomes-review').classList.add('hidden'); status('Pending action retained. Reopen the panel to review the same retry.'); } }
      if (event.target.id === 'business-outcomes-confirm') publish();
      const readButton = event.target.closest('[data-outcome-evidence]'); if (readButton) { const i = Number(readButton.dataset.outcomeEvidence); if (overview?.current[i]) evidence(overview.current[i], readButton.nextElementSibling, readButton); }
      const current = event.target.closest('[data-outcome-source-current]'); if (current && selected?.currentPublication) evidence(selected.currentPublication, $('business-outcomes-current-source'), current);
    });
    $('business-outcomes-review').addEventListener('change', controls);
    reset();
  }
  window.RunvaraOutcomes = Object.freeze({ init, reset, pause });
})();
