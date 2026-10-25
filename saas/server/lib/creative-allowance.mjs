import { creativeDigest, CREATIVE_PHASES } from './creative-safety.mjs';

// Credentials, prices and permission are never accepted from browser fields.
// The disabled-by-default switch only makes the protected contract available;
// empty/unverified database policies still deny every new submission.
export const creativeAllowancesEnabled = env => env.RUNVARA_CREATIVE_ALLOWANCES === 'enabled/v1';
export const CREATIVE_CONTRACTS = Object.freeze({
  canva: Object.freeze({ asset_upload: 'canva-asset-upload/v1', autofill: 'canva-autofill/v1', export: 'canva-export-png-pro/v1' }),
  runway: Object.freeze({ generation: 'runway-product-ad-10s/v1' })
});
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const creativeAllowanceError = (code, status = 409) => Object.assign(new Error(code), { code, status });
const fail = () => { throw creativeAllowanceError('CREATIVE_ALLOWANCE_INPUT_INVALID', 400); };
function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !fields.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key))) fail();
  return value;
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail(); return value; }
function integer(value, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum) fail(); return value; }
function hash(value) { if (typeof value !== 'string' || !HASH.test(value)) fail(); return value; }
function timestamp(value) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(); return value; }
function micros(value) { if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,59})$/.test(value)) fail(); return BigInt(value); }
function budget(value) {
  const amounts = ['limitMicros','reservedMicros','heldMicros','spentMicros','releasedMicros','uncertainMicros','overrunMicros','availableMicros'];
  object(value, [...amounts, 'overrunBlocked']);
  for (const key of amounts) micros(value[key]);
  if (typeof value.overrunBlocked !== 'boolean'
    || micros(value.reservedMicros) + micros(value.overrunMicros) !== micros(value.heldMicros) + micros(value.spentMicros) + micros(value.releasedMicros)
    || micros(value.uncertainMicros) > micros(value.heldMicros)) fail();
  const available = micros(value.limitMicros) - micros(value.heldMicros) - micros(value.spentMicros);
  if (micros(value.availableMicros) !== (available > 0n ? available : 0n) || (micros(value.overrunMicros) > 0n && !value.overrunBlocked)) fail();
}
export function creativeBinding(binding, context) {
  object(binding, ['workspaceId', 'campaignId', 'requestId', 'provider', 'phase', 'inputDigest']);
  object(context, ['endpoint', 'payloadDigest', 'accountBinding', 'sourceDigest', 'sourcePreview', 'payloadPreview']);
  const { provider, phase } = binding;
  if (!CREATIVE_PHASES[provider]?.includes(phase)) fail();
  const endpoint = provider === 'runway' ? 'https://api.dev.runwayml.com/v1/recipes/product_ad'
    : `https://api.canva.com/rest/v1/${{ asset_upload: 'asset-uploads', autofill: 'autofills', export: 'exports' }[phase]}`;
  if (context.endpoint !== endpoint) fail();
  const result = { workspaceId: id(binding.workspaceId), campaignId: id(binding.campaignId), requestId: id(binding.requestId),
    provider, phase, endpoint, payloadDigest: hash(context.payloadDigest), accountBinding: hash(context.accountBinding), sourceDigest: hash(context.sourceDigest) };
  if (creativeDigest(result) !== hash(binding.inputDigest)) fail();
  for (const [preview, digest] of [['sourcePreview','sourceDigest'], ['payloadPreview','payloadDigest']]) {
    if (typeof context[preview] !== 'string' || Buffer.byteLength(context[preview]) > 32768 || creativeDigest(context[preview]) !== context[digest]) fail();
    try { const value = JSON.parse(context[preview]); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); } catch { fail(); }
  }
  return { ...result, inputDigest: binding.inputDigest, contractId: CREATIVE_CONTRACTS[provider][phase], sourcePreview: context.sourcePreview, payloadPreview: context.payloadPreview };
}
function actor(auth) {
  if (auth?.user?.role !== 'owner' || auth.session?.sub !== auth.user.id) throw creativeAllowanceError('ROLE_DENIED', 403);
  return { p_workspace_id: id(auth.session.workspaceId), p_actor_id: id(auth.session.sub), p_session_version: integer(Number(auth.session.sessionVersion), 1) };
}
export function creativeRpcParams(name, workspaceId, input) {
  id(workspaceId);
  if (name === 'prepare') {
    object(input, ['auth', 'revision', 'operationId', 'binding']);
    if (!UUID.test(input.operationId || '') || input.binding?.workspaceId !== workspaceId) fail();
    const identity = actor(input.auth); if (identity.p_workspace_id !== workspaceId) fail();
    return { ...identity, p_expected_revision: id(input.revision), p_operation_id: input.operationId, p_binding: input.binding };
  }
  if (name === 'decide' || name === 'review') {
    object(input, name === 'decide' ? ['auth', 'approvalId', 'revision', 'decision'] : ['auth', 'requestId']);
    const identity = actor(input.auth); if (identity.p_workspace_id !== workspaceId) fail();
    if (name === 'review') return { ...identity, p_request_id: id(input.requestId) };
    if (!['approved', 'rejected', 'revoked'].includes(input.decision)) fail();
    return { ...identity, p_approval_id: id(input.approvalId), p_expected_approval_revision: integer(input.revision, 1), p_decision: input.decision };
  }
  if (name === 'reserve') {
    object(input, ['revision', 'binding']);
    if (input.binding?.workspaceId !== workspaceId) fail();
    return { p_workspace_id: workspaceId, p_expected_revision: id(input.revision), p_binding: input.binding };
  }
  if (name === 'confirm') {
    object(input, ['revision', 'reservationId', 'claimId', 'inputDigest']);
    return { p_workspace_id: workspaceId, p_expected_revision: id(input.revision), p_reservation_id: id(input.reservationId),
      p_claim_id: id(input.claimId), p_input_digest: hash(input.inputDigest) };
  }
  if (name === 'observe') {
    object(input, ['reservationId', 'inputDigest', 'outcome', 'upstreamId']);
    if (!['uncertain', 'accepted', 'completed'].includes(input.outcome)) fail();
    return { p_workspace_id: workspaceId, p_reservation_id: id(input.reservationId), p_input_digest: hash(input.inputDigest),
      p_outcome: input.outcome, p_upstream_id: input.upstreamId == null ? null : id(input.upstreamId) };
  }
  if (name === 'settle') {
    object(input, ['reservationId', 'inputDigest', 'receipt']);
    const r = object(input.receipt, ['type','id','providerAccountId','currency','costMicros','upstreamId','evidenceDigest']);
    if (!['provider_bill/v1','not_dispatched/v1'].includes(r.type) || r.currency !== 'USD') fail();
    id(r.id); id(r.providerAccountId); hash(r.evidenceDigest); micros(r.costMicros);
    if (r.type === 'not_dispatched/v1') { if (r.upstreamId !== '' || r.costMicros !== '0') fail(); }
    else id(r.upstreamId);
    return { p_workspace_id: workspaceId, p_reservation_id: id(input.reservationId), p_input_digest: hash(input.inputDigest), p_receipt: r };
  }
  fail();
}
export function creativeRpcResult(name, value, params) {
  try {
    if (name === 'settle') {
      object(value, ['ok','reservationId','status','accountedCostMicros']);
      if (value.ok !== true || value.reservationId !== params.p_reservation_id || !['settled','overrun','cancelled_pre_dispatch'].includes(value.status)
        || value.accountedCostMicros !== params.p_receipt.costMicros) fail();
      micros(value.accountedCostMicros);
      if ((value.status === 'cancelled_pre_dispatch') !== (params.p_receipt.type === 'not_dispatched/v1')) fail();
      return value;
    }
    if (name === 'reserve') {
      object(value, ['allowed', 'workspaceId', 'campaignId', 'requestId', 'provider', 'phase', 'inputDigest', 'approvalId', 'approvalRevision',
        'reservationId', 'policyRevision', 'currency', 'maxCostMicros', 'verifiedUpperBound', 'expiresAt', 'reason']);
      if (value.allowed === false && typeof value.reason === 'string' && /^CREATIVE_[A-Z_]+$/.test(value.reason)) return { allowed: false, reason: value.reason };
      if (value.allowed !== true || value.currency !== 'USD' || value.verifiedUpperBound !== true || value.reason !== undefined) fail();
      for (const key of ['workspaceId', 'campaignId', 'requestId', 'provider', 'phase', 'inputDigest']) if (value[key] !== params.p_binding[key]) fail();
      for (const key of ['approvalId', 'reservationId', 'policyRevision']) id(value[key]);
      integer(value.approvalRevision, 1); integer(value.maxCostMicros); timestamp(value.expiresAt);
      return value;
    }
    if (name === 'confirm' || name === 'observe') {
      object(value, ['ok', 'reservationId', 'status']);
      if (value.ok !== true || value.reservationId !== params.p_reservation_id || !['dispatching', 'uncertain', 'accepted', 'completed'].includes(value.status)) fail();
      if (name === 'confirm' && value.status !== 'dispatching') fail();
      return value;
    }
    const rows = name === 'review' ? value : [value];
    if (!Array.isArray(rows) || rows.length > 3) fail();
    for (const row of rows) {
      object(row, ['id', 'approvalType', 'workspaceId', 'campaignId', 'requestId', 'provider', 'phase', 'inputDigest', 'accountBinding', 'contractId',
        'status', 'revision', 'maxCostMicros', 'currency', 'expiresAt', 'policyRevision', 'priceRevision', 'reservationStatus', 'upstreamId',
        'sourcePreview', 'payloadPreview', 'providerAccountId', 'accountingStatus', 'accountedCostMicros', 'heldCostMicros', 'tenantBudget', 'accountBudget']);
      if (row.approvalType !== 'creative_phase/v1' || row.workspaceId !== params.p_workspace_id || row.currency !== 'USD' || !CREATIVE_PHASES[row.provider]?.includes(row.phase)
        || row.contractId !== CREATIVE_CONTRACTS[row.provider][row.phase] || !['pending', 'approved', 'rejected', 'revoked'].includes(row.status)) fail();
      for (const key of ['id', 'workspaceId', 'campaignId', 'requestId', 'policyRevision', 'priceRevision']) id(row[key]);
      hash(row.inputDigest); hash(row.accountBinding); integer(row.revision, 1); integer(row.maxCostMicros); timestamp(row.expiresAt);
      id(row.providerAccountId);
      for (const key of ['sourcePreview','payloadPreview']) if (typeof row[key] !== 'string' || Buffer.byteLength(row[key]) > 32768) fail();
      budget(row.tenantBudget); budget(row.accountBudget); micros(row.heldCostMicros);
      if (row.accountedCostMicros != null) micros(row.accountedCostMicros);
      if (row.accountingStatus != null && !['held','uncertain','settled','cancelled_pre_dispatch','overrun'].includes(row.accountingStatus)) fail();
      if (['settled','overrun','cancelled_pre_dispatch'].includes(row.accountingStatus)
        && (row.accountedCostMicros == null || row.heldCostMicros !== '0')) fail();
      if (['held','uncertain'].includes(row.accountingStatus) && (row.accountedCostMicros !== null || row.heldCostMicros !== String(row.maxCostMicros))) fail();
      if (row.upstreamId != null) id(row.upstreamId);
      if (row.reservationStatus != null && !['held','dispatching','uncertain','accepted','completed','cancelled_pre_dispatch'].includes(row.reservationStatus)) fail();
      if (name === 'review' && row.requestId !== params.p_request_id || name === 'decide' && row.id !== params.p_approval_id
        || name === 'prepare' && ['campaignId','requestId','provider','phase','inputDigest','accountBinding','contractId','sourcePreview','payloadPreview'].some(key => row[key] !== params.p_binding[key])) fail();
    }
    return value;
  } catch { throw creativeAllowanceError('CREATIVE_ALLOWANCE_RESPONSE_UNCERTAIN', 503); }
}

