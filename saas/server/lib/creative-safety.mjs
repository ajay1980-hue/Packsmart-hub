import crypto from 'node:crypto';

// This boundary does not create permissions or decide a price. The production
// caller supplies no allowance issuer until owner approval + atomic budget
// reservation are implemented. Browser fields/settings are never a substitute.
export const CREATIVE_SAFETY_SCHEMA = 'runvara-creative-safety/v1';
export const CREATIVE_PHASES = Object.freeze({ canva: ['asset_upload', 'autofill', 'export'], runway: ['generation'] });
export const CREATIVE_ALLOWANCE_ACTION = 'The owner must approve this exact creative phase and a verified finite provider allowance before new generation can start. Existing provider connections are unchanged.';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const validId = value => typeof value === 'string' && ID.test(value);
const HASH = /^[0-9a-f]{64}$/;
const safeCode = (error, fallback) => /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : fallback;
const record = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const lifecycles = new WeakSet();
export const isCreativeLifecycle = value => Boolean(value && typeof value === 'object' && lifecycles.has(value));
const error = (code, status = 409) => Object.assign(new Error(code), { code, status });
const iso = now => new Date(now()).toISOString();
export const creativeDigest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

export function newCreativeRequest({ workspaceId, campaignId, provider, kind, formats, now = Date.now }) {
  if (!validId(workspaceId) || !validId(campaignId) || !Object.hasOwn(CREATIVE_PHASES, provider)) throw error('CREATIVE_IDENTITY_INVALID');
  const id = `creative_${crypto.randomUUID()}`;
  return { id, provider, kind, status: 'pending', formats: [...formats], safety: {
    schema: CREATIVE_SAFETY_SCHEMA, origin: 'server_created', workspaceId, campaignId, requestId: id,
    provider, createdAt: iso(now), phases: {}
  } };
}

export function createCreativeEffects() {
  return { providerReads: 0, submissionAttempts: 0, confirmedSubmissions: 0, uncertainSubmissions: 0,
    blockedSubmissions: 0, historicalExposureUnknown: false, externalWrites: false, spend: 0, costStatus: 'not_incurred' };
}
export function summarizeCreativeEffects(effects) {
  return { ...effects,
    externalWrites: effects.confirmedSubmissions ? true : effects.uncertainSubmissions ? null : false,
    spend: effects.submissionAttempts || effects.historicalExposureUnknown ? null : 0,
    costStatus: effects.submissionAttempts || effects.historicalExposureUnknown ? 'unknown' : 'not_incurred'
  };
}
export function knownCreativeJob(request) {
  return Boolean(request?.status === 'in_progress' && (
    request.provider === 'canva' && CREATIVE_PHASES.canva.includes(request.stage) && validId(request.jobId)
    || request.provider === 'runway' && request.stage === 'generation' && validId(request.taskId)
  ));
}

function boundIdentity(state, campaign, request, now) {
  const workspaceId = state?.workspace?.id;
  if (!validId(workspaceId) || !validId(campaign?.id) || !Object.hasOwn(CREATIVE_PHASES, request?.provider)
    || !state.marketing?.campaigns?.includes(campaign) || !campaign.creativeRequests?.includes(request)) throw error('CREATIVE_IDENTITY_INVALID');
  if (!request.safety) {
    // Historical pending/failed requests have no durable proof of non-dispatch.
    // Giving them an identity permits observation, never a new POST entitlement.
    request.id ||= `creative_legacy_${creativeDigest([workspaceId, campaign.id, request.provider, request.kind || '', request.jobId || request.taskId || '']).slice(0, 32)}`;
    request.safety = { schema: CREATIVE_SAFETY_SCHEMA, origin: 'legacy_unknown', workspaceId,
      campaignId: campaign.id, requestId: request.id, provider: request.provider, createdAt: iso(now), phases: {} };
  }
  const safety = request.safety;
  if (!validId(request.id) || !record(safety) || safety.schema !== CREATIVE_SAFETY_SCHEMA
    || !['server_created', 'legacy_unknown'].includes(safety.origin) || safety.workspaceId !== workspaceId
    || safety.campaignId !== campaign.id || safety.requestId !== request.id || safety.provider !== request.provider
    || !record(safety.phases) || Object.keys(safety.phases).some(phase => !CREATIVE_PHASES[request.provider].includes(phase))) throw error('CREATIVE_IDENTITY_INVALID');
  if (campaign.creativeRequests.filter(row => row.id === request.id).length !== 1) throw error('CREATIVE_IDENTITY_AMBIGUOUS');
  return safety;
}

