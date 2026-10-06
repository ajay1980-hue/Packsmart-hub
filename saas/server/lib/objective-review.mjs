import { createHash } from 'node:crypto';
import { defaultAgentSettings } from './agents.mjs';
import { evidenceInWorkspace, tenantBusinessEvidence } from './business-evidence-scope.mjs';
import { businessObjectivesSnapshot, evaluateObjectivePlan } from './business-objectives.mjs';
import { projectCanonicalOpportunities } from './business-state.mjs';
import { derivePortfolioAllocation } from './portfolio-engine.mjs';
import { deriveExecutionPlan } from './execution-plan.mjs';
import { requiresApproval } from './security.mjs';

// Pure, deterministic diagnostic work. This module deliberately has no queue,
// store, provider, model, approval-creation, timer or external execution adapter.
export const OBJECTIVE_REVIEW_LIMITS = Object.freeze({ specialists: 3, sourceRecordsPerCollection: 1000, canonicalOpportunities: 100, proposals: 10, serializedBytes: 65536 });
const ROUTES = Object.freeze({
  revenue: ['sales', 'finance', 'pricing'], orders: ['sales', 'stock', 'finance'],
  gross_profit: ['finance', 'pricing', 'stock'], contribution_profit: ['finance', 'pricing', 'stock'],
  gross_margin_percent: ['pricing', 'finance', 'stock'], monthly_ad_spend: ['marketing', 'finance', 'stock'],
  stock_cover_days: ['stock', 'finance', 'pricing']
});
const TYPES = Object.freeze({ finance: 'economics_review', pricing: 'margin_review', stock: 'stock_constraint_review', marketing: 'advertising_budget_review', sales: 'revenue_review' });
const KINDS = new Set(['pricing', 'margin', 'reorder', 'inventory', 'stock', 'seo', 'marketing', 'advertising', 'retention', 'conversion', 'sales', 'finance', 'operations', 'data-quality']);
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/;
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const numeric = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
const nonnegative = value => numeric(value) !== null && value >= 0 ? value : null;
const hash = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
// Typed source collections are sets/multisets: preserve duplicate restrictions,
// but do not create another job merely because their storage order changed.
function canonicalFingerprintValue(value) {
  if (Array.isArray(value)) return value.map(canonicalFingerprintValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalFingerprintValue(value[key])]));
  return value;
}
function canonicalTypedCollection(rows) {
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  return rows.map(row => ({ row: canonicalFingerprintValue(row), id: typeof row.id === 'string' ? row.id : '' }))
    .map(item => ({ ...item, key: JSON.stringify(item.row) }))
    .sort((a, b) => compare(a.id, b.id) || compare(a.key, b.key)).map(item => item.row);
}
const error = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const issue = (code, field, message) => ({ code, field, message });
const array = value => Array.isArray(value) ? value : [];
const reference = value => typeof value === 'string' && REF.test(value) ? value : null;
const cleanTitle = value => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
const safeCurrency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) && Intl.supportedValuesOf('currency').includes(value) ? value : null;

function exactObject(value, fields, name) {
  if (!record(value) || Object.keys(value).some(key => !fields.includes(key))) throw error(`Invalid ${name}`, 'VALIDATION_FAILED');
}
function assertScope(value, workspaceId) {
  if (!evidenceInWorkspace(value, workspaceId)) throw error('Workspace identity mismatch', 'WORKSPACE_MISMATCH', 403);
}
function policy(state, id) {
  const defaults = defaultAgentSettings()[id];
  const input = state.agentSettings?.[id];
  if (input === undefined) return defaults;
  if (!record(input) || !evidenceInWorkspace(input, state.workspace.id)) return { enabled: false, autonomy: 0, invalid: true };
  const enabled = own(input, 'enabled') ? input.enabled : defaults.enabled;
  const autonomy = own(input, 'autonomy') ? input.autonomy : defaults.autonomy;
  if (typeof enabled !== 'boolean' || !Number.isInteger(autonomy) || autonomy < 0 || autonomy > 3) return { enabled: false, autonomy: 0, invalid: true };
  return { enabled, autonomy };
}
function sourceRef(workspaceId, collection, id, fields = []) {
  return { collection, recordId: id, identityHash: hash([workspaceId, collection, id]), fields };
}
function boundedReport(report) {
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') > OBJECTIVE_REVIEW_LIMITS.serializedBytes) throw error('Objective review exceeds its serialized result limit', 'OBJECTIVE_REVIEW_RESULT_TOO_LARGE', 413);
  return report;
}
function safeguards() {
  return { externalExecutionAllowed: false, externalWrites: false, providerCalls: 0, modelCalls: 0, spendCommitted: false,
    approvalsCreated: false, policiesChanged: false, objectiveLimitsPreserved: true, historicalResultsAreNotForecasts: true,
    unknownEvidenceDoesNotBecomeZero: true, reportCompletionIsNotCommercialReadiness: true,
    callerMustAuthorizeAndRevalidateQueueWork: true };
}


