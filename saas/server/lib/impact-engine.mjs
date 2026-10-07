import { tenantBusinessEvidence, evidenceInWorkspace } from './business-evidence-scope.mjs';
import { aggregateBusinessOutcomes } from './business-outcomes.mjs';
const clean = (value, max = 240) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const METRICS = ['incrementalRevenue', 'incrementalContribution', 'contributionProtected', 'costAvoided', 'minutesSaved'];
const own = (value, key) => Object.hasOwn(value, key);
const recordedAmount = value => (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) ? String(value) : null;

function legacyEvidence(sourceType, sourceId, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (!METRICS.some(key => own(raw, key)) && raw.verified !== true && raw.status !== 'verified')) return null;
  return {
    id: clean(raw.id || `${sourceType}:${sourceId}`, 180), sourceType, sourceId: clean(sourceId, 180),
    measuredAt: clean(raw.measuredAt || raw.completedAt || raw.createdAt, 80) || null,
    method: clean(raw.method || raw.basis, 160) || null,
    metrics: Object.fromEntries(METRICS.map(key => [key, recordedAmount(raw[key])])),
    legacyReviewed: raw.verified === true || raw.status === 'verified',
    qualified: false, currency: null, window: null, qualification: 'legacy_unqualified',
    qualificationReason: 'No committed typed outcome with resolved source, currency, window and coverage proof.'
  };
}
function collectLegacy(state) {
  const rows = [], add = (type, id, raw) => { const row = legacyEvidence(type, id, raw); if (row) rows.push(row); };
  for (const work of state.workRecords) if (work.status === 'COMPLETED') for (const evidence of work.evidence || []) add('work', work.id, evidence?.impact && typeof evidence.impact === 'object' ? evidence.impact : evidence);
  for (const experiment of state.revenueEngine.experiments) if (['completed','measured','closed'].includes(String(experiment.status || '').toLowerCase())) add('experiment', experiment.id, experiment.impact || experiment.result || experiment.outcome);
  for (const approval of state.approvals) if (approval.status === 'approved' && ['completed','succeeded','executed'].includes(String(approval.executionStatus || '').toLowerCase())) add('approval', approval.id, approval.impact || approval.executionImpact);
  const byId = new Map(), conflicts = new Set();
  for (const row of rows) {
    const previous = byId.get(row.id);
    if (previous && (JSON.stringify(previous.metrics) !== JSON.stringify(row.metrics) || previous.legacyReviewed !== row.legacyReviewed)) conflicts.add(row.id);
    else if (!previous) byId.set(row.id, row);
  }
  return { rows: [...byId.values()].filter(row => !conflicts.has(row.id)), conflicts: conflicts.size };
}

/** Pure consumer of a trusted adapter's bounded snapshot. A JSON summary,
 * persisted verified flag or copied publication-boundary object is not proof.
 * Only the adapter resolves current committed heads; this performs no IO.
 */
export function deriveQualifiedOutcomeGroups(workspaceId, { outcomeSnapshot, now = new Date().toISOString() } = {}) {
  const unavailable = reason => ({ qualifiedOutcomeGroups: [], qualifiedOutcomeCount: 0,
    outcomeCoverage: { publicationProofAvailable: false, complete: false, unavailableReason: reason, exclusions: [], completeLifetimeHistoryClaimed: false } });
  if (!outcomeSnapshot) return unavailable('COMMITTED_OUTCOME_SNAPSHOT_NOT_SUPPLIED');
  let summary;
  try { summary = aggregateBusinessOutcomes(outcomeSnapshot.versions, { workspaceId, now, publicationBoundary: outcomeSnapshot.publicationBoundary }); }
  catch (error) {
    if (error.code === 'WORKSPACE_MISMATCH') throw error;
    return unavailable('COMMITTED_OUTCOME_PROOF_INVALID_OR_UNAVAILABLE');
  }
  return {
    qualifiedOutcomeGroups: summary.coverage.complete ? summary.groups : [],
    qualifiedOutcomeCount: summary.coverage.complete ? summary.counts.qualifiedOutcomes : 0,
    outcomeCoverage: { publicationProofAvailable: true, complete: summary.coverage.complete,
      unavailableReason: summary.coverage.complete ? null : 'COMMITTED_OUTCOME_SNAPSHOT_INCOMPLETE',
      exclusions: summary.exclusions, completeLifetimeHistoryClaimed: false, publicationSnapshotId: summary.publicationSnapshotId }
  };
}

export function deriveImpact(state = {}, options = {}) {
  const workspaceId = typeof state.workspace?.id === 'string' ? state.workspace.id : '';
  if (options.outcomeSnapshot && (!evidenceInWorkspace(state, workspaceId) || !evidenceInWorkspace(state.workspace, workspaceId))) throw Object.assign(new Error('Outcome state scope mismatch'), { code:'WORKSPACE_MISMATCH', status:403 });
  state = tenantBusinessEvidence(state);
  const now = options.now || new Date().toISOString();
  const deduplicated = collectLegacy(state), evidence = deduplicated.rows;
  const qualified = deriveQualifiedOutcomeGroups(workspaceId, { outcomeSnapshot: options.outcomeSnapshot, now });
  return {
    schema: 'runvara-impact/v1', workspaceId, generatedAt: now,
    // Kept for API compatibility. These unscoped scalars have no currency or
    // measurement window; even a single qualified group must remain explicit.
    verified: { incrementalRevenue: null, incrementalContribution: null, contributionProtected: null, costAvoided: null, verifiedValue: null, hoursSaved: null },
    activity: {
      completedWork: state.workRecords.filter(item => item.status === 'COMPLETED').length,
      completedAutomations: state.automationRuns.filter(item => item.status === 'COMPLETED').length,
      completedExperiments: state.revenueEngine.experiments.filter(item => ['completed','measured','closed'].includes(String(item.status || '').toLowerCase())).length,
      verifiedImpactEvents: qualified.qualifiedOutcomeCount, legacyRecordedEvents: evidence.length, legacyReviewedEvents: evidence.filter(row => row.legacyReviewed).length
    },
    roi: { subscriptionCost: null, verifiedValue: null, multiple: null },
    ...qualified,
    // Existing evidence remains inspectable as explicitly unqualified context.
    evidence: evidence.slice(0, 100),
    legacy: { recordedEvents: evidence.length, reviewedEvents: evidence.filter(row => row.legacyReviewed).length, qualified: false, evidence: evidence.slice(0, 100) },
    coverage: {
      conflictingEvidenceExcluded: deduplicated.conflicts, ambiguousSourceRecordsExcluded: state.evidenceScope.ambiguousSourceRecordsExcluded,
      financiallyVerifiedEvents: qualified.qualifiedOutcomeCount, timeVerifiedEvents: 0, legacyUnqualifiedEvents: evidence.length,
      note: 'Only committed typed outcome groups carry qualified measurements. Legacy records remain unqualified. Unscoped money, time savings and ROI are unknown; historical benefits are not compared with monthly fees.'
    },
    safeguards: { forecastsCountedAsImpact: false, approvalFinancialImpactCountedAsRealised: false, revenueDoubleCountedAsProfit: false,
      rawCustomerIdentityIncluded: false, legacyVerificationQualifies: false, provisionalArchivesExcluded: true, currenciesNeverCombined: true,
      exactWindowsNeverCombined: true, runvaraAttributionEstablished: false, lifetimeMonthlyRoiCalculated: false }
  };
}
