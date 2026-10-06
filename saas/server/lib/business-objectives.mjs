import { randomUUID } from 'node:crypto';
import { requiresApproval, RISKY_ACTION_TYPES } from './security.mjs';

// Tenant-state definitions and deterministic, read-only preparation checks only.
// Nothing here grants authority, executes actions, calls providers, or writes a
// second store. The route must enforce owner authorization and audit persistence.
export const MAX_BUSINESS_OBJECTIVES = 50;
export const OBJECTIVE_METRICS = Object.freeze({
  revenue: { min: 0, max: Number.MAX_SAFE_INTEGER, unit: 'currency' },
  gross_profit: { min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, unit: 'currency' },
  contribution_profit: { min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER, unit: 'currency' },
  gross_margin_percent: { min: -Number.MAX_SAFE_INTEGER, max: 100, unit: 'percent' },
  monthly_ad_spend: { min: 0, max: Number.MAX_SAFE_INTEGER, unit: 'currency' },
  stock_cover_days: { min: 0, max: 3650, unit: 'days' },
  orders: { min: 0, max: Number.MAX_SAFE_INTEGER, unit: 'count', integer: true }
});
for (const definition of Object.values(OBJECTIVE_METRICS)) Object.freeze(definition);
export const OBJECTIVE_STATUSES = Object.freeze(['active', 'paused', 'disabled', 'completed', 'cancelled']);
export const INTERNAL_PREPARATION_KINDS = Object.freeze(['internal_analysis', 'read_only_research', 'prepare_report', 'prepare_proposal']);
const KINDS = Object.freeze([...INTERNAL_PREPARATION_KINDS, ...RISKY_ACTION_TYPES]);
const DIRECTIONS = ['increase', 'decrease', 'maintain'];
const ID_PATTERN = /^objective_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = 86400000;
const own = (value, key) => Object.hasOwn(value, key);
const invalid = message => Object.assign(new Error(message), { status: 400, code: 'VALIDATION_FAILED' });
const fail = (message, code, status) => Object.assign(new Error(message), { status, code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function record(value, name, fields) {
  if (!object(value)) throw invalid(`${name} must be an object`);
  for (const field of Object.keys(value)) if (!fields.includes(field)) throw invalid(`Unsupported ${name} field: ${field}`);
  return value;
}
function numeric(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw invalid(`${name} must be a finite ${integer ? 'integer' : 'number'} between ${min} and ${max}`);
  return value;
}
function text(value, name, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw invalid(`${name} must be nonempty text of at most ${maximum} characters`);
  return value.trim();
}
function date(value, name) {
  // Round-trip calendar components: Date.parse alone accepts February 30.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw invalid(`${name} must be an ISO UTC timestamp`);
  const timestamp = Date.parse(value);
  const normalized = value.includes('.') ? value : value.slice(0, -1) + '.000Z';
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== normalized) throw invalid(`${name} is not a valid calendar timestamp`);
  return new Date(timestamp).toISOString();
}
function currentTime(value = new Date()) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw invalid('Now must be a valid date');
    return value.toISOString();
  }
  return date(value, 'now');
}
function currency(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) throw invalid('Currency must be an uppercase three-letter currency code');
  // Runtime ISO-4217 catalog; never treat an arbitrary three-letter token as money.
  if (!Intl.supportedValuesOf('currency').includes(value)) throw invalid('Currency is not supported');
  return value;
}
function enumValue(value, allowed, name) {
  if (!allowed.includes(value)) throw invalid(`Unsupported ${name}`);
  return value;
}
function assertScope(workspaceId, input) {
  if (!object(input)) return;
  for (const value of [input.workspaceId, input.workspace_id, input.tenantId, input.tenant_id, input.workspace?.id]) {
    if (value !== undefined && value !== workspaceId) throw fail('Workspace identity mismatch', 'WORKSPACE_MISMATCH', 403);
  }
}
function workspace(state, options, input) {
  if (!object(state) || typeof state.workspace?.id !== 'string' || !state.workspace.id || state.workspace.id.length > 256) throw fail('Workspace identity is required', 'WORKSPACE_REQUIRED', 400);
  const workspaceId = state.workspace.id;
  assertScope(workspaceId, state); assertScope(workspaceId, options); assertScope(workspaceId, input);
  return workspaceId;
}
function kinds(value, name) {
  if (!Array.isArray(value) || value.length > KINDS.length || value.some(kind => !KINDS.includes(kind))) throw invalid(`${name} contains an unsupported action kind`);
  return [...new Set(value)].sort();
}
function limits(value, workspaceId) {
  assertScope(workspaceId, value);
  record(value, 'limits', ['minGrossMarginPercent', 'maxMonthlyAdBudget', 'currency', 'minStockCoverDays', 'profitFirst', 'approvalRequiredKinds']);
  if (own(value, 'profitFirst') && typeof value.profitFirst !== 'boolean') throw invalid('profitFirst must be a boolean');
  const result = {
    minGrossMarginPercent: own(value, 'minGrossMarginPercent') ? numeric(value.minGrossMarginPercent, 'Minimum gross margin', { max: 100, nullable: true }) : null,
    maxMonthlyAdBudget: own(value, 'maxMonthlyAdBudget') ? numeric(value.maxMonthlyAdBudget, 'Monthly ad budget', { nullable: true }) : null,
    currency: own(value, 'currency') ? currency(value.currency, true) : null,
    minStockCoverDays: own(value, 'minStockCoverDays') ? numeric(value.minStockCoverDays, 'Minimum stock cover', { max: 3650, nullable: true }) : null,
    profitFirst: value.profitFirst ?? true,
    approvalRequiredKinds: own(value, 'approvalRequiredKinds') ? kinds(value.approvalRequiredKinds, 'approvalRequiredKinds') : []
  };
  if (result.maxMonthlyAdBudget !== null && result.currency === null) throw invalid('A monthly ad budget requires a currency');
  return result;
}
const OBJECTIVE_FIELDS = ['id', 'revision', 'workspaceId', 'tenantId', 'title', 'metric', 'baseline', 'target', 'direction', 'startsAt', 'endsAt', 'status', 'limits'];
function definition(input, workspaceId) {
  assertScope(workspaceId, input);
  record(input, 'objective', OBJECTIVE_FIELDS);
  const metric = enumValue(input.metric, Object.keys(OBJECTIVE_METRICS), 'objective metric');
  const spec = OBJECTIVE_METRICS[metric];
  const baseline = numeric(input.baseline, 'Baseline', { ...spec, nullable: true });
  const target = numeric(input.target, 'Target', spec);
  const direction = enumValue(input.direction, DIRECTIONS, 'objective direction');
  if (baseline !== null && ((direction === 'increase' && target <= baseline) || (direction === 'decrease' && target >= baseline) || (direction === 'maintain' && target !== baseline))) throw invalid('Target must agree with the objective direction and baseline');
  const startsAt = date(input.startsAt, 'startsAt'), endsAt = date(input.endsAt, 'endsAt');
  if (endsAt <= startsAt || Date.parse(endsAt) - Date.parse(startsAt) > 3650 * DAY) throw invalid('Objective time bounds must be ordered and no more than ten years apart');
  const normalizedLimits = limits(own(input, 'limits') ? input.limits : {}, workspaceId);
  if (spec.unit === 'currency' && normalizedLimits.currency === null) throw invalid('A monetary objective requires a currency');
  if (metric === 'monthly_ad_spend' && normalizedLimits.maxMonthlyAdBudget !== null && target > normalizedLimits.maxMonthlyAdBudget) throw invalid('Advertising target exceeds the objective budget');
  if (metric === 'gross_margin_percent' && normalizedLimits.minGrossMarginPercent !== null && target < normalizedLimits.minGrossMarginPercent) throw invalid('Margin target is below the objective minimum');
  if (metric === 'stock_cover_days' && normalizedLimits.minStockCoverDays !== null && target < normalizedLimits.minStockCoverDays) throw invalid('Stock target is below the objective minimum');
  return { workspaceId, title: text(input.title, 'Objective title', 160), metric, baseline, target, direction, startsAt, endsAt,
    status: enumValue(own(input, 'status') ? input.status : 'active', OBJECTIVE_STATUSES, 'objective status'), limits: normalizedLimits };
}
function storedObjectives(state, workspaceId) {
  const rows = state.businessObjectives === undefined ? [] : state.businessObjectives;
  if (!Array.isArray(rows) || rows.length > MAX_BUSINESS_OBJECTIVES) throw fail('Stored objective collection is invalid', 'OBJECTIVES_INVALID', 409);
  const ids = new Set();
  return rows.map(row => {
    assertScope(workspaceId, row);
    if (!object(row)) throw fail('Stored objective is invalid', 'OBJECTIVES_INVALID', 409);
    record(row, 'stored objective', [...OBJECTIVE_FIELDS, 'createdAt', 'updatedAt']);
    const { createdAt, updatedAt, ...input } = row;
    if (!ID_PATTERN.test(input.id) || ids.has(input.id)) throw fail('Stored objective identity is invalid', 'OBJECTIVES_INVALID', 409);
    ids.add(input.id);
    return { id: input.id, ...definition(input, workspaceId), revision: numeric(input.revision, 'Revision', { min: 1, integer: true }), createdAt: date(createdAt, 'createdAt'), updatedAt: date(updatedAt, 'updatedAt') };
  });
}
function temporalStatus(row, now) {
  if (row.status !== 'active') return row.status;
  if (row.endsAt <= now) return 'expired';
  if (row.startsAt > now) return 'scheduled';
  return 'active';
}
function safeguards() {
  return { externalExecutionAllowed: false, externalWrites: false, spendCommitted: false, providerCalls: false,
    mandatoryApprovalsPreserved: true, existingAuthAndTenantPoliciesStillApply: true, unknownEvidenceDoesNotBecomeZero: true };
}

