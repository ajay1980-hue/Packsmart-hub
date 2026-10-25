(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
  const usd = value => { if (!/^(0|[1-9][0-9]{0,59})$/.test(String(value))) throw Error('Cost unavailable.'); const n=BigInt(value); return 'USD '+String(n/1000000n)+'.'+String(n%1000000n).padStart(6,'0'); };
  const phase = row => row.status !== 'pending' ? '' : row.provider === 'runway' ? 'generation'
    : ({autofill_ready:'autofill',export_ready:'export'}[row.stage] || (!row.stage ? 'asset_upload' : ''));
  function entries(campaign, role) {
    if (role !== 'owner' || !id(campaign.id)) return '';
    return (campaign.creativeRequests || []).filter(row => id(row.id) && ['canva','runway'].includes(row.provider)).map(row =>
      '<section class="creative-allowance" data-creative-phase="'+escape(phase(row))+'" data-creative-campaign="'+escape(campaign.id)+'" data-creative-request="'+escape(row.id)+'">'
      + '<button type="button" class="secondary small-button" data-creative-review>Review '+escape(row.provider)+' allowance</button>'
      + '<div data-creative-result role="status" aria-live="polite"></div></section>').join('');
  }
  function detail(row, workspaceId, requestId, campaignId) {
    if (!row || row.approvalType !== 'creative_phase/v1' || row.workspaceId !== workspaceId || row.requestId !== requestId || row.campaignId !== campaignId || !id(row.id)
      || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.currency !== 'USD'
      || !Number.isSafeInteger(row.maxCostMicros) || row.maxCostMicros < 0 || !Number.isFinite(Date.parse(row.expiresAt))
      || !['pending','approved','rejected','revoked'].includes(row.status)) throw Error('Exact creative approval is unavailable.');
    const expired = Date.parse(row.expiresAt) <= Date.now();
    const controls = !expired && row.status === 'pending' ? ['approved','rejected']
      : row.status === 'approved' ? ['revoked'] : [];
    const labels = { approved: 'Approve this phase and maximum cost', rejected: 'Reject this phase', revoked: 'Revoke future dispatch' };
    return '<article data-creative-approval="'+escape(row.id)+'"><p><strong>'+escape(row.provider)+' · '+escape(row.phase)+'</strong></p>'
      + '<p>Maximum budget reservation: '+usd(row.maxCostMicros)+'. Status: '+escape(expired ? 'expired' : row.status)+'.</p>'
      + '<p>Expires '+escape(new Date(row.expiresAt).toISOString())+'. Request '+escape(row.requestId)+'.</p>'
      + '<p>Exact input '+escape(row.inputDigest)+'. Account binding '+escape(row.accountBinding)+'. Price revision '+escape(row.priceRevision)+'.</p>'
      + '<p>Provider account '+escape(row.providerAccountId)+'. Approval revision '+row.revision+'.</p>'
      + ['tenantBudget','accountBudget'].map(key=>{ const b=row[key]; if (!b || typeof b.overrunBlocked!=='boolean') throw Error('Budget unavailable.');
        return '<p>'+ (key==='tenantBudget'?'Business':'Provider account')+' budget: '+usd(b.availableMicros)+' available; '+usd(b.heldMicros)+' held; '+usd(b.spentMicros)+' accounted; '+usd(b.uncertainMicros)+' uncertain; '+usd(b.releasedMicros)+' released; '+usd(b.overrunMicros)+' overrun'+(b.overrunBlocked?' (further spending blocked)':'')+'.</p>'; }).join('')
      + '<details><summary>Exact creative source and prepared request</summary><pre>'+escape(row.sourcePreview)+'</pre><pre>'+escape(row.payloadPreview)+'</pre></details>'
      + '<p>Approval covers this creative phase only. It does not approve publishing. A worker may dispatch an approved phase; admitted work can finish after revocation. An uncertain charge retains the full reservation.</p>'
      + (row.reservationStatus ? '<p>Reservation: '+escape(row.reservationStatus)+'. Accounting: '+escape(row.accountingStatus)+'. Held exposure: '+usd(row.heldCostMicros)+'. '
        +(row.accountedCostMicros==null?'Actual charge remains unverified.': 'Verified accounting: '+usd(row.accountedCostMicros)+'.')
        +' Provider task: '+escape(row.upstreamId || 'No acknowledged task ID')+'. Review reads the saved record; it never resubmits a job.</p>' : '')
      + controls.map(decision => '<button type="button" class="secondary small-button" data-creative-decision="'+decision+'" data-creative-revision="'+row.revision+'">'+labels[decision]+'</button>').join('')+'</article>';
  }
  function install(container, { request, context, isCurrent, storage, uuid = () => root.crypto.randomUUID() }) {
    // Storage can be unavailable in a restricted browser. Resolve it only
    // inside the guarded interaction so installing the UI cannot break startup.
    const retained = key => (storage || root.sessionStorage).getItem(key);
    const retain = (key, value) => (storage || root.sessionStorage).setItem(key, value);
    container.addEventListener('click', async event => {
      const button = event.target.closest('[data-creative-review],[data-creative-prepare],[data-creative-decision]');
      if (!button || !container.contains(button)) return;
      const section = button.closest('[data-creative-request]'), ctx = context();
      if (!section || !isCurrent(ctx, true) || section.creativeBusy) return;
      const requestId = section.dataset.creativeRequest, campaignId = section.dataset.creativeCampaign;
      if (!id(requestId) || !id(campaignId) || !id(ctx.workspaceId) || !id(ctx.userId)) return;
      const panel = section.querySelector('[data-creative-result]');
      const current = () => section.isConnected && isCurrent(ctx, true);
      const route = '/api/marketing/campaigns/'+encodeURIComponent(campaignId)+'/creatives/'+encodeURIComponent(requestId)+'/allowance';
      const currentPhase=section.dataset.creativePhase;
      const key = ['runvara-creative-allowance-v1',ctx.workspaceId,ctx.userId,campaignId,requestId,currentPhase].join(':');
      section.creativeBusy = true;
      for (const control of section.querySelectorAll('button')) control.disabled = true;
      try {
        if (button.hasAttribute('data-creative-decision')) {
          const rowId = button.closest('[data-creative-approval]').dataset.creativeApproval;
          const decision = button.dataset.creativeDecision, revision = Number(button.dataset.creativeRevision);
          if (!id(rowId) || !Number.isSafeInteger(revision) || !['approved','rejected','revoked'].includes(decision)) throw Error('Decision unavailable.');
          // Disable the displayed decision before sending. A lost response is
          // resolved by a new explicit read, never by another decision POST.
          panel.textContent = 'Saving exact decision…';
          const result = await request('/api/marketing/creative-allowances/'+encodeURIComponent(rowId)+'/decision',
            { method:'POST', body:JSON.stringify({revision,decision}) });
          if (current()) panel.innerHTML = detail(result.allowance,ctx.workspaceId,requestId,campaignId);
        } else if (button.hasAttribute('data-creative-prepare')) {
          if (!['asset_upload','autofill','export','generation'].includes(currentPhase)) throw Error('No new phase is available.');
          if (retained(key)) throw Error('A preparation may already exist. Use Review to check its saved outcome.');
          const operationId = uuid();
          retain(key,operationId); // If durable browser storage fails, do not submit.
          panel.textContent = 'Preparing an exact review; no generation is authorized…';
          const result = await request(route,{method:'POST',body:JSON.stringify({operationId})});
          if (current()) panel.innerHTML = detail(result.allowance,ctx.workspaceId,requestId,campaignId);
        } else {
          const result = await request(route);
          if (!current()) return;
          const rows = result.allowance;
          if (!Array.isArray(rows) || rows.length>3) throw Error('Saved creative approval is unavailable.');
          panel.innerHTML = rows.map(row=>detail(row,ctx.workspaceId,requestId,campaignId)).join('');
          if (currentPhase && !rows.some(row=>row.phase===currentPhase)) {
            panel.insertAdjacentHTML('beforeend','<p>'+(retained(key) ? 'Preparation outcome remains unknown. No retry or generation has been sent.'
              : 'Prepare an exact phase review using verified server pricing and entitlement. This may read source image/template data; it does not generate or approve anything.')+'</p>');
            if (!retained(key)) panel.insertAdjacentHTML('beforeend','<button type="button" class="secondary small-button" data-creative-prepare>Prepare exact phase review</button>');
          }
        }
      } catch (error) {
        if (current()) panel.textContent = (error?.message || 'Creative allowance unavailable.')+' No automatic retry. Use Review to check the saved outcome.';
      } finally {
        section.creativeBusy = false;
        if (current()) for (const control of section.querySelectorAll('button')) control.disabled = false;
      }
    });
  }
  root.RunvaraCreativeAllowances = Object.freeze({entries,detail,install});
})(window);
