const clean = (value, max = 180) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const round = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;

function verifiedContribution(raw = {}) {
  if (!(raw.verified === true || raw.status === 'verified')) return null;
  const value = raw.incrementalContribution;
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  return Number(value);
}

function experimentRows(state = {}) {
  const rows = [];
  for (const experiment of state.revenueEngine?.experiments || []) {
    if (!['completed','measured','closed'].includes(String(experiment.status || '').toLowerCase())) continue;
    const impact = experiment.impact || experiment.result || experiment.outcome;
    if (!impact || typeof impact !== 'object') continue;
    const contribution = verifiedContribution(impact);
    if (contribution === null) continue;
    const kind = clean(experiment.kind || experiment.type || experiment.category || 'unknown', 80).toLowerCase() || 'unknown';
    rows.push({
      id: clean(experiment.id, 180),
      kind,
      contribution: round(contribution),
      measuredAt: clean(impact.measuredAt || experiment.completedAt || experiment.updatedAt || experiment.createdAt, 80) || null,
      method: clean(impact.method || impact.basis || 'recorded-evidence', 160)
    });
  }
  return rows;
}

function workRows(state = {}) {
  const rows = [];
  for (const work of state.workRecords || []) {
    if (work.status !== 'COMPLETED') continue;
    for (const evidence of work.evidence || []) {
      const impact = evidence?.impact && typeof evidence.impact === 'object' ? evidence.impact : evidence;
      const contribution = verifiedContribution(impact || {});
      if (contribution === null) continue;
      const kind = clean(impact?.opportunityKind || evidence?.opportunityKind || work.opportunityKind || work.kind || 'unknown', 80).toLowerCase() || 'unknown';
      rows.push({
        id: clean(impact?.id || evidence?.id || `work:${work.id}`, 180),
        kind,
        contribution: round(contribution),
        measuredAt: clean(impact?.measuredAt || evidence?.createdAt || work.updatedAt, 80) || null,
        method: clean(impact?.method || impact?.basis || 'recorded-evidence', 160)
      });
    }
  }
  return rows;
}

function unique(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = row.id || `${row.kind}:${row.measuredAt}:${row.contribution}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function confidence(samples) {
  if (samples >= 8) return 'high';
  if (samples >= 4) return 'medium';
  if (samples >= 2) return 'low';
  return 'insufficient';
}

function summarize(kind, rows, minSamples) {
  const values = rows.map(row => Number(row.contribution)).sort((a,b) => a-b);
  const samples = values.length;
  const total = values.reduce((sum, value) => sum + value, 0);
  const average = samples ? total / samples : null;
  const median = samples ? (samples % 2 ? values[(samples - 1) / 2] : (values[samples / 2 - 1] + values[samples / 2]) / 2) : null;
  const positive = values.filter(value => value > 0).length;
  return {
    kind,
    samples,
    usableForGuidance: samples >= minSamples,
    confidence: confidence(samples),
    averageIncrementalContribution: round(average),
    medianIncrementalContribution: round(median),
    positiveRatePercent: samples ? round(positive / samples * 100, 1) : null,
    observedMin: samples ? round(values[0]) : null,
    observedMax: samples ? round(values.at(-1)) : null,
    evidenceIds: rows.map(row => row.id).slice(0, 50)
  };
}

export function deriveLearning(state = {}, { minSamples = 2 } = {}) {
  const requiredSamples = Math.max(2, Math.min(20, Number(minSamples) || 2));
  const evidence = unique([...experimentRows(state), ...workRows(state)]);
  const grouped = new Map();
  for (const row of evidence) {
    const bucket = grouped.get(row.kind) || [];
    bucket.push(row);
    grouped.set(row.kind, bucket);
  }
  const priors = [...grouped.entries()]
    .map(([kind, rows]) => summarize(kind, rows, requiredSamples))
    .sort((a,b) => b.samples - a.samples || a.kind.localeCompare(b.kind));

  return {
    schema:'runvara-learning/v1',
    workspaceId:clean(state.workspace?.id, 120),
    generatedAt:new Date().toISOString(),
    minimumSamples:requiredSamples,
    priors,
    evidence:evidence.slice(0, 200),
    summary:{
      verifiedLearningEvents:evidence.length,
      domainsObserved:priors.length,
      domainsUsableForGuidance:priors.filter(item => item.usableForGuidance).length
    },
    safeguards:{
      verifiedOutcomesOnly:true,
      forecastsExcluded:true,
      unverifiedResultsExcluded:true,
      singleObservationCannotSetGuidance:true,
      externalWrites:false,
      approvalsPreserved:true,
      rawCustomerIdentityIncluded:false
    },
    note:'Learning priors are descriptive evidence from verified realised outcomes. They do not authorise actions, guarantee future uplift, or bypass Approval Centre controls.'
  };
}
