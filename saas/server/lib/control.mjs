import crypto from 'node:crypto';
import { connectionDue, CONNECTORS } from './connection-centre.mjs';
import { AUTOMATION_DEFINITIONS, deriveOperations, ebayComparisonAvailable, integrationMatrix, normalizeApprovalRequest } from './operations.mjs';
import { addAudit, recordWork } from './events.mjs';

const nowIso = () => new Date().toISOString();
const clean = (value, max = 1000) => String(value ?? '').trim().slice(0, max);
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'VALIDATION_FAILED' });
const identity = (kind, reference) => `${kind}_${crypto.createHash('sha256').update(String(reference)).digest('hex').slice(0, 24)}`;
const own = (value, key) => Object.hasOwn(value || {}, key);
const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
export const DECISION_CATEGORIES = Object.freeze(['supplier', 'pricing', 'margin_target', 'product_exclusion', 'approval', 'shipping', 'process', 'rejected_idea', 'goal']);

export function ensureControl(state) {
  for (const key of ['exceptions', 'opportunities', 'decisions', 'workRecords', 'automationRuns']) if (!Array.isArray(state[key])) state[key] = [];
  const defaults = Object.fromEntries(AUTOMATION_DEFINITIONS.map(rule => [rule.id, {
    permitted: true, risk: 'low', intervalMinutes: rule.id === 'dailyOpsBrief' ? 1440 : rule.id === 'channelSync' ? 30 : rule.id === 'marketingPlanner' ? 1440 : 15,
    maxRunsPerDay: rule.id === 'dailyOpsBrief' ? 3 : rule.id === 'channelSync' ? 48 : rule.id === 'marketingPlanner' ? 2 : 96, spendLimit: 0
  }]));
  const previous = state.autopilot || {};
  state.autopilot = { enabled: state.workspace?.id === 'packsmart-solutions', spendLimit: 0, morningHour: 7, timeZone: 'Europe/London', ...previous,
    rules: Object.fromEntries(Object.entries(defaults).map(([id, value]) => [id, { ...value, ...(previous.rules?.[id] || {}), risk: 'low', spendLimit: 0 }])) };
  state.autopilot.spendLimit = 0;
  if (!previous.policyVersion && !previous.updatedAt) state.autopilot.rules.dailyOpsBrief.maxRunsPerDay = 3;
  state.autopilot.policyVersion = 2;
  if (state.workspace?.id === 'packsmart-solutions' && !state.decisions.some(item => item.key === 'owner-approval-policy')) {
    state.decisions.push({ id: 'decision_owner_approval_policy', key: 'owner-approval-policy', category: 'approval', title: "Aj's approval policy",
      content: 'Aj must approve spending, supplier orders, refunds, major prices, publishing, sensitive communications, data deletion, integration changes and other materially risky actions.',
      source: 'Packsmart customer-zero operating instructions', target: '', value: null, status: 'active', revision: 1,
      createdAt: state.workspace.createdAt || nowIso(), createdBy: 'system', supersedes: null });
  }
  return state;
}

export function configureAutopilot(state, body, actor) {
  ensureControl(state);
  if (own(body, 'enabled') && typeof body.enabled !== 'boolean') throw invalid('Enabled must be a boolean');
  if (own(body, 'spendLimit') && body.spendLimit !== 0) throw invalid('Autopilot has no spending permission');
  if (body.rules && (typeof body.rules !== 'object' || Array.isArray(body.rules))) throw invalid('Rules must be an object');
  for (const [id, changes] of Object.entries(body.rules || {})) {
    if (!own(state.autopilot.rules, id) || !changes || typeof changes !== 'object' || Array.isArray(changes)) throw invalid('Unknown Autopilot rule');
    if (own(changes, 'permitted') && typeof changes.permitted !== 'boolean') throw invalid('Permission must be a boolean');
    if (own(changes, 'risk') && changes.risk !== 'low') throw invalid('Only low-risk monitoring is executable');
    if (own(changes, 'spendLimit') && changes.spendLimit !== 0) throw invalid('Autopilot cannot spend money');
    for (const field of ['intervalMinutes', 'maxRunsPerDay']) {
      if (own(changes, field) && (!Number.isInteger(changes[field]) || changes[field] < (field === 'intervalMinutes' ? 15 : 1) || changes[field] > (field === 'intervalMinutes' ? 10080 : 96))) throw invalid(`Invalid ${field}`);
    }
    state.autopilot.rules[id] = { ...state.autopilot.rules[id], ...Object.fromEntries(['permitted', 'intervalMinutes', 'maxRunsPerDay'].filter(key => own(changes, key)).map(key => [key, changes[key]])) };
  }
  if (own(body, 'enabled')) state.autopilot.enabled = body.enabled;
  state.autopilot.updatedAt = nowIso();
  addAudit(state, { type: 'autopilot_configured', actor, detail: { enabled: state.autopilot.enabled, rules: body.rules || {}, spendLimit: 0 } });
  return state.autopilot;
}

