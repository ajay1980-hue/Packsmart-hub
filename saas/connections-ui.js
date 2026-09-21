(() => {
  'use strict';
  let api, channels = [], data = {}, selected = null, returnFocus, pollTimer;
  const busy = new Set();
  const $ = selector => document.querySelector(selector);
  const labels = { connected: 'Connected', degraded: 'Degraded', action_required: 'Action required', disconnected: 'Disconnected', not_configured: 'Not configured', read_only: 'Read-only', approval_gated: 'Approval-gated write', automatic: 'Automatic write', catalogs: 'Catalogues', posts: 'Facebook posts', products: 'Products', variants: 'Variants', inventory: 'Inventory', prices: 'Prices', orders: 'Orders', customers: 'Customers', promotions: 'Promotions', accounts: 'Facebook Pages & Instagram accounts', channels: 'YouTube channels', boards: 'Boards', pins: 'Pins', shops: 'Shops' };
  const label = key => labels[key] || key;
  const esc = value => api.escapeHtml(value);
  const when = value => value ? api.date(value) : 'Not yet';
  const owner = () => data.user?.role === 'owner';
  const manager = () => ['owner', 'admin'].includes(data.user?.role);
  const statusClass = status => status === 'connected' ? 'good' : ['degraded', 'action_required'].includes(status) ? 'warn' : 'neutral';
  const button = (action, text, channel, style = 'secondary') => `<button type="button" class="${style}" data-connection-action="${action}" data-provider="${channel.id}" ${busy.has(channel.id) || (!manager() && action !== 'open') ? 'disabled' : ''}>${esc(text)}</button>`;
  const managerLink = '<a class="secondary button-link" href="https://packsmart-ebay-manager.sleek-chub-7298.chatgpt.site/" target="_blank" rel="noopener noreferrer">Open existing eBay Manager</a>';
  function cards() {
    $('#connection-grid').innerHTML = channels.map(channel => `<article class="connection-card" data-channel-card="${channel.id}">
      <div class="connection-card-heading"><span class="connection-brand" aria-hidden="true">${esc(channel.name.slice(0, 2).toUpperCase())}</span><span class="tag ${statusClass(channel.status)}">${esc(label(channel.status))}</span></div>
      <h3><button type="button" class="connection-title" data-connection-action="open" data-provider="${channel.id}" aria-haspopup="dialog">${esc(channel.name)}</button></h3>
      <p class="connection-summary">${esc(channel.configured ? channel.identity || 'Account connected' : channel.status === 'disconnected' ? 'Your imported data is safe. Reconnect when you’re ready.' : 'Connect your account to get started.')}</p>
      <p class="connection-health ${channel.recovery ? 'warn' : 'muted'}">${esc(channel.recovery?.message || (channel.configured ? 'Your connection is ready to manage.' : channel.oauthReady ? 'Sign in securely with your channel account.' : 'Open setup to see availability and next steps.'))}</p>
      <div class="connection-card-footer"><small>${esc(label(channel.settings.permissionMode))}<br>Last successful sync: ${esc(when(channel.lastSuccessfulSyncAt))}</small><div class="button-row">${button(channel.configured ? 'open' : 'connect', channel.configured ? 'Manage connection' : `Connect ${channel.name}`, channel, 'primary')}${channel.configured ? button('sync', 'Sync now', channel) : ''}</div></div>
    </article>`).join('');
  }
  function onboarding(channel) {
    if (!channel.oauthReady) return `<div class="connection-notice"><h3>${channel.configured ? 'Renew this connection' : `Connect ${esc(channel.name)}`}</h3><p>${channel.refreshSupported ? 'You can renew the saved connection without entering any credentials. If access was removed at the channel, its owner will need to restore it.' : 'Runvara’s secure sign-in for this channel has not been enabled yet. The Runvara operator needs to complete the platform setup before customers can sign in here.'}</p>
      <p>You do not need to handle API keys or change server settings.</p><div class="button-row">${channel.refreshSupported ? button('refresh', 'Renew saved connection', channel, 'primary') : ''}${channel.supportRequested ? '<span role="status">Setup request recorded in this workspace.</span>' : button('setup-request', 'Record setup request', channel)}${channel.id === 'shopify' ? button('advanced', 'Existing custom app options', channel) : ''}${channel.id === 'ebay' ? managerLink : ''}</div></div>`;
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
    const writes = (data.connectionWrites || []).filter(item => item.provider === channel.id);
    $('#connection-detail').innerHTML = `<div class="section-head stack-mobile"><div><p class="eyebrow">CONNECTION CENTRE</p><h2 id="connection-dialog-title">${esc(channel.name)}</h2><p class="muted">${esc(channel.identity || 'No account connected')}</p></div><span class="tag ${statusClass(channel.status)}">${esc(label(channel.status))}</span></div>
      <p id="connection-feedback" class="connection-feedback" role="status" aria-live="polite"></p><div id="connection-progress">${progress(channel)}</div>
      ${!manager() ? '<p class="connection-notice">You have view access. Ask a workspace owner or admin to manage this connection.</p>' : ''}
      ${channel.recovery ? `<div class="connection-notice"><p>${esc(channel.recovery.message)}</p>${channel.recovery.action === 'manager' ? managerLink : button(channel.recovery.action, channel.recovery.label, channel, 'primary')}</div>` : ''}
      ${channel.coverageNote ? `<p class="muted">${esc(channel.coverageNote)}</p>` : ''}
      ${channel.configured ? `<div class="button-row connection-toolbar">${button('test', 'Test connection', channel)}${channel.refreshSupported ? button('refresh', 'Refresh access', channel) : ''}${button('reconnect', 'Reconnect', channel)}${channel.id === 'ebay' ? managerLink : ''}</div>` : ''}
      <div id="connection-setup" class="${channel.configured ? 'hidden' : ''}">${onboarding(channel)}</div>
      ${channel.id === 'meta' ? metaAssets(channel) : ''}
      ${channel.configured ? `<section class="connection-section"><h3>Imported data</h3><dl class="connection-counts">${Object.entries(channel.counts).map(([key, count]) => `<div><dt>${esc(label(key))}</dt><dd>${esc(count)}</dd></div>`).join('')}</dl><p class="muted tiny">Last successful sync: ${esc(when(channel.lastSuccessfulSyncAt))} · Last connection test: ${esc(when(channel.lastCheckedAt))}</p></section>
      <section class="connection-section"><h3>Sync controls</h3><form id="connection-sync-settings" class="connection-manage-form"><fieldset ${!manager() ? 'disabled' : ''}><legend>Choose what to sync</legend><div class="connection-area-grid">${channel.areas.map(area => `<label class="check-label"><input type="checkbox" name="areas" value="${area}" ${channel.settings.areas.includes(area) ? 'checked' : ''}>${esc(label(area))}</label>`).join('')}</div></fieldset>
      ${channel.id === 'shopify' ? '<p class="muted tiny">Product, variant, price and inventory selections update only those fields. Customers need separate read access in Shopify.</p>' : ''}
      <label class="check-label"><input type="checkbox" name="autoSync" ${channel.settings.autoSync ? 'checked' : ''} ${!manager() ? 'disabled' : ''}> Enable automatic sync</label><label>Sync frequency<select name="frequencyMinutes" ${!manager() ? 'disabled' : ''}>${[[15,'Every 15 minutes'],[30,'Every 30 minutes'],[60,'Hourly'],[180,'Every 3 hours'],[360,'Every 6 hours'],[1440,'Daily']].map(([value,text]) => `<option value="${value}" ${value === channel.settings.frequencyMinutes ? 'selected' : ''}>${text}</option>`).join('')}</select></label>
      <p class="muted tiny">Automatic sync follows your workspace’s Autopilot limits. ${data.autopilot?.enabled ? 'Autopilot is on.' : 'Autopilot is currently paused.'} <button class="connection-text-button" type="button" data-connection-action="autopilot" data-provider="${channel.id}">Manage Autopilot</button></p>
      <div class="button-row"><button class="secondary" type="submit" ${!manager() ? 'disabled' : ''}>Save sync settings</button>${button('sync-selected', 'Sync selected now', channel, 'primary')}</div></form></section>
      <section class="connection-section"><h3>Write permissions</h3><p>Reading data never changes your channel. Only the workspace owner can authorise writes.</p><form id="connection-permissions" class="connection-manage-form"><label>Permission level<select name="permissionMode" ${!owner() ? 'disabled' : ''}>${['read_only','approval_gated','automatic'].map(mode => `<option value="${mode}" ${channel.settings.permissionMode === mode ? 'selected' : ''}>${esc(label(mode))}</option>`).join('')}</select></label><label class="check-label"><input type="checkbox" name="confirmPermission" ${!owner() ? 'disabled' : ''}> I authorise the selected write policy. Financial, destructive and customer-facing changes still need approval.</label><button class="secondary" type="submit" ${!owner() ? 'disabled' : ''}>Save permissions</button></form>
      <p class="muted">${channel.id === 'shopify' ? `Supported writes: internal product notes and approval-gated product content. ${channel.writeAccessGranted ? 'Shopify product write access is granted.' : 'Shopify product write access is not granted. Request it when reconnecting, then test the connection.'} Automatic mode can bypass approval only for private Runvara product notes.` : channel.id === 'meta' ? 'Catalogue products, stock, product visibility, Facebook posts and Instagram JPEG posts support approval-gated changes. Automatic mode never bypasses approval for Meta. Reconnect to request any missing catalogue or publishing permissions.' : 'This channel currently has no supported write action in Runvara. A write policy never grants channel permissions or enables an unavailable action.'}</p>
      ${channel.id === 'shopify' && channel.settings.permissionMode !== 'read_only' && channel.writeAccessGranted && owner() ? writeForm() : channel.id === 'meta' && channel.settings.permissionMode !== 'read_only' && channel.writeAccessGranted && owner() ? metaWriteForm(channel) : ''}</section>` : ''}
      ${writes.length ? `<section class="connection-section"><h3>Proposed changes</h3>${writes.slice(0,15).map(write => `<article class="connection-write"><b>${esc(write.input.operation.replaceAll('_',' '))}</b><p>${esc(write.status.replaceAll('_',' '))}</p><details><summary>Review exact change</summary><dl>${Object.entries(write.input).map(([key,value]) => `<dt>${esc(key.replace(/([A-Z])/g,' $1'))}</dt><dd class="connection-exact-text">${esc(value)}</dd>`).join('')}</dl></details><div class="button-row">${write.approvalId ? button('approvals', 'Open Approval Centre', channel) : ''}${owner() && ['ready','processing'].includes(write.status) ? `<button class="secondary" type="button" data-connection-action="execute" data-provider="${channel.id}" data-write="${esc(write.id)}">${write.status === 'processing' ? 'Check publishing progress' : write.requiresApproval ? 'Apply approved change' : 'Apply change'}</button>` : ''}</div>${write.status === 'processing' ? '<p>Instagram is preparing your image. Check again after a minute; the same approved request will be continued.</p>' : ''}${write.status === 'uncertain' ? '<p class="warn">Check the channel before making another request. Runvara will not repeat an uncertain write.</p>' : ''}${write.status === 'failed' ? '<p class="warn">The channel declined this request. Test the connection, check the selected asset and fields, then prepare a new change.</p>' : ''}${write.result?.externalId ? `<p>Confirmed channel reference: ${esc(write.result.externalId)}</p>` : ''}</article>`).join('')}</section>` : ''}
      <section class="connection-section"><h3>Sync history</h3><p class="muted tiny">Latest 30 syncs. Completed sync summaries remain in the workspace audit log.</p><div class="connection-history">${channel.history.length ? channel.history.map(run => `<article><div><b>${esc({completed:'Completed',partial:'Partially completed',failed:'Needs attention',running:'In progress'}[run.status])}</b><small>${esc(when(run.startedAt))} · ${run.automatic ? 'Automatic' : 'Requested'}</small></div><p>${esc(run.areas.map(label).join(', '))}</p>${run.status === 'failed' || run.status === 'partial' ? '<p class="warn">Some data could not be refreshed. Your previous data is retained. Use Sync now to retry.</p>' : ''}</article>`).join('') : '<p class="muted">No sync history recorded yet. Your earlier imported data is retained.</p>'}</div></section>
      ${channel.configured ? `<section class="connection-section"><h3>Disconnect</h3><p>Stop Runvara from accessing this channel. Imported data stays in this workspace. ${channel.id === 'ebay' ? 'Your separate eBay Manager stays intact.' : 'This does not delete or close your channel account.'}</p>${button('disconnect', `Disconnect ${channel.name}`, channel, 'secondary danger')}<form id="connection-disconnect" class="connection-confirm hidden"><p>Are you sure? Syncing will stop and Runvara’s write permission will be removed.</p><label class="check-label"><input name="confirm" type="checkbox" required> I confirm I want to disconnect this channel from Runvara.</label><div class="button-row"><button class="primary danger" type="submit">Confirm disconnect</button>${button('cancel-disconnect','Keep connected',channel)}</div></form></section>` : ''}`;
    metaWriteFields();
  }
  function writeForm() {
    return `<form id="connection-write-form" class="connection-manage-form"><h3>Prepare a Shopify change</h3><label>Product<select name="productId" required>${(data.products || []).filter(item => item.provider === 'shopify').map(item => `<option value="${esc(item.id)}">${esc(item.title)}</option>`).join('')}</select></label><label>Action<select name="operation"><option value="internal_note">Private Runvara product note</option><option value="product_content">Product title and description (approval required)</option></select></label><label>Internal note<textarea name="note" maxlength="500"></textarea></label><label>New product title<input name="title" maxlength="200"></label><label>New product description<textarea name="description" maxlength="10000"></textarea></label><p class="muted tiny">Only fields for your selected action are used. This prepares an exact, reviewable change before applying it.</p><button class="secondary" type="submit">Prepare change</button></form>`;
  }
  function metaAssets(channel) {
    const meta = channel.meta || {}, assets = meta.assets || { pages:[], catalogs:[] };
    return `<section class="connection-section"><h3>Meta availability</h3><p>${esc(meta.orderRestriction?.message || '')}</p><a href="https://developers.facebook.com/docs/graph-api/changelog/version26.0/" target="_blank" rel="noopener noreferrer">Read Meta’s order API retirement notice</a>${channel.configured ? `<form id="connection-meta-assets" class="connection-manage-form"><h3>Choose your Pages and catalogues</h3><p>Select the assets this workspace should use. If an asset is missing, reconnect and grant it access in Meta.</p><fieldset ${!manager() ? 'disabled' : ''}><legend>Facebook Pages and linked Instagram accounts</legend>${assets.pages.map(page => `<label class="check-label"><input type="checkbox" name="metaPageIds" value="${esc(page.id)}" ${(channel.settings.metaPageIds || []).includes(page.id) ? 'checked' : ''}>${esc(page.name)}${page.instagram ? ` · Instagram @${esc(page.instagram.username)}` : ''}</label>`).join('') || '<p>No Pages authorised.</p>'}</fieldset><fieldset ${!manager() ? 'disabled' : ''}><legend>Catalogues</legend>${assets.catalogs.map(catalog => `<label class="check-label"><input type="checkbox" name="metaCatalogIds" value="${esc(catalog.id)}" ${(channel.settings.metaCatalogIds || []).includes(catalog.id) ? 'checked' : ''}>${esc(catalog.name)}</label>`).join('') || '<p>No catalogues authorised. Request catalogue access when reconnecting.</p>'}</fieldset><button type="submit" class="secondary" ${!manager() ? 'disabled' : ''}>Save selected assets</button></form><p class="muted tiny">Product variants are imported as catalogue items with their group references. Sync currently supports up to 2,000 items. Instagram publishing supports public JPEG images; video and carousel publishing are not implemented in this release.</p>` : ''}</section>`;
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
      if (operation === 'facebook_update') html += select('postId','Post published by Runvara',(data.connectionWrites || []).filter(item=>item.provider === 'meta' && item.status === 'completed' && item.input.operation === 'facebook_publish').map(item=>({id:item.result.externalId,name:item.input.message})));
      html += `<label>${operation === 'instagram_publish' ? 'Caption' : 'Post text'}<textarea name="message" required maxlength="${operation === 'instagram_publish' ? 2200 : 5000}"></textarea></label>`;
      if (operation === 'instagram_publish') html += field('imageUrl','Public HTTPS JPEG image address','type="url"') + '<p>Use a linked Instagram professional account and a publicly accessible JPEG. Meta may require Page publishing authorisation. Instagram allows up to 100 API-published posts per rolling 24 hours.</p>';
      if (operation === 'facebook_publish') html += '<label>Optional public HTTPS link<input name="url" type="url"></label>';
    }
    $('#connection-meta-write-fields').innerHTML = html;
  }
  async function refresh({ panel = true } = {}) {
    const payload = await api.request('/api/connection-centre'); channels = payload.channels; data.connectionWrites = payload.writes;
    data.connectionCentre = channels;
    data.autopilot = { ...data.autopilot, enabled: payload.autopilotEnabled }; cards();
    if (selected && panel) renderPanel();
    else if (selected) $('#connection-progress').innerHTML = progress(channels.find(item => item.id === selected));
  }
  function close() { $('#connection-dialog').close(); selected = null; clearInterval(pollTimer); returnFocus?.focus(); }
  function open(provider, setup = false) {
    selected = provider; returnFocus = document.activeElement; renderPanel();
    const dialog = $('#connection-dialog'); if (!dialog.open) dialog.showModal();
    if (setup) $('#connection-setup').classList.remove('hidden');
    $('#connection-close').focus(); clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (selected && !document.hidden) refresh({ panel: false }).catch(() => {}); }, 5000);
  }
  async function perform(provider, action, body = {}) {
    if (busy.has(provider)) return;
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
    } catch (error) { message = error.message; failed = true; }
    finally {
      busy.delete(provider); dialog.removeAttribute('aria-busy');
      try { await refresh(); } catch { /* Show the action result even if status refresh fails. */ }
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
    if (action === 'reconnect') { $('#connection-setup').classList.remove('hidden'); $('#connection-setup').scrollIntoView({block:'nearest'}); return; }
    if (action === 'advanced') { close(); $('#advanced-channel-connections').open = true; $('#shopify-connection-card').scrollIntoView({block:'start'}); return; }
    if (action === 'autopilot' || action === 'approvals') { close(); api.setView(action === 'autopilot' ? 'automations' : 'approvals'); return; }
    if (action === 'disconnect' || action === 'cancel-disconnect') { $('#connection-disconnect').classList.toggle('hidden', action !== 'disconnect'); if(action === 'disconnect') $('#connection-disconnect input').focus(); return; }
    if (action === 'sync-selected') { const areas = [...new FormData($('#connection-sync-settings')).getAll('areas')]; return perform(provider, 'sync', { areas }); }
    if (action === 'execute') {
      target.disabled = true;
      try { const result = await api.request(`/api/connection-writes/${target.dataset.write}/execute`, {method:'POST',body:'{}'}); await api.reload({migrate:false}); await refresh(); const processing = result.write?.status === 'processing'; api.notify(result.executedExternally ? `${channel.name} confirmed the change.` : processing ? 'Instagram is preparing the image. Check publishing progress after a minute.' : `Check the result in ${channel.name}. This request will not be repeated.`, result.executedExternally || processing ? undefined : 'error'); }
      catch(error) { target.disabled=false; $('#connection-feedback').textContent=error.message; api.notify(error.message,'error'); }
      return;
    }
    return perform(provider, action);
  }
  async function submit(event) {
    const form = event.target; if (!form.id.startsWith('connection-')) return;
    event.preventDefault(); const channel = channels.find(item=>item.id === selected); if (!channel) return;
    const values = new FormData(form);
    if (form.id === 'connection-meta-assets') return perform(channel.id,'settings',{revision:channel.settings.revision,metaPageIds:values.getAll('metaPageIds'),metaCatalogIds:values.getAll('metaCatalogIds')});
    if (form.id === 'connection-meta-write-form') { const body=Object.fromEntries(values); for(const key of ['quantity','priceMinor']) if(key in body) body[key]=Number(body[key]); return perform(channel.id,'writes',{...body,requestId:crypto.randomUUID()}); }
    if (form.id === 'connection-sync-settings') return perform(channel.id, 'settings', { revision:channel.settings.revision, areas:values.getAll('areas'), autoSync:values.has('autoSync'), frequencyMinutes:Number(values.get('frequencyMinutes')) });
    if (form.id === 'connection-permissions') return perform(channel.id, 'settings', { revision:channel.settings.revision, permissionMode:values.get('permissionMode'), confirmPermission:values.has('confirmPermission') ? `${channel.id}:${values.get('permissionMode')}` : '' });
    if (form.id === 'connection-disconnect') { if(values.has('confirm')) return perform(channel.id, 'disconnect', {confirm:channel.id,revision:channel.settings.revision}); return; }
    if (form.id === 'connection-write-form') return perform(channel.id,'writes',{...Object.fromEntries(values),requestId:crypto.randomUUID()});
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
      api=config; $('#connection-dialog').addEventListener('change',event=>{ if(event.target.matches('#connection-meta-write-form select[name=operation]')) metaWriteFields(); }); $('#connection-grid').addEventListener('click',handleAction); $('#connection-dialog').addEventListener('click',handleAction); $('#connection-dialog').addEventListener('submit',submit);
      $('#connection-close').addEventListener('click',close); $('#connection-dialog').addEventListener('cancel',event=>{event.preventDefault();close();});
      $('#connection-refresh').addEventListener('click',async event=>{event.target.disabled=true;try{await refresh();api.notify('Connection status refreshed.');}catch(error){api.notify(error.message,'error');}finally{event.target.disabled=false;}});
    },
    render(next) { data=next;channels=next.connectionCentre || [];cards();if(selected)renderPanel(); },
    open
  };
})();