function boundedFields(row, fields) {
  return Object.fromEntries(fields.filter(key => own(row, key)).map(key => {
    const value = row[key];
    return [key, typeof value === 'string' ? (value.length <= 2048 ? value : null) : typeof value === 'number' ? numeric(value) : typeof value === 'boolean' ? value : null];
  }));
}
function narrowSources(rows, workspaceId, type) {
  const local = rows.filter(row => record(row) && evidenceInWorkspace(row, workspaceId));
  if (type === 'opportunities') return local.map(row => {
    const result = boundedFields(row, ['id', 'kind', 'present', 'status', 'reference', 'sku', 'fingerprint', 'experimentId', 'requiredAction', 'actionType', 'executionCost', 'effortHours', 'approvalRequired', 'confidence', 'risk', 'effort', 'probability']);
    // A malformed duplicate remains a restrictive identity marker. Dropping it
    // before canonical deduplication could revive a weaker duplicate record.
    if (['id', 'reference', 'sku', 'fingerprint', 'experimentId', 'kind', 'status', 'requiredAction', 'actionType'].some(key => own(row, key) && row[key] !== null && (typeof row[key] !== 'string' || row[key].length > 2048))) return { id: typeof row.id === 'string' ? row.id : null, fingerprint: typeof row.fingerprint === 'string' && row.fingerprint.length <= 2048 ? row.fingerprint : undefined, present: false };
    return { ...result, title: 'Recorded opportunity', evidence: [], needsEvidence: [] };
  });
  if (type === 'decisions') return local.map(row => boundedFields(row, ['status', 'category', 'target']));
  if (type === 'approvals') return local.map(row => row.payload == null || (record(row.payload) && evidenceInWorkspace(row.payload, workspaceId))
    ? { ...boundedFields(row, ['id', 'status']), ...(record(row.payload) ? { payload: boundedFields(row.payload, ['opportunityId']) } : {}) }
    : { ...boundedFields(row, ['id']), status: 'invalid' });
  if (type === 'exceptions') return local.map(row => boundedFields(row, ['id', 'status', 'present']));
  return local.map(row => {
    const valid = ['impact', 'result', 'outcome'].every(key => row[key] == null || (record(row[key]) && evidenceInWorkspace(row[key], workspaceId)));
    const result = boundedFields(row, ['id', 'opportunityId', 'status', 'completedAt']);
    // Keep the identity marker until canonical ambiguity checks have run. A
    // foreign nested payload must not make its apparently valid duplicate win.
    return valid ? { ...result, ...(record(row.impact) ? { impact: boundedFields(row.impact, ['verified', 'verifiedAt', 'incrementalContribution', 'contributionProtected', 'costAvoided']) } : {}) }
      : { ...result, status: 'invalid', impact: { verified: false } };
  });
}

