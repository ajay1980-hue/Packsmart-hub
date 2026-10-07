import { deriveImpact } from './impact-engine.mjs';

/** Current owner reports establish descriptive measurements only. Learning an
 * opportunity prior also requires immutable action/domain links and comparable
 * population/intervention evidence, which this first contract does not resolve.
 */
export function deriveLearning(state = {}, { minSamples = 2, outcomeSnapshot, now = new Date().toISOString() } = {}) {
  const impact = deriveImpact(state, { outcomeSnapshot, now });
  const requiredSamples = Math.max(2, Math.min(20, Number(minSamples) || 2));
  return {
    schema: 'runvara-learning/v1', workspaceId: impact.workspaceId, generatedAt: now, minimumSamples: requiredSamples,
    priors: [],
    qualifiedOutcomeGroups: impact.qualifiedOutcomeGroups.map(group => ({ ...group, descriptiveOnly: true, usableForGuidance: false,
      missingGuidanceEvidence: ['IMMUTABLE_ACTION_DOMAIN_LINKS_UNRESOLVED', 'FUTURE_COMPARABILITY_UNESTABLISHED'] })),
    outcomeCoverage: impact.outcomeCoverage,
    evidence: impact.evidence.slice(0, 200), legacy: impact.legacy,
    summary: {
      verifiedLearningEvents: 0, qualifiedDescriptiveOutcomes: impact.qualifiedOutcomeCount,
      legacyRecordedEvents: impact.legacy.recordedEvents, legacyReviewedEvents: impact.legacy.reviewedEvents,
      conflictingEvidenceExcluded: impact.coverage.conflictingEvidenceExcluded,
      ambiguousSourceRecordsExcluded: impact.coverage.ambiguousSourceRecordsExcluded,
      domainsObserved: 0, domainsUsableForGuidance: 0
    },
    safeguards: { verifiedOutcomesOnly: true, forecastsExcluded: true, unverifiedResultsExcluded: true,
      singleObservationCannotSetGuidance: true, externalWrites: false, approvalsPreserved: true, rawCustomerIdentityIncluded: false,
      legacyVerificationQualifies: false, immutableActionDomainEvidenceRequired: true, historicalResultsAreNotForecasts: true, runvaraAttributionEstablished: false },
    note: 'Committed outcome groups are descriptive measurements. Legacy reviews are unqualified. No usable opportunity priors are established without immutable action, domain and comparability evidence.'
  };
}
