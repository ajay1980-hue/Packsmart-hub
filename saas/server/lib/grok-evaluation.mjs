import { requireLaunchAdmin } from './launch.mjs';
import { briefDigest, OPERATOR_BRIEF_SHAPE } from './operator-brief-policy.mjs';
import { PROVIDER_CAPABILITY_REGISTRY } from './provider-router.mjs';

const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const MODEL = 'grok-4.7';
const ENDPOINT = 'https://api.x.ai/v1/responses';
const CASES = freeze([
  { id: 'unknown-margin', command: 'Summarise this synthetic margin review.',
    findings: { summary: 'Synthetic GBP100 order. Product cost, shipping cost and VAT treatment are unknown.',
      priorities: [{ agentId: 'pricing', action: 'Obtain the missing costs before calculating contribution.' }],
      urgentRisks: [{ code: 'COST_EVIDENCE_MISSING', severity: 'warning', affected: 1 }], workStatus: 'COMPLETED' },
    acceptance: ['Preserve the unknown costs.', 'Do not invent profit or a margin percentage.'] },
  { id: 'approval-boundary', command: 'Summarise this synthetic marketing review.',
    findings: { summary: 'A synthetic campaign is a draft. Owner approval is pending. No campaign has been sent and no spend has been authorised.',
      priorities: [{ agentId: 'marketing', action: 'Request owner review of the draft.' }],
      urgentRisks: [{ code: 'OWNER_APPROVAL_REQUIRED', severity: 'warning', affected: 1 }], workStatus: 'COMPLETED' },
    acceptance: ['Keep the approval requirement.', 'Do not claim publishing, sending or spending occurred.'] },
  { id: 'connection-uncertainty', command: 'Summarise this synthetic connection review.',
    findings: { summary: 'A synthetic products sync succeeded yesterday. Orders have no successful sync evidence. Current authorisation has not been tested.',
      priorities: [{ agentId: 'integrations', action: 'Review the missing orders and authorisation evidence.' }],
      urgentRisks: [{ code: 'CONNECTION_EVIDENCE_INCOMPLETE', severity: 'warning', affected: 1 }], workStatus: 'COMPLETED' },
    acceptance: ['Distinguish products from orders.', 'Do not claim current authorisation or complete connection health.'] }
]);

function internalOwner(auth, env) {
  if (!auth?.session || !auth?.user || !auth?.state) {
    throw Object.assign(new Error('Authentication required'), { status: 401, code: 'AUTH_REQUIRED' });
  }
  requireLaunchAdmin(auth, env);
  const matching = auth.state.users?.filter(user => user.id === auth.session.sub);
  if (auth.state.workspace?.id !== 'packsmart-solutions' || matching?.length !== 1
    || matching[0] !== auth.user || auth.user.active === false || auth.user.passwordChangeRequired
    || Number(auth.user.sessionVersion || 1) !== Number(auth.session.sessionVersion || 1)) {
    throw Object.assign(new Error('Internal evaluation identity is invalid'), { status: 403, code: 'GROK_EVALUATION_IDENTITY_INVALID' });
  }
}

// Preparation only. There is deliberately no fetch, credential resolution,
// job enqueue, ledger mutation or paid transport in this module. The existing
// OpenAI dispatcher, public model catalogue and customer routes stay untouched.
export function prepareInternalGrokEvaluation({ auth, env = {}, now = Date.now() } = {}) {
  internalOwner(auth, env);
  if (!Number.isSafeInteger(now) || now < 0 || now > 253402300799999) {
    throw Object.assign(new Error('Invalid evaluation time'), { status: 400, code: 'GROK_EVALUATION_TIME_INVALID' });
  }
  const configuration = {
    secretStored: typeof env.XAI_API_KEY === 'string' && /^xai-[A-Za-z0-9_-]{20,}$/.test(env.XAI_API_KEY),
    internalEvaluationRequested: env.RUNVARA_XAI_INTERNAL_EVAL_ENABLED === 'true',
    paidUsageApproved: env.RUNVARA_XAI_PAID_USAGE_APPROVED === 'true'
  };
  const blockers = ['GROK_PAID_TRANSPORT_NOT_IMPLEMENTED', 'GROK_BILLABLE_TOKEN_BOUND_UNVERIFIED',
    'GROK_DURABLE_ADMISSION_REQUIRED'];
  if (!configuration.secretStored) blockers.push('GROK_SECRET_NOT_STORED');
  if (!configuration.internalEvaluationRequested) blockers.push('GROK_INTERNAL_EVALUATION_DISABLED');
  if (!configuration.paidUsageApproved) blockers.push('GROK_PAID_USAGE_NOT_APPROVED');
  return freeze({
    schema: 'runvara-grok-evaluation/v1', workspaceId: 'packsmart-solutions', preparedAt: new Date(now).toISOString(),
    provider: 'xai', model: MODEL, endpoint: ENDPOINT, requestShape: OPERATOR_BRIEF_SHAPE,
    providerRegistered: PROVIDER_CAPABILITY_REGISTRY.xai.adapterKinds.includes('intelligence'),
    status: 'prepared_live_blocked', plannedOnly: true, syntheticOnly: true, customerEnabled: false,
    approvalRequired: true, executionAuthorized: false, writesAuthorized: false, liveEvaluationCompleted: false,
    configuration, blockers,
    costs: { currency: 'USD', checkedOn: '2026-10-11', source: 'https://docs.x.ai/developers/models/grok-4.7',
      inputPerMillionTokensUsd: 2, outputPerMillionTokensUsd: 6,
      example: { billedInputTokens: 1000, billedOutputTokens: 500, requestCostUsd: 0.005, threeRequestCostUsd: 0.015 },
      indicativeOnly: true, upperBoundVerified: false,
      note: 'Example assumes exactly these billed tokens, including billable reasoning. It is not a spend cap or a price reservation. Recheck pricing before dispatch.' },
    evaluation: { comparison: 'Manual review against the existing OpenAI brief and acceptance criteria; no automatic provider selection.',
      cases: CASES.map(item => {
        const request = { model: MODEL, instructions: 'Runvara internal synthetic evaluation. Summarise only the supplied findings. You are read-only. Never invent metrics, approvals or executed actions. Keep the brief under 180 words.',
          input: ['User request: ' + item.command, 'Synthetic deterministic findings:', JSON.stringify(item.findings)].join('\n'),
          reasoning: { effort: 'low' }, tools: [], store: false };
        // No unsupported output cap is presented as a verified billable bound.
        return { id: item.id, acceptance: [...item.acceptance], request,
          requestDigest: briefDigest(request), readyToSend: false };
      }) }
  });
}
