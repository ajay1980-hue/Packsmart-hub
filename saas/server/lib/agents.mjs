import crypto from 'node:crypto';
import { deriveOperations, integrationMatrix } from './operations.mjs';
import { normalizeApprovalRequest } from './operations.mjs';
import { ensureControl } from './control.mjs';
import { recordWork } from './events.mjs';

export const AUTONOMY_LEVELS = Object.freeze({ 0: 'Observe', 1: 'Recommend', 2: 'Prepare', 3: 'Auto within limits' });

export const AGENT_DEFINITIONS = Object.freeze([
  ['commander', 'Commander', 2], ['stock', 'Stock', 2], ['pricing', 'Pricing & Margin', 2],
  ['product_scout', 'Product Scout', 1], ['supplier', 'Supplier', 2], ['ebay', 'eBay', 2],
  ['shopify', 'Shopify', 2], ['seo', 'SEO', 1], ['marketing', 'Marketing', 2],
  ['customer_service', 'Customer Service', 2], ['sales', 'Sales', 1], ['finance', 'Finance', 1],
  ['health_watch', 'Health Watch', 2], ['operations', 'Operations', 2], ['compliance', 'Compliance & Risk', 1]
].map(([id, name, defaultAutonomy]) => ({ id, name, defaultAutonomy })));