/** Validate fully before changing only state.businessObjectives. Updates require
 * the existing opaque id and revision; omissions preserve the existing fields.
 * No actor identity, free-form metric name, or caller-supplied id is persisted. */
export function upsertBusinessObjective(state, input, options = {}) {
  const workspaceId = workspace(state, options, input);
  record(input, 'objective', OBJECTIVE_FIELDS);
  const now = currentTime(options.now), rows = storedObjectives(state, workspaceId);
  const previous = own(input, 'id') ? rows.find(row => row.id === input.id) : null;
  if (own(input, 'id') && !previous) throw fail('Objective not found in this workspace', 'OBJECTIVE_NOT_FOUND', 404);
  if (previous && input.revision !== previous.revision) throw fail('Objective changed; reload before editing', 'OBJECTIVE_CONFLICT', 409);
  if (!previous && own(input, 'revision')) throw invalid('Revision is assigned by the server');
  if (!previous && rows.length >= MAX_BUSINESS_OBJECTIVES) throw fail('A workspace supports at most 50 objectives', 'OBJECTIVE_LIMIT_REACHED', 409);
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...previousDefinition } = previous || {};
  const candidate = { ...previousDefinition, ...input, limits: { ...(previous?.limits || {}), ...(input.limits || {}) } };
  // Do not allow malformed/null limits to disappear through object spreading.
  if (own(input, 'limits')) record(input.limits, 'limits', ['minGrossMarginPercent', 'maxMonthlyAdBudget', 'currency', 'minStockCoverDays', 'profitFirst', 'approvalRequiredKinds']);
  const result = { id: previous?.id || `objective_${randomUUID()}`, ...definition(candidate, workspaceId),
    revision: (previous?.revision || 0) + 1, createdAt: previous?.createdAt || now, updatedAt: now };
  state.businessObjectives = previous ? rows.map(row => row.id === previous.id ? result : row) : [...rows, result];
  return structuredClone(result);
}