export function putDecision(state, body, actor, id = null) {
  ensureControl(state);
  const previous = id ? state.decisions.find(item => item.id === id && item.status === 'active') : null;
  if (id && !previous) throw Object.assign(new Error('Active decision not found'), { status: 404, code: 'DECISION_NOT_FOUND' });
  if (previous && body.revision !== previous.revision) throw Object.assign(new Error('Decision changed; reload before editing'), { status: 409, code: 'DECISION_CONFLICT' });
  const key = previous?.key || clean(body.key, 100);
  const category = clean(body.category || previous?.category, 40);
  const title = clean(body.title, 160), content = clean(body.content, 2000), source = clean(body.source, 500);
  if (!/^[a-z0-9][a-z0-9_-]{1,99}$/.test(key) || !DECISION_CATEGORIES.includes(category) || !title || !content || !source) throw invalid('Decision key, category, title, content and source are required');
  if (!previous && state.decisions.some(item => item.key === key && item.status === 'active')) throw Object.assign(new Error('Edit the existing decision to retain its history'), { status: 409, code: 'DECISION_EXISTS' });
  const value = body.value === '' || body.value === null || body.value === undefined ? null : Number(body.value);
  if (value !== null && !Number.isFinite(value)) throw invalid('Decision value must be numeric');
  if (category === 'margin_target' && (value === null || value < 0 || value >= 100)) throw invalid('Margin target must be between 0 and less than 100');
  if (category === 'approval' && key === 'owner-approval-policy') throw invalid("Aj's mandatory approval policy cannot be weakened");
  const target = clean(body.target, 160);
  if (['product_exclusion', 'rejected_idea'].includes(category) && !target) throw invalid('A SKU or opportunity ID is required');
  const decision = { id: `decision_${crypto.randomUUID()}`, key, category, title, content, source, target, value,
    status: 'active', revision: (previous?.revision || 0) + 1, createdAt: nowIso(), createdBy: actor, supersedes: previous?.id || null };
  if (previous) { previous.status = 'superseded'; previous.supersededAt = decision.createdAt; }
  state.decisions.unshift(decision);
  if (category === 'margin_target') state.settings = { ...state.settings, marginFloor: value };
  addAudit(state, { type: previous ? 'decision_superseded' : 'decision_recorded', actor, detail: { decisionId: decision.id, previousId: previous?.id || null, key, revision: decision.revision } });
  return decision;
}

function reconcile(state, collection, candidates, actor) {
  const existing = new Map(state[collection].map(item => [item.fingerprint, item]));
  const detected = new Set();
  const now = nowIso();
  let created = 0;
  for (const candidate of candidates) {
    const fingerprint = identity(candidate.kind, candidate.reference);
    detected.add(fingerprint);
    const previous = existing.get(fingerprint);
    if (previous) {
      const wasPresent = previous.present !== false;
      Object.assign(previous, candidate, { lastSeenAt: now, present: true });
      // Dismissal persists while the same condition remains. A new occurrence
      // after the condition clears reopens it, preserving the previous decision.
      if (!wasPresent && ['resolved', 'dismissed'].includes(previous.status)) {
        previous.status = 'open';
        previous.history.push({ status: 'open', actor, at: now, note: 'Condition recurred' });
        addAudit(state, { type: `${collection}_reopened`, actor, detail: { id: previous.id } });
      }
    } else {
      const record = { ...candidate, id: `${collection}_${crypto.randomUUID()}`, fingerprint, status: 'open', present: true,
        createdAt: now, lastSeenAt: now, history: [{ status: 'open', actor, at: now, note: 'Detected from recorded evidence' }] };
      state[collection].unshift(record); created++;
      addAudit(state, { type: `${collection}_detected`, actor, detail: { id: record.id, kind: candidate.kind, reference: candidate.reference } });
    }
  }
  for (const item of state[collection]) if (!detected.has(item.fingerprint)) item.present = false;
  return { detected: candidates.length, created };
}