export function createCreativeIssuer({ store, state, env, auth = null, operationId = null, prepared = null }) {
  if (!creativeAllowancesEnabled(env) || store.provider !== 'supabase' || typeof store.creativeAllowanceRpc !== 'function') return undefined;
  const workspaceId = state.workspace.id;
  const issuer = async function authorizeCreativePhase(binding, context) {
    if (!creativeAllowancesEnabled(env)) return null;
    const descriptor = creativeBinding(binding, context);
    if (descriptor.workspaceId !== workspaceId) fail();
    if (prepared) {
      const result = await store.creativeAllowanceRpc('prepare', workspaceId, { auth, revision: state._revision, operationId, binding: descriptor });
      prepared.push(result);
      return null; // Preparing an exact review can NEVER authorize a POST.
    }
    return store.creativeAllowanceRpc('reserve', workspaceId, { revision: state._revision, binding: descriptor });
  };
  issuer.protectedCreativeIssuer = true;
  issuer.confirmDispatch = async claim => {
    if (!creativeAllowancesEnabled(env)) throw creativeAllowanceError('CREATIVE_ALLOWANCES_DISABLED');
    return store.creativeAllowanceRpc('confirm', workspaceId, { revision: state._revision,
      reservationId: claim.allowance.reservationId, claimId: claim.id, inputDigest: claim.inputDigest });
  };
  issuer.recordOutcome = (claim, outcome, upstreamId = null) => store.creativeAllowanceRpc('observe', workspaceId, {
    reservationId: claim.allowance.reservationId, inputDigest: claim.inputDigest, outcome, upstreamId });
  return issuer;
}
