(function () {
  'use strict';
  const SCHEMA = 'runvara-quiet-approval-pilot/v1', BASE = '/api/maintenance/approval-pilot/';
  function create({ host, session, request, isCurrent, storage, now = Date.now }) {
    const d = session?.approvalPilot;
    if (d?.schema !== SCHEMA || session.user?.role !== 'owner' || !session.workspace?.id || !session.user?.id
      || !/^[a-f0-9-]{36}$/.test(d.requestId || '') || !Number.isFinite(Date.parse(d.expiresAt))) return null;
    try { storage ||= window.sessionStorage; } catch { storage = null; }
    const doc = host.ownerDocument, root = doc.createElement('section'); root.id = 'maintenance-approval-pilot';
    const title = doc.createElement('h2'), status = doc.createElement('p'), createButton = doc.createElement('button');
    const reject = doc.createElement('button'), check = doc.createElement('button');
    title.textContent = 'Maintenance acceptance test'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    createButton.textContent = 'Create test request'; reject.textContent = 'Reject test request'; check.textContent = 'Check saved test';
    for (const b of [createButton, reject, check]) { b.type = 'button'; b.className = 'secondary'; }
    root.append(title, status, createButton, reject, check); host.append(root);
    const key = 'runvara:maintenance-pilot:v1:' + encodeURIComponent(session.workspace.id) + ':' + encodeURIComponent(session.user.id) + ':' + d.requestId;
    let record = { schema: SCHEMA, requestId: d.requestId, phase: 'new', approvalId: null, reads: 0, uncertain: false };
    let dead = false, busy = false, blocked = false, needsCheck = false, controller, generation = 0;
    let message = 'One fixed test request, then rejection only. Nothing will be executed externally.';
    try {
      const raw = storage.getItem(key);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.schema !== SCHEMA || saved.requestId !== d.requestId || !['create-sent','pending','reject-sent','rejected','unknown'].includes(saved.phase)
          || !Number.isInteger(saved.reads) || saved.reads < 0 || saved.reads > 2 || typeof saved.uncertain !== 'boolean'
          || !(saved.approvalId === null || typeof saved.approvalId === 'string')) throw Error('Invalid retained test');
        record = saved; needsCheck = true;
        if (['create-sent','reject-sent','unknown'].includes(record.phase)) { record.uncertain = true; record.phase = 'unknown'; }
        message = 'Previous test retained. Check its exact saved result; nothing has been resubmitted.';
      }
    } catch { blocked = true; message = 'The retained test reference is unavailable. Do not submit again.'; }
    const active = () => !dead && root.isConnected && isCurrent() && now() < Date.parse(d.expiresAt);
    function render() {
      const canWrite = active() && !busy && !blocked && !record.uncertain && d.writable === true && !needsCheck;
      createButton.disabled = !canWrite || record.phase !== 'new';
      reject.disabled = !canWrite || record.phase !== 'pending' || !record.approvalId;
      check.disabled = !active() || busy || blocked || record.phase === 'new' || record.reads >= 2;
      status.textContent = now() >= Date.parse(d.expiresAt) ? 'The test window is closed. Do not submit or retry.' : message;
    }
    const persist = () => { storage.setItem(key, JSON.stringify(record)); };
    async function operate(operation) {
      render(); const button = operation === 'request' ? createButton : operation === 'reject' ? reject : check;
      if (button.disabled) return;
      const ticket = ++generation; busy = true; controller = new AbortController();
      if (operation === 'reconcile') record.reads++;
      else record.phase = operation === 'request' ? 'create-sent' : 'reject-sent';
      try { persist(); } catch { blocked = true; busy = false; message = 'The test reference could not be retained. Nothing new was submitted.'; render(); return; }
      message = operation === 'reconcile' ? 'Checking the exact saved test...' : 'Submitting this step once...'; render();
      try {
        const body = { requestId: d.requestId };
        if (operation === 'reject') Object.assign(body, { approvalId: record.approvalId, revision: 1, decision: 'rejected' });
        const r = await request(BASE + operation, { method: 'POST', body: JSON.stringify(body), signal: controller.signal,
          isCurrent: () => !dead && generation === ticket && isCurrent() });
        if (!active() || generation !== ticket) return;
        if (r.schema !== SCHEMA || r.requestId !== d.requestId || r.executedExternally !== false || r.maintenance !== true || typeof r.found !== 'boolean'
          || r.found && (!r.approval || typeof r.approval.id !== 'string' || r.approval.revision !== 1 || !['pending','rejected'].includes(r.approval.status))
          || !r.found && operation !== 'reconcile' || r.found && record.approvalId && record.approvalId !== r.approval.id
          || operation === 'reject' && r.approval?.status !== 'rejected') throw Error('The exact test result could not be verified.');
        needsCheck = false;
        if (!r.found) { record.phase = 'unknown'; record.uncertain = true; message = 'No saved test was found yet. The outcome remains unknown. Do not retry.'; }
        else {
          record.approvalId = r.approval.id; record.phase = r.approval.status;
          message = record.phase === 'rejected' ? 'Test rejection confirmed. No external action was executed. The test is finished.'
            : record.uncertain ? 'Saved pending test confirmed. Further changes remain stopped after the uncertain outcome.'
              : 'Test request confirmed. You may reject this exact test request.';
        }
        persist();
      } catch {
        if (dead || generation !== ticket || !isCurrent()) return;
        record.phase = 'unknown'; record.uncertain = true; message = 'Outcome unknown. This step may already be saved. Do not retry; check its exact saved result.';
        try { persist(); } catch { blocked = true; }
      } finally { if (!dead && generation === ticket) { busy = false; controller = null; render(); } }
    }
    createButton.addEventListener('click', () => void operate('request'));
    reject.addEventListener('click', () => void operate('reject'));
    check.addEventListener('click', () => void operate('reconcile'));
    const timer = setTimeout(render, Math.max(0, Math.min(600000, Date.parse(d.expiresAt) - now())));
    render();
    return { destroy() { dead = true; generation++; controller?.abort(); clearTimeout(timer); root.remove(); }, root };
  }
  window.RunvaraMaintenanceApproval = { create };
})();