export function detectExceptions(state, actor = 'system', options = {}) {
  ensureControl(state);
  const d = deriveOperations(state, options), candidates = [];
  const skuCounts = new Map();
  for (const product of state.products || []) for (const variant of product.variants || []) if (variant.sku) skuCounts.set(variant.sku, (skuCounts.get(variant.sku) || 0) + 1);
  for (const [sku, count] of skuCounts) if (count > 1) candidates.push({ kind: 'duplicate_sku', reference: sku, severity: 'medium', title: `Shared SKU needs review: ${sku}`, businessImpact: 'Several source variants share one cost profile; verify that this is intentional.', rootCause: `${count} variants use the same SKU.`, recommendedAction: 'Confirm variant identities and cost assumptions before pricing or stock changes.', owner: 'stock', evidence: [{ type: 'catalogue_identity', id: sku, detail: `${count} source variants; reporting identities remain separate.` }] });
  for (const channel of integrationMatrix(state)) {
    if (!['error', 'failed', 'degraded', 'auth_expired'].includes(channel.status) && !channel.lastError) continue;
    candidates.push({ kind: 'integration', reference: channel.id, severity: channel.status === 'auth_expired' || ['error', 'failed'].includes(channel.status) ? 'high' : 'medium',
      title: `${channel.name} needs attention`, businessImpact: 'Business reporting or monitoring may use incomplete or stale source data.',
      rootCause: channel.lastError || channel.detail, recommendedAction: channel.recommendedRepair || 'Review this connection and its data coverage.',
      owner: 'health_watch', evidence: [{ type: 'integration_status', id: channel.id, detail: channel.detail, at: channel.lastSyncAt }] });
  }
  for (const item of d.stockRiskItems) candidates.push({ kind: 'stock', reference: item.sku, severity: item.available === false || item.inventory === 0 ? 'high' : 'medium',
    title: `Stock attention: ${item.sku}`, businessImpact: 'Orders may be delayed if stock is unavailable.', rootCause: item.inventory === null ? 'Source reports unavailable; exact inventory is unknown.' : `Recorded quantity: ${item.inventory}`,
    recommendedAction: 'Verify stock and prepare replenishment for owner approval.', owner: 'stock', evidence: [{ type: 'variant', id: item.externalId || item.id, detail: item.productTitle }] });
  for (const item of [...d.negativeMarginItems, ...d.lowMarginItems.filter(item => item.contribution >= 0)]) candidates.push({ kind: 'margin', reference: item.sku, severity: item.contribution < 0 ? 'high' : 'medium',
    title: `Margin attention: ${item.sku}`, businessImpact: 'Current recorded costs leave less contribution than the configured target.', rootCause: `${item.margin}% margin; target ${item.marginFloor}%.`,
    recommendedAction: 'Review source costs and prepare a price proposal for approval.', owner: 'pricing', evidence: [{ type: 'economics', id: item.sku, detail: `Price ${item.price}; variable cost ${item.totalVariableCost}.` }] });
  for (const item of d.customerServiceItems) candidates.push({ kind: 'order', reference: item.id, severity: 'medium', title: `Review order ${item.name || item.id}`,
    businessImpact: 'Payment or fulfilment may need follow-up.', rootCause: `${item.financialStatus}; ${item.fulfillmentStatus}.`, recommendedAction: 'Review the order before contacting the customer or issuing a refund.',
    owner: 'customer_service', evidence: [{ type: 'order', id: item.id, detail: item.provider }] });
  if (d.missingCostItems.length) candidates.push({ kind: 'cost_coverage', reference: 'catalogue', severity: 'medium', title: 'Product costs need confirmation', businessImpact: 'Profit is withheld for incompletely costed products.', rootCause: `${d.missingCostItems.length} variants have missing cost inputs.`, recommendedAction: 'Record verified supplier, shipping and selling costs.', owner: 'finance', evidence: d.missingCostItems.slice(0, 20).map(item => ({ type: 'economics', id: item.sku, detail: item.missingFields.join(', ') })) });
  const mismatches = state.ebay?.health;
  if (state.ebay?.source === 'ebay-oauth-readonly') candidates.push({ kind: 'source_coverage', reference: 'ebay_catalogue', severity: 'medium', title: 'Full eBay catalogue is not connected', businessImpact: 'A complete marketplace comparison cannot be verified.', rootCause: 'The current feed covers Inventory API items; listings managed outside that API are not included.', recommendedAction: 'Connect the existing Manager full catalogue read feed before comparing marketplaces.', owner: 'ebay', evidence: [{ type: 'source_coverage', id: 'ebay', detail: 'Inventory API scope only; orders and marketing can still be read.' }] });
  if (ebayComparisonAvailable(state.ebay)) {
    const count = ['missingOnEbay', 'staleOnEbay', 'priceMismatches', 'stockMismatches'].reduce((sum, key) => sum + (mismatches[key]?.length || 0), 0);
    if (count) candidates.push({ kind: 'inventory_mismatch', reference: 'ebay', severity: 'medium', title: 'Marketplace catalogue mismatch', businessImpact: 'Recorded channel listings differ.', rootCause: `${count} comparisons need review.`, recommendedAction: 'Verify marketplace coverage before proposing listing changes.', owner: 'ebay', evidence: [{ type: 'channel_comparison', id: 'ebay', detail: `${count} differences` }] });
  }
  const failures = new Map();
  for (const run of state.automationRuns) if (!failures.has(run.ruleId)) failures.set(run.ruleId, run);
  for (const run of failures.values()) if (['FAILED', 'BLOCKED'].includes(run.status)) candidates.push({ kind: 'automation', reference: run.ruleId, severity: 'high', title: `Automation needs attention: ${run.ruleId}`,
    businessImpact: 'Scheduled monitoring did not finish.', rootCause: run.errorCode || run.status, recommendedAction: 'Review its evidence and repair the source before retrying.', owner: 'operations', evidence: [{ type: 'automation_run', id: run.id, detail: run.status }] });
  return reconcile(state, 'exceptions', candidates, actor);
}