// If a relevant collection exceeds its bound, do not slice and accidentally
// miss a later dismissal, duplicate identity or more restrictive approval.
function evidenceView(state, workspaceId) {
  const problems = [], counts = {};
  const definitions = [
    ['opportunities', state.opportunities], ['decisions', state.decisions], ['approvals', state.approvals],
    ['exceptions', state.exceptions], ['experiments', state.revenueEngine?.experiments]
  ];
  let bounded = true;
  for (const [name, value] of definitions) {
    counts[name] = Array.isArray(value) ? value.length : 0;
    if (value !== undefined && !Array.isArray(value)) {
      bounded = false; problems.push(issue('SOURCE_COLLECTION_INVALID', name, 'The recorded collection is not a valid array'));
    } else if (counts[name] > OBJECTIVE_REVIEW_LIMITS.sourceRecordsPerCollection) {
      bounded = false; problems.push(issue('SOURCE_SCAN_LIMIT', name, 'The source exceeds this review’s scan bound; no prefix is treated as complete evidence'));
    }
  }
  if (!Array.isArray(state.opportunities)) problems.push(issue('CANONICAL_OPPORTUNITIES_UNAVAILABLE', 'opportunities', 'The authoritative opportunity collection is unavailable; aggregate fallbacks are not used'));
  if (state.revenueEngine !== undefined && !evidenceInWorkspace(state.revenueEngine, workspaceId)) {
    problems.push(issue('SOURCE_SCOPE_EXCLUDED', 'revenueEngine', 'Foreign or malformed experiment scope was excluded'));
  }
  const settings = record(state.settings) && evidenceInWorkspace(state.settings, workspaceId) ? state.settings : {};
  const local = {
    workspace: { id: workspaceId },
    settings: { growthCapacityHours: nonnegative(settings.growthCapacityHours), maxConcurrentGrowthExperiments: Number.isInteger(settings.maxConcurrentGrowthExperiments) && settings.maxConcurrentGrowthExperiments > 0 ? settings.maxConcurrentGrowthExperiments : null },
    opportunities: bounded ? narrowSources(array(state.opportunities), workspaceId, 'opportunities') : [], decisions: bounded ? narrowSources(array(state.decisions), workspaceId, 'decisions') : [],
    approvals: bounded ? narrowSources(array(state.approvals), workspaceId, 'approvals') : [], exceptions: bounded ? narrowSources(array(state.exceptions), workspaceId, 'exceptions') : [],
    revenueEngine: { experiments: bounded && evidenceInWorkspace(state.revenueEngine || {}, workspaceId) ? narrowSources(array(state.revenueEngine?.experiments), workspaceId, 'experiments') : [] }
  };
  // Canonicalize before both allocation and hashing. Sorting only the hash would
  // hide order-dependent selections/cumulative blockers behind one reuse key.
  // Sorting is not deduplication: conflicting identities remain restrictive.
  for (const key of ['opportunities', 'decisions', 'approvals', 'exceptions']) local[key] = canonicalTypedCollection(local[key]);
  local.revenueEngine.experiments = canonicalTypedCollection(local.revenueEngine.experiments);
  return { state: tenantBusinessEvidence(local), bounded, problems, counts, workspaceCurrency: safeCurrency(settings.currency) };
}
function safeOpportunity(row) {
  const id = reference(row.id);
  if (!id) return null;
  // Deliberately omit arbitrary titles, descriptions, payloads, evidence text,
  // SKU/customer references and free-form next steps. Navigation keeps the
  // original safe record ID; findings below are generated from typed facts.
  const kind = KINDS.has(row.kind) ? row.kind : 'operations';
  const actionKind = String(row.requiredAction || row.actionType || '').trim().toLowerCase();
  return { id, kind, title: `Review recorded ${kind.replaceAll('-', ' ')} opportunity`,
    executionCost: nonnegative(row.executionCost), effortHours: nonnegative(row.effortHours),
    historicalContribution: numeric(row.verifiedContributionValue), historicalEvidenceVerified: row.evidenceVerified === true,
    evidenceDecision: ['deprioritise', 'needs-more-evidence', 'ready-for-owner-review'].includes(row.evidenceDecision) ? row.evidenceDecision : null,
    experimentId: reference(row.experimentId), approvalRequired: row.approvalRequired === true,
    // Unknown action types remain approval-required through the canonical flag;
    // they are never relabelled as permission to perform internal analysis.
    actionKind: requiresApproval(actionKind) ? actionKind : 'internal_analysis',
    actionClassificationKnown: row.actionType === 'safe' || requiresApproval(actionKind) };
}
function metricEvidence(objective, workspaceCurrency) {
  return {
    name: objective.metric, baseline: objective.baseline, target: objective.target, direction: objective.direction,
    window: { startsAt: objective.startsAt, endsAt: objective.endsAt }, value: null,
    observedAt: null, sourcePeriod: null, coverage: 'unknown',
    currency: { objective: objective.limits.currency, workspace: workspaceCurrency, measured: null },
    blockers: [issue('OBJECTIVE_PERIOD_UNRESOLVED', 'metric', 'Retained rolling summaries do not establish a complete measurement for the objective window'),
      ...(objective.metric === 'gross_margin_percent' ? [issue('GROSS_MARGIN_UNRESOLVED', 'grossMarginPercent', 'Contribution margin is not gross margin')] : []),
      ...(objective.metric === 'stock_cover_days' ? [issue('STOCK_COVER_UNRESOLVED', 'stockCoverDays', 'Inventory quantity alone does not establish demand-based stock cover')] : []),
      ...(objective.metric === 'monthly_ad_spend' ? [issue('AD_MONTH_UNRESOLVED', 'monthToDateAdSpend', 'Rolling-30-day or empty advertising records do not establish calendar-month spend')] : []),
      ...(objective.limits.currency !== null ? [issue('METRIC_CURRENCY_UNRESOLVED', 'currency', 'Workspace currency does not establish the currency of measured source values')] : [])]
  };
}
function proposalAssessment(objectiveState, objective, opportunity, portfolio, planningBlockers, now, workspaceId) {
  const ref = sourceRef(workspaceId, 'opportunities', opportunity.id, ['executionCost', 'effortHours', 'requiredAction']);
  const evaluation = evaluateObjectivePlan(objectiveState, {
    objectiveId: objective.id, kind: opportunity.actionKind, mode: 'internal_preparation',
    // A business proposal has no validated period/forecast schema yet. Review
    // timing is not substituted for business-action timing or evidence age.
    startsAt: null, endsAt: null,
    evidence: { sourceRefs: [`opportunity:${ref.identityHash}`], metricValue: null, estimatedCost: opportunity.executionCost,
      effortHours: opportunity.effortHours, costsComplete: false, currency: null, observedAt: null,
      grossMarginPercent: null, monthToDateAdSpend: null, plannedAdSpend: null, adSpendMonth: null,
      stockCoverDays: null, contributionProfitDelta: null }
  }, { workspaceId, now });
  const blockers = [...evaluation.blockers];
  if (opportunity.approvalRequired && !evaluation.approvalRequired) blockers.push(issue('OWNER_APPROVAL_REQUIRED', 'opportunity', 'The canonical opportunity remains approval-required'));
  if (!opportunity.actionClassificationKnown) blockers.push(issue('ACTION_KIND_UNRESOLVED', 'actionKind', 'The recorded action has no supported trusted classification'));
  if (portfolio.approvalPending) blockers.push(issue('OWNER_APPROVAL_PENDING', 'portfolio', 'Owner approval is pending'));
  if (portfolio.activeExperiment) blockers.push(issue('EXPERIMENT_ACTIVE', 'portfolio', 'An experiment is already active'));
  if (portfolio.evidenceDecision === 'deprioritise') blockers.push(issue('HISTORICAL_CONTRIBUTION_NEGATIVE', 'portfolio', 'Verified historical contribution evidence is negative'));
  for (const message of planningBlockers) blockers.push(issue('PORTFOLIO_CONSTRAINT', 'portfolio', message));
  return {
    opportunityId: opportunity.id, title: opportunity.title, kind: opportunity.kind, objectiveId: objective.id, objectiveRevision: objective.revision,
    sourceRef: ref, sourceReferenceResolved: true, measurementsVerified: false,
    readyForPreparation: false, commercialReady: false, approvalRequired: opportunity.approvalRequired || evaluation.approvalRequired || portfolio.approvalPending,
    approvalRequiredKinds: evaluation.approvalRequiredKinds,
    evidence: { executionCost: opportunity.executionCost, effortHours: opportunity.effortHours,
      currency: null, observedAt: null, grossMarginPercent: null, stockCoverDays: null,
      monthlyAdSpend: null, forecastContribution: null,
      historicalContribution: opportunity.historicalContribution, historicalEvidenceVerified: opportunity.historicalEvidenceVerified,
      historicalCurrency: null, historicalPeriod: null, ...(opportunity.experimentId ? { historicalSourceRef: sourceRef(workspaceId, 'revenueEngine.experiments', opportunity.experimentId, ['impact']) } : {}) },
    blockers, checks: evaluation.checks,
    dependencies: ['resolve_objective_period', 'verify_economics_and_currency', 'record_bounded_effort_and_capacity',
      ...(opportunity.approvalRequired || evaluation.approvalRequired || portfolio.approvalPending ? ['obtain_owner_approval'] : [])],
    nextStep: 'Review the original opportunity and record the missing evidence before preparing a business action',
    externalExecutionAllowed: false
  };
}
function specialistFindings(agentId, proposals, capacity) {
  const candidates = proposals.map(row => row.opportunityId);
  const unknownCosts = proposals.filter(row => row.evidence.executionCost === null).length;
  if (agentId === 'finance') return [
    { code: 'HISTORICAL_CONTRIBUTION_POSTURE', message: `${proposals.filter(row => row.evidence.historicalContribution > 0).length} reviewed opportunities have positive verified historical contribution and ${proposals.filter(row => row.evidence.historicalContribution < 0).length} have negative historical contribution; these are not forecasts`, opportunityIds: candidates },
    { code: 'COST_COVERAGE', message: `${unknownCosts} of ${proposals.length} reviewed opportunities have unknown planned cost`, opportunityIds: proposals.filter(row => row.evidence.executionCost === null).map(row => row.opportunityId) },
    { code: 'PROFIT_FORECAST_UNKNOWN', message: 'Verified historical contribution is not a forecast; future contribution and its currency remain unknown', opportunityIds: candidates }
  ];
  if (agentId === 'pricing') return [{ code: 'GROSS_MARGIN_UNKNOWN', message: 'Objective gross-margin limits require separately evidenced gross margin; contribution margin is not substituted', opportunityIds: candidates }];
  if (agentId === 'stock') return [{ code: 'STOCK_COVER_UNKNOWN', message: 'Stock-cover checks require inventory and a bounded demand basis', opportunityIds: candidates }];
  if (agentId === 'marketing') return [{ code: 'MONTHLY_AD_EVIDENCE_UNKNOWN', message: 'Calendar-month ad spend, complete coverage and currency must be established before budget comparison', opportunityIds: candidates }];
  return [{ code: 'OBJECTIVE_PERIOD_UNKNOWN', message: 'The objective window has no complete resolved measurement; rolling summaries are not treated as objective progress', opportunityIds: candidates },
    { code: capacity === null ? 'CAPACITY_UNKNOWN' : 'CAPACITY_RECORDED', message: capacity === null ? 'Available growth hours are unknown' : `Recorded growth-hour capacity is ${capacity}; this report reserves no time`, opportunityIds: candidates }];
}

