(() => {
  'use strict';
  let api, data;
  const $ = id => document.getElementById(id);
  const esc = value => api.escapeHtml(value);
  const empty = message => `<p class="empty-state">${esc(message)}</p>`;
  const tag = (value, severity) => `<span class="tag ${['critical', 'high', 'FAILED'].includes(severity || value) ? 'bad' : ['COMPLETED', 'resolved'].includes(value) ? 'good' : 'warn'}">${esc(value)}</span>`;
  const evidence = items => `<details class="evidence"><summary>Evidence (${(items || []).length})</summary>${(items || []).map(item => `<p><b>${esc(item.type)} · ${esc(item.id)}</b><br>${esc(item.detail || '')}${item.at ? `<br><small>${esc(api.date(item.at))}</small>` : ''}</p>`).join('') || '<p>No supporting evidence recorded.</p>'}</details>`;
  const history = items => `<details class="evidence"><summary>History (${(items || []).length})</summary>${(items || []).map(item => `<p>${esc(item.status || `Revision ${item.revision}`)} · ${esc(item.actor)} · ${esc(api.date(item.at))}<br>${esc(item.note || item.action || '')}</p>`).join('')}</details>`;
  const canManage = () => ['owner', 'admin'].includes(data?.user?.role);
  const canWrite = () => data?.user?.role !== 'viewer';

  function render(next) {
    data = next;
    const active = (data.exceptions || []).filter(item => item.present && ['open', 'acknowledged'].includes(item.status));
    const pending = (data.approvals || []).filter(item => item.status === 'pending');
    $('attention-queue').innerHTML = `<div class="section-head"><div><p class="eyebrow">NEEDS YOUR ATTENTION</p><h2>${active.length} exceptions · ${pending.length} approvals</h2></div>${tag(data.autopilot?.enabled ? 'Autopilot ON' : 'Autopilot OFF')}</div><div class="attention-links">${active.slice(0, 3).map(item => `<button class="attention-item" data-view-link="issues">${tag(item.severity, item.severity)}<span>${esc(item.title)}</span><span>Review →</span></button>`).join('')}${pending.slice(0, 2).map(item => `<button class="attention-item" data-view-link="approvals">${tag('Approval')}<span>${esc(item.action)}</span><span>Decide →</span></button>`).join('') || empty('No recorded exceptions or approvals need attention.')}</div>`;
    renderExceptions(); renderOpportunities(); renderDecisions(); renderAutopilot(); renderValue(); renderAgentSettings();
    $('approval-list').querySelectorAll('[data-approval]').forEach(button => { button.disabled = data.user?.role !== 'owner'; });
  }

  function renderExceptions() {
    const filter = $('exception-filter').value;
    const items = (data.exceptions || []).filter(item => filter === 'all' || item.present && ['open', 'acknowledged'].includes(item.status));
    $('exception-list').innerHTML = items.map(item => `<article class="control-record"><div class="section-head"><h3>${esc(item.title)}</h3>${tag(item.severity, item.severity)}</div><p>${esc(item.businessImpact)}</p><dl class="record-facts"><div><dt>Root cause</dt><dd>${esc(item.rootCause)}</dd></div><div><dt>Next action</dt><dd>${esc(item.recommendedAction)}</dd></div><div><dt>Owner</dt><dd>${esc(item.owner)}</dd></div><div><dt>Status</dt><dd>${esc(item.status)} · ${item.present ? 'Condition still detected' : 'Condition no longer detected'}</dd></div><div><dt>Last detected</dt><dd>${esc(api.date(item.lastSeenAt))}</dd></div></dl>${evidence(item.evidence)}${history(item.history)}${canWrite() ? `<form class="record-form" data-exception-form="${esc(item.id)}"><label>Status<select name="status">${['acknowledged', 'resolved', 'dismissed', 'open'].map(value => `<option value="${value}">${value}</option>`).join('')}</select></label><label>Owner<input name="owner" value="${esc(item.owner)}" maxlength="160"></label><label class="wide">Resolution / reason<input name="note" maxlength="1000" required placeholder="Record the evidence for this decision"></label><button class="secondary" type="submit">Save status</button></form>` : ''}</article>`).join('') || empty('No exceptions match this view.');
  }

  function renderOpportunities() {
    const items = (data.opportunities || []).filter(item => item.present);
    $('opportunity-list').innerHTML = items.map(item => `<article class="control-record"><div class="section-head"><h3>${esc(item.title)}</h3>${tag(item.status)}</div><p>${esc(item.recommendedNextStep)}</p><dl class="record-facts"><div><dt>Estimated impact</dt><dd>${item.estimatedImpact ? `${esc(api.money(item.estimatedImpact.amount))} per unit. ${esc(item.estimatedImpact.assumptions)}` : 'Not quantified — more source data required.'}</dd></div><div><dt>Effort / risk</dt><dd>${esc(item.effort)} / ${esc(item.risk)}</dd></div><div><dt>Confidence</dt><dd>${Math.round(item.confidence * 100)}% · rule assessment</dd></div></dl>${evidence(item.evidence)}<div class="button-row">${canWrite() && item.status === 'open' ? `<button class="primary" data-opportunity="${esc(item.id)}">Request approval</button>` : '<button class="secondary" data-view-link="approvals">Review approval history</button>'}${canManage() ? `<button class="secondary" data-reject-idea="${esc(item.id)}">Record rejected idea</button>` : ''}</div></article>`).join('') || empty('No supported opportunities are currently detected. New suggestions require recorded business evidence.');
  }

  function renderDecisions() {
    const select = $('decision-category');
    if (!select.options.length) select.innerHTML = (data.decisionCategories || []).map(value => `<option value="${esc(value)}">${esc(value.replaceAll('_', ' '))}</option>`).join('');
    $('decision-form').classList.toggle('hidden', !canManage());
    $('decision-list').innerHTML = (data.decisions || []).map(item => `<article class="control-record"><div class="section-head"><h3>${esc(item.title)}</h3>${tag(item.status)}</div><p>${esc(item.content)}</p><small>${esc(item.category)} · revision ${item.revision} · ${esc(api.date(item.createdAt))}</small><p class="muted">Source: ${esc(item.source)}${item.target ? ` · Target: ${esc(item.target)}` : ''}</p>${item.status === 'active' && item.key !== 'owner-approval-policy' && canManage() ? `<button class="secondary" data-edit-decision="${esc(item.id)}">Edit decision</button>` : ''}</article>`).join('') || empty('No business decisions recorded yet.');
  }

  function renderAutopilot() {
    const pilot = data.autopilot || {};
    $('autopilot-toggle').textContent = pilot.enabled ? 'Turn Autopilot OFF' : 'Turn Autopilot ON';
    $('autopilot-toggle').disabled = !canManage();
    $('autopilot-run').disabled = !canManage() || !pilot.enabled;
    $('autopilot-status').textContent = `${pilot.enabled ? 'ON' : 'OFF'} · Low-risk monitoring · £0 spending permission · Morning brief at 07:00 Europe/London · Last cycle: ${pilot.lastRunAt ? api.date(pilot.lastRunAt) : 'Not run'}`;
    $('autopilot-policies').innerHTML = Object.entries(pilot.rules || {}).map(([id, policy]) => `<form class="record-form control-record" data-policy-form="${esc(id)}"><b class="wide">${esc((data.automationDefinitions || []).find(item => item.id === id)?.name || id)}</b><label>Permission<select name="permitted"><option value="true"${policy.permitted ? ' selected' : ''}>Permitted</option><option value="false"${!policy.permitted ? ' selected' : ''}>Blocked</option></select></label>${id === 'dailyOpsBrief' ? '<p class="muted">Once daily after 07:00 UK time.</p>' : `<label>Interval (minutes)<input name="intervalMinutes" type="number" min="15" max="10080" value="${policy.intervalMinutes}" required></label><label>Maximum runs / UTC day<input name="maxRunsPerDay" type="number" min="1" max="96" value="${policy.maxRunsPerDay}" required></label>`}<button class="secondary" type="submit"${canManage() ? '' : ' disabled'}>Save permission</button></form>`).join('');
  }

  function renderValue() {
    const value = data.value || { actual: {}, estimated: { opportunities: [] } }, actual = value.actual;
    const metrics = [['Tasks automated', actual.tasksAutomated], ['Issues detected', actual.issuesDetected], ['Opportunities generated', actual.opportunitiesGenerated], ['Success rate', actual.automationSuccessRate == null ? 'Not measured' : `${actual.automationSuccessRate}%`], ['Money saved', actual.moneySaved == null ? 'Not verified' : api.money(actual.moneySaved)], ['Revenue created', actual.revenueCreated == null ? 'Not verified' : api.money(actual.revenueCreated)], ['Hours saved', actual.hoursSaved == null ? 'Not verified' : actual.hoursSaved], ['Customer replies sent', actual.customerResponsesHandled]];
    $('value-metrics').innerHTML = metrics.map(([label, amount]) => `<article class="card kpi"><span>${esc(label)}</span><strong>${esc(amount ?? 'Not measured')}</strong><small>Actual recorded value</small></article>`).join('');
    $('value-explanation').textContent = value.explanation || '';
    $('value-estimates').innerHTML = (value.estimated.opportunities || []).map(item => `<p><b>${esc(item.title)}</b><br>${esc(api.money(item.amount))} · ${esc(item.unit)}<br><small>${esc(item.assumptions)}</small></p>`).join('') || empty('No supported financial estimates.');
    $('work-list').innerHTML = (data.workRecords || []).map(item => `<article class="control-record"><div class="section-head"><h3>${esc(item.title)}</h3>${tag(item.status)}</div><small>${esc(item.source)} · ${esc(api.date(item.updatedAt))}</small>${evidence(item.evidence)}${history(item.history)}</article>`).join('') || empty('Completed work will appear with its evidence.');
  }

  function renderAgentSettings() {
    for (const agent of data.aiTeam || []) {
      const card = document.querySelector(`[data-agent-id="${agent.id}"]`);
      if (!card) continue;
      card.insertAdjacentHTML('beforeend', `<form class="agent-controls" data-agent-form="${esc(agent.id)}"><label>Enabled<select name="enabled"><option value="true"${agent.enabled ? ' selected' : ''}>On</option><option value="false"${!agent.enabled ? ' selected' : ''}>Off</option></select></label><label>Autonomy<select name="autonomy">${Object.entries(data.autonomyLevels || {}).map(([level, label]) => `<option value="${level}"${Number(level) === agent.autonomy ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></label><button class="secondary" type="submit"${canManage() ? '' : ' disabled'}>Save</button></form>`);
    }
  }

  async function save(path, method, body, message) {
    const result = await api.request(path, { method, body: JSON.stringify(body) });
    await api.reload({ migrate: false }); api.notify(message); return result;
  }

  function fillDecision(item) {
    const form = $('decision-form'); form.reset(); form.dataset.id = item.id || ''; form.dataset.revision = item.revision || '';
    for (const field of ['key', 'category', 'title', 'content', 'source', 'target', 'value']) if (item[field] != null) form.elements[field].value = item[field];
    form.elements.key.readOnly = Boolean(item.id); api.setView('memory'); form.elements.title.focus();
  }

  function init(config) {
    api = config;
    $('exception-filter').addEventListener('change', renderExceptions);
    document.addEventListener('click', async event => {
      const button = event.target.closest('button'); if (!button || !data) return;
      try {
        if (button.id === 'autopilot-toggle') { button.disabled = true; await save('/api/autopilot', 'PUT', { enabled: !data.autopilot.enabled }, 'Autopilot setting saved.'); }
        if (button.id === 'autopilot-run') { button.disabled = true; const result = await save('/api/autopilot/run', 'POST', {}, 'Monitoring cycle checked. See work evidence for each result.'); if (result.skipped) api.notify(result.reason.replaceAll('_', ' ')); }
        if (button.dataset.opportunity) { button.disabled = true; await save(`/api/opportunities/${encodeURIComponent(button.dataset.opportunity)}/approval`, 'POST', {}, 'Proposal added to the Approval Centre.'); }
        if (button.dataset.editDecision) fillDecision(data.decisions.find(item => item.id === button.dataset.editDecision));
        if (button.id === 'decision-reset') fillDecision({});
        if (button.dataset.rejectIdea) { const item = data.opportunities.find(item => item.id === button.dataset.rejectIdea); fillDecision({ key: `rejected-${item.id.slice(-36)}`, category: 'rejected_idea', title: `Rejected: ${item.title}`.slice(0, 160), target: item.id, source: 'Opportunity review', content: 'Reason for rejecting this idea: ' }); }
        if (button.dataset.modifyApproval) {
          const item = data.approvals.find(item => item.id === button.dataset.modifyApproval), form = $('approval-edit-form');
          form.dataset.id = item.id; form.dataset.revision = item.revision || 1;
          for (const field of ['action', 'reason', 'financialImpact', 'expectedBenefit', 'risk']) form.elements[field].value = item[field] ?? '';
          $('approval-edit-panel').classList.remove('hidden'); form.elements.action.focus(); $('approval-edit-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        if (button.id === 'approval-edit-cancel') $('approval-edit-panel').classList.add('hidden');
      } catch (error) { api.notify(error.message, 'error'); button.disabled = false; }
    });
    document.addEventListener('submit', async event => {
      const form = event.target;
      if (!form.matches('[data-exception-form], [data-policy-form], [data-agent-form], #decision-form, #approval-edit-form')) return;
      event.preventDefault(); const button = form.querySelector('button[type="submit"]'); button.disabled = true;
      const values = Object.fromEntries(new FormData(form));
      try {
        if (form.dataset.exceptionForm) await save(`/api/exceptions/${encodeURIComponent(form.dataset.exceptionForm)}`, 'PATCH', values, 'Exception status and reason saved.');
        if (form.dataset.policyForm) { const changes = { permitted: values.permitted === 'true' }; if (values.intervalMinutes) changes.intervalMinutes = Number(values.intervalMinutes); if (values.maxRunsPerDay) changes.maxRunsPerDay = Number(values.maxRunsPerDay); await save('/api/autopilot', 'PUT', { rules: { [form.dataset.policyForm]: changes } }, 'Autopilot permission saved.'); }
        if (form.dataset.agentForm) await save(`/api/agents/${encodeURIComponent(form.dataset.agentForm)}/settings`, 'PUT', { enabled: values.enabled === 'true', autonomy: Number(values.autonomy) }, 'Agent policy saved.');
        if (form.id === 'decision-form') { const id = form.dataset.id; await save('/api/decision-memory' + (id ? '/' + encodeURIComponent(id) : ''), id ? 'PUT' : 'POST', { ...values, revision: Number(form.dataset.revision) }, 'Decision saved with its history.'); fillDecision({}); }
        if (form.id === 'approval-edit-form') { await save(`/api/approvals/${encodeURIComponent(form.dataset.id)}`, 'PATCH', { ...values, revision: Number(form.dataset.revision) }, 'Approval revised. Review this version before deciding.'); $('approval-edit-panel').classList.add('hidden'); }
      } catch (error) { api.notify(error.message, 'error'); }
      finally { button.disabled = false; }
    });
  }
  window.RunvaraControl = { init, render, evidence, history };
})();