export function detectOpportunities(state, actor = 'system', options = {}) {
  ensureControl(state);
  const d = deriveOperations(state, options), candidates = [];
  const exclusions = new Set(state.decisions.filter(item => item.status === 'active' && item.category === 'product_exclusion').map(item => item.target));
  const rejected = new Set(state.decisions.filter(item => item.status === 'active' && item.category === 'rejected_idea').map(item => item.target));
  for (const item of d.lowMarginItems) {
    if (exclusions.has(item.sku) || !item.complete || item.marginFloor >= 100 || item.price === null) continue;
    const targetPrice = Math.ceil(item.totalVariableCost / (1 - item.marginFloor / 100) * 100) / 100;
    candidates.push({ kind: 'pricing', reference: item.sku, title: `Review the selling price of ${item.sku}`, evidence: [{ type: 'economics', id: item.sku, detail: `Recorded cost ${item.totalVariableCost}; price ${item.price}; margin target ${item.marginFloor}%.` }],
      estimatedImpact: { basis: 'ESTIMATED VALUE', amount: Math.round((targetPrice - item.price) * 100) / 100, unit: 'GBP per unit at unchanged costs', assumptions: 'Demand and sales volume are unknown. This is not earned revenue.' },
      effort: 'low', risk: 'high', confidence: 0.85, requiredAction: 'major_price_change', recommendedNextStep: `Review a price of £${targetPrice.toFixed(2)} and request approval before publishing.`, owner: 'pricing' });
  }
  for (const item of d.stockRiskItems) if (!exclusions.has(item.sku)) candidates.push({ kind: 'reorder', reference: item.sku, title: `Prepare a replenishment review for ${item.sku}`,
    evidence: [{ type: 'variant', id: item.externalId || item.id, detail: item.inventory === null ? 'Reported unavailable; quantity unknown' : `Recorded stock ${item.inventory}` }], estimatedImpact: null,
    effort: 'medium', risk: 'high', confidence: item.inventory === null ? 0.55 : 0.85, requiredAction: 'supplier_order', recommendedNextStep: 'Confirm demand, supplier availability and a quote; submit the order for approval.', owner: 'stock' });
  for (const item of d.seoIssueItems) candidates.push({ kind: 'seo', reference: `${item.productId}:${item.issue}`, title: `Improve catalogue content: ${item.product}`,
    evidence: [{ type: 'product', id: item.productId, detail: item.issue }], estimatedImpact: null, effort: 'low', risk: 'medium', confidence: 0.8,
    requiredAction: 'customer_facing_publish', recommendedNextStep: 'Prepare revised content and obtain approval before publishing.', owner: 'seo' });
  const known = new Map(state.opportunities.map(item => [item.fingerprint, item.id]));
  return reconcile(state, 'opportunities', candidates.filter(item => !rejected.has(known.get(identity(item.kind, item.reference))) && !rejected.has(identity(item.kind, item.reference))), actor);
}