/** Pure detached projection: never initialize state or return nested references. */
export function businessObjectivesSnapshot(state, options = {}) {
  const workspaceId = workspace(state, options), now = currentTime(options.now);
  const objectives = storedObjectives(state, workspaceId).map(row => ({ ...row, effectiveStatus: temporalStatus(row, now) }));
  return { schema: 'runvara-business-objectives/v1', workspaceId, generatedAt: now, objectives,
    summary: { total: objectives.length, active: objectives.filter(row => row.effectiveStatus === 'active').length, limit: MAX_BUSINESS_OBJECTIVES },
    supportedMetrics: Object.keys(OBJECTIVE_METRICS), supportedKinds: [...KINDS],
    mandatoryApprovalKinds: [...RISKY_ACTION_TYPES].sort(), safeguards: safeguards() };
}

const EVIDENCE_FIELDS = ['workspaceId', 'tenantId', 'observedAt', 'sourceRefs', 'metricValue', 'estimatedCost', 'effortHours', 'costsComplete', 'currency', 'grossMarginPercent', 'monthToDateAdSpend', 'plannedAdSpend', 'adSpendMonth', 'stockCoverDays', 'contributionProfitDelta'];
function planEvidence(input, metric, workspaceId) {
  assertScope(workspaceId, input);
  record(input, 'evidence', EVIDENCE_FIELDS);
  const result = {};
  for (const field of ['metricValue', 'estimatedCost', 'effortHours', 'grossMarginPercent', 'monthToDateAdSpend', 'plannedAdSpend', 'stockCoverDays', 'contributionProfitDelta']) {
    const spec = field === 'metricValue' ? OBJECTIVE_METRICS[metric] : field === 'grossMarginPercent' ? { min: -Number.MAX_SAFE_INTEGER, max: 100 } : field === 'contributionProfitDelta' ? { min: -Number.MAX_SAFE_INTEGER } : field === 'stockCoverDays' ? { max: 3650 } : {};
    result[field] = own(input, field) ? numeric(input[field], field, { ...spec, nullable: true }) : null;
  }
  if (own(input, 'costsComplete') && typeof input.costsComplete !== 'boolean') throw invalid('costsComplete must be a boolean');
  result.costsComplete = input.costsComplete ?? false;
  result.currency = own(input, 'currency') ? currency(input.currency, true) : null;
  result.observedAt = own(input, 'observedAt') && input.observedAt !== null ? date(input.observedAt, 'Evidence observedAt') : null;
  if (own(input, 'sourceRefs') && (!Array.isArray(input.sourceRefs) || input.sourceRefs.length > 20 || input.sourceRefs.some(ref => typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(ref)))) throw invalid('Evidence sourceRefs must contain at most 20 bounded record references');
  result.sourceRefs = [...new Set(input.sourceRefs || [])];
  if (own(input, 'adSpendMonth') && input.adSpendMonth !== null && (typeof input.adSpendMonth !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.adSpendMonth))) throw invalid('adSpendMonth must be YYYY-MM');
  result.adSpendMonth = input.adSpendMonth ?? null;
  return result;
}