const safeText = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const nowIso = now => (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
const money = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? `£${Number(value).toFixed(2)}` : 'not confirmed';

export function defaultAgentSettings() {
  return Object.fromEntries(AGENT_DEFINITIONS.map(agent => [agent.id, { autonomy: agent.defaultAutonomy, enabled: true }]));
}

export function routeCommand(command) {
  const input = safeText(command, 1000).toLowerCase();
  if (!input) throw Object.assign(new Error('Enter a command for the AI Team'), { status: 400, code: 'COMMAND_REQUIRED' });
  const selected = new Set();
  const matches = (pattern, agents) => { if (pattern.test(input)) agents.forEach(id => selected.add(id)); };
  matches(/broken|health|failed|failure|error|warning|credential|login|system|integration|what.?s wrong/, ['health_watch']);
  matches(/stock|inventory|reorder|need next week|running out/, ['stock']);
  matches(/price|pricing|margin|underpriced|overpriced|competitor/, ['pricing']);
  matches(/profit|money|revenue|vat|fee|cash|cost|wasted/, ['finance', 'pricing', 'sales']);
  matches(/ebay|listing|promoted/, ['ebay']);
  matches(/shopify|store|checkout|collection/, ['shopify']);
  matches(/seo|google|ranking|keyword|index|backlink/, ['seo']);
  matches(/market|campaign|social|advert|promotion/, ['marketing']);
  matches(/customer|message|complaint|refund|delivery|damaged/, ['customer_service']);
  matches(/sales|conversion|upsell|bundle|b2b|channel/, ['sales']);
  matches(/supplier|purchase|order stock|lead time|moq/, ['supplier']);
  matches(/operation|shipping|fulfil|fulfill|dispatch|automation|autopilot/, ['operations']);
  matches(/risk|approval|compliance|security|spend|refund|publish|delete/, ['compliance']);
  matches(/new product|product scout|worth selling|product gate/, ['product_scout', 'supplier', 'pricing', 'seo', 'ebay', 'finance']);
  if (/sort packsmart|today.?s priorit|daily brief|check everything|full audit|business health/.test(input)) {
    ['health_watch', 'finance', 'stock', 'pricing', 'shopify', 'ebay', 'sales'].forEach(id => selected.add(id));
  }
  if (!selected.size) ['health_watch', 'finance', 'stock', 'sales'].forEach(id => selected.add(id));
  return [...selected];
}

function connection(state, id) {
  return integrationMatrix(state).find(item => item.id === id) || { status: 'not_configured', detail: 'Not connected', lastSyncAt: null };
}

function result(id, status, finding, data = {}, confidence = 0.8, issues = []) {
  return { agentId: id, status, finding, data, confidence, issues, completedAt: new Date().toISOString() };
}

export function runSpecialist(agentId, state, options = {}) {
  const metrics = options.metrics || deriveOperations(state, options);
  const shopify = connection(state, 'shopify');
  const ebay = connection(state, 'ebay');
  switch (agentId) {
    case 'health_watch': {
      const sources = integrationMatrix(state).filter(item => ['commerce', 'marketplace'].includes(item.kind));
      const failures = sources.filter(item => ['error', 'failed'].includes(item.status));
      const warnings = sources.filter(item => ['degraded', 'not_configured'].includes(item.status));
      const severity = failures.length ? 'CRITICAL' : warnings.length ? 'WARNING' : 'INFO';
      return result(agentId, failures.length ? 'Failed' : warnings.length ? 'Warning' : 'Idle', failures.length ? `${failures.length} connected service failure${failures.length === 1 ? '' : 's'} detected.` : warnings.length ? `${warnings.length} service connection warning${warnings.length === 1 ? '' : 's'} detected.` : 'Connected services report healthy.', { severity, services: sources.map(({ id, status, lastSyncAt, lastError, detail }) => ({ id, status, lastSyncAt, lastError, detail })) }, failures.length ? 0.95 : 0.86, [...failures, ...warnings].map(item => ({ code: item.lastError || item.status, severity: failures.includes(item) ? 'CRITICAL' : 'WARNING', affected: item.id, recommendation: item.detail })));
    }
    case 'stock':
      return result(agentId, shopify.status === 'not_configured' ? 'Warning' : metrics.stockRisks ? 'Warning' : 'Idle', metrics.stockRisks ? `${metrics.stockRisks} active variant${metrics.stockRisks === 1 ? '' : 's'} need stock attention; ${metrics.outOfStock} are out of stock.` : 'No low-stock variants detected in available catalogue data.', { lowStock: metrics.stockRiskItems, outOfStock: metrics.outOfStock }, shopify.status === 'connected' ? 0.92 : 0.55, shopify.status === 'not_configured' ? [{ code: 'SHOPIFY_NOT_CONNECTED', severity: 'WARNING' }] : []);
    case 'pricing':
      return result(agentId, metrics.negativeMargin || metrics.lowMargin ? 'Warning' : 'Idle', metrics.missingCosts ? `${metrics.missingCosts} variants cannot be priced confidently until costs are completed.` : metrics.lowMargin ? `${metrics.lowMargin} variants are below their margin floor.` : 'Recorded product margins are above their configured floors.', { missingCosts: metrics.missingCostItems, belowFloor: metrics.lowMarginItems, lossMaking: metrics.negativeMarginItems }, metrics.costCoverage === 100 ? 0.94 : Math.max(0.35, metrics.costCoverage / 100), metrics.missingCosts ? [{ code: 'INCOMPLETE_COSTS', severity: 'WARNING' }] : []);
    case 'finance':
      return result(agentId, metrics.last30d.profitCoverage < 100 ? 'Warning' : 'Idle', `Last 30 days: ${money(metrics.last30d.revenue)} revenue; estimated operating contribution ${money(metrics.last30d.operatingProfit)} with ${metrics.last30d.profitCoverage}% profit coverage.`, { today: metrics.today, last7d: metrics.last7d, last30d: metrics.last30d, estimates: true }, metrics.last30d.profitCoverage / 100, metrics.last30d.profitCoverage < 100 ? [{ code: 'LOW_PROFIT_COVERAGE', severity: 'WARNING' }] : []);
    case 'shopify':
      return result(agentId, shopify.status === 'connected' ? 'Idle' : shopify.status === 'not_configured' ? 'Warning' : 'Failed', shopify.status === 'connected' ? `Shopify is connected; ${metrics.products} products and ${metrics.variants} variants are available to Runvara.` : `Shopify: ${shopify.detail || 'NOT CONNECTED'}`, { connection: shopify, catalogueIssues: metrics.seoIssueItems }, shopify.status === 'connected' ? 0.96 : 0.35, shopify.status === 'connected' ? [] : [{ code: shopify.lastError || 'SHOPIFY_NOT_CONNECTED', severity: 'HIGH' }]);
    case 'ebay':
      if (ebay.status === 'connected' && state.ebay?.source === 'ebay-oauth-readonly') return result(agentId, 'Warning', `${state.ebay.listings?.length || 0} Inventory API listings are available. Full marketplace comparison needs the existing Manager catalogue feed.`, { connection: ebay, coverage: state.ebay.coverage, health: null }, 0.6, [{ code: 'FULL_CATALOGUE_UNAVAILABLE', severity: 'WARNING' }]);
      return result(agentId, ebay.status === 'connected' ? 'Idle' : ebay.status === 'not_configured' ? 'Warning' : 'Failed', ebay.status === 'connected' ? `${state.ebay?.listings?.length || 0} eBay listings available through the existing read-only Manager connection.` : `eBay: ${ebay.detail || 'NOT CONNECTED'}`, { connection: ebay, health: state.ebay?.health || null }, ebay.status === 'connected' ? 0.94 : 0.35, ebay.status === 'connected' ? [] : [{ code: ebay.lastError || 'EBAY_NOT_CONNECTED', severity: 'HIGH' }]);
    case 'sales':
      return result(agentId, 'Idle', `${metrics.last30d.orders} orders produced ${money(metrics.last30d.revenue)} revenue in the last 30 days.`, { channels: metrics.channels, strongestProducts: metrics.productRows.slice().sort((a, b) => b.revenue30d - a.revenue30d).slice(0, 10) }, metrics.last30d.orders ? 0.88 : 0.5);
    case 'supplier':
      return result(agentId, metrics.supplierCount ? 'Idle' : 'Warning', metrics.supplierCount ? `${metrics.supplierCount} active supplier${metrics.supplierCount === 1 ? '' : 's'} recorded. Supplier orders remain approval-gated.` : 'No active supplier data is recorded.', { suppliers: state.suppliers || [], stockRisks: metrics.stockRiskItems }, metrics.supplierCount ? 0.75 : 0.3);
    case 'seo':
      return result(agentId, metrics.seoIssues ? 'Warning' : 'Idle', metrics.seoIssues ? `${metrics.seoIssues} actionable catalogue SEO issue${metrics.seoIssues === 1 ? '' : 's'} detected.` : 'No catalogue SEO hygiene issues detected.', { issues: metrics.seoIssueItems, externalSources: { searchConsole: 'NOT CONNECTED', ahrefs: 'NOT CONNECTED' } }, shopify.status === 'connected' ? 0.72 : 0.45);
    case 'marketing':
      return result(agentId, 'Idle', 'Campaign preparation is available; publishing and advertising spend require approval.', { brand: ['premium', 'gold', 'black', 'grey', 'clean', 'professional', 'vibrant'], spend30d: metrics.advertising.spend }, 0.7);
    case 'customer_service':
      return result(agentId, metrics.customerServiceIssues ? 'Warning' : 'Idle', metrics.customerServiceIssues ? `${metrics.customerServiceIssues} order${metrics.customerServiceIssues === 1 ? '' : 's'} may need customer follow-up.` : 'No customer-service order exceptions detected.', { cases: metrics.customerServiceItems }, metrics.orders30d ? 0.82 : 0.5);
    case 'product_scout':
      return result(agentId, 'Warning', 'Live product discovery sources are NOT CONNECTED. Existing catalogue data can be scored, but no external opportunity is being claimed.', { sources: { trends: 'NOT CONNECTED', competitors: 'NOT CONNECTED', suppliers: metrics.supplierCount ? 'PARTIAL' : 'NOT CONNECTED' } }, 0.25, [{ code: 'SCOUT_SOURCES_NOT_CONNECTED', severity: 'WARNING' }]);
    case 'operations':
      return result(agentId, metrics.openOrders ? 'Warning' : 'Idle', `${metrics.openOrders} open orders need operational review.`, { orders: metrics.customerServiceItems, exceptions: (state.exceptions || []).filter(item => ['open', 'acknowledged'].includes(item.status)).map(({ id, title, severity }) => ({ id, title, severity })) }, 0.8);
    case 'compliance':
      return result(agentId, metrics.pendingApprovals ? 'Warning' : 'Idle', `${metrics.pendingApprovals} approvals are pending. Spending and risky external actions require the workspace owner's decision.`, { approvalIds: (state.approvals || []).filter(item => item.status === 'pending').map(item => item.id), externalWritesEnabled: false }, 1);
    default:
      return result(agentId, 'Failed', 'This specialist is not implemented.', {}, 0, [{ code: 'AGENT_NOT_IMPLEMENTED', severity: 'HIGH' }]);
  }
}

export async function runCommander(state, command, options = {}) {
  ensureControl(state);
  const startedAt = nowIso(options.now);
  const agentIds = routeCommand(command);
  const settings = { ...defaultAgentSettings(), ...state.agentSettings };
  if (settings.commander?.enabled === false) throw Object.assign(new Error('Commander is disabled'), { status: 409, code: 'COMMANDER_DISABLED' });
  const metrics = deriveOperations(state, options);
  const specialistResults = await Promise.all(agentIds.map(async agentId => {
    if (settings[agentId]?.enabled === false) return { ...result(agentId, 'Warning', 'This specialist is disabled by workspace policy.', {}, 0), workStatus: 'BLOCKED' };
    try {
      const output = await (options.specialist || runSpecialist)(agentId, state, { ...options, metrics });
      return { ...output, autonomy: settings[agentId]?.autonomy ?? 1, workStatus: output.status === 'Failed' ? 'FAILED' : 'COMPLETED', evidence: [{ type: 'workspace_analysis', id: state.workspace.id, detail: `Analysis of recorded ${agentId} data; no external action executed.` }] };
    } catch (error) {
      return { ...result(agentId, 'Failed', 'Specialist analysis failed; review the recorded error code.', {}, 0, [{ code: 'SPECIALIST_FAILED', severity: 'HIGH' }]), workStatus: 'FAILED' };
    }
  }));
  const issues = specialistResults.flatMap(item => item.issues || []);
  const priorities = specialistResults.filter(item => item.status !== 'Idle' && item.autonomy > 0 && settings.commander.autonomy > 0).sort((a, b) => (b.confidence || 0) - (a.confidence || 0)).slice(0, 5).map(item => ({ agentId: item.agentId, action: item.finding }));
  const decisions = state.decisions.filter(item => item.status === 'active');
  const conflicts = metrics.stockRiskItems.filter(item => metrics.lowMarginItems.some(row => row.sku === item.sku)).map(item => ({ sku: item.sku, agents: ['stock', 'pricing'], reason: 'Replenishment is suggested while recorded margins are below target.', resolution: 'Resolve margin and demand assumptions before approving a supplier order.' }));
  let proposedType = null;
  if (/\b(place|buy|purchase|order)\b.*\b(stock|supplier|carton|pack|inventory)\b/i.test(command)) proposedType = 'supplier_order';
  if (/\b(issue|send|make|process)\b.*\brefund\b/i.test(command)) proposedType = 'refund';
  if (/\b(spend|pay|buy|purchase)\b/i.test(command)) proposedType ||= 'spend_money';
  if (/\b(change|raise|reduce|set|increase|decrease)\b.*\bprice/i.test(command)) proposedType = 'major_price_change';
  if (/\bpublish\b/i.test(command)) proposedType = 'customer_facing_publish';
  if (/\b(send|email|message)\b.*\b(customer|supplier|complaint)\b/i.test(command)) proposedType = 'sensitive_communication';
  if (/\bdelete\b/i.test(command)) proposedType = 'delete_data';
  if (proposedType && settings.commander.autonomy >= 2) {
    const approval = normalizeApprovalRequest({ type: proposedType, action: safeText(command, 180), reason: 'Commander prepared this request; confirm the exact scope and supporting evidence before approval.',
      financialImpact: null, expectedBenefit: 'Business impact requires owner review.', risk: 'External or financial action. Execution is disabled until a supported executor is connected and tested.',
      source: 'commander', agentId: 'commander', evidence: specialistResults.flatMap(item => item.evidence || []).slice(0, 20), payload: {} }, options.actor || 'commander');
    state.approvals.unshift(approval);
    options.approvalId = approval.id;
  }
  const workStatus = proposedType || conflicts.length ? 'REQUIRES APPROVAL' : specialistResults.some(item => item.workStatus === 'FAILED') ? 'FAILED' : specialistResults.every(item => item.workStatus === 'BLOCKED') ? 'BLOCKED' : 'COMPLETED';
  const run = {
    id: options.runId || `agent_run_${crypto.randomUUID()}`, command: safeText(command, 1000), routedAgents: agentIds,
    startedAt, completedAt: nowIso(), status: specialistResults.some(item => item.status === 'Failed') ? 'Warning' : 'Completed',
    summary: specialistResults.map(item => item.finding).filter(Boolean).join(' '), priorities,
    urgentRisks: issues.filter(item => ['HIGH', 'CRITICAL'].includes(item.severity)), results: specialistResults,
    workStatus, conflicts, decisionContext: decisions.map(({ id, title, content, revision }) => ({ id, title, content, revision })), approvalId: options.approvalId || null,
    executedExternally: false, resultKind: 'analysis', modelCalls: 0,
    evidence: specialistResults.flatMap(item => item.evidence || [])
  };
  return run;
}

export function agentTeamSnapshot(state) {
  const settings = { ...defaultAgentSettings(), ...(state.agentSettings || {}) };
  const latest = new Map();
  for (const run of state.agentRuns || []) for (const item of run.results || []) if (!latest.has(item.agentId)) latest.set(item.agentId, { ...item, runId: run.id });
  return AGENT_DEFINITIONS.map(agent => {
    const last = latest.get(agent.id);
    const setting = settings[agent.id] || { autonomy: agent.defaultAutonomy, enabled: true };
    if (agent.id === 'commander') {
      const run = state.agentRuns?.[0];
      return { ...agent, ...setting, status: run?.status === 'Warning' ? 'Warning' : 'Idle', lastRun: run?.completedAt || null, currentTask: null, lastFinding: run?.summary || 'Ready for a business command.', issuesDetected: run?.urgentRisks?.length || 0, confidence: run?.results?.length ? Math.round(run.results.reduce((sum, item) => sum + item.confidence, 0) / run.results.length * 100) : null };
    }
    return { ...agent, ...setting, status: last?.status || 'Idle', lastRun: last?.completedAt || null, currentTask: null, lastFinding: last?.finding || 'Not run yet.', issuesDetected: last?.issues?.length || 0, confidence: last ? Math.round(last.confidence * 100) : null };
  });
}

export function recordAgentRun(state, run, actor = 'system') {
  state.agentRuns = [run, ...(state.agentRuns || [])];
  recordWork(state, { id: run.id, title: run.command, source: 'commander', status: run.workStatus || 'COMPLETED', evidence: run.evidence || [{ type: 'agent_run', id: run.id }], approvalId: run.approvalId || null, executedExternally: false });
  const activities = [
    { id: `activity_${crypto.randomUUID()}`, agentId: 'commander', type: 'command_analysis', message: `Commander analysis: ${run.command}`, status: run.workStatus || run.status, createdAt: run.completedAt },
    ...run.results.map(item => ({ id: `activity_${crypto.randomUUID()}`, agentId: item.agentId, type: 'agent_finding', message: item.finding, status: item.status, confidence: item.confidence, createdAt: item.completedAt }))
  ];
  state.agentActivity = [...activities, ...(state.agentActivity || [])];
  return { run, actor };
}
