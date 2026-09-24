/* Runvara's shared presentation vocabulary. Pure projections of workspace data:
   no requests, persistence, permissions or state transitions belong here. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const badge = (text, tone = 'neutral') => `<span class="tag ${['good','warn','bad','neutral'].includes(tone) ? tone : 'neutral'}">${escape(text)}</span>`;
  const label = value => String(value || '').replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, x => x.toUpperCase());
  const role = id => ({commander:'Business coordination',stock:'Inventory monitoring',pricing:'Pricing & margin analysis',product_scout:'Product research',supplier:'Supplier analysis',ebay:'Marketplace operations',shopify:'Store operations',seo:'Catalogue quality',marketing:'Marketing analysis',customer_service:'Order follow-up',sales:'Revenue analysis',finance:'Financial oversight',health_watch:'Integration monitoring',operations:'Operations analysis',compliance:'Risk & approval oversight'}[id] || 'Workspace specialist');
  const marks = {
    shopify:'<path d="m5 7 13-2 3 16H3zM8 7V5a4 4 0 0 1 8 0v1"/><text x="9" y="18" font-size="11" fill="currentColor" stroke="none">S</text>',
    ebay:'<text x="1" y="16" font-size="10" font-weight="600" fill="currentColor" stroke="none">ebay</text>',
    meta:'<path d="M3 16C-1 4 7 1 12 12c5 11 12 8 9-3-3-10-8 0-12 7-4 7-6 3-6 0Z"/>',
    google_youtube:'<rect x="2" y="5" width="20" height="14" rx="4"/><path d="m10 9 6 3-6 3z"/>',
    pinterest:'<circle cx="12" cy="12" r="10"/><path d="m9 21 3-13m-1 7c8 4 9-11 1-10-5 1-7 7-4 9"/>',
    tiktok_shop:'<path d="M14 3v13a5 5 0 1 1-4-5m4-8c1 5 4 6 7 6"/>',
    whatsapp_business:'<path d="M5 20 2 22l1-6a10 10 0 1 1 2 4Z"/><path d="M8 6c-4 5 5 13 9 8l-3-2-2 1-2-2 1-2z"/>',
    amazon:'<text x="6" y="16" font-size="18" font-weight="700" fill="currentColor" stroke="none">a</text><path d="M3 19q9 5 18-1m-4 0h4v4"/>'
  };
  const logo = id => `<svg class="platform-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${Object.hasOwn(marks,id) ? marks[id] : '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4v16"/>'}</svg>`;
  function issueCopy(code, channelName = 'This connection') {
    const value = String(code || '');
    if (/PERMISSION|ACCESS_DENIED/.test(value)) return `${channelName} needs permission`;
    if (/TOKEN|AUTH|CREDENTIAL/.test(value)) return `${channelName} needs reconnecting`;
    if (/RATE_LIMIT/.test(value)) return `${channelName} is limiting requests`;
    if (/SOURCE_COVERAGE_INCOMPLETE/.test(value)) return 'Some source data could not be refreshed';
    if (/COVERAGE_UNAVAILABLE/.test(value)) return 'Full marketplace coverage is not available';
    if (/TIMEOUT|TIMED_OUT|UNAVAILABLE|NETWORK/.test(value)) return `${channelName} could not be reached`;
    if (/NO_RECORDED_DATA/.test(value)) return 'There is not enough imported data for this check';
    if (/WORKER_INTERRUPTED/.test(value)) return 'The previous check was interrupted';
    return /^[A-Z][A-Z0-9_]+$/.test(value) ? 'This check needs review' : value;
  }
  function connectionMessage(channel) {
    if (!channel) return '';
    const code = channel.history?.find(run => run.errorCode)?.errorCode;
    return channel.recovery?.action === 'reconnect' ? `${issueCopy(code || 'AUTH_REQUIRED',channel.name)}. ${channel.recovery.message}` : channel.recovery?.message || (channel.configured ? 'Selected data is connected. Review coverage and sync history below.' : 'Connect an account to start importing data.');
  }
  function schedule(channel, data, now = Date.now()) {
    if (!channel.configured) return 'Connect first';
    if (channel.progress) return 'Sync in progress';
    if (!channel.settings?.autoSync || !data.autopilot?.enabled || data.automations?.channelSync === false || data.autopilot?.rules?.channelSync?.permitted === false) return 'Automatic sync paused';
    if (channel.recovery?.action === 'reconnect') return 'Access needs review';
    const latest = channel.history?.[0]?.startedAt || channel.lastSuccessfulSyncAt;
    const next = Date.parse(latest) + Number(channel.settings?.frequencyMinutes || 30) * 60000;
    if (!Number.isFinite(next) || next <= now) return 'Eligible at next check';
    return `Eligible after ${new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit'}).format(new Date(next))}`;
  }
  const active = item => item.present && ['open','acknowledged'].includes(item.status);
  function incidents(data, activeOnly = true) {
    const records = (data.exceptions || []).filter(item => !activeOnly || active(item));
    const groups = records.map(item => ({key:item.id,primary:item,items:[item],channel:(data.connectionCentre || []).find(ch=>item.kind==='integration'&&ch.id===item.reference)}));
    if (!activeOnly) return groups;
    const absorbed = new Set();
    for (const group of groups.filter(group => group.primary.kind === 'automation')) {
      const record = group.primary;
      const runId = record.evidence?.find(item=>item.type==='automation_run')?.id;
      const run = (data.automationRuns || []).find(item=>item.id===runId);
      if (!run) continue;
      const failedProviders = (run.evidence || []).filter(item=>item.type==='integration_read'&&!['connected','configured','completed'].includes(String(item.detail).toLowerCase())).map(item=>item.id);
      let roots = groups.filter(item => item.channel && failedProviders.includes(item.channel.id));
      if (run.ruleId === 'channelMismatchAlerts' && run.errorCode === 'COVERAGE_UNAVAILABLE') roots = groups.filter(item=>item.primary.kind==='source_coverage'&&item.primary.reference==='ebay_catalogue');
      // Multiple possible causes remain separate. Temporal proximity or a shared
      // severity is never enough to claim that one incident caused another.
      if (roots.length === 1) { roots[0].items.push(record); absorbed.add(group.key); }
    }
    const remaining = groups.filter(group=>!absorbed.has(group.key));
    for (const kind of ['stock','margin','order']) {
      const cohort = remaining.filter(group=>group.primary.kind===kind);
      if (cohort.length > 1) {
        cohort[0].cohort = true; cohort[0].items = cohort.flatMap(group=>group.items);
        for (const group of cohort.slice(1)) absorbed.add(group.key);
      }
    }
    return remaining.filter(group=>!absorbed.has(group.key)).sort((a,b)=>Number(Boolean(b.channel))-Number(Boolean(a.channel)));
  }
  function incidentTitle(group) {
    if (group.cohort) return ({stock:'Stock needs review',margin:'Margins need review',order:'Orders need follow-up'})[group.primary.kind];
    if (group.channel?.recovery?.action==='reconnect') return issueCopy(group.channel.history?.find(run=>run.errorCode)?.errorCode || group.primary.rootCause,group.channel.name);
    return group.primary.kind === 'automation' ? `${label(group.primary.reference)} needs review` : group.primary.title;
  }
  function incidentTone(group) {
    if (group.channel?.recovery || group.primary.kind==='source_coverage') return {text:group.channel?.recovery?.action==='reconnect'?'Access needed':'Review coverage',tone:'warn'};
    if (group.primary.kind==='automation' && /BLOCKED|COVERAGE|PERMISSION|AUTH|TIMEOUT|UNAVAILABLE/.test(group.primary.rootCause||'')) return {text:'Check paused',tone:'warn'};
    return {text:label(group.primary.severity || 'Review'),tone:['critical','high'].includes(group.primary.severity)?'bad':'warn'};
  }
  function attempts(group, data) {
    const history = group.channel?.history || [];
    const latest = history[0];
    if (latest) return `${latest.automatic ? 'Automatic' : 'Requested'} sync ${latest.status === 'completed' ? 'completed' : latest.status === 'running' ? 'is in progress' : 'could not complete all selected reads'}. ${history.filter(run=>['failed','partial'].includes(run.status)).length} incomplete attempts in the retained history.`;
    const id = group.primary.evidence?.find(item=>item.type==='automation_run')?.id;
    const run = (data.automationRuns || []).find(item=>item.id===id);
    return run ? `${label(run.ruleId)}: ${label(run.status)}. ${issueCopy(run.errorCode)}` : 'No repair attempt is recorded for this condition.';
  }
  const workName = (item,data) => (data.automationDefinitions || []).find(rule=>rule.id===item.title)?.name || item.title;
  function workState(item) {
    if (item.status==='COMPLETED' && !(item.evidence || []).length) return {text:'Outcome not verified',tone:'warn'};
    return ({'COMPLETED':{text:'Completed',tone:'good'},'IN PROGRESS':{text:'In progress',tone:'neutral'},'REQUIRES APPROVAL':{text:'Awaiting approval',tone:'warn'},'FAILED':{text:'Needs review',tone:'warn'},'BLOCKED':{text:'Paused',tone:'warn'}})[item.status] || {text:label(item.status),tone:'neutral'};
  }
  window.RunvaraUI = Object.freeze({escape,badge,label,role,logo,issueCopy,connectionMessage,schedule,active,incidents,incidentTitle,incidentTone,attempts,workName,workState});
})();
