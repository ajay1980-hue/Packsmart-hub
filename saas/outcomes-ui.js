/* On-demand business results. Server-committed publications are the only result authority. */
(() => {
  'use strict';
  const LIMIT = 20;
  let api, generation = 0, scope = null, session = null, selected = null, overview = null;
  let pending = null, stale = false, busy = new Set(), controllers = new Set();
  let relationship = null, receiptPreview = null, receiptRead = null, receiptEpoch = 0;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const bounded = (value, max = 1000) => String(value ?? '').slice(0, max);
  const unknown = value => value === null || value === undefined || value === '' ? 'Unknown' : bounded(value);
  const amount = value => `${unknown(value?.amount)} ${value?.currency || '(currency unknown)'}`;
  const windowText = value => value ? `${unknown(value.startsAt)} → ${unknown(value.endsAt)} (UTC, end exclusive)` : 'Unknown';
  const METHOD_LABELS = Object.freeze({ reconciled_manual: 'Reconciled records', before_after: 'Before and after', holdout: 'Holdout comparison', unknown: 'Unknown' });
  const labelFrom = (labels, value, fallback) => typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : fallback;
  const methodLabel = value => labelFrom(METHOD_LABELS, value, 'Unknown');
  const coverageLabel = value => labelFrom({ complete: 'Complete', partial: 'Partial', unknown: 'Unknown' }, value, 'Unknown');
  const totalLabel = value => labelFrom({ measured_sum: 'Recorded total', standalone_observations: 'Separate results; no combined total', incomplete_publication_read: 'Results incomplete; total unavailable' }, value, 'Total unavailable');
  const reviewLabel = action => labelFrom({ publish: 'result', correct: 'correction', withdraw: 'withdrawal' }, action, 'result');
  const WITHDRAWAL_REASON_LABELS = Object.freeze({ incorrect_measurement: 'Incorrect measurement', duplicate_observation: 'Duplicate observation', incorrect_scope: 'Incorrect scope', evidence_retracted: 'Evidence retracted' });
  const REASON_LABELS = Object.freeze({
    AMOUNT_UNKNOWN: 'The measured amount is unknown.', CURRENCY_UNKNOWN: 'The currency is unknown.', WINDOW_UNKNOWN: 'The measurement period is unknown.',
    COVERAGE_INCOMPLETE: 'Measurement coverage is incomplete.', METHOD_UNKNOWN: 'The measurement method is unknown.',
    OBSERVATION_TIME_UNKNOWN: 'The observation time is unknown.', OBSERVATION_BEFORE_WINDOW_END: 'The observation time is before the measurement period ends.',
    COSTS_INCOMPLETE: 'Some relevant costs are missing.', COST_COMPLETENESS_UNKNOWN: 'Confirm whether all relevant costs are included.',
    INVALID_OUTCOME_VERSION: 'A saved result could not be checked.', UNPUBLISHED_OUTCOME: 'A result has not completed owner review.',
    PUBLICATION_UNAVAILABLE: 'A saved result could not be loaded.', CONFLICTING_OUTCOME_VERSION: 'Conflicting versions need review.',
    OUTCOME_WITHDRAWN: 'A result was withdrawn.', CURRENT_VERSION_UNPROVED: 'The latest reviewed result could not be checked.',
    UNQUALIFIED_MEASUREMENT: 'Required measurement details are missing.', DUPLICATE_OBSERVATION: 'The same observation appears more than once.',
    DUPLICATE_MEASUREMENT: 'The same measurement appears more than once.', REUSED_MEASUREMENT_REPORT: 'The same report supports more than one result.',
    OVERLAPPING_SCOPE: 'Measurement periods overlap for the same business activity.'
  });
  const reasonLabel = code => labelFrom(REASON_LABELS, code, 'More evidence is needed before this result can be included.');
  const role = () => api.getContext().role;
  const canPrepare = () => ['owner', 'admin'].includes(role());
  const key = c => `${c.workspaceId || ''}:${c.userId || ''}`;
  const context = () => api.getContext();
  const active = ticket => ticket.generation === generation && ticket.scope === key(context()) && ticket.session === context().session && ticket.role === context().role && context().view === 'revenue-engine' && $('business-outcomes-panel').open;
  const ticket = () => ({ generation, scope: key(context()), session: context().session, role: context().role });
  function status(text, error = false) { $('business-outcomes-status').textContent = text; $('business-outcomes-status').classList.toggle('outcome-error', error); }
  function clearRelationship() { relationship = null; $('business-outcomes-relationship')?.remove(); }
  function invalidate() { cancelReceiptRead(); receiptPreview = null; $('business-outcomes-receipt-preview')?.replaceChildren(); generation++; clearRelationship(); controllers.forEach(c => c.abort()); controllers.clear(); for (const name of busy) if (!['save', 'publish'].includes(name)) busy.delete(name); }
  function controls() {
    $('business-outcomes-refresh').disabled = busy.has('overview');
    $('business-outcomes-load').disabled = busy.has('detail') || busy.has('save') || busy.has('publish');
    $('business-outcomes-experiment').disabled = busy.has('save') || busy.has('publish') || Boolean(pending?.attempted);
    $('business-outcomes-form').querySelectorAll('input,select,textarea,button').forEach(el => { el.disabled = !canPrepare() || busy.has('save') || busy.has('publish') || stale || Boolean(pending?.attempted); });
    const saveButton = $('business-outcomes-form').querySelector('button[type="submit"]'); if (saveButton) saveButton.disabled ||= busy.has('receipt');
    if ($('business-outcomes-action')) $('business-outcomes-action').disabled ||= !actionChoices(selected) && !receiptChoices(selected) && !selected?.measurement?.intervention;
    $('business-outcomes-review').querySelectorAll('button,input,textarea').forEach(el => { el.disabled = busy.has('publish'); });
    if (pending?.attempted && $('business-outcomes-reason')) $('business-outcomes-reason').disabled = true;
    const confirm = $('business-outcomes-confirm'); if (confirm) confirm.disabled = busy.has('publish') || !$('business-outcomes-attest').checked;
    $('business-outcomes-detail').querySelectorAll('[data-outcome-action]').forEach(el => { el.disabled = stale || busy.has('save') || busy.has('publish') || Boolean(pending?.attempted); });
    document.querySelectorAll('[data-receipt-read]').forEach(el => { el.disabled = !canPrepare() || stale || busy.has('receipt') || busy.has('save') || busy.has('publish') || Boolean(pending?.attempted); });
    renderWithdrawalReason();
  }
  const ACTION_CONTRACT = 'runvara-reviewed-action/v1';
  const OBJECTIVE_ACTION_CONTRACT = 'runvara-reviewed-action/v2';
  const OBJECTIVE_ASSOCIATION = 'runvara-owner-action-association/v2';
  const RECEIPT_CONTRACT = 'runvara-protected-content-source/v1';
  const protectedMeasurement = m => m?.schema === 'runvara-experiment-measurement/v4';
  const attemptIdentifier = value => typeof value === 'string' && /^content_attempt_[a-f0-9]{64}$/.test(value);
  const receiptSelector = ref => ({ attemptId: ref.attemptId, receiptDigest: ref.receiptDigest, sourceDigest: ref.sourceDigest });
  const sameReceipt = (a, b) => Boolean(a && b) && canonical(a) === canonical(b);
  const receiptRef = value => exact(value, ['schema', 'workspaceId', 'attemptId', 'receiptDigest', 'sourceDigest', 'commitRevision'])
    && value.schema === RECEIPT_CONTRACT && value.workspaceId === context().workspaceId && recordedText(value.workspaceId, 256)
    && value.workspaceId.length > 0 && attemptIdentifier(value.attemptId) && hash(value.receiptDigest) && hash(value.sourceDigest)
    && typeof value.commitRevision === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.commitRevision) && withinBytes(value, 2048);
  const objectiveOrigin = value => value?.origin === 'owner_objective_content';
  const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)
      && Object.getOwnPropertyDescriptor(value, field)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, field), 'value'));
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
  const versionIdentifier = value => typeof value === 'string' && /^outcome_version_[a-f0-9]{64}$/.test(value);
  const productIdentifier = value => typeof value === 'string' && /^gid:\/\/shopify\/Product\/\d+$/.test(value) && value.length <= 160;
  const accountIdentifier = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value) && value.length <= 253;
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  const recordedText = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\u0000') && (!value.isWellFormed || value.isWellFormed());
  const sameRef = (a, b) => a?.workspaceId === b?.workspaceId && a?.id === b?.id && a?.revision === b?.revision && a?.digest === b?.digest;
  const actionRef = value => exact(value, ['workspaceId', 'id', 'revision', 'digest']) && value.workspaceId === context().workspaceId
    && identifier(value.id) && Number.isSafeInteger(value.revision) && value.revision > 0 && hash(value.digest);
  function validAssociation(value, links) {
    const objective = value?.schema === OBJECTIVE_ASSOCIATION;
    return exact(value, ['schema', 'relationship', 'comparison', 'action', 'approval', 'account', 'productId', 'completedAt', 'reuseVersionId', ...(objective ? ['origin', 'originatingObjective'] : [])])
      && (objective ? objectiveOrigin(value) && actionRef(value.originatingObjective) : value.schema === 'runvara-owner-action-association/v1')
      && value.relationship === 'owner_associated_recorded_action'
      && value.comparison === 'not_established' && actionRef(value.action) && value.action.revision === 1 && actionRef(value.approval) && value.approval.revision === 1
      && accountIdentifier(value.account) && productIdentifier(value.productId) && timestamp(value.completedAt)
      && (value.reuseVersionId === null || versionIdentifier(value.reuseVersionId))
      && exact(links, ['action', 'approval', 'objective', 'opportunity']) && actionRef(links.action) && actionRef(links.approval) && sameRef(value.action, links.action)
      && sameRef(value.approval, links.approval) && links.objective === null && links.opportunity === null;
  }
  function measurementAssociation(m) {
    if (!m) return null;
    if (['runvara-experiment-measurement/v2', 'runvara-experiment-measurement/v3', 'runvara-experiment-measurement/v4'].includes(m.schema)) {
      const protectedSource = protectedMeasurement(m), objective = protectedSource ? objectiveOrigin(m.intervention) : m.schema === 'runvara-experiment-measurement/v3';
      if (!validAssociation(m.intervention, m.links) || objective !== (m.intervention.schema === OBJECTIVE_ASSOCIATION)
        || m.report?.schema !== (protectedSource ? 'runvara-measurement-report/v4' : objective ? 'runvara-measurement-report/v3' : 'runvara-measurement-report/v2')
        || !validAssociation(m.report.facts?.intervention, m.links)
        || canonical(m.report.facts.intervention) !== canonical(m.intervention)) throw new Error('Invalid recorded action association');
      if (protectedSource && (!receiptRef(m.receiptSource) || !sameReceipt(m.receiptSource, m.report.facts.receiptSource) || m.receiptSource.sourceDigest !== m.intervention.action.digest)) throw new Error('Invalid protected receipt association');
      if (objective || protectedSource) checkObjectiveMeasurementShape(m);
      return m.intervention;
    }
    if (m.schema !== 'runvara-experiment-measurement/v1' || m.intervention != null || m.links?.action != null || m.links?.approval != null) throw new Error('Invalid unlinked measurement');
    return null;
  }
  function associationFacts(a, receipt = null, historical = false) {
    if (!a) return '<p class="muted">No recorded action associated with this measurement.</p>';
    const rows = [['Recorded action ID', a.action.id], ['Shopify account', a.account], ['Product ID', a.productId], [receipt ? 'Application-observed completion (UTC)' : 'Recorded completion (UTC)', a.completedAt]];
    if (receipt) rows.push(['Protected attempt ID', receipt.attemptId], ['Receipt digest', receipt.receiptDigest], ['Protected source digest', receipt.sourceDigest], ['Protected completion commit revision', receipt.commitRevision]);
    if (objectiveOrigin(a)) {
      rows.push(['Action origin', 'Captured objective-content action'], ['Captured objective ID', a.originatingObjective.id],
        ['Captured objective revision', a.originatingObjective.revision], ['Captured objective definition digest', a.originatingObjective.digest]);
      if (a.approval) rows.push(['Approval ID', a.approval.id], ['Approval revision', a.approval.revision]);
    }
    return '<section class="outcome-association"><h4>Owner-selected recorded action</h4><dl class="outcome-facts">'
      + rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')
      + '</dl><p class="muted tiny">This association does not establish a comparison, causality or commercial benefit. ' + (receipt ? 'The application observed completion; the source was protected at its completion workspace commit. The observation time is not a database commit timestamp. Current status was not checked. Provider authentication is not established.' : historical ? 'This is the exact historical association retained with the reviewed result. Its source is not rechecked during reuse or withdrawal.' : 'The response was recorded by the application; the action snapshot becomes immutable only when the outcome is published.') + '</p>'
      + (objectiveOrigin(a) ? '<p class="muted tiny">The objective reference was captured with the action. It does not establish the current objective definition, objective progress or goal attainment.</p>' : '') + '</section>';
  }
  function actionChoices(detail) {
    if (![ACTION_CONTRACT, OBJECTIVE_ACTION_CONTRACT].includes(detail?.actionLinkContract) || !Array.isArray(detail.actionChoices) || detail.actionChoices.length > LIMIT) return null;
    try { if (new TextEncoder().encode(canonical(detail.actionChoices)).length > 16384) return null; } catch { return null; }
    const ids = new Set();
    for (const choice of detail.actionChoices) {
      const objective = Object.hasOwn(choice || {}, 'origin');
      if (!exact(choice, ['id', 'account', 'productId', 'title', 'completedAt', 'digest', ...(objective ? ['origin', 'originatingObjective'] : [])]) || !identifier(choice.id)
        || (objective && (detail.actionLinkContract !== OBJECTIVE_ACTION_CONTRACT || !objectiveOrigin(choice) || !actionRef(choice.originatingObjective)))
        || ids.has(choice.id) || !accountIdentifier(choice.account) || !productIdentifier(choice.productId)
        || !recordedText(choice.title, 200) || !timestamp(choice.completedAt) || !hash(choice.digest)) return null;
      ids.add(choice.id);
    }
    return detail.actionChoices;
  }
  function currentAssociation(detail) {
    const value = detail?.currentActionAssociation, p = detail?.currentPublication;
    return p && validAssociation(value, p.version.links) && (!objectiveOrigin(value) || detail.actionLinkContract === OBJECTIVE_ACTION_CONTRACT) ? value : null;
  }
  function currentReceiptReference(detail) {
    const m = detail?.measurement, p = detail?.currentPublication;
    return protectedMeasurement(m) && p && (m.digest === p.version.source.measurementDigest || m.intervention.reuseVersionId === p.head.versionId)
      && sameRef(m.intervention.action, currentAssociation(detail)?.action) ? m.receiptSource : null;
  }
  function checkActionCapability(detail) {
    if ((detail?.measurement?.schema === 'runvara-experiment-measurement/v3' || (protectedMeasurement(detail?.measurement) && objectiveOrigin(detail.measurement.intervention)) || detail?.currentActionAssociation?.schema === OBJECTIVE_ASSOCIATION)
      && detail.actionLinkContract !== OBJECTIVE_ACTION_CONTRACT) throw new Error('Objective action storage is unavailable');
  }
  function receiptChoices(detail) {
    if (detail?.receiptLinkContract !== RECEIPT_CONTRACT || !actionChoices(detail) || !Array.isArray(detail.receiptChoices) || detail.receiptChoices.length > LIMIT) return null;
    try {
      if (!withinBytes(detail.receiptChoices, 16384) || typeof detail.hasMoreReceipts !== 'boolean'
        || !(detail.nextReceiptCursor === null || attemptIdentifier(detail.nextReceiptCursor))) return null;
      let previous = null;
      for (const c of detail.receiptChoices) {
        if (!exact(c, ['receiptSource', 'actionId', 'account', 'productId', 'title', 'completedAt', 'origin', 'originatingObjective'])
          || !receiptRef(c.receiptSource) || !identifier(c.actionId) || !accountIdentifier(c.account) || !productIdentifier(c.productId)
          || !recordedText(c.title, 200) || !c.title.trim() || c.title !== c.title.trim() || !timestamp(c.completedAt)
          || !(objectiveOrigin(c) ? detail.actionLinkContract === OBJECTIVE_ACTION_CONTRACT && actionRef(c.originatingObjective) : c.origin === 'owner_manual' && c.originatingObjective === null)
          || (previous && c.receiptSource.attemptId <= previous)) return null;
        previous = c.receiptSource.attemptId;
      }
      if (detail.hasMoreReceipts ? !previous || detail.nextReceiptCursor !== previous : detail.nextReceiptCursor !== null) return null;
      return detail.receiptChoices;
    } catch { return null; }
  }
  function cancelReceiptRead() {
    receiptEpoch++;
    if (receiptRead) { receiptRead.controller.abort(); controllers.delete(receiptRead.controller); receiptRead = null; }
    busy.delete('receipt');
  }
  function populateActionSelection({ preserve = false } = {}) {
    const field = $('business-outcomes-action'), hint = $('business-outcomes-action-hint'), previous = field.value;
    const choices = actionChoices(selected), receipts = receiptChoices(selected), m = measurementAssociation(selected?.measurement), current = currentAssociation(selected);
    const options = [{ value: '', label: 'No recorded action' }];
    if (m) options.push({ value: 'saved', label: `Keep saved ${protectedMeasurement(selected.measurement) ? 'protected receipt' : 'association'} · ${m.action.id} · ${m.account}` });
    if (choices) for (const c of choices) options.push({ value: 'action:' + c.id, label: `${c.id} · ${c.account} · ${c.title}` });
    if (receipts) for (const c of receipts) options.push({ value: 'receipt:' + c.receiptSource.attemptId, label: `Protected completion · ${c.actionId} · ${c.account} · ${c.title}` });
    if (choices && current && selected.currentPublication.head.status === 'published') options.push({ value: 'reuse:' + selected.currentPublication.head.versionId, label: `Reuse exact published snapshot · ${current.action.id} · ${current.account}` });
    field.innerHTML = options.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    field.value = preserve && options.some(o => o.value === previous) ? previous : m ? 'saved' : '';
    hint.textContent = !choices ? 'Recorded action linking is unavailable until compatible storage is installed. Unlinked drafts remain available.'
      : (selected.actionLinkContract === ACTION_CONTRACT ? 'This storage supports manual actions only. Objective action linking requires compatible storage. ' : 'Manual and captured objective actions are supported. ')
        + 'Optional. Choose a recorded action explicitly, then save and review the association. No action is selected for you.';
    if (receipts) hint.textContent += ' Protected completions are shown one page at a time. Preview a chosen receipt before saving. Refresh to see concurrent additions; pages are not a lifetime snapshot.';
    renderActionSelection();
  }
  function selectedReceipt() {
    const value = $('business-outcomes-action').value;
    return value === 'saved' && protectedMeasurement(selected?.measurement) ? selected.measurement.receiptSource
      : value.startsWith('receipt:') ? receiptChoices(selected)?.find(c => c.receiptSource.attemptId === value.slice(8))?.receiptSource ?? null : null;
  }
  function renderActionSelection() {
    const value = $('business-outcomes-action').value, m = measurementAssociation(selected?.measurement), receipts = receiptChoices(selected);
    const c = value.startsWith('action:') ? actionChoices(selected)?.find(row => row.id === value.slice(7))
      : value.startsWith('receipt:') ? receipts?.find(row => row.receiptSource.attemptId === value.slice(8)) : null;
    const association = value === 'saved' ? m : value.startsWith('reuse:') ? currentAssociation(selected)
      : c ? { action: { id: c.id || c.actionId }, account: c.account, productId: c.productId, completedAt: c.completedAt,
        ...(objectiveOrigin(c) ? { origin: c.origin, originatingObjective: c.originatingObjective } : {}) } : null;
    const ref = selectedReceipt(), preview = ref && receiptPreview && sameReceipt(ref, receiptPreview.source.receiptSource) ? receiptPreview : null;
    $('business-outcomes-action-details').innerHTML = associationFacts(association, ref || (value.startsWith('reuse:') ? currentReceiptReference(selected) : null), value.startsWith('reuse:'))
      + (ref ? `<button type="button" class="secondary" data-receipt-read="preview">${value === 'saved' && m.reuseVersionId ? 'View exact reused publication source' : preview ? 'Refresh selected receipt preview' : 'Preview selected protected receipt'}</button><div id="business-outcomes-receipt-preview">${preview?.markup || '<p class="muted">The exact source preview has not been loaded for this selection.</p>'}</div>` : '')
      + (receipts ? `<div class="outcome-actions"><button type="button" class="secondary" data-receipt-read="first">Refresh first receipt page</button>${selected.hasMoreReceipts ? '<button type="button" class="secondary" data-receipt-read="next">Next receipt page</button>' : ''}</div><p class="muted tiny">${receipts.length} protected completion${receipts.length === 1 ? '' : 's'} on this page. ${selected.hasMoreReceipts ? 'More are available.' : 'No further page was reported at this read.'}</p>` : '');
    controls();
  }
  function selectedActionInput() {
    const value = $('business-outcomes-action').value, m = measurementAssociation(selected?.measurement);
    if (!value) return m ? { actionSelection: null } : {};
    const choices = actionChoices(selected), ref = selectedReceipt();
    if (ref && !(value === 'saved' && m.reuseVersionId)) {
      if (!receiptChoices(selected) || !receiptPreview || !sameReceipt(receiptPreview.source.receiptSource, ref)) throw new Error('Preview this exact protected receipt before saving.');
      const receipt = receiptSelector(ref); if (!withinBytes({ receipt }, 512)) throw new Error('Invalid protected receipt selection');
      return { actionSelection: { receipt } };
    }
    if (value.startsWith('receipt:')) throw new Error('Choose a receipt from the current page and preview it before saving.');
    if (!choices) throw new Error('Recorded action linking is unavailable. Refresh after compatible storage is installed, or explicitly choose no action.');
    checkActionCapability(selected);
    if (value === 'saved') {
      if (!m) throw new Error('Refresh the saved association before editing.');
      if (m.reuseVersionId) return { actionSelection: { reuseVersionId: m.reuseVersionId } };
      if (!choices.some(c => c.id === m.action.id && c.digest === m.action.digest)) throw new Error('The saved action is no longer an exact current choice. Explicitly reuse its published snapshot, choose another action, or remove the association.');
      return { actionSelection: { actionId: m.action.id } };
    }
    if (value.startsWith('action:') && choices.some(c => c.id === value.slice(7))) return { actionSelection: { actionId: value.slice(7) } };
    if (value === 'reuse:' + selected.currentPublication?.head.versionId && currentAssociation(selected)
      && selected.currentPublication.head.status === 'published') return { actionSelection: { reuseVersionId: selected.currentPublication.head.versionId } };
    throw new Error('Choose an available recorded action, or leave it unlinked.');
  }
  function selectedActionSnapshot(selection) {
    if (!selection) return null;
    if (selection.receipt) return { ...receiptPreview.source, receiptSource: receiptPreview.source.receiptSource };
    if (selection.actionId) {
      const c = actionChoices(selected)?.find(row => row.id === selection.actionId);
      return c ? { ...c, action: { id: c.id, digest: c.digest } } : null;
    }
    return $('business-outcomes-action').value === 'saved' ? { ...measurementAssociation(selected.measurement), ...(protectedMeasurement(selected.measurement) ? { receiptSource: selected.measurement.receiptSource } : {}) } : currentAssociation(selected);
  }
  function sameSelectedOrigin(before, after, measurement) {
    if (before?.receiptSource && (!protectedMeasurement(measurement) || !sameReceipt(before.receiptSource, measurement.receiptSource) || !sameRef(before.action, after?.action) || !sameRef(before.approval, after?.approval) || ['account', 'productId', 'completedAt'].some(k => before[k] !== after?.[k]))) return false;
    if (!objectiveOrigin(before) && !objectiveOrigin(after)) return true;
    return objectiveOrigin(before) && objectiveOrigin(after) && before.action.id === after.action.id && before.action.digest === after.action.digest
      && ['account', 'productId', 'completedAt'].every(k => before[k] === after[k]) && sameRef(before.originatingObjective, after.originatingObjective);
  }
  // Exact evidence is explicit and display-only. The server validates its
  // authority; these bounds, bindings and hashes also prevent malformed bytes
  // from being presented as the selected immutable source in the browser.
  function canonical(value, depth = 0) {
    if (depth > 16) throw new Error('Evidence nesting is too deep');
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value))) return JSON.stringify(value);
    if (typeof value === 'string' && recordedText(value, 32768)) return JSON.stringify(value);
    if (Array.isArray(value) && value.length <= 50 && Object.keys(value).length === value.length) return '[' + value.map(v => canonical(v, depth + 1)).join(',') + ']';
    if (value && typeof value === 'object' && !Array.isArray(value) && exact(value, Object.keys(value))) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
    throw new Error('Invalid evidence JSON');
  }
  async function digest(value, stringified = false) {
    if (!window.crypto?.subtle) throw new Error('Evidence integrity cannot be checked in this browser');
    const bytes = new TextEncoder().encode(stringified ? value : canonical(value));
    return Array.from(new Uint8Array(await window.crypto.subtle.digest('SHA-256', bytes)), v => v.toString(16).padStart(2, '0')).join('');
  }
  const withinBytes = (value, maximum) => new TextEncoder().encode(canonical(value)).length <= maximum;
  const positiveRevision = value => Number.isSafeInteger(value) && value > 0;
  const count = value => value === null || (Number.isSafeInteger(value) && value >= 0 && value <= 1000000000);
  function checkObjectiveMeasurementShape(m) {
    const r = m.report, p = m.provenance, f = r?.facts, receiptFields = protectedMeasurement(m) ? ['receiptSource'] : [];
    if (!exact(m, ['schema', 'workspaceId', 'experimentId', 'revision', 'recordedBy', 'recordedAt', 'metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'links', 'report', 'intervention', 'digest', ...receiptFields])
      || m.workspaceId !== context().workspaceId || !identifier(m.experimentId) || !positiveRevision(m.revision)
      || !identifier(m.recordedBy) || !timestamp(m.recordedAt) || !hash(m.digest) || !withinBytes(m, 8192)
      || m.metric !== 'incrementalContribution' || !(m.amount === null || (typeof m.amount === 'string' && /^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(m.amount)))
      || !(m.currency === null || (typeof m.currency === 'string' && /^[A-Z]{3}$/.test(m.currency)))
      || !(m.window === null || (exact(m.window, ['startsAt', 'endsAt']) && timestamp(m.window.startsAt) && timestamp(m.window.endsAt)
        && m.window.startsAt < m.window.endsAt && Date.parse(m.window.endsAt) - Date.parse(m.window.startsAt) <= 366 * 86400000))
      || !exact(m.coverage, ['status', 'scopeId', 'observedCount', 'expectedCount']) || !['complete', 'partial', 'unknown'].includes(m.coverage.status)
      || !identifier(m.coverage.scopeId) || !count(m.coverage.observedCount) || !count(m.coverage.expectedCount)
      || !exact(m.method, ['kind', 'definitionVersion']) || !Object.hasOwn(METHOD_LABELS, m.method.kind) || m.method.definitionVersion !== 'incremental-contribution/v1'
      || !exact(p, ['observationId', 'sourceRefs', 'observedAt', 'aggregation']) || !identifier(p.observationId) || p.aggregation !== 'standalone'
      || !(p.observedAt === null || timestamp(p.observedAt)) || (p.observedAt && p.observedAt > m.recordedAt)
      || !Array.isArray(p.sourceRefs) || p.sourceRefs.length !== 1 || !exact(p.sourceRefs[0], ['type', 'id', 'digest'])
      || !exact(r, ['schema', 'id', 'workspaceId', 'experimentId', 'measurementRevision', 'recordedBy', 'recordedAt', 'description', 'costsComplete', 'facts', 'digest'])
      || r.workspaceId !== m.workspaceId || r.experimentId !== m.experimentId || r.measurementRevision !== m.revision
      || r.recordedBy !== m.recordedBy || r.recordedAt !== m.recordedAt || !identifier(r.id) || !hash(r.digest)
      || !recordedText(r.description, 1000) || !r.description.trim() || r.description.trim() !== r.description || /[\u0000-\u001f\u007f]/.test(r.description)
      || ![true, false, null].includes(r.costsComplete) || !exact(f, ['metric', 'amount', 'currency', 'window', 'coverage', 'method', 'observedAt', 'intervention', ...receiptFields])
      || ['metric', 'amount', 'currency', 'window', 'coverage', 'method', 'intervention'].some(k => canonical(f[k]) !== canonical(m[k]))
      || f.observedAt !== p.observedAt || p.sourceRefs[0].type !== 'measurement_report' || p.sourceRefs[0].id !== r.id || p.sourceRefs[0].digest !== r.digest
      || m.intervention.completedAt > m.recordedAt) throw new Error('Invalid public objective measurement');
    const c = m.coverage;
    if ((c.observedCount !== null && c.expectedCount !== null && c.observedCount > c.expectedCount)
      || (c.status === 'complete' && (c.observedCount === null || c.expectedCount === null || c.observedCount !== c.expectedCount))
      || (c.status === 'complete' && c.observedCount === 0 && m.amount !== null && m.amount !== '0')
      || (c.status === 'partial' && c.observedCount !== null && c.expectedCount !== null && c.observedCount >= c.expectedCount)) throw new Error('Invalid public coverage');
  }
  async function checkObjectiveMeasurement(m) {
    measurementAssociation(m);
    if (m?.schema !== 'runvara-experiment-measurement/v3' && !protectedMeasurement(m)) return;
    const { digest: recordedDigest, ...body } = m, { digest: reportDigest, ...report } = m.report;
    if (await digest(body) !== recordedDigest || await digest(report) !== reportDigest
      || m.report.id !== 'measurement_report_' + await digest([m.workspaceId, m.experimentId, m.revision])
      || m.provenance.observationId !== 'measurement_observation_' + await digest([m.workspaceId, m.experimentId])
      || m.coverage.scopeId !== 'whole_business_' + await digest([m.workspaceId, 'whole-business'])) throw new Error('Changed public measurement evidence');
  }
  async function checkObjectivePublication(publication, m = null) {
    const v = publication.version, h = publication.head, s = v.source, a = v.verification, l = v.lineage;
    if (!validPublication(publication) || !exact(publication, ['head', 'version'])
      || !exact(h, ['schema', 'workspaceId', 'outcomeId', 'revision', 'versionId', 'digest', 'status', 'publicationId', 'committedAt', 'commitRevision'])
      || h.schema !== 'runvara-outcome-head/v1' || h.outcomeId !== v.outcomeId || h.revision !== v.revision
      || !identifier(h.publicationId) || !identifier(h.commitRevision) || !timestamp(h.committedAt)
      || !exact(v, ['schema', 'workspaceId', 'outcomeId', 'versionId', 'digest', 'revision', 'status', 'source', 'metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'verification', 'links', 'lineage', 'publicationAuthority', 'sourceReferencesResolved', 'runvaraAttribution'])
      || v.schema !== 'runvara-business-outcome/v1' || !positiveRevision(v.revision) || !hash(v.digest) || !versionIdentifier(v.versionId) || !withinBytes(v, 16384)
      || !['recorded', 'withdrawn'].includes(v.status) || publication.head.status !== (v.status === 'withdrawn' ? 'withdrawn' : 'published')
      || v.publicationAuthority !== false || v.sourceReferencesResolved !== false || v.runvaraAttribution !== 'unestablished'
      || !exact(s, ['type', 'experimentId', 'measurementRevision', 'measurementDigest']) || s.type !== 'experiment_measurement'
      || !identifier(s.experimentId) || !positiveRevision(s.measurementRevision) || !hash(s.measurementDigest)
      || !exact(a, ['kind', 'actorId', 'verifiedAt', 'measurementDigest']) || a.kind !== 'owner_attestation'
      || !identifier(a.actorId) || !timestamp(a.verifiedAt) || a.verifiedAt > h.committedAt || a.measurementDigest !== s.measurementDigest
      || !exact(l, ['previousVersionId', 'previousDigest', 'previousRevision', 'reason'])) throw new Error('Invalid public outcome version');
    if (v.revision === 1 ? v.status !== 'recorded' || l.previousVersionId !== null || l.previousDigest !== null || l.previousRevision !== null || l.reason !== 'initial'
      : !versionIdentifier(l.previousVersionId) || !hash(l.previousDigest) || l.previousRevision !== v.revision - 1
        || !(v.status === 'recorded' ? l.reason === 'correction' : ['incorrect_measurement', 'duplicate_observation', 'incorrect_scope', 'evidence_retracted'].includes(l.reason))) throw new Error('Invalid public outcome lineage');
    if (m && (s.experimentId !== m.experimentId || s.measurementRevision !== m.revision || s.measurementDigest !== m.digest
      || ['metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'links'].some(k => canonical(v[k]) !== canonical(m[k])))) throw new Error('Public outcome measurement mismatch');
    const { digest: recordedDigest, versionId, ...body } = v;
    if (await digest(body) !== recordedDigest || v.outcomeId !== 'outcome_' + await digest([v.workspaceId, 'experiment_measurement', s.experimentId, v.metric])
      || versionId !== 'outcome_version_' + await digest([v.outcomeId, v.revision, recordedDigest])
      || (v.revision > 1 && l.previousVersionId !== 'outcome_version_' + await digest([v.outcomeId, l.previousRevision, l.previousDigest]))) throw new Error('Changed public outcome evidence');
  }
  async function objectiveSourceMarkup(source, m, publication, association) {
    if (!validAssociation(association, publication.version.links)
      || !exact(source, ['schema', 'action', 'approval', 'origin', 'originatingObjective', 'account', 'productId', 'completedAt', 'input', 'decision', 'policies', 'validation'])
      || source.schema !== 'runvara-reviewed-source-action-display/v2' || !objectiveOrigin(source) || !withinBytes(source, 24576)
      || !actionRef(source.action) || !sameRef(source.action, association.action) || !actionRef(source.approval) || !sameRef(source.approval, association.approval)
      || !actionRef(source.originatingObjective) || !sameRef(source.originatingObjective, association.originatingObjective)
      || ['account', 'productId', 'completedAt'].some(k => source[k] !== association[k])) throw new Error('Invalid public action evidence');
    const i = source.input, d = source.decision, v = source.validation;
    if (!exact(i, ['productId', 'operation', 'title', 'description']) || i.productId !== association.productId || i.operation !== 'product_content'
      || !recordedText(i.title, 200) || !i.title.trim() || i.title !== i.title.trim() || !recordedText(i.description, 10000)
      || !exact(d, ['status', 'decidedBy', 'decidedAt']) || d.status !== 'approved' || !identifier(d.decidedBy) || !timestamp(d.decidedAt) || d.decidedAt > source.completedAt
      || !Array.isArray(source.policies) || !source.policies.length || source.policies.length > 50
      || source.policies.some(p => !exact(p, ['objectiveId', 'revision', 'digest']) || !identifier(p.objectiveId) || !positiveRevision(p.revision) || !hash(p.digest))
      || new Set(source.policies.map(p => p.objectiveId)).size !== source.policies.length
      || !source.policies.some(p => p.objectiveId === source.originatingObjective.id && p.revision === source.originatingObjective.revision && p.digest === source.originatingObjective.digest)
      || !exact(v, ['snapshot', 'currentStatus', 'providerAuthentication', 'causalAttribution']) || v.snapshot !== 'server_validated_immutable_publication'
      || v.currentStatus !== 'not_checked' || v.providerAuthentication !== 'not_established' || v.causalAttribution !== 'not_established') throw new Error('Invalid public action details');
    await checkObjectiveMeasurement(m); await checkObjectivePublication(publication, m);
    const refs = [['Action snapshot reference', source.action.digest], ['Approval decision reference', source.approval.digest], ['Approved by', d.decidedBy], ['Recorded approval (UTC)', d.decidedAt]];
    return `${associationFacts(association)}<h4>Exact recorded action input</h4><p class="muted tiny">Historical snapshot retained with this outcome version. Current status was not checked. The server validated the complete private action snapshot before returning this public view. This browser checks the public references and measurement hashes; it cannot recompute the private action snapshot digest. Provider authentication is not established.</p><dl class="outcome-facts"><div><dt>Product title</dt><dd class="outcome-description">${esc(i.title)}</dd></div><div><dt>Product description</dt><dd class="outcome-description">${esc(i.description)}</dd></div>${refs.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><h4>Captured objective policy references</h4><ul>${source.policies.map(p => `<li>${esc(p.objectiveId)} · revision ${esc(p.revision)} · ${esc(p.digest)}</li>`).join('')}</ul>`;
  }
  function protectedSourceMarkup(source, association = null, ref = null) {
    if (!exact(source, ['schema', 'receiptSource', 'action', 'approval', 'origin', 'originatingObjective', 'account', 'productId', 'completedAt', 'input', 'decision', 'policies', 'validation'])
      || source.schema !== 'runvara-protected-content-source-display/v1' || !withinBytes(source, 36 * 1024)
      || !receiptRef(source.receiptSource) || (ref && !sameReceipt(source.receiptSource, ref))
      || !actionRef(source.action) || source.action.revision !== 1 || source.action.digest !== source.receiptSource.sourceDigest
      || !actionRef(source.approval) || source.approval.revision !== 1 || !accountIdentifier(source.account) || !productIdentifier(source.productId) || !timestamp(source.completedAt)
      || !(objectiveOrigin(source) ? actionRef(source.originatingObjective) : source.origin === 'owner_manual' && source.originatingObjective === null)) throw new Error('Invalid protected source display');
    if (association && (!sameRef(source.action, association.action) || !sameRef(source.approval, association.approval)
      || objectiveOrigin(source) !== objectiveOrigin(association) || (objectiveOrigin(source) && !sameRef(source.originatingObjective, association.originatingObjective))
      || ['account', 'productId', 'completedAt'].some(k => source[k] !== association[k]))) throw new Error('Protected source association mismatch');
    const i = source.input, d = source.decision, v = source.validation;
    if (!exact(i, ['productId', 'operation', 'title', 'description']) || i.productId !== source.productId || i.operation !== 'product_content'
      || !recordedText(i.title, 200) || !i.title.trim() || i.title !== i.title.trim() || !recordedText(i.description, 10000)
      || !exact(d, ['status', 'decidedBy', 'decidedAt']) || d.status !== 'approved' || !identifier(d.decidedBy) || !timestamp(d.decidedAt) || d.decidedAt > source.completedAt
      || !Array.isArray(source.policies) || source.policies.length > 50
      || source.policies.some(p => !exact(p, ['objectiveId', 'revision', 'digest']) || !identifier(p.objectiveId) || !positiveRevision(p.revision) || !hash(p.digest))
      || new Set(source.policies.map(p => p.objectiveId)).size !== source.policies.length
      || (objectiveOrigin(source) && !source.policies.some(p => p.objectiveId === source.originatingObjective.id && p.revision === source.originatingObjective.revision && p.digest === source.originatingObjective.digest))
      || !exact(v, ['protection', 'currentStatus', 'providerAuthentication', 'causalAttribution']) || v.protection !== 'completion_workspace_commit'
      || v.currentStatus !== 'not_checked' || v.providerAuthentication !== 'not_established' || v.causalAttribution !== 'not_established') throw new Error('Invalid protected source details');
    const refs = [['Action snapshot reference', source.action.digest], ['Approval decision reference', source.approval.digest], ['Approved by', d.decidedBy], ['Recorded approval (UTC)', d.decidedAt]];
    return `<h4>Exact protected action input</h4><p class="muted tiny">The server validated this protected source before returning this display. Browser checks of public references do not authenticate the provider or establish current eligibility, causality or financial qualification.</p><dl class="outcome-facts"><div><dt>Product title</dt><dd class="outcome-description">${esc(i.title)}</dd></div><div><dt>Product description</dt><dd class="outcome-description">${esc(i.description)}</dd></div>${refs.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`
      + (source.policies.length ? `<h4>Captured policy references</h4><ul>${source.policies.map(p => `<li>${esc(p.objectiveId)} · revision ${esc(p.revision)} · ${esc(p.digest)}</li>`).join('')}</ul>` : '')
      + (objectiveOrigin(source) ? '' : '<p class="muted tiny">Manual action. Any captured policy references describe restrictions; they do not establish an originating objective.</p>');
  }
  function checkReceiptReview(detail, { expectedReceipt = null, afterAttemptId = null, allowSavedMissing = false } = {}) {
    const marker = detail?.receiptLinkContract;
    if (marker === undefined || marker === null) {
      if (protectedMeasurement(detail?.measurement) || detail?.selectedReceiptSource != null || (detail?.receiptChoices?.length ?? 0) > 0 || expectedReceipt || afterAttemptId) throw new Error('Protected source storage is unavailable');
      return null;
    }
    if (marker !== RECEIPT_CONTRACT || !withinBytes(detail, 128 * 1024) || !receiptChoices(detail)) throw new Error('Unsupported protected source review');
    if (afterAttemptId && detail.receiptChoices.some(c => c.receiptSource.attemptId <= afterAttemptId)) throw new Error('Receipt page did not advance');
    const source = detail.selectedReceiptSource;
    const ref = expectedReceipt || (protectedMeasurement(detail.measurement) ? detail.measurement.receiptSource : null);
    if (source === null) { if (expectedReceipt || (ref && !allowSavedMissing && !detail.measurement?.intervention?.reuseVersionId)) throw new Error('Protected receipt preview is missing'); return null; }
    if (!ref || !source) throw new Error('Unexpected protected receipt preview');
    const association = !expectedReceipt && protectedMeasurement(detail.measurement) ? measurementAssociation(detail.measurement) : null;
    const markup = protectedSourceMarkup(source, association, ref);
    if (expectedReceipt) {
      const c = receiptChoices(selected)?.find(row => sameReceipt(row.receiptSource, ref));
      if (c && (c.actionId !== source.action.id || c.origin !== source.origin || c.title !== source.input.title || ['account', 'productId', 'completedAt'].some(k => c[k] !== source[k])
        || (objectiveOrigin(c) && !sameRef(c.originatingObjective, source.originatingObjective)))) throw new Error('Receipt preview changed the selected choice');
    }
    return { source, markup };
  }
  const reviewFence = detail => canonical({ workspaceRevision: detail.workspaceRevision, experimentId: detail.experiment.id,
    measurementRevision: detail.measurement?.revision ?? null, measurementDigest: detail.measurement?.digest ?? null,
    versionId: detail.currentPublication?.head.versionId ?? null, versionDigest: detail.currentPublication?.head.digest ?? null });
  async function readReceipt(kind) {
    if (!selected || !canPrepare() || stale || pending?.attempted || busy.has('receipt') || busy.has('save') || busy.has('publish') || !receiptChoices(selected)) return;
    const ref = kind === 'preview' ? selectedReceipt() : null, cursor = kind === 'next' ? selected.nextReceiptCursor : null;
    if (kind === 'preview' && !ref || kind === 'next' && (!selected.hasMoreReceipts || !cursor) || !['preview', 'first', 'next'].includes(kind)) return;
    cancelReceiptRead(); receiptPreview = null; pending = null; renderReview(); renderActionSelection();
    const t = ticket(), epoch = receiptEpoch, id = selected.experiment.id, fence = reviewFence(selected), value = $('business-outcomes-action').value;
    const controller = new AbortController(); receiptRead = { controller, epoch }; controllers.add(controller); busy.add('receipt'); controls();
    const isCurrent = () => active(t) && epoch === receiptEpoch && selected?.experiment?.id === id && $('business-outcomes-action').value === value;
    status(kind === 'preview' ? 'Loading the exact protected receipt preview…' : 'Loading the requested receipt page…');
    try {
      const reuseVersion = kind === 'preview' && value === 'saved' ? selected.measurement?.intervention?.reuseVersionId : null;
      if (reuseVersion) {
        const result = await api.request('/api/business-outcomes/versions/' + encodeURIComponent(reuseVersion), { signal: controller.signal, isCurrent });
        if (!isCurrent()) return;
        if (!withinBytes(result, 128 * 1024) || !exact(result, ['publication', 'sourceMeasurement', 'sourceAction', 'currentStatus', 'source'])
          || result.source !== 'immutable_business_outcome_version' || result.currentStatus !== 'not_checked'
          || result.publication?.version?.versionId !== reuseVersion || result.sourceMeasurement?.experimentId !== id
          || !protectedMeasurement(result.sourceMeasurement) || !sameReceipt(result.sourceMeasurement.receiptSource, ref)) throw new Error('Invalid reused protected source');
        await sourceActionMarkup(result.sourceAction, result.sourceMeasurement, result.publication);
        const markup = protectedSourceMarkup(result.sourceAction, measurementAssociation(selected.measurement), ref);
        if (!isCurrent()) return;
        receiptPreview = { source: result.sourceAction, markup }; renderActionSelection(); status('Exact reused publication source loaded. Its current receipt status was not rechecked.'); return;
      }
      const result = await api.request('/api/business-outcomes/experiments/' + encodeURIComponent(id) + '/content-sources', {
        method: 'POST', body: JSON.stringify({ receipt: ref ? receiptSelector(ref) : null, afterAttemptId: cursor }), signal: controller.signal, isCurrent });
      if (!isCurrent()) return;
      if (result.workspaceId !== context().workspaceId || result.experiment?.id !== id || reviewFence(result) !== fence) {
        stale = true; clearRelationship(); status('The experiment changed while loading receipts. Reload it before saving or reviewing.', true); return;
      }
      checkActionCapability(result); await checkObjectiveMeasurement(result.measurement);
      const preview = checkReceiptReview(result, { expectedReceipt: ref, afterAttemptId: cursor, allowSavedMissing: kind !== 'preview' });
      if (!isCurrent()) return;
      if (kind === 'preview') { receiptPreview = preview; renderActionSelection(); status('Exact protected receipt preview loaded. Save the draft to associate it.'); }
      else {
        selected = { ...selected, receiptChoices: result.receiptChoices, nextReceiptCursor: result.nextReceiptCursor, hasMoreReceipts: result.hasMoreReceipts, selectedReceiptSource: result.selectedReceiptSource };
        receiptPreview = preview; populateActionSelection({ preserve: false });
        status('Receipt page loaded. Choose and preview a protected completion explicitly; draft fields were kept.');
      }
    } catch (error) { if (isCurrent()) { receiptPreview = null; renderActionSelection(); status('Could not load the protected receipt. Reload the experiment before trying again.', true); } }
    finally { controllers.delete(controller); if (receiptRead?.epoch === epoch) { receiptRead = null; busy.delete('receipt'); if (active(t)) controls(); } }
  }
  async function sourceActionMarkup(source, m, publication) {
    const a = measurementAssociation(m);
    if (!a) { if (source != null || publication.version.links?.action != null || publication.version.links?.approval != null) throw new Error('Unexpected linked evidence'); return ''; }
    if (protectedMeasurement(m)) {
      if (!validAssociation(a, publication.version.links)) throw new Error('Protected publication association mismatch');
      const markup = protectedSourceMarkup(source, a, m.receiptSource);
      await checkObjectiveMeasurement(m); await checkObjectivePublication(publication, m);
      return associationFacts(a, m.receiptSource) + markup;
    }
    if (objectiveOrigin(a)) return objectiveSourceMarkup(source, m, publication, a);
    if (!validAssociation(a, publication.version.links) || !exact(source, ['schema', 'revision', 'context', 'input', 'digest'])
      || source.schema !== 'runvara-reviewed-source-action/v1' || source.revision !== 1 || source.digest !== a.action.digest
      || new TextEncoder().encode(canonical(source)).length > 24576) throw new Error('Linked evidence mismatch');
    const c = source.context, i = source.input, approval = c?.approval;
    if (!exact(c, ['schema', 'workspaceId', 'writeId', 'requestId', 'claimId', 'claimIdentity', 'provider', 'operation', 'connectionId', 'account', 'apiVersion', 'requestedBy', 'executedBy', 'inputDigest', 'phase', 'dispatchRequestDigest', 'resultId', 'completedAt', 'origin', 'originatingObjective', 'approval', 'proposal', 'policies'])
      || c.schema !== 'runvara-recorded-action-context/v1' || c.workspaceId !== context().workspaceId || c.writeId !== a.action.id
      || !['requestId', 'claimId', 'connectionId', 'requestedBy', 'executedBy'].every(k => identifier(c[k]))
      || c.provider !== 'shopify' || c.operation !== 'product_content' || c.phase !== 'shopify_mutation'
      || c.origin !== 'owner_manual' || c.originatingObjective !== null || c.account !== a.account || c.completedAt !== a.completedAt
      || !/^[a-zA-Z0-9_-]{16,100}$/.test(c.requestId) || !hash(c.claimIdentity) || !/^\d{4}-(01|04|07|10)$/.test(c.apiVersion)
      || !hash(c.inputDigest) || !hash(c.dispatchRequestDigest) || !exact(i, ['productId', 'operation', 'title', 'description'])
      || i.productId !== a.productId || c.resultId !== i.productId || i.operation !== 'product_content'
      || !recordedText(i.title, 200) || !i.title.trim() || i.title !== i.title.trim() || !recordedText(i.description, 10000)
      || !exact(approval, ['workspaceId', 'id', 'revision', 'status', 'decidedBy', 'decidedAt', 'payload', 'digest'])
      || !sameRef(approval, a.approval) || approval.status !== 'approved' || !identifier(approval.decidedBy) || !timestamp(approval.decidedAt) || approval.decidedAt > c.completedAt
      || ![2, 3].includes(Object.keys(approval.payload || {}).length)
      || !exact(approval.payload, Object.hasOwn(approval.payload || {}, 'objectivePolicyProposalDigest') ? ['connectionWriteId', 'digest', 'objectivePolicyProposalDigest'] : ['connectionWriteId', 'digest'])
      || approval.payload.connectionWriteId !== c.writeId || approval.payload.digest !== c.inputDigest
      || !Array.isArray(c.policies) || c.policies.length > 50 || c.policies.some(p => !exact(p, ['objectiveId', 'revision', 'digest']) || !identifier(p.objectiveId) || !Number.isSafeInteger(p.revision) || p.revision < 1 || !hash(p.digest))) throw new Error('Invalid recorded action evidence');
    if (new Set(c.policies.map(p => p.objectiveId)).size !== c.policies.length) throw new Error('Duplicate policy references');
    const proposal = c.proposal;
    if (proposal === null) { if (c.policies.length || Object.hasOwn(approval.payload, 'objectivePolicyProposalDigest')) throw new Error('Unexpected policy reference'); }
    else if (!exact(proposal, ['schema', 'workspaceId', 'origin', 'writeId', 'provider', 'operation', 'inputDigest', 'connectionId', 'account', 'requestedBy', 'approvalKind', 'policies', 'evidenceQualification', 'digest'])
      || proposal.schema !== 'runvara-objective-dispatch-proposal/v1' || proposal.approvalKind !== 'customer_facing_publish'
      || proposal.evidenceQualification !== 'no_financial_execution_evidence' || !c.policies.length
      || !['workspaceId', 'origin', 'writeId', 'provider', 'operation', 'inputDigest', 'connectionId', 'account', 'requestedBy'].every(k => proposal[k] === c[k])
      || canonical(proposal.policies) !== canonical(c.policies) || proposal.digest !== approval.payload.objectivePolicyProposalDigest) throw new Error('Invalid policy proposal');
    const checkTenant = value => { if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { if (['workspaceId', 'workspace_id', 'tenantId', 'tenant_id'].includes(k) && v !== context().workspaceId) throw new Error('Foreign action evidence'); if (['workspace', 'tenant'].includes(k) && (v && typeof v === 'object' ? v.id : v) !== context().workspaceId) throw new Error('Foreign action evidence'); checkTenant(v); } };
    checkTenant(source);
    const { digest: sourceDigest, ...body } = source, { digest: approvalDigest, ...decision } = approval;
    const query = 'mutation RunvaraProductContent($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id title } userErrors { field message } } }';
    const variables = { product: { id: i.productId, title: i.title, descriptionHtml: `<p>${i.description.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/\n/g, '<br>')}</p>` } };
    const request = { provider: 'shopify', phase: 'shopify_mutation', method: 'POST', url: `https://${c.account}/admin/api/${c.apiVersion}/graphql.json`, body: JSON.stringify({ query, variables }) };
    // Match the executor's typed JSON.stringify order, not canonical evidence
    // ordering. Older fingerprints never acquire a new interpretation here.
    const orderedInput = { productId: i.productId, operation: i.operation, title: i.title, description: i.description };
    const orderedProposal = proposal === null ? null : { schema: proposal.schema, workspaceId: proposal.workspaceId,
      origin: proposal.origin, writeId: proposal.writeId, provider: proposal.provider, operation: proposal.operation,
      inputDigest: proposal.inputDigest, connectionId: proposal.connectionId, account: proposal.account,
      requestedBy: proposal.requestedBy, approvalKind: proposal.approvalKind,
      policies: proposal.policies.map(p => ({ objectiveId: p.objectiveId, revision: p.revision, digest: p.digest })),
      evidenceQualification: proposal.evidenceQualification, digest: proposal.digest };
    const claim = { id: c.writeId, requestId: c.requestId, provider: c.provider, input: orderedInput, digest: c.inputDigest,
      connectionId: c.connectionId, account: c.account, requestedBy: c.requestedBy, requiresApproval: true, approvalId: approval.id,
      ...(orderedProposal ? { objectivePolicyProposal: orderedProposal } : {}) };
    if (proposal && await digest(Object.fromEntries(Object.entries(proposal).filter(([k]) => k !== 'digest'))) !== proposal.digest) throw new Error('Changed policy proposal');
    if (await digest(body) !== sourceDigest || await digest(decision) !== approvalDigest
      || await digest(JSON.stringify(orderedInput), true) !== c.inputDigest
      || await digest(JSON.stringify(request), true) !== c.dispatchRequestDigest
      || await digest(JSON.stringify(claim), true) !== c.claimIdentity) throw new Error('Changed recorded action evidence');
    return `${associationFacts(a)}<h4>Exact recorded action input</h4><p class="muted tiny">Historical snapshot retained with this outcome version. Current status was not checked. Manual action; objective policy references are restrictions, not an originating objective.</p><dl class="outcome-facts"><div><dt>Product title</dt><dd class="outcome-description">${esc(i.title)}</dd></div><div><dt>Product description</dt><dd class="outcome-description">${esc(i.description)}</dd></div></dl>`;
  }
  function facts(value) {
    const rows = [ ['Incremental contribution', amount(value)], ['Measurement window', windowText(value?.window)],
      ['Coverage', `${coverageLabel(value?.coverage?.status)} · ${unknown(value?.coverage?.observedCount)} / ${unknown(value?.coverage?.expectedCount)}`],
      ['Method', methodLabel(value?.method?.kind)], ['Observed at (UTC)', unknown(value?.provenance?.observedAt)],
      ['Scope', 'Whole business; overlapping periods cannot be added together'], ['Attribution to Runvara', 'Not established'] ];
    return '<dl class="outcome-facts">' + rows.map(([label, text]) => `<div><dt>${esc(label)}</dt><dd>${esc(text)}</dd></div>`).join('') + '</dl>';
  }
  function publicationCard(publication, index) {
    const { head, version } = publication;
    return `<article class="outcome-record"><h4>${head.status === 'withdrawn' ? 'Withdrawn' : 'Owner-reviewed result'} · version ${esc(version.revision)}</h4><p class="muted tiny">Experiment ${esc(bounded(version.source?.experimentId, 180))}</p>${facts(version)}<p class="muted tiny">${head.status === 'withdrawn' ? 'Excluded from recorded totals.' : 'Reviewed by the owner; not independently verified.'}</p><button type="button" class="secondary" data-outcome-evidence="${index}">View original report</button><div data-outcome-evidence-result="${index}"></div></article>`;
  }
  function validPublication(value) {
    return value?.head?.workspaceId === context().workspaceId && value?.version?.workspaceId === context().workspaceId && value.head.versionId === value.version.versionId && value.head.digest === value.version.digest && typeof value.version.versionId === 'string' && value.version.versionId.length <= 180;
  }
  // This display-only projection cannot grant authority or qualify any other
  // result. Accept it only alongside a matching selected-detail read.
  function selectedRelationship(detail) {
    const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
      && Reflect.ownKeys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)
        && Object.getOwnPropertyDescriptor(value, field)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, field), 'value'));
    const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const ref = (value, kind) => typeof value === 'string' && value.startsWith(kind + '_') && hash(value.slice(kind.length + 1));
    const unresolved = value => exact(value, ['status', 'reason', 'identityHash']) && value.status === 'unresolved'
      && value.reason === 'separate_graph_not_resolved' && hash(value.identityHash);
    const r = detail.relationships, p = detail.currentPublication, m = detail.measurement;
    if (!exact(r, ['schema', 'scope', 'snapshot', 'publication', 'nodes', 'edges', 'coverage', 'safeguards'])
      || r.schema !== 'runvara-selected-outcome-relationships/v1' || r.scope !== 'selected_experiment_only'
      || !exact(r.snapshot, ['id', 'workspaceRevisionRef', 'readCompletedAt'])
      || !ref(r.snapshot.id, 'selected_snapshot') || !ref(r.snapshot.workspaceRevisionRef, 'selected_revision')
      || typeof r.snapshot.readCompletedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.snapshot.readCompletedAt)
      || !Number.isFinite(Date.parse(r.snapshot.readCompletedAt))
      || !exact(r.coverage, ['selectedExperimentConfirmed', 'currentHeadChecked', 'wholeGraphSynchronized', 'otherOutcomesChecked', 'crossOutcomeComparabilityChecked'])
      || r.coverage.selectedExperimentConfirmed !== true || r.coverage.currentHeadChecked !== true
      || r.coverage.wholeGraphSynchronized !== false || r.coverage.otherOutcomesChecked !== false || r.coverage.crossOutcomeComparabilityChecked !== false
      || !exact(r.safeguards, ['causalAttribution', 'forecastingAuthorized', 'learningAuthorized', 'executionAuthorized', 'rawIdentifiersIncluded', 'amountsIncluded'])
      || Object.values(r.safeguards).some(value => value !== false)
      || !exact(r.publication, ['state', 'qualification', 'versionDigest', 'draftRelationship', 'draftDigest'])
      || !Array.isArray(r.nodes) || r.nodes.length !== (p ? 2 : 1) || !Array.isArray(r.edges) || r.edges.length !== (p ? 1 : 0)) return null;
    const expectedDraft = !m ? 'no_draft' : !p ? 'no_publication'
      : m.revision === p.version.source?.measurementRevision && m.digest === p.version.source?.measurementDigest ? 'matches_publication' : 'different_from_publication';
    if ((m && !hash(m.digest)) || r.publication.draftDigest !== (m?.digest ?? null) || r.publication.draftRelationship !== expectedDraft) return null;
    const experiment = r.nodes[0];
    if (!exact(experiment, ['id', 'type', 'canonicalGraphRef']) || !ref(experiment.id, 'selected_experiment')
      || experiment.type !== 'experiment_reference' || !unresolved(experiment.canonicalGraphRef)) return null;
    if (!p) return r.publication.state === 'none' && r.publication.qualification === 'none' && r.publication.versionDigest === null ? 'none' : null;
    const { head, version } = p, source = version.source, verification = version.verification;
    if (!validPublication(p) || !hash(version.digest) || r.publication.versionDigest !== version.digest
      || source?.type !== 'experiment_measurement' || source.experimentId !== detail.experiment.id || !hash(source.measurementDigest)
      || verification?.kind !== 'owner_attestation' || verification.measurementDigest !== source.measurementDigest
      || !['published', 'withdrawn'].includes(head.status) || r.publication.state !== head.status
      || version.status !== (head.status === 'withdrawn' ? 'withdrawn' : 'recorded')) return null;
    const complete = typeof version.amount === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(version.amount)
      && typeof version.currency === 'string' && /^[A-Z]{3}$/.test(version.currency)
      && typeof version.window?.startsAt === 'string' && typeof version.window.endsAt === 'string'
      && version.coverage?.status === 'complete' && ['reconciled_manual', 'before_after', 'holdout'].includes(version.method?.kind)
      && typeof version.provenance?.observationId === 'string' && Array.isArray(version.provenance.sourceRefs)
      && version.provenance.sourceRefs.length > 0 && typeof version.provenance.observedAt === 'string';
    const qualification = head.status === 'withdrawn' ? 'withdrawn' : complete ? 'owner_attested_measurement' : 'unqualified';
    const outcome = r.nodes[1], edge = r.edges[0];
    if (r.publication.qualification !== qualification
      || !exact(outcome, ['id', 'type', 'qualification', 'sourceVersionRef', 'canonicalGraphRef'])
      || !ref(outcome.id, 'selected_outcome') || !ref(outcome.sourceVersionRef, 'selected_version')
      || outcome.type !== (head.status === 'withdrawn' ? 'withdrawn_measurement_reference' : 'published_measurement_reference')
      || outcome.qualification !== qualification || !unresolved(outcome.canonicalGraphRef)
      || !exact(edge, ['id', 'from', 'to', 'relation', 'basis']) || !ref(edge.id, 'selected_edge')
      || edge.from !== outcome.id || edge.to !== experiment.id || edge.relation !== 'measurement_recorded_for_experiment' || edge.basis !== 'same_review_snapshot') return null;
    return qualification;
  }
  function relationshipText() {
    const text = labelFrom({ none: 'No owner-reviewed result was found for this experiment when loaded.',
      owner_attested_measurement: 'An owner-reviewed result was linked to this experiment when loaded.',
      withdrawn: 'This experiment’s reviewed result was withdrawn and no longer qualifies.',
      unqualified: 'This experiment’s reviewed result is missing required measurement details.' }, relationship, '');
    return text ? `<p id="business-outcomes-relationship" class="muted">${text} Only this experiment was checked; the rest of the workspace was not.</p>` : '';
  }
  function renderOverview() {
    if (!overview) return;
    const summary = overview.summary || {}, groups = Array.isArray(summary.groups) ? summary.groups : [], current = overview.current;
    $('business-outcomes-summary').innerHTML = `<p class="muted">${summary.coverage?.complete === true ? 'Reviewed results loaded for the periods shown.' : 'Some results could not be checked; totals are unavailable.'} These are not lifetime totals.</p>` +
      groups.slice(0, LIMIT).map(group => `<article class="outcome-record"><h4>${esc(group.currency || 'Currency unknown')} · ${esc(methodLabel(group.method?.kind || group.method))}</h4><p>${esc(windowText(group.window))}</p><strong>${esc(summary.coverage?.complete === true && group.amountStatus === 'measured_sum' ? amount(group) : 'Total unavailable')}</strong><p class="muted tiny">${esc(totalLabel(summary.coverage?.complete === true ? group.amountStatus : 'incomplete_publication_read'))} · ${esc(unknown(group.measuredCount))} ${group.measuredCount === 1 ? 'measurement' : 'measurements'}</p></article>`).join('') +
      (!groups.length ? '<p class="empty-state">No comparable reviewed results yet.</p>' : '') +
      (groups.length > LIMIT ? `<p>Showing ${LIMIT} of ${groups.length} result groups.</p>` : '') +
      (Array.isArray(summary.exclusions) && summary.exclusions.length ? '<p class="muted">Not included in totals: ' + summary.exclusions.slice(0, LIMIT).map(row => esc(reasonLabel(row.code))).join(' ') + '</p>' : '') +
      '<h3>Reviewed results</h3>' + current.slice(0, LIMIT).map(publicationCard).join('') +
      (!current.length ? '<p class="empty-state">No owner-reviewed results yet. Record a draft below.</p>' : '') +
      (current.length > LIMIT ? `<p>Showing ${LIMIT} of ${current.length} reviewed results. Select an experiment below for its latest result.</p>` : '');
  }
  async function read(name, path, apply) {
    if (busy.has(name)) return;
    const t = ticket(), controller = new AbortController(); controllers.add(controller); busy.add(name); controls();
    try { const result = await api.request(path, { signal: controller.signal, isCurrent: () => active(t) }); if (active(t)) await apply(result, () => active(t)); }
    catch (error) { if (active(t)) status(error.status === 401 ? 'Sign in again to read business results.' : 'Could not load business results. Select Refresh to try again.', true); }
    finally { controllers.delete(controller); if (active(t)) { busy.delete(name); controls(); } }
  }
  function loadOverview() {
    status('Loading reviewed results…');
    return read('overview', '/api/business-outcomes', result => {
      if (result.workspaceId !== context().workspaceId || !Array.isArray(result.current) || result.current.some(p => !validPublication(p))) throw new Error('Mismatched business results');
      overview = result; renderOverview(); status('Results loaded. Refresh when you want to check for updates.');
    });
  }
  function dateInput(value) { return value ? String(value).replace(/Z$/, '') : ''; }
  function populateForm() {
    const f = $('business-outcomes-form'), m = selected?.measurement;
    const values = { amount: m?.amount ?? '', currency: m?.currency ?? '', startsAt: dateInput(m?.window?.startsAt), endsAt: dateInput(m?.window?.endsAt), observedAt: dateInput(m?.provenance?.observedAt), coverageStatus: m?.coverage?.status || 'unknown', observedCount: m?.coverage?.observedCount ?? '', expectedCount: m?.coverage?.expectedCount ?? '', method: m?.method?.kind || 'unknown', description: m?.report?.description || '', costsComplete: m?.report?.costsComplete === true ? 'true' : m?.report?.costsComplete === false ? 'false' : '' };
    for (const [name, value] of Object.entries(values)) f.elements[name].value = value;
    populateActionSelection(); f.classList.toggle('hidden', !canPrepare()); controls();
  }
  function renderDetail(justReviewed = false) {
    const d = selected; if (!d) { $('business-outcomes-detail').replaceChildren(); $('business-outcomes-action-details').replaceChildren(); $('business-outcomes-action').innerHTML = '<option value="">No recorded action</option>'; $('business-outcomes-action-hint').textContent = 'Recorded action linking is unavailable until compatible experiment details are loaded.'; $('business-outcomes-form').classList.add('hidden'); return; }
    const m = d.measurement, publication = d.currentPublication;
    const blockers = Array.isArray(d.assessment?.blockers) ? d.assessment.blockers : [];
    let html = `<h3>${esc(bounded(d.experiment.title || d.experiment.id, 180))}</h3>${relationshipText()}<p class="muted">${m ? `Saved measurement · version ${esc(m.revision)}` : 'No business result recorded yet.'} · Earlier legacy reviews do not count as reviewed business results.</p>`;
    if (m) html += facts(m) + associationFacts(measurementAssociation(m), protectedMeasurement(m) ? m.receiptSource : null) + `<p>All relevant costs included: ${m.report?.costsComplete === true ? 'Yes (reported)' : m.report?.costsComplete === false ? 'No' : 'Unknown'}</p><p class="outcome-description">${esc(bounded(m.report?.description))}</p>`;
    const alreadyReviewed = justReviewed || (m && publication?.head.status === 'published' && m.revision === publication.version.source.measurementRevision && m.digest === publication.version.source.measurementDigest);
    const reviewStatus = alreadyReviewed ? 'This saved version has already been reviewed. Save an updated draft to request a correction.'
      : stale ? 'Refresh the experiment before reviewing these details.'
      : publication?.head.status === 'withdrawn' ? 'This result was withdrawn and cannot be reviewed again.'
      : d.assessment?.readyForOwnerVerification === true ? 'Measurement details are complete and ready for owner review.' : 'More detail is needed before owner review.';
    html += `<p>${reviewStatus}</p>` + (blockers.length ? '<ul>' + blockers.slice(0, LIMIT).map(b => `<li>${esc(reasonLabel(b.code))}</li>`).join('') + '</ul>' : '');
    if (publication) html += `<div class="outcome-current"><h4>Current ${publication.head.status === 'withdrawn' ? 'withdrawn' : 'owner-reviewed'} result · version ${esc(publication.version.revision)}</h4>${facts(publication.version)}<p class="muted tiny">Editing a draft leaves this reviewed version unchanged.</p><button type="button" class="secondary" data-outcome-source-current>View report for this result</button><div id="business-outcomes-current-source"></div></div>`;
    if (role() === 'owner') {
      const withdrawn = publication?.head.status === 'withdrawn';
      const newer = !publication || m?.revision > publication.version.source.measurementRevision;
      if (m && d.assessment?.readyForOwnerVerification === true && newer && !withdrawn) html += `<button type="button" class="primary" data-outcome-action="${publication ? 'correct' : 'publish'}">Review ${publication ? 'correction' : 'result'}</button>`;
      if (publication?.head.status === 'published') html += '<button type="button" class="secondary" data-outcome-action="withdraw">Review withdrawal</button>';
      if (withdrawn) html += '<p class="muted">This result was withdrawn and cannot be restored.</p>';
    } else html += '<p class="muted">Only the owner can confirm, correct or withdraw a reviewed result.</p>';
    $('business-outcomes-detail').innerHTML = html; controls();
  }
  function loadDetail() {
    if (busy.has('detail') || busy.has('save') || busy.has('publish')) return;
    const id = $('business-outcomes-experiment').value; if (!id) return status('Choose an experiment.');
    if (pending?.attempted) return status('Finish checking the pending action before editing this result. Retrying keeps the same request.', true);
    cancelReceiptRead(); receiptPreview = null; generation++; clearRelationship(); controllers.forEach(c => c.abort()); controllers.clear(); busy.clear(); pending = null; renderReview();
    selected = null; renderDetail(); status('Loading the selected experiment…');
    return read('detail', '/api/business-outcomes/experiments/' + encodeURIComponent(id), async (result, isCurrent) => {
      if (result.workspaceId !== context().workspaceId || result.experiment?.id !== id || (result.measurement && (result.measurement.workspaceId !== result.workspaceId || result.measurement.experimentId !== id)) || (result.currentPublication && !validPublication(result.currentPublication))) throw new Error('Mismatched experiment');
      checkActionCapability(result); await checkObjectiveMeasurement(result.measurement);
      const preview = checkReceiptReview(result);
      if (!isCurrent()) return;
      receiptPreview = preview; selected = result; relationship = selectedRelationship(result); stale = false; renderDetail(); populateForm(); status('Experiment loaded. Edit a draft or review the saved measurement.');
    });
  }
  function measurementInput() {
    const f = $('business-outcomes-form'), get = name => f.elements[name].value.trim();
    const count = name => { const v = get(name); if (v === '') return null; if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error('Coverage counts must be nonnegative whole numbers.'); return Number(v); };
    const utc = name => { const v = get(name); if (!v) return null; const d = new Date(v + 'Z'); if (!Number.isFinite(d.getTime())) throw new Error('Enter a valid UTC date and time.'); return d.toISOString(); };
    const startsAt = utc('startsAt'), endsAt = utc('endsAt');
    if (Boolean(startsAt) !== Boolean(endsAt)) throw new Error('Supply both UTC window dates, or leave both unknown.');
    return { ...selectedActionInput(), expectedRevision: selected.measurement?.revision || 0, amount: get('amount') || null, currency: get('currency') || null,
      window: startsAt ? { startsAt, endsAt } : null, coverage: { status: get('coverageStatus'), observedCount: count('observedCount'), expectedCount: count('expectedCount') },
      method: { kind: get('method') }, observedAt: utc('observedAt'), report: { description: get('description'), costsComplete: get('costsComplete') === '' ? null : get('costsComplete') === 'true' } };
  }
  async function save(event) {
    event.preventDefault(); if (!selected || !canPrepare() || stale || pending?.attempted || busy.has('receipt') || busy.has('save') || busy.has('publish')) return;
    let body; try { body = measurementInput(); } catch (error) { status(error.message, true); return; }
    const selectedSnapshot = selectedActionSnapshot(body.actionSelection);
    cancelReceiptRead(); pending = null; renderReview(); const t = ticket(), id = selected.experiment.id, controller = new AbortController(); controllers.add(controller);
    clearRelationship(); busy.add('save'); controls(); status('Saving measurement…');
    try {
      const result = await api.request('/api/business-outcomes/experiments/' + encodeURIComponent(id) + '/measurement', { method: 'PUT', body: JSON.stringify(body), signal: controller.signal, isCurrent: () => active(t) });
      if (!active(t)) return;
      if (result.workspaceId !== context().workspaceId || result.measurement?.experimentId !== id) throw new Error('Unexpected measurement response');
      checkActionCapability({ ...selected, ...result }); await checkObjectiveMeasurement(result.measurement);
      if (!active(t)) return;
      if (!sameSelectedOrigin(selectedSnapshot, measurementAssociation(result.measurement), result.measurement)) {
        selected = { ...selected, ...result }; stale = true; renderDetail(); populateForm();
        status('The draft was saved with changed action evidence. Reload the experiment and review the new association before publishing, or explicitly select another action.', true); return;
      }
      const merged = { ...selected, ...result };
      if (protectedMeasurement(result.measurement)) {
        // Save responses may omit a new preview; retain only the already-validated exact source.
        if (result.selectedReceiptSource === undefined) merged.selectedReceiptSource = receiptPreview && sameReceipt(receiptPreview.source.receiptSource, result.measurement.receiptSource) ? receiptPreview.source : null;
        receiptPreview = checkReceiptReview(merged, { allowSavedMissing: true });
      } else receiptPreview = null;
      selected = merged; renderDetail(); populateForm(); status('Draft saved. Owner review is still required.');
    } catch (error) { if (active(t)) { stale = true; status(error.status === 409 ? 'The measurement changed. Refresh the experiment before editing again.' : 'Save was not confirmed. Refresh the experiment before making another change.', true); } }
    finally { controllers.delete(controller); if (t.scope === scope && t.session === session) { busy.delete('save'); if (!active(t)) stale = true; controls(); } }
  }
  function review(action) {
    if (!selected || stale || role() !== 'owner' || busy.has('save') || busy.has('publish') || pending) return;
    const p = selected.currentPublication, m = selected.measurement;
    if (action === 'withdraw' ? p?.head.status !== 'published' : !m || selected.assessment?.readyForOwnerVerification !== true || p?.head.status === 'withdrawn') return;
    const association = action === 'withdraw' ? currentAssociation(selected) : measurementAssociation(m);
    if (action !== 'withdraw' && association && (protectedMeasurement(m) ? !receiptChoices(selected) : !actionChoices(selected))) return status('Refresh after compatible action-link storage is installed before reviewing this association.', true);
    const source = action === 'withdraw' ? p.version.source : { measurementRevision: m.revision, measurementDigest: m.digest };
    const id = window.crypto?.randomUUID?.(); if (!id) return status('This browser cannot safely submit the review. Refresh in a supported secure browser.', true);
    pending = { action, attempted: false, uncertain: false, association, receiptSource: action === 'withdraw' ? currentReceiptReference(selected) : protectedMeasurement(m) ? m.receiptSource : null, facts: action === 'withdraw' ? p.version : m,
      payload: { publicationId: id, action, experimentId: selected.experiment.id, expectedWorkspaceRevision: selected.workspaceRevision,
        expectedMeasurementRevision: source.measurementRevision, expectedMeasurementDigest: source.measurementDigest,
        expectedHeadVersionId: p?.head.versionId || null, expectedHeadDigest: p?.head.digest || null, withdrawalReason: null } };
    renderReview(); $('business-outcomes-review').scrollIntoView({ block: 'nearest' });
  }
  function renderReview() {
    const root = $('business-outcomes-review'); root.classList.toggle('hidden', !pending); if (!pending) { root.replaceChildren(); controls(); return; }
    const p = pending;
    root.innerHTML = `<h3>Review ${esc(reviewLabel(p.action))}</h3>${facts(p.facts)}${p.action === 'withdraw' && !p.association && p.facts.links?.action ? '<p>The exact retained action snapshot stays in this withdrawn result’s history.</p>' : associationFacts(p.association, p.receiptSource, p.action === 'withdraw')}<p>Measurement version ${esc(p.payload.expectedMeasurementRevision)}. ${p.action === 'withdraw' ? 'This withdraws the reviewed result. Any later draft is kept.' : 'Confirm the saved measurement and its complete costs below. This does not prove Runvara caused the result.'}</p>` +
      (p.action === 'withdraw' ? `<label>Withdrawal reason<select id="business-outcomes-reason" aria-describedby="business-outcomes-selected-reason" ${p.attempted ? 'disabled' : ''}>${[['','Choose a reason'], ...Object.entries(WITHDRAWAL_REASON_LABELS)].map(([value,label]) => `<option value="${value}" ${p.payload.withdrawalReason === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><p id="business-outcomes-selected-reason" aria-live="polite" aria-atomic="true"></p>` : `<p>All relevant costs included: ${p.facts.report?.costsComplete === true ? 'Yes (reported)' : 'Unknown'}</p><p class="outcome-description">${esc(bounded(p.facts.report?.description))}</p>`) +
      `<label class="outcome-attest"><input id="business-outcomes-attest" type="checkbox">I reviewed these exact details and ${p.action === 'withdraw' ? 'want to withdraw this result' : 'attest that this measurement and its costs are complete' + (p.association ? ' and explicitly associate the recorded action shown above' : '')}.</label>` +
      (p.uncertain ? '<p class="outcome-error">Confirmation was not received. Nothing was retried automatically. Retrying submits the same reviewed details as the same request.</p>' : '') +
      `<div class="outcome-actions"><button id="business-outcomes-confirm" class="primary" type="button" disabled>${p.uncertain ? 'Retry same reviewed action' : 'Confirm ' + esc(reviewLabel(p.action))}</button><button id="business-outcomes-cancel" class="secondary" type="button">${p.attempted ? 'Close review (keep pending action)' : 'Cancel'}</button></div>`;
    controls();
  }
  function renderWithdrawalReason() {
    const confirmation = $('business-outcomes-selected-reason'); if (!confirmation || pending?.action !== 'withdraw') return;
    const reason = pending.attempted ? pending.payload.withdrawalReason : $('business-outcomes-reason').value;
    const text = 'Selected reason: ' + labelFrom(WITHDRAWAL_REASON_LABELS, reason, reason ? 'Unknown reason' : 'No reason selected');
    if (confirmation.textContent !== text) confirmation.textContent = text;
  }
  async function publish() {
    if (!pending || busy.has('publish') || role() !== 'owner' || !$('business-outcomes-attest')?.checked) return;
    const p = pending;
    if (p.action === 'withdraw' && !p.attempted) { p.payload.withdrawalReason = $('business-outcomes-reason').value.trim(); if (!p.payload.withdrawalReason) return status('Give a reason for this withdrawal.', true); }
    p.attempted = true; clearRelationship(); const t = ticket(), controller = new AbortController(); controllers.add(controller); busy.add('publish'); controls(); status('Submitting the reviewed action…');
    try {
      const result = await api.request('/api/business-outcomes/publish', { method: 'POST', body: JSON.stringify(p.payload), signal: controller.signal, isCurrent: () => active(t) });
      if (!active(t)) { p.uncertain = true; return; }
      if (!validPublication(result.publication) || result.publication.head.publicationId !== p.payload.publicationId) throw new Error('Publication response did not match the reviewed action');
      if (objectiveOrigin(p.association) || p.receiptSource) {
        if (!validAssociation(p.association, result.publication.version.links)
          || result.publication.version.source?.measurementDigest !== p.payload.expectedMeasurementDigest) throw new Error('Publication association mismatch');
        await checkObjectivePublication(result.publication, p.facts.schema === 'runvara-experiment-measurement/v3' || protectedMeasurement(p.facts) ? p.facts : null);
        if (!active(t)) { p.uncertain = true; return; }
      }
      pending = null; stale = true; renderDetail(result.isCurrent === true && p.action !== 'withdraw' && result.publication.version.source?.measurementDigest === selected?.measurement?.digest); renderReview(); status(result.isCurrent === false ? 'This action was recorded; a newer result is now available. Refresh the experiment and results.' : 'Review saved. Refresh the experiment and results to see the latest version.');
    } catch (error) {
      if ([400,403,404,409,413,422].includes(error.status)) { if (pending !== p || t.scope !== scope || t.session !== session) return; pending = null; stale = true; if (active(t)) { renderReview(); status('The action was not accepted. Refresh the experiment and review its current details before trying again.', true); } }
      else { p.uncertain = true; if (active(t)) { renderReview(); status('Confirmation was not received. Retry only the same reviewed action.', true); } }
    } finally { controllers.delete(controller); if (t.scope === scope && t.session === session) { busy.delete('publish'); controls(); } }
  }
  function evidence(publication, target, button) {
    const name = 'source:' + publication.version.versionId; if (busy.has(name) || button.dataset.loaded) return;
    button.disabled = true;
    return read(name, '/api/business-outcomes/versions/' + encodeURIComponent(publication.version.versionId), async (result, isCurrent) => {
      if (!withinBytes(result, 128 * 1024)) throw new Error('Evidence response exceeds its bound');
      if (result.source !== 'immutable_business_outcome_version' || result.currentStatus !== 'not_checked' || !validPublication(result.publication) || result.publication.version.versionId !== publication.version.versionId || result.publication.version.digest !== publication.version.digest || result.sourceMeasurement?.digest !== publication.version.source.measurementDigest || result.sourceMeasurement?.workspaceId !== context().workspaceId) throw new Error('Evidence mismatch');
      const m = result.sourceMeasurement;
      if ((m?.schema === 'runvara-experiment-measurement/v3' || protectedMeasurement(m)) && !exact(result, ['publication', 'sourceMeasurement', 'sourceAction', 'currentStatus', 'source'])) throw new Error('Unsupported public evidence envelope');
      const actionMarkup = await sourceActionMarkup(result.sourceAction, m, result.publication);
      if (!isCurrent() || !target.isConnected) return;
      target.innerHTML = `<h4>Original measurement report</h4><p class="muted tiny">Saved with this result; its current status has not been rechecked. Recorded by an owner or admin, not independently verified.</p>${facts(m)}<p>All relevant costs included: ${m.report?.costsComplete === true ? 'Yes (reported)' : 'Unknown'}</p><p class="outcome-description">${esc(bounded(m.report?.description))}</p>${actionMarkup}`;
      button.dataset.loaded = 'true'; button.textContent = 'Original report loaded';
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
    status('Open this panel to load reviewed results. Updates run only when requested.'); controls();
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
    $('business-outcomes-action').addEventListener('change', () => { cancelReceiptRead(); receiptPreview = null; renderActionSelection(); if (!pending?.attempted) { pending = null; renderReview(); } });
    $('business-outcomes-form').addEventListener('input', () => { if (!pending?.attempted) { pending = null; renderReview(); } });
    $('business-outcomes-panel').addEventListener('click', event => {
      const receiptButton = event.target.closest('[data-receipt-read]'); if (receiptButton) readReceipt(receiptButton.dataset.receiptRead);
      const action = event.target.closest('[data-outcome-action]'); if (action) review(action.dataset.outcomeAction);
      if (event.target.id === 'business-outcomes-cancel') { if (!pending?.attempted) { pending = null; renderReview(); } else { $('business-outcomes-review').classList.add('hidden'); status('Pending action retained. Reopen the panel to review the same retry.'); } }
      if (event.target.id === 'business-outcomes-confirm') publish();
      const readButton = event.target.closest('[data-outcome-evidence]'); if (readButton) { const i = Number(readButton.dataset.outcomeEvidence); if (overview?.current[i]) evidence(overview.current[i], readButton.nextElementSibling, readButton); }
      const current = event.target.closest('[data-outcome-source-current]'); if (current && selected?.currentPublication) evidence(selected.currentPublication, $('business-outcomes-current-source'), current);
    });
    $('business-outcomes-review').addEventListener('change', controls);
    window.addEventListener('popstate', pause);
    reset();
  }
  window.RunvaraOutcomes = Object.freeze({ init, reset, pause });
})();