export function setExceptionStatus(state, id, body, actor) {
  const item = state.exceptions.find(record => record.id === id);
  if (!item) throw Object.assign(new Error('Exception not found'), { status: 404, code: 'EXCEPTION_NOT_FOUND' });
  if (!['open', 'acknowledged', 'resolved', 'dismissed'].includes(body.status) || !clean(body.note, 1000)) throw invalid('A valid status and resolution note are required');
  item.status = body.status; item.owner = clean(body.owner || item.owner, 160); item.updatedAt = nowIso();
  item.history.push({ status: item.status, actor, at: item.updatedAt, note: clean(body.note, 1000) });
  addAudit(state, { type: 'exception_status_changed', actor, detail: { exceptionId: id, status: item.status, note: clean(body.note, 1000) } });
  return item;
}

export function requestOpportunityApproval(state, id, actor) {
  const item = state.opportunities.find(record => record.id === id);
  if (!item) throw Object.assign(new Error('Opportunity not found'), { status: 404, code: 'OPPORTUNITY_NOT_FOUND' });
  const existing = state.approvals.find(record => record.payload?.opportunityId === id && record.status === 'pending');
  if (existing) return existing;
  const approval = normalizeApprovalRequest({ type: item.requiredAction, action: item.title, reason: item.recommendedNextStep, financialImpact: null,
    expectedBenefit: item.estimatedImpact ? `${item.estimatedImpact.amount} ${item.estimatedImpact.unit}; ${item.estimatedImpact.assumptions}` : 'Impact unquantified until source data is confirmed.',
    risk: item.risk, evidence: item.evidence, agentId: item.owner, source: 'opportunity-engine', payload: { opportunityId: id } }, actor);
  state.approvals.unshift(approval); item.status = 'requires_approval'; item.approvalId = approval.id;
  addAudit(state, { type: 'opportunity_approval_requested', actor, detail: { opportunityId: id, approvalId: approval.id } });
  return approval;
}

export function modifyApproval(state, id, body, actor) {
  const item = state.approvals.find(record => record.id === id);
  if (!item) throw Object.assign(new Error('Approval not found'), { status: 404, code: 'APPROVAL_NOT_FOUND' });
  if (item.status !== 'pending' || body.revision !== (item.revision || 1)) throw Object.assign(new Error('Approval is decided or changed; refresh before editing'), { status: 409, code: 'APPROVAL_CONFLICT' });
  const next = normalizeApprovalRequest({ ...item, ...body, type: item.type, source: item.source, payload: item.payload }, item.requestedBy);
  const history = [...(item.history || []), { revision: item.revision || 1, action: item.action, reason: item.reason, financialImpact: item.financialImpact,
    expectedBenefit: item.expectedBenefit, risk: item.risk, evidence: item.evidence || [], actor, at: nowIso() }];
  Object.assign(item, next, { id, createdAt: item.createdAt, revision: (item.revision || 1) + 1, history });
  addAudit(state, { type: 'approval_modified', actor, detail: { approvalId: id, revision: item.revision } });
  return item;
}