/**
 * Build an internal evidence review from current authoritative tenant state.
 * The caller must authenticate/authorize the owner and revalidate these bindings
 * at queue claim/persistence. Frozen inputs are supported; no state is changed.
 * Stable IDs depend on tenant/objective/revision/job, never on customer identity.
 */
export function buildObjectiveReview(state, input, options = {}) {
  if (!record(state) || !record(state.workspace)) throw error('Workspace identity is required', 'WORKSPACE_REQUIRED');
  const workspaceId = state.workspace.id;
  assertScope(state, workspaceId); assertScope(state.workspace, workspaceId);
  assertScope(input, workspaceId); assertScope(options, workspaceId);
  exactObject(input, ['workspaceId', 'tenantId', 'objectiveId', 'objectiveRevision', 'jobId'], 'objective review request');
  exactObject(options, ['workspaceId', 'now'], 'objective review options');
  if (!Number.isSafeInteger(input.objectiveRevision) || input.objectiveRevision < 1 || typeof input.jobId !== 'string' || !/^job_[A-Za-z0-9_-]{1,100}$/.test(input.jobId)) throw error('A valid objective revision and server-assigned job ID are required', 'VALIDATION_FAILED');
  const snapshot = businessObjectivesSnapshot(state, { workspaceId, now: options.now });
  const objective = snapshot.objectives.find(row => row.id === input.objectiveId);
  if (!objective) throw error('Objective not found in this workspace', 'OBJECTIVE_NOT_FOUND', 404);
  if (objective.revision !== input.objectiveRevision) throw error('Objective changed; reload before preparing its review', 'OBJECTIVE_CONFLICT', 409);
  const now = snapshot.generatedAt;
  const id = `objective_review_${hash([workspaceId, objective.id, objective.revision, input.jobId])}`;
  const sourceId = `review_sources_${hash([id, 'sources'])}`;
  const report = {
    schema: 'runvara-objective-review/v1', id, workspaceId, jobId: input.jobId, objectiveId: objective.id, objectiveRevision: objective.revision,
    generatedAt: now, sourceAsOf: { snapshotReadAt: now, stateRevision: reference(state._revision), typedInputFingerprint: null, fingerprintScope: 'not_scanned', financialObservedAt: null }, reportStatus: 'blocked', reportCompleted: false, commercialReady: false,
    objective: { title: cleanTitle(objective.title), metric: objective.metric, baseline: objective.baseline, target: objective.target,
      direction: objective.direction, effectiveStatus: objective.effectiveStatus, startsAt: objective.startsAt, endsAt: objective.endsAt, limits: structuredClone(objective.limits) },
    sourceResolution: { id: sourceId, status: 'blocked', scanned: {}, canonical: 0, proposalsOmitted: 0, complete: false },
    metricEvidence: null, specialists: [], proposals: [], blockers: [], evidenceGaps: [], summary: null,
    synthesis: { id: `review_synthesis_${hash([id, 'synthesis'])}`, dependsOn: [], status: 'blocked' }, safeguards: safeguards()
  };
  const commander = policy(state, 'commander');
  if (state.agentSettings !== undefined && !evidenceInWorkspace(state.agentSettings, workspaceId)) report.blockers.push(issue('AGENT_POLICY_INVALID', 'agentSettings', 'Agent settings have foreign or malformed scope'));
  if (objective.effectiveStatus !== 'active') report.blockers.push(issue('OBJECTIVE_NOT_ACTIVE', 'objective', `Objective is ${objective.effectiveStatus}`));
  if (!commander.enabled) report.blockers.push(issue(commander.invalid ? 'AGENT_POLICY_INVALID' : 'COMMANDER_DISABLED', 'commander', 'Commander review is disabled by workspace policy'));
  if (report.blockers.length) return boundedReport(report);

  const view = evidenceView(state, workspaceId);
  report.sourceAsOf = { ...report.sourceAsOf, typedInputFingerprint: hash(canonicalFingerprintValue(['objective-review-input/v1', workspaceId, objective, view, commander, ROUTES[objective.metric].map(id => [id, policy(state, id)])])), fingerprintScope: 'bounded_typed_records_and_policy' };
  const canonical = projectCanonicalOpportunities(view.state, { limit: OBJECTIVE_REVIEW_LIMITS.canonicalOpportunities }) || [];
  const opportunities = new Map(canonical.map(safeOpportunity).filter(Boolean).map(row => [row.id, row]));
  const portfolio = derivePortfolioAllocation(view.state);
  const executionPlan = deriveExecutionPlan(portfolio);
  const planningBlockers = new Map(executionPlan.blocked.map(row => [row.opportunityId, row.blockers]));
  const admitted = new Set(executionPlan.sequence.map(row => row.opportunityId));
  // The older projection returns at most 50 blocker rows. A missing row is not
  // evidence that the remaining canonical opportunity passed its constraints.
  for (const row of portfolio.portfolio) if (!admitted.has(row.opportunityId) && !planningBlockers.has(row.opportunityId)) planningBlockers.set(row.opportunityId, ['Canonical preparation planning did not admit this opportunity; inspect its full constraints']);
  report.sourceResolution = { id: sourceId, status: view.bounded ? 'completed' : 'incomplete', availableRecords: view.counts, scanned: Object.fromEntries(Object.entries(view.counts).map(([name, count]) => [name, view.bounded ? count : 0])),
    canonical: canonical.length, unsafeIdentityExcluded: canonical.length - opportunities.size,
    proposalsOmitted: Math.max(0, opportunities.size - OBJECTIVE_REVIEW_LIMITS.proposals),
    complete: view.bounded && Array.isArray(state.opportunities) && canonical.length < OBJECTIVE_REVIEW_LIMITS.canonicalOpportunities };
  report.metricEvidence = metricEvidence(objective, view.workspaceCurrency);
  report.evidenceGaps = [...view.problems, ...report.metricEvidence.blockers];
  if (canonical.length === OBJECTIVE_REVIEW_LIMITS.canonicalOpportunities) report.evidenceGaps.push(issue('CANONICAL_VIEW_BOUNDED', 'opportunities', 'The canonical view reached its cap; this report is not a complete opportunity inventory'));
  const objectiveState = { workspace: { id: workspaceId }, settings: view.state.settings, businessObjectives: state.businessObjectives };
  const candidates = portfolio.portfolio.filter(row => opportunities.has(row.opportunityId)).slice(0, OBJECTIVE_REVIEW_LIMITS.proposals);
  const assessed = candidates.map(row => proposalAssessment(objectiveState, objective, opportunities.get(row.opportunityId), row, planningBlockers.get(row.opportunityId) || [], now, workspaceId));
  const route = ROUTES[objective.metric].slice(0, OBJECTIVE_REVIEW_LIMITS.specialists);
  for (const agentId of route) {
    const setting = policy(state, agentId), enabled = setting.enabled;
    const mode = Math.min(setting.autonomy, commander.autonomy) >= 1 ? 'recommend' : 'observe';
    const task = { id: `review_task_${hash([id, agentId])}`, type: TYPES[agentId], agentId, objectiveId: objective.id, objectiveRevision: objective.revision,
      dependsOn: [sourceId], status: enabled ? 'completed' : 'blocked', mode, autonomy: setting.autonomy,
      sourceRefs: [], findings: [], recommendations: [], blockers: [] };
    if (!enabled) task.blockers.push(issue(setting.invalid ? 'AGENT_POLICY_INVALID' : 'SPECIALIST_DISABLED', agentId, 'This specialist is disabled by workspace policy'));
    else {
      task.sourceRefs = assessed.map(row => row.sourceRef);
      task.findings = specialistFindings(agentId, assessed, portfolio.capacity.availableGrowthHours);
      if (mode === 'recommend') task.recommendations = [{ kind: 'collect_recorded_evidence', opportunityIds: assessed.map(row => row.opportunityId),
        detail: agentId === 'finance' ? 'Verify missing costs, economic source currency and forecast assumptions in the original records' : agentId === 'pricing' ? 'Record separately evidenced gross margin before a price proposal' : agentId === 'stock' ? 'Record the inventory and demand period needed to assess stock cover' : agentId === 'marketing' ? 'Reconcile complete current-month advertising evidence before proposing budget changes' : 'Establish objective-period measurement and bounded effort before advancing opportunities' }];
    }
    report.specialists.push(task);
  }
  const completed = report.specialists.filter(task => task.status === 'completed');
  const recommendationAllowed = commander.autonomy >= 1 && completed.some(task => task.mode === 'recommend');
  report.proposals = recommendationAllowed ? assessed : [];
  report.reportCompleted = completed.length > 0;
  report.reportStatus = report.reportCompleted ? (completed.length === route.length && !report.evidenceGaps.length ? 'completed' : 'completed_with_gaps') : 'blocked';
  report.synthesis = { ...report.synthesis, dependsOn: report.specialists.map(task => task.id), status: report.reportStatus };
  report.summary = { specialistsCompleted: completed.length, specialistsBlocked: route.length - completed.length,
    opportunitiesReviewed: assessed.length, proposalsReady: 0, proposalsBlocked: report.proposals.length,
    ownerApprovalRequired: report.proposals.filter(row => row.approvalRequired).length, availableGrowthHours: portfolio.capacity.availableGrowthHours,
    recommendationsSuppressed: !recommendationAllowed, sourceCoverageComplete: report.sourceResolution.complete };
  if (!completed.length) report.blockers.push(issue('NO_SPECIALIST_AVAILABLE', 'specialists', 'No selected specialist is available for this review'));
  return boundedReport(report);
}

/** Reuse the same typed evidence/policy boundary for enqueue and stale checks. */
export function objectiveReviewFingerprint(state, input, options = {}) {
  exactObject(input, ['objectiveId', 'objectiveRevision'], 'objective fingerprint request');
  return buildObjectiveReview(state, { ...input, jobId: 'job_fingerprint_v1' }, options).sourceAsOf.typedInputFingerprint;
}
