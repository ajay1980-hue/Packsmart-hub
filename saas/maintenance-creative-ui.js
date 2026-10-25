(function () {
  'use strict';
  const SCHEMA = 'runvara-quiet-creative-pilot/v1', BASE = '/api/maintenance/creative-pilot/';
  function create({ host, session, request, isCurrent, storage, now = Date.now }) {
    const d = session?.creativePilot;
    if (d?.schema !== SCHEMA || session.user?.role !== 'owner' || !session.workspace?.id || !session.user?.id
      || !Number.isSafeInteger(d.maxCostMicros) || d.maxCostMicros <= 0 || d.currency !== 'USD'
      || !Number.isFinite(Date.parse(d.expiresAt))) return null;
    try { storage ||= window.sessionStorage; } catch { storage = null; }
    const doc = host.ownerDocument, root = doc.createElement('section'); root.id = 'maintenance-creative-pilot';
    const title = doc.createElement('h2'), status = doc.createElement('p'), details = doc.createElement('pre'), buttons = {};
    title.textContent = 'One Runway maintenance test'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    details.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;font:inherit;text-align:left';
    root.append(title, status, details);
    for (const [op, label] of Object.entries({ review: 'Read saved review', prepare: 'Prepare exact review', approved: 'Approve this ceiling', revoked: 'Revoke further admission', submit: 'Submit once', observe: 'Check known task' })) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = label;
      button.dataset.creativePilot = op; root.append(button); buttons[op] = button;
    }
    host.append(root);
    const key = 'runvara:quiet-creative:v1:' + [session.workspace.id, session.user.id, d.requestId].map(encodeURIComponent).join(':');
    let record = { schema: SCHEMA, inputDigest: d.inputDigest, sent: [], reviews: 0, observations: 0, uncertain: false, pending: false };
    let row = null, dead = false, busy = false, blocked = false, checked = false, controller, sequence = 0;
    let writable = d.writable === true;
    let message = 'No request has been sent. Read the exact saved review first. Other business activity remains paused.';
    try {
      const raw = storage.getItem(key);
      if (raw) {
        const old = JSON.parse(raw);
        if (old.schema !== SCHEMA || old.inputDigest !== d.inputDigest || !Array.isArray(old.sent)
          || old.sent.some(x => !['prepare','approved','revoked','submit'].includes(x)) || typeof old.uncertain !== 'boolean' || typeof old.pending !== 'boolean'
          || !Number.isInteger(old.reviews) || old.reviews < 0 || old.reviews > 3
          || !Number.isInteger(old.observations) || old.observations < 0 || old.observations > 5) throw Error('Invalid retained reference');
        record = old; record.uncertain ||= record.pending; message = 'Previous request retained. Read its saved state; nothing has been resubmitted.';
      }
    } catch { blocked = true; message = 'The retained request reference is unavailable. Do not submit.'; }
    const active = () => !dead && root.isConnected && isCurrent() && now() < Date.parse(d.expiresAt);
    const persist = () => storage.setItem(key, JSON.stringify(record));
    const dollars = micros => { const value = BigInt(micros); return (value / 1000000n) + '.' + (value % 1000000n).toString().padStart(6, '0'); };
    function render() {
      const read = active() && !busy && !blocked, write = read && checked && !record.uncertain && writable;
      buttons.review.disabled = !read || record.reviews >= 3;
      buttons.prepare.disabled = !write || Boolean(row) || record.sent.includes('prepare');
      buttons.approved.disabled = !write || row?.status !== 'pending' || record.sent.includes('approved');
      buttons.revoked.disabled = !write || row?.status !== 'approved' || record.sent.includes('revoked');
      buttons.submit.disabled = !write || row?.status !== 'approved' || Boolean(row.reservationStatus) || record.sent.includes('submit');
      buttons.observe.disabled = !write || !row?.upstreamId || row.reservationStatus !== 'accepted' || record.observations >= 5;
      status.textContent = now() >= Date.parse(d.expiresAt) ? 'The test window is closed. Existing holds and tasks are retained.' : message;
      details.textContent = row ? [
        'Account: ' + row.providerAccountId, 'Request: ' + d.requestId, '10 seconds · 1280 × 720 · audio off',
        'Price revision: ' + row.priceRevision, 'Approval revision: ' + row.revision,
        'Ceiling: USD ' + dollars(row.maxCostMicros), 'Expires: ' + row.expiresAt,
        'Approval: ' + row.status, 'Reservation: ' + (row.reservationStatus || 'none'),
        'Held exposure (USD micros): ' + row.heldCostMicros, 'Task: ' + (row.upstreamId || 'not confirmed'),
        'Tenant available (USD micros): ' + (row.tenantBudget?.availableMicros ?? 'unverified'),
        'Provider account available (USD micros): ' + (row.accountBudget?.availableMicros ?? 'unverified'),
        'Completion is not billing proof. Actual charge remains unverified until trusted reconciliation.',
        'Exact source: ' + row.sourcePreview, 'Exact provider payload: ' + row.payloadPreview
      ].join('\n') : 'Fixed request: ' + d.requestId + '\nWindow closes: ' + d.expiresAt;
    }
    function accept(r) {
      if (r?.schema !== SCHEMA || r.maintenance !== true || r.requestId !== d.requestId || r.expiresAt !== d.expiresAt) throw Error('Response mismatch');
      const a = r.allowance;
      if (a && (a.approvalType !== 'creative_phase/v1' || a.workspaceId !== session.workspace.id || a.campaignId !== d.campaignId
        || a.requestId !== d.requestId || a.provider !== 'runway' || a.phase !== 'generation' || a.inputDigest !== d.inputDigest
        || a.providerAccountId !== d.providerAccountId || a.priceRevision !== d.priceRevision || a.maxCostMicros !== d.maxCostMicros
        || a.currency !== 'USD' || !Number.isFinite(Date.parse(a.expiresAt)) || Date.parse(a.expiresAt) > Date.parse(d.expiresAt)
        || !Number.isSafeInteger(a.revision) || a.revision < 1 || typeof a.id !== 'string' || !a.id
        || !['pending','approved','rejected','revoked'].includes(a.status))) throw Error('Authority mismatch');
      row = a; checked = true;
    }
    async function operate(op) {
      render(); if (buttons[op].disabled) return;
      busy = true; const ticket = ++sequence; controller = new AbortController();
      if (op === 'review') record.reviews++;
      else if (op === 'observe') record.observations++;
      else record.sent.push(op);
      record.pending = true;
      try { persist(); } catch { blocked = true; busy = false; message = 'Could not retain the request reference. Nothing was submitted.'; render(); return; }
      message = op === 'review' ? 'Reading this saved request...' : 'Sending this step once...'; render();
      try {
        const decide = ['approved','revoked'].includes(op), body = { requestId: d.requestId };
        if (decide) Object.assign(body, { approvalId: row.id, revision: row.revision, decision: op });
        const r = await request(BASE + (decide ? 'decide' : op), { method: op === 'review' ? 'GET' : 'POST',
          ...(op === 'review' ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
          isCurrent: () => !dead && sequence === ticket && isCurrent() });
        if (!active() || sequence !== ticket) return;
        accept(r);
        if (!r.writable) writable = false;
        record.pending = false;
        message = 'Saved state confirmed. No automatic polling or resubmission.';
        if (r.status === 'complete') message = 'Known task completed. Generation is closed; billing and asset validation remain separate.';
        if (r.status === 'failed') message = 'The known task failed. Further actions are closed; the full hold is retained until trusted billing reconciliation.';
        persist();
      } catch {
        if (dead || sequence !== ticket || !isCurrent()) return;
        record.uncertain = true; record.pending = false; message = 'Outcome unknown. Stop further actions; use the saved review only. No automatic retry.';
        try { persist(); } catch { blocked = true; }
      } finally { if (!dead && sequence === ticket) { busy = false; controller = null; render(); } }
    }
    for (const [op, button] of Object.entries(buttons)) button.addEventListener('click', () => void operate(op));
    const timer = setTimeout(render, Math.max(0, Math.min(600000, Date.parse(d.expiresAt) - now()))); render();
    return { root, destroy() { dead = true; sequence++; controller?.abort(); clearTimeout(timer); root.remove(); } };
  }
  window.RunvaraMaintenanceCreative = { create };
})();
