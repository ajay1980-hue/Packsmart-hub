/* Saved snapshots are read on demand. No refresh, calculation or provider action. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const LIST_INTEGRITY = new Set(['retained', 'archive_pending_read', 'legacy_archive_unverified', 'archive_unavailable']);
  const DETAIL_INTEGRITY = new Set(['retained', 'verified_archive', 'legacy_archive_unverified']);
  const contextKeys = ['session', 'workspaceId', 'userId', 'role', 'view', 'generation', 'csrf', 'sessionWorkspaceId', 'sessionUserId', 'sessionRole'];
  let api, epoch = 0, controller = null, busy = false, scope = null, rows = [], selected = null, returnFocus = null;
  const context = () => api.getContext();
  const allowed = value => Boolean(value.session && value.workspaceId && value.userId && value.role && value.view === 'overview');
  const sameContext = () => {
    const value = context();
    return scope && allowed(value) && contextKeys.every(key => scope[key] === value[key]);
  };
  const current = token => {
    if (token !== epoch) return false;
    if (!sameContext()) { reset(); return false; }
    return $('brief-history-dialog').open;
  };
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const recordedDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC') : 'Date unknown';
  const summary = value => typeof value === 'string' && value.trim() ? value : 'No summary was recorded.';
  const integrityText = value => ({
    retained: 'Retained snapshot',
    archive_pending_read: 'Archived snapshot · integrity not checked yet',
    legacy_archive_unverified: 'Legacy archive · integrity unverified',
    verified_archive: 'Archive integrity matched',
    archive_unavailable: 'Full snapshot unavailable'
  })[value];
  function status(text) { $('brief-history-status').textContent = text; }
  function controls() {
    $('brief-history-body').setAttribute('aria-busy', String(busy));
    $('brief-history-retry').disabled = busy;
    for (const button of $('brief-history-list').querySelectorAll('button')) button.disabled = busy;
  }
  function stop() { epoch++; controller?.abort(); controller = null; busy = false; controls(); }
  function clear() {
    rows = []; selected = null; scope = null;
    $('brief-history-list').replaceChildren(); $('brief-history-detail').replaceChildren();
    $('brief-history-list').hidden = false; $('brief-history-detail').hidden = true;
    $('brief-history-back').hidden = true; $('brief-history-retry').hidden = true;
    status(''); $('brief-history-body').scrollTop = 0;
  }
  function dismiss(restoreFocus = true) {
    if (!api) return;
    const focus = returnFocus; returnFocus = null;
    stop(); clear();
    if ($('brief-history-dialog').open) $('brief-history-dialog').close();
    if (restoreFocus && focus?.isConnected) focus.focus({ preventScroll: true });
  }
  function reset() { dismiss(false); }
  function validateList(payload) {
    if (!object(payload) || payload.limit !== 30 || !Array.isArray(payload.briefs) || payload.briefs.length > 30) throw new Error('BRIEF_LIST_INVALID');
    const ids = new Set();
    for (const item of payload.briefs) {
      if (!object(item) || typeof item.id !== 'string' || !item.id || item.id.length > 512 || ids.has(item.id)
        || typeof item.archived !== 'boolean' || !LIST_INTEGRITY.has(item.integrity)
        || (item.summary != null && typeof item.summary !== 'string') || (item.generatedAt != null && typeof item.generatedAt !== 'string')) throw new Error('BRIEF_LIST_INVALID');
      ids.add(item.id);
    }
    return payload.briefs;
  }
  function renderList() {
    const root = $('brief-history-list'); root.replaceChildren();
    for (const item of rows) {
      const row = node('li', undefined, 'brief-history-record');
      row.append(node('h3', recordedDate(item.generatedAt)), node('p', integrityText(item.integrity), 'brief-history-integrity'), node('p', summary(item.summary)));
      const button = node('button', 'Read saved brief', 'secondary'); button.type = 'button';
      button.dataset.briefId = item.id;
      button.setAttribute('aria-label', 'Read saved brief: ' + recordedDate(item.generatedAt));
      row.append(button); root.append(row);
    }
  }
  function showList() {
    if (!sameContext()) { reset(); return; }
    stop(); selected = null; $('brief-history-detail').replaceChildren(); $('brief-history-detail').hidden = true;
    $('brief-history-list').hidden = false; $('brief-history-back').hidden = true; $('brief-history-retry').hidden = true;
    status(rows.length ? 'Select a saved brief to read its recorded detail.' : 'No saved briefs are retained for this workspace.');
    $('brief-history-body').scrollTop = 0;
    $('brief-history-list').querySelector('button')?.focus({ preventScroll: true });
  }
  function renderActions(root, brief, field, title) {
    if (!Array.isArray(brief[field])) return;
    const section = node('section'), list = node('ol');
    section.append(node('h4', title));
    if (!brief[field].length) section.append(node('p', 'None recorded.', 'muted'));
    // The collapsed complete record below preserves every field and every entry.
    for (const item of brief[field].slice(0, 30)) {
      const row = node('li');
      if (typeof item === 'string') row.textContent = item;
      else if (object(item)) {
        row.append(node('strong', typeof item.title === 'string' ? item.title : 'Recorded item'));
        for (const key of ['detail', 'action', 'qualification']) if (typeof item[key] === 'string') row.append(node('p', item[key]));
      } else row.textContent = 'See the complete recorded detail for this item.';
      list.append(row);
    }
    if (brief[field].length) section.append(list);
    if (brief[field].length > 30) section.append(node('p', 'The first 30 recorded items are shown here. All items are in the complete recorded detail.', 'muted'));
    root.append(section);
  }
  function renderDetail(payload, id) {
    if (!object(payload) || !object(payload.brief) || payload.brief.id !== id || !DETAIL_INTEGRITY.has(payload.integrity)
      || payload.brief.archived === true || Object.hasOwn(payload.brief, 'archive')) throw new Error('BRIEF_DETAIL_INVALID');
    const brief = payload.brief, root = $('brief-history-detail'); root.replaceChildren();
    const heading = node('h3', 'Saved brief: ' + recordedDate(brief.generatedAt)); heading.id = 'brief-history-detail-title';
    root.append(heading, node('p', integrityText(payload.integrity), 'brief-history-integrity'));
    if (payload.integrity === 'verified_archive') root.append(node('p', 'The archived content matches its saved integrity reference. This does not establish accuracy or immutability.', 'muted'));
    if (payload.integrity === 'legacy_archive_unverified') root.append(node('p', 'This older archive has no verified integrity reference. Its content could not be checked against the originally saved snapshot.', 'brief-history-notice'));
    root.append(node('p', 'Historical record only. These assessments and recommendations describe the information saved at the time; they are not current business results or instructions to act.', 'brief-history-notice'));
    root.append(node('h4', 'Recorded summary'), node('p', summary(brief.summary)));
    renderActions(root, brief, 'topActions', 'Top actions recorded at the time');
    renderActions(root, brief, 'recommendations', 'Recommendations recorded at the time');
    const detail = node('details', undefined, 'brief-history-complete');
    detail.append(node('summary', 'Complete recorded detail'), node('p', 'This is the saved record as returned. Missing or null amounts remain unknown; values have not been recalculated.', 'muted'), node('pre', JSON.stringify(brief, null, 2)));
    root.append(detail);
  }
  async function read(id) {
    if (!sameContext()) { reset(); return; }
    if (busy || !rows.some(item => item.id === id)) return;
    stop(); selected = id;
    const token = epoch, ownController = new AbortController(); controller = ownController; busy = true;
    $('brief-history-list').hidden = true; $('brief-history-detail').hidden = false;
    $('brief-history-detail').replaceChildren(); $('brief-history-back').hidden = false; $('brief-history-retry').hidden = true;
    $('brief-history-body').scrollTop = 0; controls(); status('Reading the selected saved brief…');
    try {
      const payload = await api.request('/api/briefs/' + encodeURIComponent(id), { signal: ownController.signal, isCurrent: () => current(token) });
      if (!current(token)) return;
      renderDetail(payload, id); status('Saved brief loaded. This is a historical snapshot.');
      $('brief-history-detail').focus({ preventScroll: true });
    } catch (error) {
      if (!current(token)) return;
      $('brief-history-detail').replaceChildren(); $('brief-history-retry').hidden = false;
      status(error.code === 'BRIEF_ARCHIVE_TOO_LARGE' ? 'This saved brief is too large to open safely here. It remains stored; no detail has been deleted or truncated.'
        : error.status === 404 ? 'This saved brief is no longer available. Return to the list or try again.'
        : error.status === 503 ? 'The full saved brief is unavailable or could not be verified. No complete detail can be shown. Try again later.'
        : error.status === 401 ? 'Sign in again to read saved briefs.'
        : error.status === 403 ? 'You do not have access to this saved brief.'
        : 'The full saved brief could not be read. No complete detail can be shown. Try again.');
    } finally { if (current(token)) { busy = false; controller = null; controls(); } }
  }
  async function loadList() {
    if (!sameContext()) { reset(); return; }
    if (busy) return;
    stop(); rows = []; selected = null;
    const token = epoch, ownController = new AbortController(); controller = ownController; busy = true;
    $('brief-history-list').replaceChildren(); $('brief-history-retry').hidden = true; controls(); status('Loading saved briefs…');
    try {
      const payload = await api.request('/api/briefs?view=history', { signal: ownController.signal, isCurrent: () => current(token) });
      if (!current(token)) return;
      rows = validateList(payload); renderList();
      status(rows.length ? 'Select a saved brief to read its recorded detail.' : 'No saved briefs are retained for this workspace.');
    } catch (error) {
      if (!current(token)) return;
      rows = []; $('brief-history-list').replaceChildren(); $('brief-history-retry').hidden = false;
      status(error.status === 401 ? 'Sign in again to read saved briefs.' : error.status === 403 ? 'You do not have access to saved briefs.' : 'Saved briefs could not be listed. Try again.');
    } finally { if (current(token)) { busy = false; controller = null; controls(); } }
  }
  function open() {
    if ($('brief-history-dialog').open && sameContext()) return;
    dismiss(false);
    const value = context(); if (!allowed(value)) return;
    scope = { ...value }; returnFocus = document.activeElement;
    $('brief-history-dialog').showModal(); loadList();
  }
  function init(value) {
    if (api) return;
    api = value;
    $('open-brief-history').addEventListener('click', open);
    $('brief-history-close').addEventListener('click', () => dismiss());
    $('brief-history-dialog').addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    // A close event queued before a rapid reopen must not clear the newer view.
    $('brief-history-dialog').addEventListener('close', () => { if (!$('brief-history-dialog').open) dismiss(); });
    $('brief-history-back').addEventListener('click', showList);
    $('brief-history-retry').addEventListener('click', () => selected === null ? loadList() : read(selected));
    $('brief-history-list').addEventListener('click', event => {
      const button = event.target.closest('button[data-brief-id]');
      if (button && $('brief-history-list').contains(button)) read(button.dataset.briefId);
    });
    reset();
  }
  window.RunvaraBriefHistory = Object.freeze({ init, reset, pause: reset });
})();