export function dueRules(state, now = new Date()) {
  ensureControl(state);
  if (!state.autopilot.enabled) return [];
  return AUTOMATION_DEFINITIONS.filter(rule => {
    const policy = state.autopilot.rules[rule.id];
    if (!state.automations?.[rule.id] || !policy.permitted) return false;
    const runs = state.automationRuns.filter(item => item.ruleId === rule.id);
    if (runs.some(item => item.status === 'IN PROGRESS' && Date.parse(item.leaseUntil) > now.getTime())) return false;
    if (rule.id === 'dailyOpsBrief') {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: state.autopilot.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(item => [item.type, item.value]));
      const localDay = `${parts.year}-${parts.month}-${parts.day}`;
      const todayRuns = runs.filter(run => new Intl.DateTimeFormat('en-CA', { timeZone: state.autopilot.timeZone }).format(new Date(run.startedAt)) === localDay);
      return Number(parts.hour) >= state.autopilot.morningHour && !todayRuns.some(run => run.status === 'COMPLETED') && todayRuns.length < policy.maxRunsPerDay && (!todayRuns[0] || now.getTime() - Date.parse(todayRuns[0].startedAt) >= 15 * 60000);
    }
    if (runs.filter(item => item.startedAt.slice(0, 10) === now.toISOString().slice(0, 10)).length >= policy.maxRunsPerDay) return false;
    const last = runs[0];
    if (rule.id === 'channelSync' && state.connectionSettings && Object.keys(state.connectionSettings).length) {
      return Object.keys(CONNECTORS).some(provider => connectionDue(state, provider, now) && (state.connections?.some(item => item.provider === provider || (provider === 'ebay' && item.provider === 'ebay_oauth')) || state.integrationStatus?.[provider]?.lastSyncAt));
    }
    return !last || now.getTime() - Date.parse(last.startedAt) >= policy.intervalMinutes * 60000;
  });
}

export function claimAutomation(state, ruleId, now = new Date()) {
  const rule = dueRules(state, now).find(item => item.id === ruleId);
  if (!rule) return null;
  const run = { id: `automation_${crypto.randomUUID()}`, ruleId, status: 'IN PROGRESS', startedAt: now.toISOString(),
    leaseUntil: new Date(now.getTime() + 10 * 60000).toISOString(), risk: 'low', spend: 0, evidence: [] };
  state.automationRuns.unshift(run);
  recordWork(state, { id: run.id, title: rule.name, source: 'autopilot', status: 'IN PROGRESS', evidence: [] });
  addAudit(state, { type: 'automation_started', actor: 'autopilot', detail: { runId: run.id, ruleId } });
  return run;
}

export function finishAutomation(state, run, { evidence = [], errorCode = null, blocked = false } = {}) {
  run.status = errorCode ? (blocked ? 'BLOCKED' : 'FAILED') : 'COMPLETED';
  run.completedAt = nowIso(); run.errorCode = errorCode; run.evidence = evidence;
  recordWork(state, { id: run.id, title: run.ruleId, source: 'autopilot', status: run.status, evidence, errorCode });
  addAudit(state, { type: 'automation_finished', actor: 'autopilot', detail: { runId: run.id, ruleId: run.ruleId, status: run.status, evidence } });
  return run;
}

export function valueSummary(state) {
  const runs = state.automationRuns || [];
  const finished = runs.filter(item => ['COMPLETED', 'FAILED', 'BLOCKED'].includes(item.status));
  const succeeded = finished.filter(item => item.status === 'COMPLETED' && item.evidence?.length);
  return { actual: { tasksAutomated: succeeded.length, issuesDetected: (state.exceptions || []).length, opportunitiesGenerated: (state.opportunities || []).length,
    automationSuccessRate: finished.length ? Math.round(succeeded.length / finished.length * 100) : null,
    moneySaved: null, revenueCreated: null, hoursSaved: null, customerResponsesHandled: 0 },
    estimated: { opportunities: (state.opportunities || []).filter(item => item.present && item.estimatedImpact).map(item => ({ id: item.id, title: item.title, ...item.estimatedImpact })) },
    explanation: 'Actual counts come from durable records. Financial savings and time savings remain unknown until verified. Opportunity estimates are per unit and are never added to realised value.' };
}

export function controlSnapshot(state) {
  ensureControl(state);
  return { autopilot: state.autopilot, exceptions: [...state.exceptions].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]),
    opportunities: state.opportunities, decisions: state.decisions, workRecords: state.workRecords.slice(0, 100), automationRuns: state.automationRuns.slice(0, 100), value: valueSummary(state), decisionCategories: DECISION_CATEGORIES };
}
