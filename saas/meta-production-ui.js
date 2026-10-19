(() => {
  'use strict';
  let api, active = null, dialog;
  const node = (tag, text) => {const e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e;};
  const button = (text, action) => {const e = node('button', text); e.type = 'button'; e.className = 'secondary'; e.addEventListener('click', action); return e;};
  const base = campaign => '/api/meta-production/campaigns/' + encodeURIComponent(campaign);
  const key = (context, campaign) => 'runvara-meta-production-reference:' + JSON.stringify([context.workspaceId, context.userId, campaign]);
  const current = ticket => active === ticket && api.isCurrent(ticket.context);
  function close() {active = null; if (dialog?.open) dialog.close(); dialog?.replaceChildren();}
  function check(ticket) {if (!current(ticket)) {close(); return false;} return true;}
  function message(ticket, text) {if (check(ticket)) ticket.status.textContent = text;}
  function remember(ticket, requestId) {
    ticket.requestId = requestId;
    try {sessionStorage.setItem(key(ticket.context, ticket.campaign), requestId);} catch {}
  }
  function error(ticket, operation) {
    message(ticket, operation + ' could not be confirmed. Read this exact saved request before taking another action. No request is automatically resent.');
    if (ticket.requestId && current(ticket)) ticket.content.replaceChildren(button('Read saved request', () => review(ticket)));
  }
  async function review(ticket) {
    if (!check(ticket) || !ticket.requestId) return;
    ticket.content.replaceChildren(); message(ticket, 'Reading retained proposal and outcome…');
    try {
      const route = base(ticket.campaign) + '/requests/' + encodeURIComponent(ticket.requestId);
      const saved = await api.request(route); if (!check(ticket)) return;
      const image = await api.request(route + '/image'); if (!check(ticket)) return;
      if (saved.campaignId !== ticket.campaign || saved.requestId !== ticket.requestId || saved.consent?.postCount !== 1
        || saved.consent.imageSha256 !== image.sha256 || image.mediaType !== 'image/jpeg'
        || typeof image.bytesBase64 !== 'string' || image.bytesBase64.length > 2796204) throw Error('Unverified image');
      const binary = atob(image.bytesBase64), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
      if (!check(ticket)) return;
      if (digest !== saved.consent.imageSha256 || bytes.length !== saved.consent.byteLength) throw Error('Image changed');
      const img = node('img'); img.alt = 'Exact retained image for this Instagram proposal'; img.width = 280; img.height = 280;
      img.src = 'data:image/jpeg;base64,' + image.bytesBase64;
      const caption = node('pre', saved.consent.caption); caption.className = 'connection-exact-text';
      const target = saved.consent.target;
      ticket.content.append(img, node('h3', 'Exact caption'), caption,
        node('p', 'Instagram: ' + target.instagramId + ' · Facebook Page: ' + target.pageId + ' · Connected account: ' + target.account),
        node('p', 'Image SHA-256: ' + digest), node('p', 'Source revision: ' + saved.consent.sourceRevision),
        node('p', 'Delivery expires: ' + new Date(saved.expiresAt).toISOString()),
        node('p', 'Decision: ' + saved.status + ' · Retained phase: ' + saved.retained.phase));
      if (saved.retained.resultId) ticket.content.append(node('p', 'Retained provider result: ' + saved.retained.resultId));
      const recovery = {
        readiness_unresolved: 'The readiness response is unresolved. This request is held and cannot be resent.',
        publication_id_unresolved: 'Meta reported a published container, but no publication ID is retained. This is unresolved; do not resend.',
        container_error: 'The retained container status is ERROR. This request cannot continue.',
        container_expired: 'The retained container has expired. This request cannot continue.',
        readiness_budget_closed: 'The readiness checking limit has closed. This request cannot continue.',
        readiness_waiting: 'The retained container is not ready to continue. Read the saved outcome after ' + saved.retained.retryAfter + ' before requesting another check.'
      }[saved.retained.phase];
      if (recovery) ticket.content.append(node('p', recovery));
      const ack = node('input'); ack.type = 'checkbox'; ack.dataset.metaProductionConsent = '';
      const label = node('label'); label.append(ack, document.createTextNode(' I reviewed this exact image, caption and Instagram destination for one post.'));
      const mutate = async (action, body) => {
        if (!check(ticket) || ticket.busy || !ack.checked) return;
        ticket.busy = true; ticket.content.querySelectorAll('button,input').forEach(e => {e.disabled = true;});
        message(ticket, action === 'execute' ? 'Checking and submitting this exact approved request…' : 'Recording your exact decision…');
        try {await api.request(route + '/' + action, {method: 'POST', body: JSON.stringify(body)}); if (check(ticket)) await review(ticket);}
        catch {error(ticket, action === 'execute' ? 'Publication' : 'Decision');}
        finally {ticket.busy = false;}
      };
      if (saved.status === 'pending' || saved.status === 'approved') ticket.content.append(label);
      if (saved.status === 'pending' && saved.enabled) ticket.content.append(button('Approve this exact proposal', () => mutate('decision', {decision: 'approved', consent: saved.consent})));
      if (['pending', 'approved'].includes(saved.status)) ticket.content.append(button('Reject or revoke this proposal', () => mutate('decision', {decision: 'rejected', consent: saved.consent})));
      if (saved.status === 'approved' && saved.enabled && saved.retained.canContinue) {
        ticket.content.append(node('p', 'This next action can publish one real Instagram post. A retained uncertain attempt cannot be resent.'),
          button(saved.retained.phase === 'not_started' ? 'Publish this exact one post' : 'Check readiness and publish this approved post', () => mutate('execute', {consent: saved.consent})));
      }
      ticket.content.append(button('Read saved outcome without contacting Meta', () => review(ticket)));
      message(ticket, saved.enabled ? 'Approval and publishing are separate actions. There is no automatic retry.' : 'Production publishing is closed. Retained evidence remains available.');
    } catch {error(ticket, 'Saved request read');}
  }
  async function prepareForm(ticket) {
    const context = await api.request(base(ticket.campaign) + '/context'); if (!check(ticket)) return;
    message(ticket, context.notice);
    if (!context.enabled) return;
    const form = node('form'); form.dataset.metaProductionForm = '';
    const page = node('select'), asset = node('select'), image = node('input'); image.type = 'file'; image.accept = 'image/jpeg'; image.required = true;
    for (const [i, p] of context.pages.entries()) {const o = node('option', 'Page ' + p.pageId + ' → Instagram ' + p.instagramId); o.value = String(i); page.append(o);}
    for (const [i, a] of context.assets.entries()) {const o = node('option', a.creativeRequestId + ' · ' + a.assetUrl); o.value = String(i); asset.append(o);}
    for (const [text, input] of [['Instagram destination', page], ['Saved campaign image reference', asset], ['Existing 1080 × 1080 JPEG (maximum 2 MiB)', image]]) {
      const label = node('label', text); label.append(input); form.append(label);
    }
    form.append(node('p', 'Save an exact proposal with the current campaign caption. This stores your JPEG in the existing app database. It does not approve or publish a post.'));
    const submit = node('button', 'Save proposal for exact review'); submit.type = 'submit'; submit.className = 'primary';
    submit.disabled = !context.pages.length || !context.assets.length; form.append(submit); ticket.content.append(form);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!check(ticket) || ticket.busy) return;
      const file = image.files?.[0];
      if (!file || file.size < 100 || file.size > 2097152 || file.type !== 'image/jpeg') {message(ticket, 'Select one JPEG up to 2 MiB.'); return;}
      const p = context.pages[Number(page.value)], a = context.assets[Number(asset.value)]; if (!p || !a) return;
      ticket.busy = true; submit.disabled = true;
      try {
        const jpegBase64 = await new Promise((resolve, reject) => {const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file);});
        if (!check(ticket)) return;
        const body = {requestId: crypto.randomUUID(), selection: {pageId: p.pageId, creativeRequestId: a.creativeRequestId, assetUrl: a.assetUrl},
          jpegBase64, expiresAt: Date.now() + 3600000};
        remember(ticket, body.requestId); message(ticket, 'Saving the exact proposal…');
        await api.request(base(ticket.campaign) + '/proposals', {method: 'POST', body: JSON.stringify(body)});
        if (check(ticket)) await review(ticket);
      } catch {error(ticket, 'Proposal save');} finally {ticket.busy = false;}
    });
  }
  async function open(campaign, requestId) {
    close(); const context = api.getContext(); if (!api.isCurrent(context)) return;
    const ticket = {context, campaign, requestId, busy: false, content: node('section'), status: node('p')}; active = ticket;
    ticket.status.setAttribute('role', 'status');
    dialog.append(node('h2', 'Instagram publication'), button('Close', close), ticket.status, ticket.content); dialog.showModal();
    if (!requestId) {try {requestId = sessionStorage.getItem(key(context, campaign));} catch {}}
    if (typeof requestId === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(requestId)) {ticket.requestId = requestId; await review(ticket);}
    else {try {await prepareForm(ticket);} catch {message(ticket, 'Publication preparation is unavailable. No request was saved.');}}
  }
  function render() {
    if (active && !current(active)) close();
    const context = api.getContext(); if (!api.isCurrent(context)) return;
    for (const preview of document.querySelectorAll('[data-publication-choices]')) {
      if (preview.parentElement.querySelector('[data-meta-production-open]')) continue;
      const b = button('Review Instagram publication', () => open(preview.dataset.publicationChoices));
      b.dataset.metaProductionOpen = preview.dataset.publicationChoices; preview.after(b);
    }
  }
  window.RunvaraMetaProduction = {init(options) {
    api = options; dialog = node('dialog'); dialog.id = 'meta-production-dialog'; dialog.setAttribute('aria-label', 'Exact Instagram publication review'); document.body.append(dialog);
    dialog.addEventListener('cancel', close);
    document.addEventListener('click', event => {const b = event.target.closest('[data-meta-production-request]'); if (b) open(b.dataset.metaProductionCampaign, b.dataset.metaProductionRequest);});
    new MutationObserver(() => {if (active && !current(active)) close();}).observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden']});
  }, render, close};
})();