/**
 * Evaluate a proposed internal preparation only. Supplied evidence remains an
 * explicitly labelled assertion; this function neither fetches nor verifies a
 * provider's figures. Missing, stale, or incomplete evidence blocks readiness.
 * Approval flags cannot be cleared by this API, even by an approved record.
 */
export function evaluateObjectivePlan(state, input, options = {}) {
  const workspaceId = workspace(state, options, input), now = currentTime(options.now);
  record(input, 'plan', ['workspaceId', 'tenantId', 'objectiveId', 'kind', 'mode', 'startsAt', 'endsAt', 'evidence']);
  if (input.mode !== 'internal_preparation') throw invalid('Only internal_preparation plans can be evaluated');
  const kind = enumValue(input.kind, KINDS, 'plan kind');
  const objective = storedObjectives(state, workspaceId).find(row => row.id === input.objectiveId);
  if (!objective) throw fail('Objective not found in this workspace', 'OBJECTIVE_NOT_FOUND', 404);
  const evidence = planEvidence(input.evidence ?? {}, objective.metric, workspaceId);
  const startsAt = input.startsAt === undefined || input.startsAt === null ? null : date(input.startsAt, 'Plan startsAt');
  const endsAt = input.endsAt === undefined || input.endsAt === null ? null : date(input.endsAt, 'Plan endsAt');
  if (startsAt && endsAt && (endsAt <= startsAt || Date.parse(endsAt) - Date.parse(startsAt) > 31 * DAY)) throw invalid('Preparation must have ordered time bounds no more than 31 days apart');
  const blockers = [], checks = [];
  const block = (code, field, message) => blockers.push({ code, field, message });
  const check = (field, actual, limit, passed) => checks.push({ field, actual, limit, passed, basis: 'supplied_evidence' });
  const status = temporalStatus(objective, now);
  if (status !== 'active') block('OBJECTIVE_NOT_ACTIVE', 'status', `Objective is ${status}`);
  if (objective.baseline === null) block('BASELINE_UNKNOWN', 'baseline', 'A recorded baseline is required');
  if (!startsAt || !endsAt) block('TIME_BOUNDS_UNKNOWN', 'startsAt/endsAt', 'Bounded preparation start and end times are required');
  else if (startsAt < objective.startsAt || endsAt > objective.endsAt || endsAt <= now) block('TIME_OUTSIDE_OBJECTIVE', 'startsAt/endsAt', 'Preparation must fit within the live objective period');
  if (!evidence.observedAt) block('EVIDENCE_TIME_UNKNOWN', 'evidence.observedAt', 'Evidence observation time is required');
  else if (evidence.observedAt > now || Date.parse(now) - Date.parse(evidence.observedAt) > 30 * DAY) block('EVIDENCE_NOT_CURRENT', 'evidence.observedAt', 'Evidence must be no more than 30 days old and not future-dated');
  if (!evidence.sourceRefs.length) block('EVIDENCE_SOURCE_UNKNOWN', 'evidence.sourceRefs', 'Record references are required');
  for (const field of ['metricValue', 'estimatedCost', 'effortHours', 'grossMarginPercent']) if (evidence[field] === null) block('EVIDENCE_UNKNOWN', `evidence.${field}`, `${field} is unknown`);
  if (!evidence.costsComplete) block('COST_EVIDENCE_INCOMPLETE', 'evidence.costsComplete', 'Complete cost evidence is required');
  if (evidence.currency === null) block('CURRENCY_UNKNOWN', 'evidence.currency', 'The cost currency is unknown');
  if (objective.limits.currency !== null && evidence.currency !== null && objective.limits.currency !== evidence.currency) block('CURRENCY_MISMATCH', 'evidence.currency', 'Evidence currency does not match the objective; no exchange rate is assumed');
  if (startsAt && endsAt && evidence.effortHours !== null && evidence.effortHours > Math.max(0, Date.parse(endsAt) - Math.max(Date.parse(startsAt), Date.parse(now))) / 3600000) block('EFFORT_EXCEEDS_TIME_WINDOW', 'evidence.effortHours', 'Preparation effort exceeds the remaining bounded plan duration');
  const availableHours = state.settings?.growthCapacityHours;
  if (typeof availableHours !== 'number' || !Number.isFinite(availableHours) || availableHours < 0) block('CAPACITY_UNKNOWN', 'settings.growthCapacityHours', 'Recorded preparation capacity is required');
  else if (evidence.effortHours !== null) {
    check('effortHours', evidence.effortHours, availableHours, evidence.effortHours <= availableHours);
    if (evidence.effortHours > availableHours) block('TIME_CAPACITY_EXCEEDED', 'evidence.effortHours', 'Preparation exceeds recorded available growth hours');
  }
  const policy = objective.limits;
  if (policy.minGrossMarginPercent !== null && evidence.grossMarginPercent !== null) {
    const passed = evidence.grossMarginPercent >= policy.minGrossMarginPercent;
    check('grossMarginPercent', evidence.grossMarginPercent, policy.minGrossMarginPercent, passed);
    if (!passed) block('GROSS_MARGIN_BELOW_LIMIT', 'evidence.grossMarginPercent', 'Gross margin is below the objective minimum');
  }
  if (policy.maxMonthlyAdBudget !== null) {
    if (evidence.monthToDateAdSpend === null || evidence.plannedAdSpend === null) block('AD_SPEND_UNKNOWN', 'evidence.monthToDateAdSpend/plannedAdSpend', 'Recorded month-to-date and planned advertising spend are required');
    if (!startsAt || !endsAt || evidence.adSpendMonth !== startsAt.slice(0, 7) || evidence.adSpendMonth !== endsAt.slice(0, 7) || evidence.adSpendMonth !== now.slice(0, 7)) block('AD_SPEND_PERIOD_UNKNOWN', 'evidence.adSpendMonth', 'The budget comparison requires a single current calendar month');
    if (!evidence.observedAt || evidence.observedAt.slice(0, 7) !== evidence.adSpendMonth) block('AD_SPEND_EVIDENCE_PERIOD_MISMATCH', 'evidence.observedAt', 'Month-to-date spend must have been observed in the budget month');
    if (evidence.monthToDateAdSpend !== null && evidence.plannedAdSpend !== null) {
      const total = evidence.monthToDateAdSpend + evidence.plannedAdSpend;
      const passed = Number.isSafeInteger(Math.trunc(total)) && total <= policy.maxMonthlyAdBudget;
      check('monthlyAdSpend', total, policy.maxMonthlyAdBudget, passed);
      if (!passed) block('AD_BUDGET_EXCEEDED', 'evidence.plannedAdSpend', 'Month-to-date plus planned advertising spend exceeds the monthly limit');
    }
  }
  if (policy.minStockCoverDays !== null) {
    if (evidence.stockCoverDays === null) block('STOCK_COVER_UNKNOWN', 'evidence.stockCoverDays', 'Stock-cover evidence is required');
    else {
      const passed = evidence.stockCoverDays >= policy.minStockCoverDays;
      check('stockCoverDays', evidence.stockCoverDays, policy.minStockCoverDays, passed);
      if (!passed) block('STOCK_COVER_BELOW_LIMIT', 'evidence.stockCoverDays', 'Stock cover is below the objective minimum');
    }
  }
  if (policy.profitFirst) {
    if (evidence.contributionProfitDelta === null) block('PROFIT_IMPACT_UNKNOWN', 'evidence.contributionProfitDelta', 'Profit-first preparation requires a recorded contribution-profit estimate');
    else {
      const passed = evidence.contributionProfitDelta >= 0;
      check('contributionProfitDelta', evidence.contributionProfitDelta, 0, passed);
      if (!passed) block('PROFIT_FIRST_LIMIT', 'evidence.contributionProfitDelta', 'Expected contribution-profit change is negative');
    }
  }
  const approvalKinds = new Set();
  if (requiresApproval(kind) || policy.approvalRequiredKinds.includes(kind)) approvalKinds.add(kind);
  if (evidence.estimatedCost > 0) approvalKinds.add('spend_money');
  if (evidence.plannedAdSpend > 0) approvalKinds.add('advertising_spend');
  if (approvalKinds.size) block('OWNER_APPROVAL_REQUIRED', 'kind', 'Mandatory owner approval remains required; this evaluation cannot authorize the action');
  return { schema: 'runvara-objective-evaluation/v1', workspaceId, generatedAt: now, objectiveId: objective.id, objectiveRevision: objective.revision,
    objectiveStatus: status, kind, mode: 'internal_preparation', readyForPreparation: blockers.length === 0, approvalRequired: approvalKinds.size > 0,
    approvalRequiredKinds: [...approvalKinds].sort(), blockers, checks, assessment:'conditional_on_supplied_evidence', sourceReferencesResolved:false, evidence: { ...evidence, provenance: 'supplied_unverified', providerVerified: false },
    metric: { name: objective.metric, baseline: objective.baseline, target: objective.target, direction: objective.direction, current: evidence.metricValue },
    safeguards: safeguards() };
}