function validateAllowance(value, binding, now) {
  const fields = ['allowed', 'workspaceId', 'campaignId', 'requestId', 'provider', 'phase', 'inputDigest',
    'approvalId', 'approvalRevision', 'reservationId', 'policyRevision', 'currency', 'maxCostMicros', 'verifiedUpperBound', 'expiresAt'];
  if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key)
    || !('value' in Object.getOwnPropertyDescriptor(value, key))) || value.allowed !== true) return null;
  for (const key of ['workspaceId', 'campaignId', 'requestId', 'provider', 'phase', 'inputDigest']) if (value[key] !== binding[key]) return null;
  if (!validId(value.approvalId) || !validId(value.reservationId) || !validId(value.policyRevision)
    || !Number.isSafeInteger(value.approvalRevision) || value.approvalRevision < 1
    || value.currency !== 'USD' || !Number.isSafeInteger(value.maxCostMicros) || value.maxCostMicros < 0
    || value.verifiedUpperBound !== true || typeof value.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now()) return null;
  return Object.fromEntries(fields.filter(key => key !== 'allowed').map(key => [key, value[key]]));
}

export function createCreativeLifecycle({ state, campaign, request, persist, durableStore = false, authorizePhase,
  now = Date.now, effects = createCreativeEffects() }) {
  const safety = boundIdentity(state, campaign, request, now);
  if (safety.origin === 'legacy_unknown' || knownCreativeJob(request)
    || Object.values(safety.phases).some(phase => ['dispatching', 'uncertain', 'accepted', 'completed'].includes(phase?.status))) effects.historicalExposureUnknown = true;

  function block(code = 'CREATIVE_ALLOWANCE_REQUIRED', uncertain = false) {
    request.blockReason = code;
    request.ownerAction = code === 'CREATIVE_ALLOWANCE_REQUIRED' ? CREATIVE_ALLOWANCE_ACTION
      : 'Review the recorded provider job and unresolved submission before preparing a separately authorized creative request. This request will not be sent again.';
    effects.blockedSubmissions++;
    if (uncertain) effects.historicalExposureUnknown = true;
    return { blocked: true, code };
  }
  async function save(requireDurable = false, expectedClaim = null) {
    if (typeof persist !== 'function') {
      if (requireDurable) throw error('CREATIVE_DURABLE_STORE_REQUIRED', 503);
      return;
    }
    const previous = state._revision;
    const claimSnapshot = expectedClaim ? structuredClone(expectedClaim) : null;
    try {
      const saved = await persist();
      if (requireDurable && (durableStore !== true || typeof previous !== 'string' || !previous
        || typeof state._revision !== 'string' || state._revision === previous
        || saved?.workspace?.id !== state.workspace.id || saved?._revision !== state._revision)) throw error('CREATIVE_CLAIM_ACK_INVALID', 503);
      if (requireDurable && claimSnapshot) {
        const campaigns = saved.marketing?.campaigns?.filter(row => row.id === campaign.id) || [];
        const requests = campaigns[0]?.creativeRequests?.filter(row => row.id === request.id) || [];
        const recorded = requests[0]?.safety?.phases?.[claimSnapshot.phase];
        if (campaigns.length !== 1 || requests.length !== 1 || requests[0].safety.workspaceId !== safety.workspaceId
          || requests[0].safety.campaignId !== campaign.id || requests[0].safety.requestId !== request.id
          || !recorded || creativeDigest(recorded) !== creativeDigest(claimSnapshot)) throw error('CREATIVE_CLAIM_ACK_INVALID', 503);
      }
    } catch (cause) {
      const failure = error(safeCode(cause, 'CREATIVE_PERSISTENCE_UNCERTAIN'), 503);
      failure.creativePersistenceFailure = true;
      failure.creativeEffects = summarizeCreativeEffects(effects);
      throw failure;
    }
  }

  async function mutate({ phase, endpoint, payloadDigest, accountBinding, sourceDigest, checkBinding, submit, accepted }) {
    if (!CREATIVE_PHASES[request.provider].includes(phase) || !HASH.test(payloadDigest || '')
      || !HASH.test(accountBinding || '') || !HASH.test(sourceDigest || '') || typeof checkBinding !== 'function'
      || typeof endpoint !== 'string' || typeof submit !== 'function' || typeof accepted !== 'function') throw error('CREATIVE_PHASE_INVALID');
    const inputDigest = creativeDigest({ workspaceId: safety.workspaceId, campaignId: campaign.id, requestId: request.id,
      provider: request.provider, phase, endpoint, payloadDigest, accountBinding, sourceDigest });
    const previous = safety.phases[phase];
    if (previous) {
      if (previous.inputDigest !== inputDigest) return block('CREATIVE_INPUT_CHANGED', true);
      return block('CREATIVE_SUBMISSION_ALREADY_CLAIMED', true);
    }
    if (safety.origin !== 'server_created') return block('CREATIVE_LEGACY_DISPATCH_UNVERIFIED', true);
    if (typeof authorizePhase !== 'function') return block();
    if (durableStore !== true || typeof persist !== 'function' || typeof state._revision !== 'string') return block('CREATIVE_DURABLE_STORE_REQUIRED');
    const binding = { workspaceId: safety.workspaceId, campaignId: campaign.id, requestId: request.id,
      provider: request.provider, phase, inputDigest };
    // Only a future trusted server issuer may reserve an exact allowance. No
    // state/settings/raw provider price or browser estimate is accepted here.
    const allowance = validateAllowance(await authorizePhase(Object.freeze({ ...binding })), binding, now);
    if (!allowance) return block();
    Object.freeze(allowance);
    // Authorization is asynchronous. A sibling invocation sharing this request
    // may have installed its claim while the issuer was awaited.
    if (boundIdentity(state, campaign, request, now) !== safety || request.id !== binding.requestId
      || campaign.id !== binding.campaignId || safety.workspaceId !== binding.workspaceId) throw error('CREATIVE_IDENTITY_INVALID');
    if (safety.phases[phase]) return block('CREATIVE_SUBMISSION_ALREADY_CLAIMED', true);
    const claim = { id: `creative_claim_${crypto.randomUUID()}`, phase, status: 'dispatching', inputDigest,
      endpoint, payloadDigest, accountBinding, sourceDigest, allowance: { ...allowance }, claimedAt: iso(now), upstreamId: null,
      costStatus: 'unknown', accountedCostMicros: null };
    // Authority is held independently of mutable workspace data. Neither a
    // changed saved receipt nor a mutated claim can extend this authorization.
    const claimDigest = creativeDigest(claim);
    safety.phases[phase] = claim;
    request.blockReason = null; request.ownerAction = null;
    // Persistence failure is outside the POST catch: never pretend a failed CAS
    // is a provider failure, and never retry the business callback.
    await save(true, claim);
    // A slow persistence request must not carry expired authority or changed
    // source/credential/payload bindings across the external-send boundary.
    if (Date.parse(allowance.expiresAt) <= now()) return block('CREATIVE_ALLOWANCE_EXPIRED', true);
    let live;
    try {
      if (boundIdentity(state, campaign, request, now) !== safety) return block('CREATIVE_INPUT_CHANGED', true);
      live = checkBinding();
    } catch { return block('CREATIVE_INPUT_CHANGED', true); }
    if (request.safety !== safety || safety.phases[phase] !== claim || claim.status !== 'dispatching'
      || creativeDigest(claim) !== claimDigest
      || live?.payloadDigest !== payloadDigest || live?.accountBinding !== accountBinding || live?.sourceDigest !== sourceDigest) return block('CREATIVE_INPUT_CHANGED', true);
    // Rebinding can itself take time (for example hashing a prepared image).
    // Keep the deadline check adjacent to the actual dispatch boundary.
    if (Date.parse(allowance.expiresAt) <= now()) return block('CREATIVE_ALLOWANCE_EXPIRED', true);
    effects.submissionAttempts++;
    let patch;
    try {
      const response = await submit();
      patch = accepted(response);
      const upstreamId = phase === 'generation' ? patch?.taskId : patch?.jobId;
      if (!validId(upstreamId) || !record(patch) || patch.provider !== request.provider || patch.status !== 'in_progress'
        || patch.stage !== phase) throw error('CREATIVE_PROVIDER_RECEIPT_UNVERIFIED', 502);
      claim.status = 'accepted'; claim.upstreamId = upstreamId; claim.acceptedAt = iso(now);
      Object.assign(request, patch);
      effects.confirmedSubmissions++;
    } catch (cause) {
      claim.status = 'uncertain'; claim.errorCode = safeCode(cause, 'CREATIVE_SUBMISSION_UNCERTAIN');
      claim.uncertainAt = iso(now); request.blockReason = 'CREATIVE_SUBMISSION_UNCERTAIN';
      request.ownerAction = 'The provider may have accepted this request. Check its recorded job before any new submission; automatic replay is blocked.';
      effects.uncertainSubmissions++;
      effects.historicalExposureUnknown = true;
      await save();
      return { blocked: true, uncertain: true, code: 'CREATIVE_SUBMISSION_UNCERTAIN' };
    }
    // Receipt failure propagates. A restart sees either the original permanent
    // intent or the accepted upstream ID, and neither permits another POST.
    await save();
    return { accepted: true, upstreamId: claim.upstreamId };
  }

  async function observe(patch, phase = request.stage) {
    if (!record(patch)) throw error('CREATIVE_OBSERVATION_INVALID');
    Object.assign(request, patch);
    const claim = safety.phases[phase];
    if (claim?.status === 'accepted' && (patch.status === 'complete' || patch.stage !== phase)) {
      claim.status = 'completed'; claim.observedAt = iso(now);
    }
    request.lastPollError = null;
    await save();
    return request;
  }
  const lifecycle = { mutate, observe, block, safety, effects, canAuthorize: typeof authorizePhase === 'function',
    readStarted() { effects.providerReads++; effects.historicalExposureUnknown = true; },
    readFailed(cause) { request.lastPollError = safeCode(cause, 'CREATIVE_STATUS_READ_FAILED'); request.ownerAction = 'The existing provider job is retained. Retry its status check; no new generation is authorized.'; },
    summary: () => summarizeCreativeEffects(effects) };
  lifecycles.add(lifecycle);
  return lifecycle;
}
