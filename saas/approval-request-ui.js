(function () {
  'use strict';
  const SCHEMA = 'runvara-approval-draft/v1';
  const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  function create({ form, error, request, identity, onResolved, storage }) {
    try { storage ||= window.sessionStorage; } catch { storage = null; }
    const document = form.ownerDocument, panel = document.createElement('div');
    const status = document.createElement('p'), check = document.createElement('button'), retry = document.createElement('button');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    check.type = retry.type = 'button'; check.className = retry.className = 'secondary';
    check.textContent = 'Check saved request'; retry.textContent = 'Retry this same request';
    panel.append(status, check, retry); form.after(panel);
    const controls = [...form.elements], submit = controls.find(element => element.type === 'submit');
    let bound = null, intent = null, blocked = false, busy = false, canRetry = false, generation = 0, controller = null, message = '';
    const scope = value => value?.workspaceId && value?.actorId && ['owner', 'admin', 'member'].includes(value.role)
      ? 'runvara:approval-request:v1:' + encodeURIComponent(value.workspaceId) + ':' + encodeURIComponent(value.actorId) : null;
    function current(ticket) { const now = identity(); return generation === ticket.generation && scope(now) === ticket.key && now?.session === ticket.session; }
    function render() {
      for (const control of controls) control.disabled = !bound || blocked || busy || Boolean(intent);
      if (submit) submit.textContent = busy ? 'Checking request...' : intent ? 'Request outcome unknown' : 'Create request';
      panel.hidden = !bound && !message; status.textContent = message;
      check.hidden = !intent; check.disabled = busy || blocked;
      retry.hidden = !intent || !canRetry; retry.disabled = busy || blocked;
    }
    function interrupt() {
      generation++; controller?.abort(); controller = null; busy = false; canRetry = false;
      if (intent) message = 'Outcome unknown. This request may already be saved. Check its saved status before retrying.';
      render();
    }
    function refresh() {
      const now = identity(), key = scope(now);
      if (bound?.key === key && bound?.session === now?.session) { render(); return; }
      interrupt(); bound = key ? { ...now, key } : null; intent = null; blocked = false; canRetry = false; form.reset();
      message = ''; error.textContent = '';
      if (bound) {
        try {
          const raw = storage.getItem(key);
          if (raw) {
            const saved = JSON.parse(raw);
            if (saved.schema !== SCHEMA || saved.key !== key || !ID.test(saved.requestId)
              || !saved.body || typeof saved.body !== 'object' || Array.isArray(saved.body)) throw Error('Invalid saved reference');
            intent = saved;
            for (const control of controls) if (control.name && typeof saved.body[control.name] === 'string') control.value = saved.body[control.name];
            message = 'Outcome unknown. Your previous request is retained. Check its saved status; nothing has been resubmitted.';
          }
        } catch {
          blocked = true; message = 'The saved request reference could not be read. Do not resubmit until it can be checked.';
        }
      }
      render();
    }
    async function operate(kind, firstSend = false) {
      if (!intent || busy || blocked || !bound || (kind === 'retry' && !canRetry)) return;
      const ticket = { generation, key: bound.key, session: bound.session }, saved = intent;
      // Retain the exact intent before transport; refresh never resubmits it.
      try { storage.setItem(bound.key, JSON.stringify(saved)); }
      catch { blocked = true; message = 'The request reference could not be retained. Nothing new was submitted.'; render(); return; }
      busy = true; canRetry = false; controller = new AbortController(); error.textContent = '';
      message = kind === 'check' ? 'Checking the exact saved request...' : 'Submitting this request once...'; render();
      try {
        const result = await request(kind === 'check' ? '/api/actions/reconcile' : '/api/actions', {
          method: 'POST', body: JSON.stringify({ ...saved.body, requestId: saved.requestId }),
          signal: controller.signal, isCurrent: () => current(ticket)
        });
        if (!current(ticket)) return;
        if (result.requestId !== saved.requestId || result.executedExternally !== false) throw Error('The saved outcome could not be verified.');
        if (kind === 'check' && result.found === false) {
          canRetry = true; message = 'No saved request was found yet. If you retry, the same request identity and contents will be used.';
          return;
        }
        if (!result.approval || typeof result.approval.id !== 'string' || (kind === 'check' && result.found !== true)) throw Error('The saved outcome could not be verified.');
        storage.removeItem(bound.key);
        intent = null; canRetry = false; form.reset(); message = 'Saved request confirmed. No external action was executed.';
        onResolved(result.approval);
      } catch (cause) {
        if (!current(ticket)) return;
        // A later refusal cannot erase an earlier unknown outcome.
        if (firstSend && cause.status === 400 && cause.code === 'APPROVAL_REQUEST_INPUT_INVALID') {
          try { storage.removeItem(bound.key); intent = null; message = 'The request was not accepted. Correct its details before submitting.'; }
          catch { blocked = true; message = 'The request reference could not be updated. Do not resubmit.'; }
        } else message = 'Outcome unknown. This request may already be saved. Check its saved status before retrying.';
        error.textContent = cause.message || 'The outcome could not be confirmed.';
      } finally {
        if (current(ticket)) { busy = false; controller = null; render(); }
      }
    }
    form.addEventListener('submit', event => {
      event.preventDefault(); refresh();
      if (!bound || intent || busy || blocked) return;
      intent = { schema: SCHEMA, key: bound.key, requestId: window.crypto.randomUUID(),
        body: { ...Object.fromEntries(new window.FormData(form)), source: 'owner-command-centre' } };
      void operate('create', true);
    });
    check.addEventListener('click', () => { refresh(); void operate('check'); });
    retry.addEventListener('click', () => { refresh(); void operate('retry'); });
    refresh();
    return { refresh, interrupt };
  }
  window.RunvaraApprovalRequest = { create };
})();

