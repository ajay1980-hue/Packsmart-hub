(() => {
  'use strict';
  let api, channels = [], data = {}, selected = null, returnFocus, pollTimer, refreshPending, refreshController, refreshTicket, sessionGeneration = 0, journeyTimer;
  const busy = new Set();
  const $ = selector => document.querySelector(selector);
  const labels = { connected: 'Connected', degraded: 'Limited coverage', action_required: 'Action required', disconnected: 'Disconnected', not_configured: 'Not configured', read_only: 'Read-only', approval_gated: 'Approval-gated write', automatic: 'Automatic write', catalogs: 'Catalogues', posts: 'Facebook posts', products: 'Products', variants: 'Variants', inventory: 'Inventory', prices: 'Prices', orders: 'Orders', customers: 'Customers', promotions: 'Promotions', accounts: 'Facebook Pages & Instagram accounts', channels: 'YouTube channels', boards: 'Boards', pins: 'Pins', shops: 'Shops' };
  const label = key => labels[key] || key;
  const esc = value => api.escapeHtml(value);
  const when = value => value ? api.date(value) : 'Not yet';
  const owner = () => data.user?.role === 'owner';
  const manager = () => ['owner', 'admin'].includes(data.user?.role);
  const operatorWorkspace = () => data.launchAdmin === true;
  const statusClass = status => status === 'connected' ? 'good' : ['degraded', 'action_required'].includes(status) ? 'warn' : 'neutral';
  const button = (action, text, channel, style = 'secondary') => `<button type="button" class="${style}" data-connection-action="${action}" data-provider="${channel.id}" ${busy.has(channel.id) || (!manager() && action !== 'open') ? 'disabled' : ''}>${esc(text)}</button>`;
  const content = { editor: null, attempt: null, previous: null, ticket: null, epoch: 0 };
  const contentSchema = 'runvara-manual-content-target/v1';
  const cloneContent = value => JSON.parse(JSON.stringify(value));
  const freezeContent = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freezeContent); Object.freeze(value); } return value; };
  const contentId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
  const sameKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
  // Selection is an opaque, one-use server capability. Keep it in this closure,
  // never in DOM attributes, history, storage, notifications or display copy.
  const orderRecovery = { epoch:0, ticket:null, review:null, display:null, identity:null, source:null, acknowledged:false, phase:'idle', message:'' };
  const recoveryPath = '/api/connections/shopify/order-recovery';
  const recoveryCodes = Object.freeze({
    ORDER_RECOVERY_AUTH_REFRESH_REQUIRED:'Access needs attention. Use the existing Refresh access or Reconnect control, then review again. A changed connection identity can make retained pages ineligible.',
    ORDER_RECOVERY_CAPACITY_EXHAUSTED:'Recovery is on hold because retained recovery storage is full. Paused, failed, uncertain and superseded pages still use capacity; saved completion records also count. An ordinary fresh orders sync remains available.',
    ORDER_RECOVERY_GLOBAL_CAPACITY_EXHAUSTED:'Recovery is on hold because shared retained recovery storage is full. Saved completion records also count. An ordinary fresh orders sync remains available.',
    ORDER_RECOVERY_UNKNOWN:'The recovery outcome is unknown. Retained pages remain on hold. Review the saved status explicitly before taking another recovery action.',
    ORDER_RECOVERY_PAUSED:'Recovery is paused. Retained pages still use capacity and cannot be resumed. An ordinary fresh orders sync remains available.',
    ORDER_RECOVERY_SUPERSEDED:'An ordinary fresh orders sync replaced this recovery attempt. Its retained pages still use capacity and cannot be resumed.',
    ORDER_RECOVERY_SELECTION_INVALID:'This review is no longer valid. Review the current saved status again before continuing.',
    ORDER_RECOVERY_SELECTION_EXPIRED:'This review expired. Review the current saved status again before continuing.',
    ORDER_RECOVERY_SOURCE_UNAVAILABLE:'The saved connection cannot currently be verified for recovery. Review the existing connection controls, then review recovery again.',
    ORDER_RECOVERY_SOURCE_HELD:'The saved order source is on hold. Recovery cannot continue until the source checks pass; retained pages still use capacity.',
    ORDER_RECOVERY_SOURCE_CHANGED:'The connection or saved source changed. These retained pages may no longer be eligible. Review the current connection before another recovery action.',
    ORDER_RECOVERY_BUDGET_EXHAUSTED:'The existing read retry limit has been reached. Recovery is on hold and cannot reset that limit.',
    ORDER_RECOVERY_LEASE_ACTIVE:'An admitted read is still active. Recovery is on hold; review its saved status after that read has settled.',
    ORDER_RECOVERY_READ_FAILED:'This read was interrupted. Validated earlier pages may be retained. Review the saved status and original window explicitly before another attempt.',
    SHOPIFY_ORDER_RECOVERY_PAGE_LIMIT:'This read reached its bounded page limit. Recovery is paused; retained pages still use capacity and are not a complete source-period history.',
    SHOPIFY_ORDER_RECOVERY_STAGE_LIMIT:'This read reached its bounded retained-data limit. Recovery is paused; retained pages still use capacity.',
    ORDER_RECOVERY_UNAVAILABLE:'Optional recovery is unavailable. The ordinary sync controls remain available.'
  });
  const recoveryDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  function recoveryAuthority(context = contentContext()) {
    return Boolean(context?.session && context.csrf && context.userId && context.workspaceId && ['owner','admin'].includes(context.role) &&
      context.role === context.dataRole && context.role === context.session.user?.role && context.userId === context.dataUserId && context.userId === context.session.user?.id &&
      context.workspaceId === context.dataWorkspaceId && context.workspaceId === context.session.workspace?.id &&
      !context.passwordChangeRequired && !context.dataPasswordChangeRequired && !context.session.user?.passwordChangeRequired &&
      context.active !== false && context.dataActive !== false && context.session.user?.active !== false);
  }
  function sameRecoveryIdentity(original, current = contentContext()) {
    return recoveryAuthority(current) && original?.session === current.session && original.userId === current.userId && original.workspaceId === current.workspaceId &&
      original.role === current.role && original.csrf === current.csrf && original.sessionCsrf === current.sessionCsrf;
  }
  function recoveryChannel() { const rows = channels.filter(row=>row?.id==='shopify'); return rows.length===1 ? rows[0] : null; }
  function recoveryAvailable() { return recoveryChannel()?.orderRecovery?.available === true; }
  function recoverySource() { const c=recoveryChannel(); return JSON.stringify(c ? [c.identity,c.configured,c.status,c.settings,c.accessExpiresAt,c.orderRecovery,c.orderRecoveryObservation] : null); }
  function recoveryVisible() { return selected==='shopify' && $('#connection-dialog').open && !document.hidden && contentContext()?.view==='channels'; }
  function validRecoveryWindow(value, startedAt) {
    return sameKeys(value,['requestedLowerBound','requestedUpperBound','sortKey','reverse']) && recoveryDate(startedAt) && recoveryDate(value.requestedLowerBound) &&
      value.requestedUpperBound===startedAt && value.requestedLowerBound<startedAt && value.sortKey==='UPDATED_AT' && value.reverse===false;
  }
  function validRecoveryObservation(value) {
    return sameKeys(value,['originalStartedAt','lastCapturedAt','continued','snapshotConsistency','window']) && validRecoveryWindow(value.window,value.originalStartedAt) &&
      (value.lastCapturedAt===null || recoveryDate(value.lastCapturedAt) && value.lastCapturedAt>=value.originalStartedAt) && typeof value.continued==='boolean' && value.snapshotConsistency==='unverified';
  }
  function validRecoveryPreview(value, workspaceId) {
    if (!sameKeys(value,['schema','workspaceId','available','selection','expiresAt','stage','canStart','canResume','reason','originalStartedAt','window']) ||
      value.schema!=='runvara-order-recovery-preview/v1' || value.workspaceId!==workspaceId || typeof value.available!=='boolean' ||
      typeof value.canStart!=='boolean' || typeof value.canResume!=='boolean' || value.canStart && value.canResume ||
      !(value.reason===null || typeof value.reason==='string' && /^[A-Z_]{1,100}$/.test(value.reason)) ||
      !(value.selection===null || typeof value.selection==='string' && /^[A-Za-z0-9_.:-]{16,512}$/.test(value.selection)) ||
      !(value.expiresAt===null || recoveryDate(value.expiresAt)) ||
      !(value.originalStartedAt===null && value.window===null && !value.available || validRecoveryWindow(value.window,value.originalStartedAt))) return false;
    if ((value.canStart || value.canResume) && (!value.available || !value.selection || !value.expiresAt || Date.parse(value.expiresAt)<=Date.now())) return false;
    if (value.stage!==null) {
      const s=value.stage;
      if (!sameKeys(s,['status','pageCount','orderCount','originalStartedAt','lastCapturedAt','continued','snapshotConsistency','window']) ||
        !['reading','complete','failed','paused','unknown','committed','superseded'].includes(s.status) || !Number.isSafeInteger(s.pageCount) || s.pageCount<0 || s.pageCount>10 ||
        !Number.isSafeInteger(s.orderCount) || s.orderCount<0 || s.orderCount>s.pageCount*50 || !validRecoveryObservation(Object.fromEntries(['originalStartedAt','lastCapturedAt','continued','snapshotConsistency','window'].map(k=>[k,s[k]]))) ||
        s.originalStartedAt!==value.originalStartedAt || JSON.stringify(s.window)!==JSON.stringify(value.window) || value.canStart ||
        value.canResume && !['reading','complete','failed'].includes(s.status)) return false;
    } else if (value.canResume) return false;
    return true;
  }
  function recoveryReason(code) { return recoveryCodes[code] || 'Recovery is on hold. Review the saved connection and current status before continuing. Ordinary sync controls remain available.'; }
  function recoveryAge(value) {
    if (!value) return 'No page captured';
    const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(value))/60000));
    return minutes<1 ? 'less than a minute old' : minutes<60 ? `${minutes} minute${minutes===1?'':'s'} old` : minutes<1440 ? `${Math.floor(minutes/60)} hour${Math.floor(minutes/60)===1?'':'s'} old` : `${Math.floor(minutes/1440)} day${Math.floor(minutes/1440)===1?'':'s'} old`;
  }
  function recoveryObservationText(observation) {
    return `<p>Original observation started: <span>${esc(when(observation.originalStartedAt))}</span>.</p><p>Fixed updated-order window: <span>${esc(observation.window.requestedLowerBound)}</span> (inclusive) to <span>${esc(observation.window.requestedUpperBound)}</span> (exclusive). Orders are read by updated time, oldest first.</p><p>Last retained page: ${esc(observation.lastCapturedAt ? when(observation.lastCapturedAt) : 'None')} · ${esc(recoveryAge(observation.lastCapturedAt))}.</p>`;
  }
  function recoveryProvenance(channel) {
    const o=channel.orderRecoveryObservation;
    if (!o) return '';
    if (!validRecoveryObservation(o)) return '<section id="connection-order-observation" class="connection-section"><h3>Saved order observation</h3><p>Original order observation details are unavailable. Freshness, snapshot consistency and source-period coverage remain unverified.</p></section>';
    return `<section id="connection-order-observation" class="connection-section connection-exact-text"><h3>Saved order observation</h3>${recoveryObservationText(o)}<p>${o.continued?'Saved orders include pages retained from an earlier observation.':'These orders were saved through optional recovery.'} Completing or saving the read does not make the original observation newer. Snapshot consistency and source-period coverage remain unverified.</p></section>`;
  }
  function recoveryPanel() {
    if (!recoveryAvailable() || !recoveryAuthority()) return '';
    return `<section id="connection-order-recovery" class="connection-section connection-exact-text" aria-labelledby="order-recovery-heading"><h3 id="order-recovery-heading">Optional order recovery</h3><p>Review a bounded saved orders read before starting or continuing it. Only orders are included; customer records remain optional under the existing sync controls.</p><p>Pages can reflect different observation times. Shopify snapshot consistency, cursor lifetime and complete source-period coverage are unverified. This does not establish current sales, profit or financial approval.</p><div id="order-recovery-details"></div><p id="order-recovery-status" role="status" aria-live="polite"></p><form id="connection-order-recovery-form" class="connection-manage-form" aria-busy="false"><label class="check-label"><input id="order-recovery-ack" type="checkbox" disabled> I reviewed the fixed window, original observation time and page age. Continue only this orders read using my current owner or admin session.</label><div class="button-row"><button id="order-recovery-review" type="button" class="secondary">Review order recovery</button><button id="order-recovery-start" type="submit" class="primary hidden" disabled>Start reviewed orders read</button><button id="order-recovery-resume" type="submit" class="primary hidden" disabled>Resume reviewed orders read</button><button id="order-recovery-cancel" type="button" class="secondary hidden">Cancel review</button></div></form><p>Recovery has bounded capacity. Retained attempts and saved completion records count toward its limits. Ordinary fresh orders sync remains available through Sync selected now; it supersedes a retained recovery attempt before reading and does not free that attempt’s capacity.</p></section>`;
  }
  function renderRecoveryState() {
    const panel=$('#connection-order-recovery'); if (!panel) return;
    if (!recoveryAuthority() || !recoveryAvailable()) { panel.remove(); return; }
    const review=orderRecovery.review, display=review || orderRecovery.display, working=Boolean(orderRecovery.ticket), ready=review && (review.canStart || review.canResume) && Date.parse(review.expiresAt)>Date.now();
    const s=display?.stage;
    $('#order-recovery-details').innerHTML=display?.window ? recoveryObservationText({originalStartedAt:display.originalStartedAt,window:display.window,lastCapturedAt:s?.lastCapturedAt||null}) +
      (s?`<p>Saved status: ${esc(s.status)}. ${s.pageCount} retained page${s.pageCount===1?'':'s'} · ${s.orderCount} retained order${s.orderCount===1?'':'s'}.</p>`:'<p>No retained pages will be used for this new read.</p>') : '';
    $('#order-recovery-status').textContent=orderRecovery.message || (working?'Reviewing saved recovery status…':review?.reason?recoveryReason(review.reason):s?.status==='superseded'?recoveryReason('ORDER_RECOVERY_SUPERSEDED'):s?.status==='paused'?recoveryReason('ORDER_RECOVERY_PAUSED'):s?.status==='unknown'?recoveryReason('ORDER_RECOVERY_UNKNOWN'):review?'Review the original window and observation above, then choose whether to continue.':'Recovery status is read only when you choose Review order recovery.');
    $('#connection-order-recovery-form').setAttribute('aria-busy',String(working));
    $('#order-recovery-review').disabled=working || busy.has('shopify');
    $('#order-recovery-ack').disabled=working || !ready;
    $('#order-recovery-ack').checked=Boolean(orderRecovery.acknowledged && ready);
    for (const action of ['start','resume']) { const node=$('#order-recovery-'+action); node.classList.toggle('hidden',!review?.[action==='start'?'canStart':'canResume']); node.disabled=working || !ready || !orderRecovery.acknowledged; }
    $('#order-recovery-cancel').classList.toggle('hidden',!review && !working);
    $('#order-recovery-cancel').textContent=orderRecovery.ticket?.kind==='action'?'Dismiss review':'Cancel review';
  }
  function interruptRecovery(reason='Review interrupted',clear=false) {
    const ticket=orderRecovery.ticket; orderRecovery.epoch++; orderRecovery.ticket=null; ticket?.controller.abort();
    const unknown=ticket?.kind==='action' && ticket.sent;
    orderRecovery.review=null; orderRecovery.acknowledged=false;
    if (clear || orderRecovery.identity && !sameRecoveryIdentity(orderRecovery.identity)) { orderRecovery.identity=null; orderRecovery.source=null; orderRecovery.display=null; orderRecovery.phase='idle'; orderRecovery.message=''; $('#connection-order-recovery')?.remove(); }
    else if (unknown) { orderRecovery.phase='unknown'; orderRecovery.message='The recovery outcome is unknown. Leaving cannot cancel a server save. Review saved status explicitly before another recovery action.'; }
    else if (orderRecovery.phase!=='unknown' && orderRecovery.phase!=='saved') { orderRecovery.display=null; orderRecovery.phase='idle'; orderRecovery.message=reason+'. Review again before continuing.'; }
    renderRecoveryState();
  }
  function observeRecoverySource() {
    if (!orderRecovery.identity) return;
    const current=contentContext();
    if (!sameRecoveryIdentity(orderRecovery.identity)) { interruptRecovery('Current session changed',true); return; }
    if (orderRecovery.source!==recoverySource() || orderRecovery.identity.generation!==current.generation || orderRecovery.identity.bootstrap!==current.bootstrap) interruptRecovery('The saved connection or workspace changed');
  }
  function currentRecoveryTicket(ticket) {
    const context=contentContext();
    return orderRecovery.ticket===ticket && ticket.epoch===orderRecovery.epoch && recoveryVisible() && recoveryAvailable() && sameRecoveryIdentity(ticket.context) &&
      ticket.context.generation===context.generation && ticket.context.bootstrap===context.bootstrap && ticket.source===recoverySource();
  }
  async function reviewRecovery() {
    observeRecoverySource();
    if (!recoveryAuthority() || !recoveryAvailable() || !recoveryVisible() || orderRecovery.ticket || busy.has('shopify') || content.ticket) return;
    orderRecovery.review=null; orderRecovery.display=null; orderRecovery.acknowledged=false; orderRecovery.message=''; orderRecovery.phase='reviewing';
    const ticket={kind:'review',context:{...contentContext()},source:recoverySource(),epoch:orderRecovery.epoch,controller:new AbortController()};
    orderRecovery.ticket=ticket; orderRecovery.identity=ticket.context; orderRecovery.source=ticket.source; renderRecoveryState();
    try {
      const result=await api.request(recoveryPath,{signal:ticket.controller.signal,isCurrent:()=>currentRecoveryTicket(ticket)});
      if (!currentRecoveryTicket(ticket)) return;
      if (!validRecoveryPreview(result,ticket.context.workspaceId)) throw new Error('Invalid public recovery preview');
      orderRecovery.review=cloneContent(result); orderRecovery.display=cloneContent({stage:result.stage,originalStartedAt:result.originalStartedAt,window:result.window}); orderRecovery.phase='reviewed';
    } catch(error) { if (currentRecoveryTicket(ticket)) { orderRecovery.phase='held'; orderRecovery.message=contentIdentityError(error)?'Your current owner or admin session could not be verified. Sign in again and review the saved status.':recoveryReason(error.code); } }
    finally { if (orderRecovery.ticket===ticket) { orderRecovery.ticket=null; renderRecoveryState(); } }
  }
  async function submitRecovery() {
    observeRecoverySource();
    const review=orderRecovery.review;
    if (!recoveryAuthority() || !recoveryAvailable() || !recoveryVisible() || orderRecovery.ticket || busy.has('shopify') || content.ticket || !review || !orderRecovery.acknowledged || !$('#order-recovery-ack')?.checked) return;
    if (!sameRecoveryIdentity(orderRecovery.identity) || !validRecoveryPreview(review,contentContext().workspaceId) || Date.parse(review.expiresAt)<=Date.now()) { interruptRecovery('This review expired or changed'); return; }
    const action=review.canResume?'resume':review.canStart?'start':null; if (!action) return;
    const ticket={kind:'action',sent:true,context:{...contentContext()},source:recoverySource(),epoch:orderRecovery.epoch,controller:new AbortController()};
    const selection=review.selection; orderRecovery.review=null; orderRecovery.acknowledged=false; orderRecovery.ticket=ticket; orderRecovery.phase='sending';
    orderRecovery.message='Reading the reviewed orders window. Leaving cannot cancel a server save.'; renderRecoveryState();
    try {
      const result=await api.request(recoveryPath+'/'+action,{method:'POST',body:JSON.stringify({selection}),signal:ticket.controller.signal,isCurrent:()=>currentRecoveryTicket(ticket)});
      if (!currentRecoveryTicket(ticket)) return;
      if (!sameKeys(result,['schema','workspaceId','status','originalStartedAt','lastCapturedAt','continued','snapshotConsistency','code']) || result.schema!=='runvara-order-recovery-result/v1' || result.workspaceId!==ticket.context.workspaceId ||
        !['committed','interrupted','unknown'].includes(result.status) || result.originalStartedAt!==review.originalStartedAt || !(result.lastCapturedAt===null || recoveryDate(result.lastCapturedAt) && result.lastCapturedAt>=result.originalStartedAt) ||
        typeof result.continued!=='boolean' || result.snapshotConsistency!=='unverified' || !(result.code===null || typeof result.code==='string' && /^[A-Z_]{1,100}$/.test(result.code))) throw new Error('Recovery outcome unconfirmed');
      ticket.sent=false; orderRecovery.phase=result.status==='committed'?'saved':result.status==='unknown'?'unknown':'held';
      orderRecovery.message=result.status==='committed'?'Orders saved with the original observation time. Retained earlier pages do not become a fresh snapshot; snapshot consistency and source-period coverage remain unverified.':recoveryReason(result.code || (result.status==='unknown'?'ORDER_RECOVERY_UNKNOWN':null));
      if (result.status==='committed') { orderRecovery.display=null; orderRecovery.ticket=null; renderRecoveryState(); await api.reload({migrate:false}); }
    } catch(error) {
      if (!currentRecoveryTicket(ticket)) return;
      orderRecovery.phase='unknown'; orderRecovery.message=error.code==='ORDER_RECOVERY_AUTH_REFRESH_REQUIRED'?recoveryReason(error.code):contentIdentityError(error)?'Your current owner or admin session could not be verified. The outcome needs a fresh saved-status review after signing in.':error.status && error.status<500 && error.code!=='STATE_CONFLICT'?recoveryReason(error.code):recoveryReason('ORDER_RECOVERY_UNKNOWN');
    } finally { if (orderRecovery.ticket===ticket) { orderRecovery.ticket=null; renderRecoveryState(); } }
  }
  function contentContext() { return api.getContentContext?.() || null; }
  function contentOwner(context = contentContext()) {
    return Boolean(context?.session && context.userId && context.workspaceId && context.csrf && context.userId === context.session.user?.id &&
      context.userId === context.dataUserId && context.workspaceId === context.session.workspace?.id && context.workspaceId === context.dataWorkspaceId &&
      context.role === 'owner' && context.dataRole === 'owner' && context.session.user?.role === 'owner' &&
      !context.passwordChangeRequired && !context.dataPasswordChangeRequired && !context.session.user?.passwordChangeRequired &&
      context.active !== false && context.dataActive !== false && context.session.user?.active !== false);
  }
  function sameContentIdentity(original, current = contentContext()) {
    return contentOwner(current) && original?.session === current.session && original.userId === current.userId && original.workspaceId === current.workspaceId &&
      original.csrf === current.csrf && original.sessionCsrf === current.sessionCsrf;
  }
  function currentContentTarget() {
    const matches = channels.filter(channel => channel?.id === 'shopify');
    const projection = matches.length === 1 ? matches[0].contentPreparation : null, target = projection?.target;
    if (projection?.available !== true || !sameKeys(target, ['schema','connectionId','account','settingsRevision']) || target.schema !== contentSchema ||
      !contentId(target.connectionId) || typeof target.account !== 'string' || target.account.length > 253 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(target.account) ||
      !Number.isSafeInteger(target.settingsRevision) || target.settingsRevision < 0) return null;
    return cloneContent(target);
  }
  function contentProducts() {
    const rows = Array.isArray(data.products) ? data.products : [];
    return rows.filter(row => row?.provider === 'shopify' && typeof row.id === 'string' && row.id.length <= 100 && /^gid:\/\/shopify\/Product\/\d+$/.test(row.id) &&
      rows.filter(other => other?.id === row.id).length === 1 && [row.workspaceId,row.workspace_id,row.tenantId,row.tenant_id,row.workspace?.id,row.tenant?.id,typeof row.workspace === 'string' ? row.workspace : undefined,typeof row.tenant === 'string' ? row.tenant : undefined].every(value => value === undefined || value === data.workspace?.id))
      .map(row => ({ id: row.id, title: typeof row.title === 'string' ? row.title.slice(0,400) : 'Saved Shopify product' }));
  }
  function contentSourceKey() { return JSON.stringify([currentContentTarget(), contentProducts()]); }
  function currentContentIdentity() {
    const identity = content.attempt?.identity || content.editor?.identity;
    if (identity && !sameContentIdentity(identity)) { interruptContent('Session changed', true); return false; }
    return contentOwner();
  }
  function contentVisible() { return selected === 'shopify' && $('#connection-dialog').open && !document.hidden && contentContext()?.view === 'channels'; }
  function interruptContent(reason = 'Editing interrupted', clear = false) {
    content.epoch++;
    const ticket = content.ticket; content.ticket = null; ticket?.controller.abort();
    if (clear || ((content.attempt || content.editor) && !sameContentIdentity(content.attempt?.identity || content.editor.identity))) {
      content.editor = null; content.attempt = null; content.previous = null;
      $('#connection-content-editor')?.replaceChildren();
      return;
    }
    if (content.attempt && !['saved','refused'].includes(content.attempt.phase)) {
      if (content.attempt.sent) { content.attempt.phase = 'unknown'; content.attempt.hadUnknown = true; content.attempt.retryReady = false; }
      else content.attempt = null;
    }
    if (content.editor) {
      content.editor.ackKey = null; content.editor.stale = true;
      content.editor.message = reason + '. Review the retained draft and explicitly reload saved targets before preparing a change.';
    }
    renderContentState();
  }
  function observeContentSource() {
    if (!currentContentIdentity()) return;
    const editor = content.editor;
    if (editor && (editor.sourceKey !== contentSourceKey() || editor.generation !== contentContext()?.generation || editor.bootstrap !== contentContext()?.bootstrap)) {
      if (content.ticket) interruptContent('The saved content target or workspace changed');
      editor.stale = true; editor.ackKey = null;
      editor.message = 'The saved target, products or workspace context changed. Reload and review; no account or product will be selected automatically.';
      if (content.attempt) content.attempt.retryReady = false;
      renderContentState();
    }
  }
  function newContentEditor() {
    if (!contentOwner()) return;
    const context = contentContext();
    content.editor = { identity: { ...context }, generation: context.generation, bootstrap: context.bootstrap, target: currentContentTarget(), products: contentProducts(),
      sourceKey: contentSourceKey(), fields: { account:'', product:'', title:'', description:'' }, ackKey:null, stale:false, message:'' };
  }
  function contentForm() {
    if (!currentContentIdentity()) return '<section id="connection-content-editor" class="connection-section"><p>Content preparation requires the current owner session.</p></section>';
    if (!content.editor) newContentEditor();
    const editor = content.editor, attempt = content.attempt, target = attempt?.intent?.target || editor.target, fields = editor.fields;
    const selectedAccount = attempt?.intent ? attempt.intent.target.connectionId : fields.account;
    const selectedProduct = attempt?.intent ? attempt.intent.input.productId : fields.product;
    const choices = editor.products.some(row => row.id === selectedProduct) || !selectedProduct ? editor.products : [...editor.products, { id:selectedProduct,title:'Retained exact product reference' }];
    return `<section id="connection-content-editor" class="connection-section"><h3>Prepare an exact Shopify content change</h3>
      <p>Choose the saved account and product, then review the exact title and description. Preparation records a request for approval; it never publishes. Other restrictions still apply.</p>
      <form id="connection-content-form" class="connection-manage-form" aria-busy="false">
      <label>Exact saved account<select id="content-account" required><option value="">Choose the exact saved Shopify account</option>${target ? `<option value="${esc(target.connectionId)}" ${selectedAccount === target.connectionId ? 'selected' : ''}>${esc(target.account)} · ${esc(target.connectionId)}</option>` : ''}</select></label>
      <label>Product<select id="content-product" required><option value="">Choose a saved Shopify product</option>${choices.map(row => `<option value="${esc(row.id)}" ${row.id === selectedProduct ? 'selected' : ''}>${esc(row.title)} · ${esc(row.id)}</option>`).join('')}</select></label>
      <label>Exact new title<input id="content-title" maxlength="200" required value="${esc(attempt?.intent?.input.title ?? fields.title)}"></label>
      <label>Exact new description<textarea id="content-description" maxlength="10000">${esc(attempt?.intent?.input.description ?? fields.description)}</textarea></label>
      <p id="content-status" role="status"></p><div id="content-exact" class="connection-exact-text"></div>
      <label class="check-label"><input id="content-ack" type="checkbox"> I reviewed this exact account, product, title and description. Prepare only this request for separate owner approval.</label>
      <div class="button-row"><button id="content-prepare" type="submit" class="secondary">Prepare exact content request</button><button id="content-check" type="button" class="secondary hidden">Check exact saved request</button><button id="content-retry" type="button" class="secondary hidden">Retry the same request reference</button><button id="content-reload" type="button" class="secondary">Discard unsent draft and reload targets</button><button id="content-new" type="button" class="secondary hidden">Start a different content draft</button><button id="content-approvals" type="button" class="secondary hidden" data-connection-action="approvals" data-provider="shopify">Open Approval Centre</button></div>
      <p id="content-error" class="connection-feedback bad" role="alert"></p></form>
      <p class="muted tiny">Saved target settings can change before preparation. This reference is not proof of current credentials or provider freshness. Exact approval and a separate Apply action remain necessary. Unconfirmed request references stay only in this session; a full page reload cannot prove whether an earlier request was recorded.</p></section>`;
  }
  function readContentFields() {
    return { account:$('#content-account')?.value || '', product:$('#content-product')?.value || '', title:$('#content-title')?.value || '', description:$('#content-description')?.value || '' };
  }
  function contentDraftKey() { return JSON.stringify([content.editor?.target, readContentFields(), content.editor?.sourceKey]); }
  function contentInput(fields) { return { productId:fields.product, operation:'product_content', title:fields.title.trim(), description:fields.description }; }
  function contentIntentKey(input, target) { return JSON.stringify([input, target.connectionId, target.account]); }
  function validContentDraft() {
    const editor = content.editor, fields = readContentFields();
    return editor?.target && fields.account === editor.target.connectionId && editor.products.some(row => row.id === fields.product) && fields.title.trim() && fields.title.length <= 200 && fields.description.length <= 10000;
  }
  function renderContentState() {
    const form = $('#connection-content-form'), editor = content.editor, attempt = content.attempt;
    if (!form || !editor) return;
    const working = Boolean(content.ticket), unresolved = attempt && !['saved','refused'].includes(attempt.phase), saved = attempt?.phase === 'saved';
    const locked = working || Boolean(unresolved) || saved || editor.stale;
    for (const id of ['content-account','content-product','content-title','content-description']) $('#' + id).disabled = locked;
    const ready = unresolved ? attempt.retryReady && !working && !editor.stale : !saved && !editor.stale && validContentDraft();
    $('#content-ack').disabled = !ready;
    if (!editor.ackKey) $('#content-ack').checked = false;
    $('#content-prepare').classList.toggle('hidden', Boolean(unresolved) || saved);
    $('#content-prepare').disabled = working || !ready || !$('#content-ack').checked || editor.ackKey !== contentDraftKey();
    $('#content-check').classList.toggle('hidden', !unresolved); $('#content-check').disabled = working;
    $('#content-retry').classList.toggle('hidden', !unresolved || !attempt.retryReady);
    $('#content-retry').disabled = !ready || !$('#content-ack').checked || editor.ackKey !== contentDraftKey();
    $('#content-reload').classList.toggle('hidden', Boolean(unresolved) || saved); $('#content-reload').disabled = working;
    $('#content-new').classList.toggle('hidden', !saved && attempt?.phase !== 'refused'); $('#content-new').disabled = working;
    $('#content-approvals').classList.toggle('hidden', !saved);
    form.setAttribute('aria-busy', String(working));
    const fields = attempt?.intent ? { product:attempt.intent.input.productId,title:attempt.intent.input.title,description:attempt.intent.input.description } : readContentFields();
    const target = attempt?.intent?.target || editor.target;
    $('#content-exact').textContent = 'Account: ' + (target ? target.account + '\nConnection: ' + target.connectionId + '\nSaved settings revision: ' + target.settingsRevision : 'No eligible exact target') +
      '\nProduct ID: ' + (fields.product || 'Not selected') + '\nExact proposed title: ' + (fields.title.trim() || 'Not entered') + '\nExact proposed description:\n' + fields.description +
      (attempt ? '\nRequest reference: ' + attempt.requestId : '');
    $('#content-status').textContent = saved ? 'Exact request found: ' + attempt.record.id + ' · ' + label(attempt.record.status) + '. This is saved request history, not permission to apply or evidence of a new publication.' :
      attempt?.phase === 'submitting' ? 'Preparing this one exact request. Leaving cannot cancel a server save.' :
      attempt?.phase === 'reconciling' ? 'Checking this exact saved request reference…' :
      unresolved ? (attempt.retryReady ? 'No matching request was found in the checked snapshot. An earlier request could still commit. Review the retained exact content before deliberately retrying the same reference.' : 'The preparation outcome is unknown. This exact request may already have been recorded. Check its saved reference before any retry; no new reference will be created.') :
      editor.stale ? editor.message : editor.target ? 'Choose the exact account and product deliberately. The account reference is for preparation; write authority is checked separately.' :
      'Exact content preparation is unavailable. Reload saved targets after the connection settings have been reviewed.';
  }
  function contentTicket(kind) {
    const context = contentContext(), ticket = { kind, context:{...context}, epoch:content.epoch, controller:new AbortController() };
    content.ticket = ticket; return ticket;
  }
  function currentContentTicket(ticket) {
    if (content.ticket !== ticket || ticket.epoch !== content.epoch || !sameContentIdentity(ticket.context)) return false;
    const context = contentContext();
    return ticket.context.generation === context.generation && ticket.context.bootstrap === context.bootstrap && contentVisible();
  }
  const contentIdentityError = error => error.status === 401 || (error.status === 403 && ['ROLE_DENIED','WRITE_ACTOR_CHANGED','PASSWORD_CHANGE_REQUIRED'].includes(error.code));
  function contentError(message) { if ($('#content-error')) $('#content-error').textContent = message; }
  function validContentRecord(record, attempt, strict = false) {
    const input = attempt.intent.input;
    return (!strict || sameKeys(record,['id','requestId','provider','input','digest','connectionId','account','requestedBy','status','approvalId'])) &&
      contentId(record?.id) && record.requestId === attempt.requestId && record.provider === 'shopify' && record.requestedBy === attempt.identity.userId &&
      record.connectionId === attempt.intent.target.connectionId && record.account === attempt.intent.target.account && record.digest === attempt.intent.digest &&
      contentId(record.approvalId) && ['pending_approval','ready','executing','processing','completed','uncertain','failed','rejected'].includes(record.status) &&
      sameKeys(record.input,['productId','operation','title','description']) && Object.keys(input).every(key => record.input[key] === input[key]);
  }
  function acceptContentRecord(attempt, record) {
    attempt.phase = 'saved'; attempt.retryReady = false; attempt.record = freezeContent(cloneContent(record));
    content.editor.ackKey = null; content.editor.stale = false; contentError('');
  }
  function unavailableContentAttempt(attempt, message) {
    attempt.phase = 'unknown'; attempt.hadUnknown = true; attempt.retryReady = false; content.editor.ackKey = null;
    contentError(message); renderContentState();
  }
  async function prepareContent(retry = false) {
    if (!currentContentIdentity() || !contentVisible() || content.ticket || !content.editor || content.editor.stale) return;
    observeContentSource();
    const editor = content.editor;
    if (editor.stale || !$('#content-ack').checked || editor.ackKey !== contentDraftKey()) return;
    let attempt = content.attempt;
    if (retry) {
      if (!attempt?.retryReady || !sameContentIdentity(attempt.identity) || JSON.stringify(currentContentTarget()) !== JSON.stringify(attempt.intent.target)) return;
      const fields = readContentFields();
      if (fields.account !== attempt.intent.target.connectionId || JSON.stringify(contentInput(fields)) !== JSON.stringify(attempt.intent.input)) {
        editor.ackKey = null; contentError('The displayed fields no longer match the frozen request. Close and reopen to review that exact request before checking again.'); renderContentState(); return;
      }
    } else {
      if ((attempt && attempt.phase !== 'refused') || !validContentDraft()) return;
      const fields = readContentFields(), input = contentInput(fields), target = cloneContent(editor.target), key = contentIntentKey(input,target);
      if (content.previous?.phase === 'saved' && content.previous.key === key) { contentError('This exact content was already prepared. Review the saved request, or deliberately change the content or target for a different draft.'); return; }
      const prior = attempt?.phase === 'refused' ? attempt : content.previous?.phase === 'refused' ? content.previous : null;
      attempt = { identity:{...contentContext()}, requestId:prior?.key === key ? prior.requestId : crypto.randomUUID(), key, phase:'submitting', sent:false, hadUnknown:false, retryReady:false,
        intent: { input, target, digest:null } };
      content.attempt = attempt;
      $('#content-title').value = input.title; editor.fields = { ...fields, title:input.title };
    }
    const ticket = contentTicket('prepare'); attempt.phase = 'submitting'; attempt.retryReady = false; contentError(''); renderContentState();
    try {
      if (!attempt.intent.digest) {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(attempt.intent.input)));
        if (!currentContentTicket(ticket)) return;
        attempt.intent = freezeContent({ ...attempt.intent, digest:Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2,'0')).join('') });
      }
      if (!currentContentTicket(ticket)) return;
      const visible = readContentFields();
      if (visible.account !== attempt.intent.target.connectionId || JSON.stringify(contentInput(visible)) !== JSON.stringify(attempt.intent.input) ||
        content.editor.sourceKey !== contentSourceKey()) throw Object.assign(new Error('The reviewed fields or saved target changed before preparation. Reload and review again.'), {status:400,code:'CONTENT_REVIEW_CHANGED'});
      attempt.sent = true;
      const body = { operation:'product_content', requestId:attempt.requestId, productId:attempt.intent.input.productId, title:attempt.intent.input.title, description:attempt.intent.input.description, target:attempt.intent.target };
      const result = await api.request('/api/connections/shopify/writes', { method:'POST',body:JSON.stringify(body), signal:ticket.controller.signal, isCurrent:()=>currentContentTicket(ticket) });
      if (!currentContentTicket(ticket)) return;
      if (!sameKeys(result,['write']) || !validContentRecord(result.write,attempt) || result.write.requiresApproval !== true) throw Object.assign(new Error('The response did not confirm this exact request.'),{code:'CONTENT_RESULT_UNKNOWN'});
      acceptContentRecord(attempt,result.write);
    } catch (error) {
      if (!currentContentTicket(ticket)) return;
      if (contentIdentityError(error)) { interruptContent('Owner session unavailable',true); return; }
      if (attempt.sent && (attempt.hadUnknown || !error.status || error.status >= 500 || error.code === 'STATE_CONFLICT' || error.code === 'CONTENT_RESULT_UNKNOWN')) unavailableContentAttempt(attempt,'The outcome is unknown. Check the exact saved request before retrying. ' + error.message);
      else { attempt.phase = 'refused'; editor.ackKey = null; editor.stale = true; editor.message = 'Preparation was refused. Reload targets and review a deliberate draft before another request.'; contentError(error.message); }
    } finally {
      if (content.ticket === ticket) { content.ticket = null; if (currentContentIdentity()) renderContentState(); }
    }
  }
  async function checkContentAttempt() {
    const attempt = content.attempt;
    if (!attempt?.intent?.digest || ['saved','refused'].includes(attempt.phase) || !currentContentIdentity() || !contentVisible() || content.ticket) return;
    const ticket = contentTicket('check'); attempt.phase = 'reconciling'; attempt.retryReady = false; content.editor.ackKey = null; contentError(''); renderContentState();
    const config = {signal:ticket.controller.signal,isCurrent:()=>currentContentTicket(ticket)};
    try {
      const result = await api.request('/api/connections/shopify/content-requests/' + encodeURIComponent(attempt.requestId),config);
      if (!currentContentTicket(ticket)) return;
      if (!sameKeys(result,['schema','workspaceId','requestId','requestedBy','found','request']) || result.schema !== 'runvara-manual-content-request/v1' || result.workspaceId !== attempt.identity.workspaceId ||
        result.requestedBy !== attempt.identity.userId || result.requestId !== attempt.requestId || typeof result.found !== 'boolean' ||
        (result.found ? !validContentRecord(result.request,attempt,true) : result.request !== null)) throw new Error('The saved response did not match this exact request and requester.');
      if (result.found) { acceptContentRecord(attempt,result.request); return; }
      const latest = await api.request('/api/connection-centre',config);
      if (!currentContentTicket(ticket)) return;
      if (!Array.isArray(latest?.channels) || latest.channels.filter(channel=>channel?.id==='shopify').length !== 1) throw new Error('A current exact Shopify target was not returned.');
      channels = latest.channels; data.connectionCentre = channels;
      const matching = JSON.stringify(currentContentTarget()) === JSON.stringify(attempt.intent.target) && contentProducts().some(row=>row.id===attempt.intent.input.productId);
      attempt.phase = 'unknown'; attempt.retryReady = matching;
      content.editor.stale = !matching; content.editor.sourceKey = contentSourceKey(); content.editor.generation = contentContext().generation; content.editor.bootstrap = contentContext().bootstrap;
      if (!matching) contentError('The saved target or product changed. The original request stays unconfirmed; a new account or reference cannot be substituted. Check the exact saved request again after reviewing the connection.');
    } catch(error) {
      if (!currentContentTicket(ticket)) return;
      if (contentIdentityError(error)) { interruptContent('Owner session unavailable',true); return; }
      unavailableContentAttempt(attempt,'Could not reconcile this exact request. It remains unconfirmed. ' + error.message);
    } finally { if (content.ticket === ticket) { content.ticket = null; if (currentContentIdentity()) renderContentState(); } }
  }
  async function reloadContentDraft() {
    if (!currentContentIdentity() || !contentVisible() || content.ticket || (content.attempt && !['saved','refused'].includes(content.attempt.phase))) return;
    const ticket = contentTicket('reload'); content.editor.ackKey = null; contentError(''); renderContentState();
    try {
      const payload = await api.request('/api/connection-centre',{signal:ticket.controller.signal,isCurrent:()=>currentContentTicket(ticket)});
      if (!currentContentTicket(ticket)) return;
      if (!Array.isArray(payload?.channels) || payload.channels.filter(channel=>channel?.id==='shopify').length !== 1) throw new Error('The saved Shopify target is unavailable.');
      channels = payload.channels; data.connectionCentre = channels;
      content.previous = content.attempt || content.previous; content.attempt = null; newContentEditor();
      const panel = $('#connection-content-editor'); panel.outerHTML = contentForm(); renderContentState(); $('#content-account')?.focus();
    } catch(error) { if (currentContentTicket(ticket)) { if (contentIdentityError(error)) interruptContent('Owner session unavailable',true); else contentError('Could not reload saved targets: ' + error.message); } }
    finally { if (content.ticket === ticket) { content.ticket = null; if (currentContentIdentity()) renderContentState(); } }
  }
  function contentFieldChanged(event) {
    if (!event.target.closest('#connection-content-form') || !currentContentIdentity() || !contentVisible() || content.ticket || !content.editor) return;
    if (event.target.id === 'content-ack') content.editor.ackKey = event.target.checked ? contentDraftKey() : null;
    else { content.editor.fields = readContentFields(); content.editor.ackKey = null; }
    observeContentSource(); renderContentState();
  }
  function objectiveContentDisplay(write) {
    // This is a display-only DTO. It never validates a signed proposal or supplies
    // authority for preparation, approval, reconciliation or provider execution.
    if (!write || !Object.hasOwn(write, 'sourceDisplay')) return null;
    const source = write.sourceDisplay;
    const unavailable = { origin: source?.origin === 'owner_objective_content' ? 'owner_objective_content' : 'unknown', status: 'unavailable' };
    if (!sameKeys(source, ['schema','origin','status','objectiveId','objectiveRevision','jobId','reportId','opportunityId','productId']) ||
      source.schema !== 'runvara-objective-content-display/v1' || source.origin !== 'owner_objective_content' || source.status !== 'available' ||
      write.provider !== 'shopify' || write.input?.operation !== 'product_content' || source.productId !== write.input.productId ||
      !['objectiveId','jobId','reportId','opportunityId'].every(key => contentId(source[key])) ||
      !Number.isSafeInteger(source.objectiveRevision) || source.objectiveRevision < 1 || typeof source.productId !== 'string' || source.productId.length > 100 ||
      !/^gid:\/\/shopify\/Product\/\d+$/.test(source.productId)) return unavailable;
    return source;
  }
  function objectiveContentWriteDetails(write) {
    const source = objectiveContentDisplay(write);
    if (!source) return '';
    const identity = source.status === 'available' ? '<dt>Request purpose</dt><dd>Owner-written content associated with a saved goal; commercial readiness and objective progress remain unverified.</dd>' +
      [['Saved objective', source.objectiveId],['Objective revision',source.objectiveRevision],['Diagnostic report',source.reportId],['Review job',source.jobId],['Selected opportunity',source.opportunityId],['Retained product reference',source.productId]].map(([key,value]) => '<dt>' + key + '</dt><dd class="connection-exact-text">' + esc(value) + '</dd>').join('') :
      '<dt>' + (source.origin === 'owner_objective_content' ? 'Goal-associated source' : 'Unsupported request origin') + '</dt><dd>Saved source unavailable. This request must not be treated as a manual content request.</dd>';
    return identity +
      (write.input?.description === '' ? '<dt>Description consequence</dt><dd>The empty proposed description clears the Shopify description.</dd>' : '') +
      '<dt>Source limits</dt><dd>Server-recorded diagnostic history, not independently immutable proof. Retained product import account is unverified. Saved financial and stock restrictions remain blocking without qualified evidence. Exact approval and separate Apply are still required. Current manual-action outcome linking does not support this origin.</dd>';
  }
  function reviewableWriteInput(write) {
    const input = write?.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const strings = keys => keys.every(key => typeof input[key] === 'string');
    if (write.provider === 'shopify' && strings(['productId'])) {
      if (input.operation === 'product_content') return strings(['title','description']);
      if (input.operation === 'internal_note') return strings(['note']);
      if (['product_tags_add','product_tags_remove'].includes(input.operation)) return Array.isArray(input.tags) && input.tags.every(value => typeof value === 'string') &&
        (!Object.hasOwn(input,'expectedTags') || Array.isArray(input.expectedTags) && input.expectedTags.every(value => typeof value === 'string'));
    }
    if (write.provider !== 'meta') return false;
    switch (input.operation) {
      case 'catalog_product_create': return strings(['catalogId','name','description','retailerId','brand','category','url','imageUrl','currency','availability','condition','visibility']) && Number.isSafeInteger(input.priceMinor);
      case 'catalog_product_update': return strings(['catalogId','productId','name','description']);
      case 'catalog_visibility': return strings(['catalogId','productId','visibility']);
      case 'catalog_inventory': return strings(['catalogId','productId','availability']) && Number.isSafeInteger(input.quantity);
      case 'instagram_publish': return strings(['pageId','instagramId','caption','imageUrl']);
      case 'facebook_publish': return strings(['pageId','message']) && (!Object.hasOwn(input,'link') || typeof input.link === 'string');
      case 'facebook_update': return strings(['pageId','postId','message']);
      default: return false;
    }
  }
  // Match only fixed receipt codes. Raw receipt messages and source documents
  // are never display copy, and a code alone cannot prove a pre-send refusal.
  const contentReceiptErrors = Object.freeze({
    CONTENT_RECEIPT_CAPACITY_EXHAUSTED: 'Protected content history is full.',
    CONTENT_RECEIPT_STATE_CAPACITY_EXHAUSTED: 'Workspace history has no room to safely retain this content change.',
    CONTENT_RECEIPT_TOO_LARGE: 'This content change is too large to retain safely.',
    CONTENT_RECEIPT_SOURCE_UNAVAILABLE: 'The saved source for this content change is unavailable.',
    CONTENT_RECEIPT_UNAVAILABLE: 'Protected content history is unavailable.',
    CONTENT_RECEIPT_INVALID: 'Runvara could not validate the saved record for this content change.',
    CONTENT_RECEIPT_ACTOR_REQUIRED: 'Runvara could not verify the authorised owner for this saved content change.',
    CONTENT_RECEIPT_IDENTITY_CONFLICT: 'The saved content request no longer matches its protected record.',
    CONTENT_RECEIPT_GUARD_REQUIRED: 'Required protection for this content change could not be verified.',
    CONTENT_RECEIPT_ACK_INVALID: 'Runvara could not confirm the saved record for this content change.',
    CONTENT_RECEIPT_COMMIT_UNCONFIRMED: 'Shopify may have applied the change, but Runvara could not confirm its saved completion.'
  });
  function contentReceiptFailureMessage(write, code, dispatchBlocked = false) {
    if (write?.provider !== 'shopify' || write.input?.operation !== 'product_content' || typeof code !== 'string' || !Object.hasOwn(contentReceiptErrors, code)) return null;
    if (code === 'CONTENT_RECEIPT_COMMIT_UNCONFIRMED' && dispatchBlocked === true) return 'Runvara stopped this request before sending a change to Shopify, but could not confirm its saved record. Review the existing request before taking further action.';
    const beforeSend = dispatchBlocked === true ? 'Runvara stopped this request before sending a change to Shopify. ' : '';
    return beforeSend + contentReceiptErrors[code] + ' Review the existing request before taking further action.';
  }
  const customerZeroManagerLink = '<a class="secondary button-link" href="https://packsmart-ebay-manager.sleek-chub-7298.chatgpt.site/" target="_blank" rel="noopener noreferrer">Open existing eBay Manager</a>';
  function firstSyncSteps(channel) {
    const first = channel.firstSync;
    const steps = [
      ['Account connected', channel.configured ? 'completed' : 'pending'],
      ['Account identity checked', first?.identityVerifiedAt || channel.lastCheckedAt ? 'completed' : 'pending'],
      ...Object.entries(first?.areas || {}).map(([area,status]) => [`Reading ${label(area).toLowerCase()}`,status]),
      ['Checking imported data', first?.validation?.ok ? 'completed' : first?.validation?.ok === false ? 'failed' : 'pending'],
      ['Safe sync settings prepared', first ? 'completed' : 'pending'],
      ['Business data ready', first?.status === 'completed' ? 'completed' : 'pending']
    ];
    return `<ol class="setup-steps">${steps.map(([title,status])=>`<li data-step-status="${esc(status)}"><span class="setup-step-marker" aria-hidden="true">${status==='completed'?'✓':status==='failed'?'!':status==='running'?'…':'○'}</span><span>${esc(title)}</span><small>${esc(status==='completed'?'Done':status==='running'?'In progress':status==='failed'?'Needs attention':'Waiting')}</small></li>`).join('')}</ol>`;
  }
  function journey() {
    const root = $('#connection-journey'); if (!root) return;
    const progress = data.onboarding?.journey || { revision:0, platforms:[] };
    const completed = progress.platforms.filter(item => item.tested && item.imported && item.reviewed && !(item.blocksSetup ?? item.needsAttention)).length;
    const returning = Boolean(progress.completedAt || progress.platforms.some(item=>item.imported));
    const running = channels.some(c=>['queued','running'].includes(c.firstSync?.status));
    const preferences = progress.preferences || {};
    root.classList.toggle('returning-workspace', returning);
    root.innerHTML = `<details ${returning && !running ? '' : 'open'}><summary>${progress.completedAt ? 'Business setup complete · review setup' : running ? 'Runvara is setting up your business' : 'Set up your business'}</summary>
      <p class="eyebrow">YOUR BUSINESS, CONNECTED</p><h2>${progress.completedAt ? 'Your business is ready' : running ? 'Runvara is setting up your business' : 'A few simple steps. A clearer business.'}</h2>
      <p>Choose your channels, sign in and let Runvara read your business data. Your progress is saved. Add or skip channels whenever you like.</p>
      <progress aria-label="Selected channels ready" value="${completed}" max="${Math.max(1,progress.platforms.length)}"></progress><p role="status">${completed} of ${progress.platforms.length} selected channels ready</p>
      <section class="setup-section"><h3>1. Choose your channels</h3><form id="journey-platforms"><fieldset class="setup-channel-choices" ${!manager()?'disabled':''}><legend>Connect the channels you use</legend>${channels.filter(c=>['shopify','ebay','meta','tiktok_shop','google_youtube','pinterest'].includes(c.id)).map(channel=>`<label class="setup-choice"><input type="checkbox" name="platforms" value="${esc(channel.id)}" ${progress.platforms.some(item=>item.provider===channel.id)?'checked':''}><span><strong>${esc(channel.name)}</strong><small>${esc(channel.health?.status || (channel.configured?'Connected':channel.oauthReady?'Ready to connect':'Access being prepared'))}</small></span></label>`).join('')}</fieldset><button class="secondary" ${!manager()?'disabled':''}>Save channel choices</button></form></section>
      <section class="setup-section"><h3>2. Connect and check your data</h3>${progress.platforms.length ? progress.platforms.map(item=>{const channel=channels.find(c=>c.id===item.provider);if(!channel)return '';const pending=!channel.oauthReady&&!channel.configured;return `<article class="setup-provider"><div class="section-head stack-mobile"><h4>${esc(channel.name)}</h4><span class="tag ${channel.health?.status==='Healthy'?'good':'neutral'}">${esc(channel.health?.status || label(channel.status))}</span></div><p>${esc(channel.health?.message || (pending?'Access is being prepared. You can skip this channel for now.':'Sign in to begin.'))}</p>${channel.firstSync?firstSyncSteps(channel):''}${channel.firstSync?.validation?.counts?`<p class="setup-import-summary">${Object.entries(channel.firstSync.validation.counts).map(([key,value])=>`${esc(value)} ${esc(label(key).toLowerCase())}`).join(' · ')}</p>`:''}<div class="button-row">${button(channel.health?.action?.action || (channel.configured?'open':pending?'setup-request':'connect'),channel.health?.action?.label || (channel.configured?'Review connection':pending?'Request access':`Connect ${channel.name}`),channel,'primary')}${!item.reviewed&&channel.configured?`<button class="secondary" data-journey-review="${esc(channel.id)}" ${!manager()?'disabled':''}>Keep current permissions</button>`:''}<button class="connection-text-button" data-journey-skip="${esc(channel.id)}" ${!manager()?'disabled':''}>Skip for now</button></div></article>`;}).join(''):'<p class="muted">Select a channel above, or explore your dashboard and connect later.</p>'}</section>
      <section class="setup-section"><h3>3. Make it yours</h3><p>Recommended settings use automatic reads, keep customer records optional and require approval for external changes.</p><button class="primary" id="journey-recommended" ${!manager()?'disabled':''}>Use recommended settings</button><details class="setup-preferences"><summary>Optional business preferences</summary><form id="journey-preferences" class="record-form"><label>Main goal<select name="goal">${[['visibility','Understand my business'],['stock','Keep stock under control'],['growth','Grow sales']].map(([id,title])=>`<option value="${id}" ${preferences.goal===id?'selected':''}>${title}</option>`).join('')}</select></label><label>Read automation<select name="automation"><option value="recommended" ${preferences.automation!=='manual'?'selected':''}>Recommended automatic reads</option><option value="manual" ${preferences.automation==='manual'?'selected':''}>I will start reads myself</option></select></label><label>Low-stock alert threshold<input name="stockThreshold" type="number" min="0" max="100000" value="${esc(preferences.stockThreshold??20)}" required></label><label class="check-label"><input name="customerRecords" type="checkbox" ${preferences.customerRecords?'checked':''}>I may need customer records (separate access required)</label><label class="check-label"><input name="marketing" type="checkbox" ${preferences.marketing?'checked':''}>Show marketing recommendations</label><p>External changes always retain the existing owner permissions and approval checks.</p><button class="secondary" ${!manager()?'disabled':''}>Save preferences</button></form><form id="journey-business" class="record-form"><label>Business name<input name="businessName" value="${esc(data.workspace?.name || '')}" minlength="2" maxlength="120" required></label><button class="secondary" ${!manager()?'disabled':''}>Save business details</button></form></details></section>
      ${(data.connectionRecommendations||[]).length?`<section class="setup-section"><h3>Useful next steps</h3><ul class="setup-recommendations">${data.connectionRecommendations.map(item=>`<li><span>${esc(item.title)}</span><small>${item.enabled?'Active':'Suggested'}</small></li>`).join('')}</ul><button class="secondary" id="journey-controls">Review automations</button></section>`:''}
      <div class="button-row"><button class="primary" id="journey-finish" ${!progress.complete||!manager()?'disabled':''}>Finish setup</button><button class="secondary" id="journey-dashboard">${progress.completedAt?'Open your business dashboard':'Explore dashboard'}</button></div><p id="journey-feedback" role="status"></p></details>`;
  }
  function notifications() {
    const root=$('#connection-notifications');if(!root)return;
    root.innerHTML=(data.connectionNotifications||[]).map(item=>`<p class="connection-notice" data-priority="${esc(item.priority)}"><strong>${esc(item.priority==='critical'?'Action needed':item.priority==='important'?'Connection update':'Runvara update')}</strong> ${esc(item.message)}</p>`).join('');
  }
  async function operatorStatus() {
    const root=$('#connection-operator');if(!root||!operatorWorkspace())return;
    root.hidden=false;root.innerHTML='<button class="secondary" id="operator-provider-refresh">View provider readiness</button><div id="operator-provider-results" role="status"></div>';
    $('#operator-provider-refresh').onclick=async event=>{
      event.target.disabled=true;
      try { const payload=await api.request('/api/operator/providers');$('#operator-provider-results').innerHTML=`<h3>Operator provider status</h3><div class="setup-operator-grid">${payload.providers.map(p=>`<article class="setup-provider"><h4>${esc(p.displayName)}</h4><p>${esc(p.setupMessage)}</p><dl><dt>Customer sign-in</dt><dd>${p.oauthReady?'Enabled':'Pending'}</dd><dt>Return address ready</dt><dd>${p.callbackReady?'Yes':'No'}</dd><dt>Provider approval</dt><dd>${esc(p.providerApprovalStatus)}</dd><dt>Active connections</dt><dd>${esc(p.activeConnections)}</dd><dt>Waiting for access</dt><dd>${esc(p.waitingForAccess)}</dd><dt>Recent failure events</dt><dd>${esc(p.recentFailures.length)}</dd><dt>Temporary service error evidence</dt><dd>${esc(p.outageEvidence.length)}</dd></dl></article>`).join('')}</div>`; }
      catch(error){$('#operator-provider-results').textContent=error.message;}finally{event.target.disabled=false;}
    };
  }
  async function saveJourney(body) {
    const root = $('#connection-journey'); root.setAttribute('aria-busy','true'); root.querySelectorAll('button').forEach(item=>item.disabled=true);
    try { await api.request('/api/onboarding',{method:'POST',body:JSON.stringify({revision:data.onboarding?.journey?.revision||0,...body})});await api.reload({migrate:false});api.notify(body.finish?'Business setup complete.':'Setup progress saved.'); }
    catch(error){api.notify(error.message,'error');}
    finally {journey();root.removeAttribute('aria-busy');}
  }
  function cards() {
    const ui=window.RunvaraUI;
    $('#connection-grid').innerHTML = channels.map(channel=>{
      const repair=channel.health?.status==='Reconnect required' || channel.recovery?.action==='reconnect';
      const countText=Object.entries(channel.counts || {}).filter(([,value])=>typeof value==='number').map(([key,value])=>`${value} ${label(key)}`).join(' · ');
      const providerPending=!channel.oauthReady && !channel.configured;
      const action=repair?'reconnect':channel.configured?'open':providerPending?'open':'connect';
      const primaryText=repair?`Reconnect ${channel.name}`:channel.configured?'Manage connection':providerPending?(operatorWorkspace()?'Finish provider setup':'Request access'):`Connect ${channel.name}`;
      return `<article class="connection-card" data-channel-card="${channel.id}"><div class="connection-card-heading"><span class="connection-brand">${ui.logo(channel.id)}</span>${ui.badge(repair?'Access needed':providerPending?'Access being prepared':channel.health?.status || label(channel.status),providerPending?'neutral':statusClass(channel.status))}</div><h3><button type="button" class="connection-title" data-connection-action="open" data-provider="${channel.id}" aria-haspopup="dialog">${esc(channel.name)}</button></h3><p class="connection-summary">${esc(channel.identity || (channel.configured?'Account connected':'No account connected'))}</p><p class="connection-health ${channel.recovery?'warn':'muted'}">${esc(channel.health?.message || (providerPending?'Access is being prepared. Request access or continue with another channel.':ui.connectionMessage(channel)))}</p><dl class="connection-facts"><div><dt>Authentication</dt><dd>${esc(repair?'Renew access':channel.oauthReady?'Secure sign-in ready':'Access being prepared')}</dd></div><div><dt>Last successful sync</dt><dd>${esc(when(channel.lastSuccessfulSyncAt))}</dd></div><div><dt>Next automatic read</dt><dd>${esc(ui.schedule(channel,data))}</dd></div><div><dt>Permission policy</dt><dd>${esc(label(channel.settings.permissionMode))}</dd></div></dl><div class="connection-coverage"><span class="eyebrow">SELECTED DATA</span><div class="capabilities">${(channel.settings.areas || []).map(area=>`<span>${esc(label(area))}</span>`).join('') || '<span>No areas selected</span>'}</div><small>${esc(countText || 'No imported coverage reported')}</small></div><details class="evidence"><summary>Capabilities &amp; access</summary><p>Supported reads: ${esc(channel.areas.map(label).join(', '))}.</p><p>${esc(channel.coverageNote || 'Availability depends on provider access and your selected sync areas.')}</p><p>${esc(channel.writeAccessGranted?'Provider write access granted. Runvara’s permission policy and approvals still apply.':'Provider write access has not been confirmed.')}</p><p>Automatic reads follow your saved channel schedule and permissions.</p></details><div class="connection-card-footer"><div class="button-row">${button(action,primaryText,channel,'primary')}${channel.configured?button(repair?'open':'sync',repair?'Review access':'Sync now',channel):''}</div></div></article>`;
    }).join('');
  }
  function onboarding(channel) {
    if (!channel.oauthReady) {
      if (!operatorWorkspace()) return `<div class="connection-notice"><h3>${esc(channel.name)} access is being prepared</h3><p>Runvara is preparing access for this channel. Your shop and existing data are safe. You can request access, then continue with another channel.</p><p>When this connection is enabled, setup is simply: <strong>Connect → sign in with ${esc(channel.name)} → approve access → return to Runvara.</strong></p><div class="button-row">${channel.supportRequested ? '<span role="status">Access requested. Runvara will make this connection available when access is available.</span>' : button('setup-request', 'Request access', channel, 'primary')}</div></div>`;
      return `<div class="connection-notice"><h3>Runvara provider setup pending</h3><p>This is the operator workspace. Complete the provider-level application/approval once here; customer workspaces will never see developer credentials or server configuration.</p><p>Once provider approval is active, customers will only use: <strong>Connect → provider sign-in → approve → return to Runvara.</strong></p><div class="button-row">${channel.refreshSupported ? button('refresh', 'Renew saved connection', channel, 'primary') : ''}${channel.supportRequested ? '<span role="status">Provider setup is already being tracked.</span>' : button('setup-request', 'Track provider setup', channel)}${channel.id === 'shopify' ? button('advanced', 'Existing custom app options', channel) : ''}${channel.id === 'ebay' ? customerZeroManagerLink : ''}</div></div>`;
    }
    return `<form id="connection-onboarding" class="connection-manage-form"><h3>${channel.configured ? 'Reconnect securely' : 'Connect your account'}</h3><p>You’ll sign in with ${esc(channel.name)}, review access, and return to Runvara. Your channel password is never shared with Runvara.</p>${channel.id === 'meta' ? '<p>Use the Facebook account that manages your business’s Page and linked Instagram professional account. No Meta Work account is needed.</p>' : ''}
      ${channel.id === 'shopify' ? `<label>Store address<input name="storeDomain" placeholder="your-store.myshopify.com" value="${esc(channel.identity?.endsWith('.myshopify.com') ? channel.identity : '')}" required autocomplete="url" autocapitalize="none" spellcheck="false"></label><label class="check-label"><input name="includeCustomers" type="checkbox"> Include customer records (requires Shopify approval)</label>${owner() ? '<label class="check-label"><input name="writeAccess" type="checkbox"> Request Shopify product write access. Runvara will still start in read-only mode.</label>' : ''}` : ''}
      ${channel.id === 'meta' && owner() ? `<label class="check-label"><input name="catalogAccess" type="checkbox"> Request catalogue access. Meta bundles reading and editing in this permission; Runvara remains read-only until you separately enable writes.</label><label class="check-label"><input name="writeAccess" type="checkbox"> Request Facebook and Instagram publishing access. Every publication or update needs approval in Runvara.</label><label class="check-label"><input name="businessInstagramAccess" type="checkbox"> My Instagram role is assigned through Meta Business Manager: request the additional advertising permissions Meta requires for this publishing setup. Runvara will not manage ads.</label>` : ''}
      ${channel.configured && owner() ? '<label class="check-label"><input name="allowAccountChange" type="checkbox"> I explicitly authorise connecting a different account if I select one.</label>' : ''}
      <button class="primary" type="submit" ${!manager() ? 'disabled' : ''}>Continue to ${esc(channel.name)}</button></form>`;
  }
  function progress(channel) {
    const running = channel.progress;
    return running ? `<div class="connection-progress" role="status" aria-live="polite"><progress aria-label="Sync in progress"></progress><span>${esc(running.stage)} · ${esc(running.areas.map(label).join(', '))}<small>Started ${esc(when(running.startedAt))}. You can leave this panel while the sync continues.</small></span></div>` : '';
  }
  function renderPanel() {
    const channel = channels.find(item => item.id === selected); if (!channel) return;
    observeContentSource();
    observeRecoverySource();
    const preservedRecovery = selected==='shopify' && $('#connection-dialog').open && recoveryAuthority() && recoveryAvailable() ? $('#connection-order-recovery') : null;
    const recoveryFocus = preservedRecovery?.contains(document.activeElement) ? document.activeElement : null;
    const preservedContent = selected === 'shopify' && $('#connection-dialog').open && content.editor && currentContentIdentity() ? $('#connection-content-editor') : null;
    const contentFocus = preservedContent?.contains(document.activeElement) ? document.activeElement : null;
    const writes = (data.connectionWrites || []).filter(item => item.provider === channel.id);
    $('#connection-detail').innerHTML = `<div class="section-head stack-mobile"><div><p class="eyebrow">CONNECTION CENTRE</p><h2 id="connection-dialog-title">${esc(channel.name)}</h2><p class="muted">${esc(channel.identity || 'No account connected')}</p></div><span class="tag ${statusClass(channel.status)}">${esc(label(channel.status))}</span></div>
      <p id="connection-feedback" class="connection-feedback" role="status" aria-live="polite"></p><div id="connection-progress">${progress(channel)}</div>${channel.firstSync?firstSyncSteps(channel):''}
      ${!manager() ? '<p class="connection-notice">You have view access. Ask a workspace owner or admin to manage this connection.</p>' : ''}
      ${channel.health && channel.health.status !== 'Healthy' ? `<div class="connection-notice"><p>${esc(channel.health.message)}</p>${channel.health.action?button(channel.health.action.action,channel.health.action.label,channel,'primary'):''}</div>` : channel.recovery ? `<div class="connection-notice"><p>${esc(channel.recovery.message)}</p>${channel.recovery.action === 'manager' ? (data.workspace?.id === 'packsmart-solutions' ? customerZeroManagerLink : '<p>Review older listings in your eBay Seller Hub.</p>') : button(channel.recovery.action, channel.recovery.label, channel, 'primary')}</div>` : ''}
      ${channel.coverageNote ? `<p class="muted">${esc(channel.coverageNote)}</p>` : ''}
      ${channel.configured ? `<div class="button-row connection-toolbar">${button('test', 'Test connection', channel)}${channel.refreshSupported ? button('refresh', 'Refresh access', channel) : ''}${button('reconnect', 'Reconnect', channel)}${channel.id === 'ebay' && data.workspace?.id === 'packsmart-solutions' ? customerZeroManagerLink : ''}</div>` : ''}
      ${channel.configured && operatorWorkspace() ? diagnostics(channel) : ''}
      <div id="connection-setup" class="${channel.configured ? 'hidden' : ''}">${onboarding(channel)}</div>
      ${channel.id === 'meta' ? metaAssets(channel) : ''}
      ${channel.configured ? `<section class="connection-section"><h3>Imported data</h3><dl class="connection-counts">${Object.entries(channel.counts).map(([key, count]) => `<div><dt>${esc(label(key))}</dt><dd>${esc(count)}</dd></div>`).join('')}</dl><p class="muted tiny">Last successful sync: ${esc(when(channel.lastSuccessfulSyncAt))} · Last connection test: ${esc(when(channel.lastCheckedAt))}</p></section>
      <section class="connection-section"><h3>Sync controls</h3><form id="connection-sync-settings" class="connection-manage-form"><fieldset ${!manager() ? 'disabled' : ''}><legend>Choose what to sync</legend><div class="connection-area-grid">${channel.areas.map(area => `<label class="check-label"><input type="checkbox" name="areas" value="${area}" ${channel.settings.areas.includes(area) ? 'checked' : ''}>${esc(label(area))}</label>`).join('')}</div></fieldset>
      ${channel.id === 'shopify' ? '<p class="muted tiny">Product, variant, price and inventory selections update only those fields. Customers need separate read access in Shopify.</p>' : ''}
      <label class="check-label"><input type="checkbox" name="autoSync" ${channel.settings.autoSync ? 'checked' : ''} ${!manager() ? 'disabled' : ''}> Enable automatic sync</label><label>Sync frequency<select name="frequencyMinutes" ${!manager() ? 'disabled' : ''}>${[[15,'Every 15 minutes'],[30,'Every 30 minutes'],[60,'Hourly'],[180,'Every 3 hours'],[360,'Every 6 hours'],[1440,'Daily']].map(([value,text]) => `<option value="${value}" ${value === channel.settings.frequencyMinutes ? 'selected' : ''}>${text}</option>`).join('')}</select></label>
      <p class="muted tiny">${channel.settings.managedReadSchedule ? 'Automatic reads follow this channel’s saved schedule, independently of broader automations.' : `Automatic sync follows your workspace’s Autopilot limits. ${data.autopilot?.enabled ? 'Autopilot is on.' : 'Autopilot is currently paused.'}`} <button class="connection-text-button" type="button" data-connection-action="autopilot" data-provider="${channel.id}">Manage Autopilot</button></p>
      <div class="button-row"><button class="secondary" type="submit" ${!manager() ? 'disabled' : ''}>Save sync settings</button>${button('sync-selected', 'Sync selected now', channel, 'primary')}</div></form></section>
      <section class="connection-section"><h3>Write permissions</h3><p>Reading data never changes your channel. Only the workspace owner can authorise writes.</p><form id="connection-permissions" class="connection-manage-form"><label>Permission level<select name="permissionMode" ${!owner() ? 'disabled' : ''}>${(channel.writes.length ? ['read_only','approval_gated','automatic'] : ['read_only']).map(mode => `<option value="${mode}" ${channel.settings.permissionMode === mode ? 'selected' : ''}>${esc(label(mode))}</option>`).join('')}</select></label><label class="check-label"><input type="checkbox" name="confirmPermission" ${!owner() ? 'disabled' : ''}> I authorise the selected write policy. Financial, destructive and customer-facing changes still need approval.</label><button class="secondary" type="submit" ${!owner() ? 'disabled' : ''}>Save permissions</button></form>
      <p class="muted">${channel.id === 'shopify' ? `Supported writes: internal product notes and approval-gated product content. ${channel.writeAccessGranted ? 'Shopify product write access is granted.' : 'Shopify product write access is not granted. Request it when reconnecting, then test the connection.'} Automatic mode can bypass approval only for private Runvara product notes.` : channel.id === 'meta' ? 'Catalogue products, stock, product visibility, Facebook posts and Instagram JPEG posts support approval-gated changes. Automatic mode never bypasses approval for Meta. Reconnect to request any missing catalogue or publishing permissions.' : 'This channel currently has no supported write action in Runvara. A write policy never grants channel permissions or enables an unavailable action.'}</p>
      ${channel.id === 'shopify' && owner() ? `<form id="connection-tag-preview" class="connection-manage-form"><h3>Safe write acceptance preview</h3><p>Read the current product tags and prepare one reversible test for owner review. This does not change Shopify or your write permissions.</p><label>Product<select name="productId" required>${(data.products || []).filter(item => item.provider === 'shopify').map(item => `<option value="${esc(item.id)}">${esc(item.title)}</option>`).join('')}</select></label><button class="secondary">Prepare exact tag test</button><div id="tag-preview-result" class="connection-exact-text" role="status"></div></form>` : ''}
      ${channel.id === 'shopify' && channel.settings.permissionMode !== 'read_only' && channel.writeAccessGranted && owner() ? writeForm() : channel.id === 'meta' && channel.settings.permissionMode !== 'read_only' && channel.writeAccessGranted && owner() ? metaWriteForm(channel) : ''}</section>` : ''}
      ${channel.id === 'shopify' ? recoveryProvenance(channel)+recoveryPanel() : ''}
      ${channel.id === 'shopify' && owner() ? contentForm() : ''}
      ${writes.length ? `<section class="connection-section"><h3>Proposed changes</h3>${writes.slice(0,15).map(write => `<article class="connection-write"><b>${esc(typeof write.input?.operation === 'string' ? write.input.operation.replaceAll('_',' ') : 'Unsupported change')}</b><p>${esc(typeof write.status === 'string' ? write.status.replaceAll('_',' ') : 'Status unavailable')}</p><details><summary>Review exact change</summary><dl>${objectiveContentWriteDetails(write)}${!reviewableWriteInput(write) ? '<dt>Change review unavailable</dt><dd>The saved change is unsupported or incomplete. Exact fields must be available before applying.</dd>' : ''}${write.provider === 'shopify' && write.input?.operation === 'product_content' ? `<dt>Saved Shopify account</dt><dd class="connection-exact-text">${esc(write.account || 'Unavailable saved target')}</dd><dt>Saved connection reference</dt><dd class="connection-exact-text">${esc(write.connectionId || 'Unavailable saved reference')}</dd>` : ''}${Object.entries(write.input || {}).map(([key,value]) => `<dt>${esc(key.replace(/([A-Z])/g,' $1'))}</dt><dd class="connection-exact-text">${esc(value)}</dd>`).join('')}</dl></details><div class="button-row">${write.approvalId ? button('approvals', 'Open Approval Centre', channel) : ''}${owner() && contentId(write.id) && reviewableWriteInput(write) && ['ready','processing'].includes(write.status) ? `<button class="secondary" type="button" data-connection-action="execute" data-provider="${channel.id}" data-write="${esc(write.id)}">${write.status === 'processing' ? 'Check publishing progress' : write.requiresApproval ? 'Apply approved change' : 'Apply change'}</button>` : ''}</div>${write.status === 'processing' ? `<p>${write.observationErrorCode ? 'Instagram status could not be verified. The saved container is retained; check its status again after a minute.' : 'Instagram is preparing your image. Check again after a minute; the same approved request will be continued.'}</p>` : ''}${write.status === 'uncertain' ? '<p class="warn">Check the channel before making another request. Runvara will not repeat an uncertain write.</p>' : ''}${write.status === 'failed' ? `<p class="warn">${esc(contentReceiptFailureMessage(write, write.errorCode, write.dispatchBlocked) || (write.dispatchBlocked ? 'Runvara stopped this request before a new channel submission. Review the current permissions and prepare a new exact change.' : 'The channel declined this request. Test the connection, check the selected asset and fields, then prepare a new change.'))}</p>` : ''}${write.result?.externalId ? `<p>Confirmed channel reference: ${esc(write.result.externalId)}</p>` : ''}</article>`).join('')}</section>` : ''}
      <section class="connection-section"><h3>Sync history</h3><p class="muted tiny">Latest 30 syncs. Completed sync summaries remain in the workspace audit log.</p><div class="connection-history">${channel.history.length ? channel.history.map(run => `<article><div><b>${esc({completed:'Completed',partial:'Partially completed',failed:'Needs attention',running:'In progress'}[run.status])}</b><small>${esc(when(run.startedAt))} · ${run.automatic ? 'Automatic' : 'Requested'}</small></div><p>${esc(run.areas.map(label).join(', '))}</p>${run.status === 'failed' || run.status === 'partial' ? '<p class="warn">Some data could not be refreshed. Your previous data is retained. Use Sync now to retry.</p>' : ''}</article>`).join('') : '<p class="muted">No sync history recorded yet. Your earlier imported data is retained.</p>'}</div></section>
      ${channel.configured ? `<section class="connection-section"><h3>Disconnect</h3><p>Stop Runvara from accessing this channel. Imported data stays in this workspace. ${channel.id === 'ebay' ? 'Your separate eBay Manager stays intact.' : 'This does not delete or close your channel account.'}</p>${button('disconnect', `Disconnect ${channel.name}`, channel, 'secondary danger')}<form id="connection-disconnect" class="connection-confirm hidden"><p>Are you sure? Syncing will stop and Runvara’s write permission will be removed.</p><label class="check-label"><input name="confirm" type="checkbox" required> I confirm I want to disconnect this channel from Runvara.</label><div class="button-row"><button class="primary danger" type="submit">Confirm disconnect</button>${button('cancel-disconnect','Keep connected',channel)}</div></form></section>` : ''}`;
    if (preservedContent) $('#connection-content-editor')?.replaceWith(preservedContent);
    if (preservedRecovery) $('#connection-order-recovery')?.replaceWith(preservedRecovery);
    renderRecoveryState(); recoveryFocus?.focus({preventScroll:true});
    renderContentState(); contentFocus?.focus({preventScroll:true});
    metaWriteFields();
  }
  function diagnostics(channel) {
    const events = { connection_authorised: 'Account connected', connection_authorisation_started: 'Sign-in started', connection_authorisation_failed: 'Sign-in did not complete', connection_disconnected: 'Disconnected', connection_permissions_changed: 'Write permissions changed', connection_permissions_reset: 'Write permissions reset', connection_sync_settings_changed: 'Sync settings saved', connection_assets_selected: 'Selected accounts updated', connection_sync_finished: 'Sync finished' };
    return `<section class="connection-section"><h3>Connection health & access</h3><dl class="connection-counts"><div><dt>Authentication</dt><dd>${esc(channel.status === 'action_required' ? 'Needs attention' : label(channel.status))}</dd></div><div><dt>Last failed sync</dt><dd>${esc(when(channel.lastFailedSyncAt))}</dd></div><div><dt>Access expires</dt><dd>${esc(channel.accessExpiresAt ? when(channel.accessExpiresAt) : 'Not reported')}</dd></div><div><dt>Automatic sync</dt><dd>${channel.settings.autoSync && data.autopilot?.enabled ? 'On' : 'Paused'}</dd></div></dl><p>Reads: ${esc(channel.areas.map(label).join(', ') || 'Not available')}.</p><p>Writes: ${esc(channel.writes.length ? label(channel.settings.permissionMode) : 'Not implemented for this channel')}.</p>${Object.keys(channel.readDiagnostics || {}).length ? `<details><summary>Support diagnostics</summary>${Object.entries(channel.readDiagnostics).map(([surface,entry])=>`<p>${esc(surface)} · ${esc(entry.code)} · HTTP ${esc(entry.httpStatus)} · Provider references ${esc((entry.errorIds||[]).join(', '))} · ${esc(when(entry.at))}</p>`).join('')}</details>` : ''}<details><summary>Permissions granted by the channel</summary><p class="connection-exact-text">${esc((channel.grantedScopes || []).join(', ') || 'Not reported by the channel. Test the connection to check access.')}</p></details><details><summary>Connection activity</summary>${(channel.audit || []).length ? channel.audit.map(event => `<p>${esc(events[event.type] || 'Connection updated')} · ${esc(when(event.createdAt))}</p>`).join('') : '<p>No connection activity recorded yet.</p>'}</details></section>`;
  }
  function writeForm() {
    return `<form id="connection-write-form" class="connection-manage-form"><h3>Prepare a Shopify change</h3><label>Product<select name="productId" required>${(data.products || []).filter(item => item.provider === 'shopify').map(item => `<option value="${esc(item.id)}">${esc(item.title)}</option>`).join('')}</select></label><label>Action<select name="operation"><option value="internal_note">Private Runvara product note</option><option value="product_tags_add">Add product tags (approval required)</option><option value="product_tags_remove">Remove product tags (approval required)</option></select></label><label>Tags, separated by commas<input name="tags" maxlength="12799"></label><p>Tags can affect collections and shop automations. Review existing tags before adding or removing them. Reversing a change requires a new approval.</p><label>Internal note<textarea name="note" maxlength="500"></textarea></label><p class="muted tiny">Only fields for your selected action are used. This prepares an exact, reviewable change before applying it.</p><button class="secondary" type="submit">Prepare change</button></form>`;
  }
  function metaAssets(channel) {
    const meta = channel.meta || {}, assets = meta.assets || { pages:[], catalogs:[] };
    return `<section class="connection-section"><h3>Meta availability</h3><p>${esc(meta.orderRestriction?.message || '')}</p><a href="https://developers.facebook.com/docs/graph-api/changelog/version26.0/" target="_blank" rel="noopener noreferrer">Read Meta’s order API retirement notice</a>${channel.configured ? `<form id="connection-meta-assets" class="connection-manage-form"><h3>Choose your Pages and catalogues</h3><p>Select the assets this workspace should use. Test the connection to refresh accounts. If an asset is still missing, check that the same Facebook account manages the Page and its linked Instagram professional account. Reconnecting helps only when access has not been granted.</p>${meta.discovery ? `<details><summary>Account discovery details</summary><p>Meta returned ${esc(meta.discovery.returnedPageCount)} Pages from your account. Last checked ${esc(when(meta.discovery.checkedAt))}.</p>${(meta.discovery.pageChecks||[]).map(check=>`<p>Page ${esc(check.pageId)}: ${esc({granted_page_recovered:'Authorised Page recovered',linked:'Instagram account found',no_link_returned:'Meta returned no linked Instagram professional account',lookup_failed:'Meta could not confirm the Instagram link'}[check.result])}${check.code?` · ${esc(check.code)} · ${esc(check.providerCode||'')}`:''}</p>`).join('')}</details>`:''}<fieldset ${!manager() ? 'disabled' : ''}><legend>Facebook Pages and linked Instagram accounts</legend>${assets.pages.map(page => `<label class="check-label"><input type="checkbox" name="metaPageIds" value="${esc(page.id)}" ${(channel.settings.metaPageIds || []).includes(page.id) ? 'checked' : ''}>${esc(page.name)}${page.instagram ? ` · Instagram @${esc(page.instagram.username)}` : ''}</label>`).join('') || '<p>No Pages authorised.</p>'}</fieldset><fieldset ${!manager() ? 'disabled' : ''}><legend>Catalogues</legend>${assets.catalogs.map(catalog => `<label class="check-label"><input type="checkbox" name="metaCatalogIds" value="${esc(catalog.id)}" ${(channel.settings.metaCatalogIds || []).includes(catalog.id) ? 'checked' : ''}>${esc(catalog.name)}</label>`).join('') || '<p>No catalogues authorised. Request catalogue access when reconnecting.</p>'}</fieldset><button type="submit" class="secondary" ${!manager() ? 'disabled' : ''}>Save selected assets</button></form><p class="muted tiny">Product variants are imported as catalogue items with their group references. Sync currently supports up to 2,000 items. Instagram publishing supports public JPEG images; video and carousel publishing are not implemented in this release.</p>` : ''}</section>`;
  }
  function metaWriteForm(channel) {
    const scopes = channel.meta.grantedScopes || [], operations = [];
    if (['catalog_management','business_management'].every(scope=>scopes.includes(scope))) operations.push(['catalog_product_create','Create a draft product'],['catalog_product_update','Update product name and description'],['catalog_inventory','Update stock'],['catalog_visibility','Publish or hide a product']);
    if (['pages_manage_posts','pages_read_engagement'].every(scope=>scopes.includes(scope))) operations.push(['facebook_publish','Publish a Facebook post'],['facebook_update','Update a Runvara Facebook post']);
    if (['instagram_basic','instagram_content_publish','pages_read_engagement'].every(scope=>scopes.includes(scope))) operations.push(['instagram_publish','Publish an Instagram JPEG image']);
    if (!operations.length) return '<p>Reconnect with the permissions needed for your intended action.</p>';
    return `<form id="connection-meta-write-form" class="connection-manage-form"><h3>Prepare a Meta change</h3><p>Nothing is published until the owner approves and applies this exact change.</p><label>Action<select name="operation">${operations.map(([value,title])=>`<option value="${value}">${title}</option>`).join('')}</select></label><div id="connection-meta-write-fields"></div><button type="submit" class="secondary">Prepare change for approval</button></form>`;
  }
  function metaWriteFields() {
    const form = $('#connection-meta-write-form'); if (!form) return;
    const channel = channels.find(item=>item.id === selected), operation = form.elements.operation.value;
    const select = (name,title,items) => `<label>${title}<select name="${name}" required><option value="">Choose…</option>${items.map(item=>`<option value="${esc(item.id)}">${esc(item.name || item.id)}</option>`).join('')}</select></label>`;
    const field = (name,title,extra='') => `<label>${title}<input name="${name}" required ${extra}></label>`;
    const products = channel.meta.data.products || [], assets = channel.meta.assets;
    let html = '';
    if (operation.startsWith('catalog_')) {
      html += select('catalogId','Catalogue',assets.catalogs.filter(item=>channel.settings.metaCatalogIds?.includes(item.id)));
      if (operation !== 'catalog_product_create') html += select('productId','Synced product',products.filter(item=>channel.settings.metaCatalogIds?.includes(item.catalogId)));
      if (operation === 'catalog_inventory') html += field('quantity','Stock quantity','type="number" min="0" max="100000000" step="1"') + '<label>Availability<select name="availability"><option>in stock</option><option>out of stock</option><option>preorder</option><option>available for order</option><option>discontinued</option></select></label>';
      else if (operation === 'catalog_visibility') html += '<label>Visibility<select name="visibility"><option value="staging">Draft / hidden</option><option value="published">Published</option></select></label>';
      else {
        html += field('name','Product name','maxlength="200"') + '<label>Description<textarea name="description" required maxlength="5000"></textarea></label>';
        if (operation === 'catalog_product_create') html += field('retailerId','SKU','maxlength="100"') + field('brand','Brand','maxlength="100"') + field('category','Product category','maxlength="750"') + field('url','Public HTTPS product address','type="url"') + field('imageUrl','Public HTTPS image address','type="url"') + field('priceMinor','Price in minor units (for example, 599 means 5.99)','type="number" min="1" max="100000000" step="1"') + field('currency','Currency (for example, GBP)','pattern="[A-Z]{3}" maxlength="3"') + '<p>The product will be created as new, out of stock and hidden. Publishing and stock changes need separate approval.</p>';
      }
    } else {
      html += select('pageId','Facebook Page',assets.pages.filter(item=>channel.settings.metaPageIds?.includes(item.id) && (operation !== 'instagram_publish' || item.instagram)));
      if (operation === 'facebook_update') html += select('postId','Post published by Runvara',(data.connectionWrites || []).filter(item=>item.provider === 'meta' && item.status === 'completed' && item.input?.operation === 'facebook_publish' && reviewableWriteInput(item) && typeof item.result?.externalId === 'string').map(item=>({id:item.result.externalId,name:item.input.message})));
      html += `<label>${operation === 'instagram_publish' ? 'Caption' : 'Post text'}<textarea name="message" required maxlength="${operation === 'instagram_publish' ? 2200 : 5000}"></textarea></label>`;
      if (operation === 'instagram_publish') html += field('imageUrl','Public HTTPS JPEG image address','type="url"') + '<p>Use a linked Instagram professional account and a publicly accessible JPEG. Meta may require Page publishing authorisation. Instagram allows up to 100 API-published posts per rolling 24 hours.</p>';
      if (operation === 'facebook_publish') html += '<label>Optional public HTTPS link<input name="url" type="url"></label>';
    }
    $('#connection-meta-write-fields').innerHTML = html;
  }
  function currentRefresh(ticket) {
    const context = contentContext(), original = ticket.context;
    return refreshTicket === ticket && ticket.generation === sessionGeneration && (!original || (context?.session === original.session && context?.userId === original.userId &&
      context?.workspaceId === original.workspaceId && context?.csrf === original.csrf && context?.generation === original.generation && context?.bootstrap === original.bootstrap && context?.view === original.view));
  }
  async function refresh({ panel = true } = {}) {
    if (!refreshPending) {
      const ticket = { generation:sessionGeneration,context:contentContext(),controller:new AbortController() };
      refreshTicket = ticket; refreshController = ticket.controller;
      refreshPending = api.request('/api/connection-centre', { signal:ticket.controller.signal,isCurrent:()=>currentRefresh(ticket) });
    }
    const ticket = refreshTicket;
    try {
      const payload = await refreshPending;
      if (!ticket || !currentRefresh(ticket)) return;
      channels = payload.channels; data.connectionWrites = payload.writes;
      data.connectionCentre = channels;
      if(payload.journey)data.onboarding={...data.onboarding,journey:payload.journey};
      data.connectionNotifications=payload.notifications||[];data.connectionRecommendations=payload.recommendations||[];
      if(!$('#connection-journey')?.contains(document.activeElement))journey();notifications();
      data.autopilot = { ...data.autopilot, enabled: payload.autopilotEnabled }; cards();
      observeContentSource();
      observeRecoverySource();
      if (selected && panel) renderPanel();
      else if (selected) $('#connection-progress').innerHTML = progress(channels.find(item => item.id === selected));
    } finally {
      if (refreshTicket === ticket) { refreshPending = null; refreshController = null; refreshTicket = null; }
    }
  }
  function close() { interruptContent('Connection editor closed'); interruptRecovery('Connection review closed'); $('#connection-dialog').close(); selected = null; clearInterval(pollTimer); returnFocus?.focus(); }
  function open(provider, setup = false) {
    if (selected && selected !== provider) { interruptContent('Connection changed'); interruptRecovery('Connection changed'); }
    selected = provider; returnFocus = document.activeElement; renderPanel();
    const dialog = $('#connection-dialog'); if (!dialog.open) dialog.showModal();
    if (setup) $('#connection-setup').classList.remove('hidden');
    $('#connection-close').focus(); clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (selected && !document.hidden && !refreshPending && !busy.size) refresh({ panel: false }).catch(() => {}); }, 15000);
  }
  async function perform(provider, action, body = {}) {
    if (busy.has(provider) || (provider === 'shopify' && (content.ticket || orderRecovery.ticket?.kind==='action'))) return;
    if (provider === 'shopify') { interruptContent('Connection activity changed'); interruptRecovery('Connection activity changed'); }
    if (!selected) open(provider);
    busy.add(provider); cards();
    const dialog = $('#connection-dialog'); dialog.setAttribute('aria-busy', 'true');
    $('#connection-detail').querySelectorAll('button').forEach(button => { button.disabled = true; });
    if (action === 'sync') $('#connection-progress').innerHTML = '<div class="connection-progress" role="status"><progress aria-label="Sync in progress"></progress><span>Starting sync…</span></div>';
    let message, failed = false;
    try {
      const result = await api.request(`/api/connections/${provider}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      if (action === 'sync') await api.reload({ migrate: false });
      message = result.message || (action === 'sync' ? result.status?.lastError ? 'Sync completed with some data needing attention.' : 'Selected data synced successfully.' : ({settings:'Settings saved.',disconnect:'Disconnected. Your imported data is retained.',test:'Connection tested successfully.',refresh:'Access refreshed and connection tested.',writes:'Change prepared. Review it before applying.'}[action] || 'Saved.'));
    } catch (error) { message = error.code === 'AUTH_REQUIRED' || error.status === 401 ? 'Your Runvara session has expired. Sign in again to continue; your channel connection has not been removed.' : error.message; failed = true; }
    finally {
      busy.delete(provider); dialog.removeAttribute('aria-busy');
      try { await refresh(); } catch {
        // Restore controls even when the status endpoint is also unavailable.
        // Never leave a local Starting sync indicator claiming a job is running.
        if (selected === provider) renderPanel();
        cards();
      }
      if (selected === provider) { const feedback = $('#connection-feedback'); feedback.textContent = message; feedback.classList.toggle('bad', failed); }
      api.notify(message, failed ? 'error' : undefined);
    }
  }
  async function handleAction(event) {
    const target = event.target.closest('[data-connection-action]');
    if (!target) { const card = event.target.closest('[data-channel-card]'); if (card) open(card.dataset.channelCard); return; }
    const provider = target.dataset.provider, action = target.dataset.connectionAction;
    const channel = channels.find(item => item.id === provider); if (!channel) return;
    if (action === 'open' || action === 'connect') return open(provider, action === 'connect');
    if (action === 'reconnect') { if (selected !== provider || !$('#connection-dialog').open) return open(provider,true); $('#connection-setup').classList.remove('hidden'); $('#connection-setup').scrollIntoView({block:'nearest'}); return; }
    if (action === 'advanced') { close(); $('#advanced-channel-connections').open = true; $('#shopify-connection-card').scrollIntoView({block:'start'}); return; }
    if (action === 'autopilot' || action === 'approvals') { close(); api.setView(action === 'autopilot' ? 'automations' : 'approvals'); return; }
    if (action === 'disconnect' || action === 'cancel-disconnect') { $('#connection-disconnect').classList.toggle('hidden', action !== 'disconnect'); if(action === 'disconnect') $('#connection-disconnect input').focus(); return; }
    if (action === 'sync-selected') { const areas = [...new FormData($('#connection-sync-settings')).getAll('areas')]; return perform(provider, 'sync', { areas }); }
    if (action === 'execute') {
      const write = (data.connectionWrites || []).find(item => item.id === target.dataset.write && item.provider === provider);
      if (!owner() || !contentId(write?.id) || !reviewableWriteInput(write) || !['ready','processing'].includes(write.status)) return;
      target.disabled = true;
      try {
        const result = await api.request(`/api/connection-writes/${target.dataset.write}/execute`, {method:'POST',body:'{}'});
        await api.reload({migrate:false}); await refresh();
        const processing = result.write?.status === 'processing';
        const receiptMessage = !result.executedExternally && !processing ? contentReceiptFailureMessage(write, result.write?.errorCode, result.write?.dispatchBlocked) : null;
        if (receiptMessage) $('#connection-feedback').textContent = receiptMessage;
        api.notify(result.executedExternally ? `${channel.name} confirmed the change.` : processing ? result.write?.observationErrorCode ? 'Instagram status could not be verified. Its saved container is retained; check again after a minute.' : 'Instagram is preparing the image. Check publishing progress after a minute.' : receiptMessage || `Check the result in ${channel.name}. This request will not be repeated.`, result.executedExternally || processing ? undefined : 'error');
      }
      catch(error) { const message = contentReceiptFailureMessage(write, error.code) || error.message; target.disabled=false; $('#connection-feedback').textContent=message; api.notify(message,'error'); }
      return;
    }
    return perform(provider, action);
  }
  async function submit(event) {
    const form = event.target; if (!form.id.startsWith('connection-')) return;
    event.preventDefault(); const channel = channels.find(item=>item.id === selected); if (!channel) return;
    const values = new FormData(form);
    if (form.id === 'connection-tag-preview') {
      const button=form.querySelector('button');button.disabled=true;
      try { const preview=await api.request('/api/connections/shopify/write-preview',{method:'POST',body:JSON.stringify({productId:values.get('productId')})});$('#tag-preview-result').innerHTML=`<h3>Exact change for owner approval</h3><p><strong>${esc(preview.resource.title)}</strong><br>${esc(preview.resource.store)}<br>${esc(preview.resource.id)}</p><dl><dt>Checked</dt><dd>${esc(when(preview.checkedAt))}</dd><dt>Current tags</dt><dd>${esc(preview.before.join(', ') || 'No tags')}</dd><dt>Add only</dt><dd>${esc(preview.request.tags.join(', '))}</dd><dt>Rollback</dt><dd>Remove only ${esc(preview.rollback.tags.join(', '))}; preserve every other tag. A separate approval is required.</dd><dt>Write access</dt><dd>${preview.writeScopeGranted?'Granted':'Not granted'} · ${esc(label(preview.permissionMode))}</dd></dl><p><strong>Approval request</strong><br>${esc(preview.approval)}</p><p class="warn">${esc(preview.notice)}</p>`; }
      catch(error){$('#tag-preview-result').textContent=error.message;}finally{button.disabled=false;}return;
    }
    if (form.id === 'connection-meta-assets') return perform(channel.id,'settings',{revision:channel.settings.revision,metaPageIds:values.getAll('metaPageIds'),metaCatalogIds:values.getAll('metaCatalogIds')});
    if (form.id === 'connection-meta-write-form') { const body=Object.fromEntries(values); for(const key of ['quantity','priceMinor']) if(key in body) body[key]=Number(body[key]); return perform(channel.id,'writes',{...body,requestId:crypto.randomUUID()}); }
    if (form.id === 'connection-sync-settings') return perform(channel.id, 'settings', { revision:channel.settings.revision, areas:values.getAll('areas'), autoSync:values.has('autoSync'), frequencyMinutes:Number(values.get('frequencyMinutes')) });
    if (form.id === 'connection-permissions') return perform(channel.id, 'settings', { revision:channel.settings.revision, permissionMode:values.get('permissionMode'), confirmPermission:values.has('confirmPermission') ? `${channel.id}:${values.get('permissionMode')}` : '' });
    if (form.id === 'connection-disconnect') { if(values.has('confirm')) return perform(channel.id, 'disconnect', {confirm:channel.id,revision:channel.settings.revision}); return; }
    if (form.id === 'connection-content-form') return prepareContent();
    if (form.id === 'connection-order-recovery-form') return submitRecovery();
    if (form.id === 'connection-write-form') { if (values.get('operation') === 'product_content') return; return perform(channel.id,'writes',{...Object.fromEntries(values),requestId:crypto.randomUUID()}); }
    if (form.id === 'connection-onboarding') {
      const button = form.querySelector('button[type="submit"]'); button.disabled=true; button.textContent='Opening secure sign-in…';
      try {
        const result=await api.request(`/api/integrations/${channel.id}/oauth/start`,{method:'POST',body:JSON.stringify({catalogAccess:values.has('catalogAccess'),confirmCatalogAccess:values.has('catalogAccess')?'meta':'',businessInstagramAccess:values.has('businessInstagramAccess'),confirmBusinessInstagramAccess:values.has('businessInstagramAccess')?'meta':'',storeDomain:values.get('storeDomain'),includeCustomers:values.has('includeCustomers'),writeAccess:values.has('writeAccess'),confirmWriteAccess:values.has('writeAccess')?channel.id:'',allowAccountChange:values.has('allowAccountChange')})});
        const destination = new URL(result.authorizationUrl);
        // The customer flow is Facebook Login, never the Meta developer portal or
        // a Managed Meta Account login. Fail closed before leaving Runvara.
        if (channel.id === 'meta' && (destination.origin !== 'https://www.facebook.com' || !/^\/v[0-9]+\.0\/dialog\/oauth$/.test(destination.pathname) || destination.username || destination.password)) {
          throw new Error('Facebook sign-in could not be opened safely. No account was connected. Please contact Runvara support; you do not need a Meta Work account.');
        }
        window.location.assign(destination.href);
      } catch(error) { button.disabled=false; button.textContent=`Continue to ${channel.name}`; $('#connection-feedback').textContent=error.message; }
    }
  }
  window.RunvaraConnections = {
    init(config) {
      api=config;
      $('#connection-dialog').addEventListener('input',contentFieldChanged);
      $('#connection-dialog').addEventListener('change',contentFieldChanged);
      $('#connection-dialog').addEventListener('change',event=>{
        if(event.target.id!=='order-recovery-ack')return;
        observeRecoverySource();
        orderRecovery.acknowledged=Boolean(event.target.checked && recoveryAuthority() && recoveryVisible() && orderRecovery.review && !orderRecovery.ticket && Date.parse(orderRecovery.review.expiresAt)>Date.now());
        renderRecoveryState();
      });
      $('#connection-dialog').addEventListener('click',event=>{
        const id=event.target.closest('button')?.id;
        if(id==='order-recovery-review')reviewRecovery();
        if(id==='order-recovery-cancel'){interruptRecovery('Review cancelled');$('#order-recovery-review')?.focus();}
      });
      $('#connection-dialog').addEventListener('click',event=>{ const id=event.target.closest('button')?.id; if(id==='content-check')checkContentAttempt(); else if(id==='content-retry')prepareContent(true); else if(id==='content-reload'||id==='content-new')reloadContentDraft(); });
      $('#connection-dialog').addEventListener('close',()=>{interruptContent('Connection dialog closed');interruptRecovery('Connection dialog closed');});
      document.addEventListener('visibilitychange',()=>{if(document.hidden){interruptContent('Tab hidden');interruptRecovery('Tab hidden');}});
      window.addEventListener('pagehide',()=>{interruptContent('Page hidden');interruptRecovery('Page hidden');});
      window.addEventListener('popstate',()=>{interruptContent('Navigation changed');interruptRecovery('Navigation changed');if(selected==='shopify')close();});
      $('#connection-journey')?.addEventListener('submit',event=>{if(event.target.id==='journey-business'){event.preventDefault();saveJourney({businessName:new FormData(event.target).get('businessName')});}else if(event.target.id==='journey-preferences'){event.preventDefault();const values=new FormData(event.target);saveJourney({preferences:{goal:values.get('goal'),automation:values.get('automation'),approval:'always',stockThreshold:Number(values.get('stockThreshold')),customerRecords:values.has('customerRecords'),marketing:values.has('marketing')}});}else if(event.target.id==='journey-platforms'){event.preventDefault();saveJourney({platforms:new FormData(event.target).getAll('platforms')});}});
      $('#connection-journey')?.addEventListener('click',event=>{const target=event.target.closest('button');if(!target)return;if(target.dataset.journeyReview)saveJourney({reviewPermissions:target.dataset.journeyReview});else if(target.dataset.journeySkip)saveJourney({platforms:(data.onboarding?.journey?.platforms||[]).filter(item=>item.provider!==target.dataset.journeySkip).map(item=>item.provider)});else if(target.id==='journey-recommended')saveJourney({useRecommended:true});else if(target.id==='journey-finish')saveJourney({finish:true,reviewControls:true});else if(target.id==='journey-controls')api.setView('automations');else if(target.id==='journey-dashboard')api.setView('overview');else if(target.dataset.connectionAction)handleAction(event);});
      $('#connection-dialog').addEventListener('change',event=>{ if(event.target.matches('#connection-meta-write-form select[name=operation]')) metaWriteFields(); }); $('#connection-grid').addEventListener('click',handleAction); $('#connection-dialog').addEventListener('click',handleAction); $('#connection-dialog').addEventListener('submit',submit);
      $('#connection-close').addEventListener('click',close); $('#connection-dialog').addEventListener('cancel',event=>{event.preventDefault();close();});
      $('#connection-refresh').addEventListener('click',async event=>{event.target.disabled=true;try{await refresh();api.notify('Connection status refreshed.');}catch(error){api.notify(error.message,'error');}finally{event.target.disabled=false;}});
    },
    render(next) { data=next;channels=next.connectionCentre || [];observeContentSource();observeRecoverySource();cards();journey();notifications();operatorStatus();if(selected)renderPanel();
      clearInterval(journeyTimer);journeyTimer=setInterval(()=>{if(!document.hidden&&!refreshPending&&!busy.size&&channels.some(c=>['queued','running'].includes(c.firstSync?.status)))refresh({panel:false}).catch(()=>{});},3000);
    },
    interruptContent(reason, clear = false) { interruptContent(reason,clear); interruptRecovery(reason,clear); if(reason==='Navigation changed'&&selected==='shopify')close(); },
    endSession() { interruptContent('Session ended',true); interruptRecovery('Session ended',true); clearInterval(journeyTimer);sessionGeneration++; refreshController?.abort(); refreshPending = null; refreshTicket = null; refreshController = null; if (selected) close(); busy.clear(); channels = []; data = {}; },
    open,
    objectiveContentDisplay
  };
})();
