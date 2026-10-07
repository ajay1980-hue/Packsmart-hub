import crypto from 'node:crypto';
import { businessObjectivesSnapshot } from './business-objectives.mjs';

export const OBJECTIVE_DISPATCH_PROPOSAL_SCHEMA = 'runvara-objective-dispatch-proposal/v1';
export const OBJECTIVE_DISPATCH_PROPOSAL_MAX_BYTES = 8192;
const SOURCE_MAX_BYTES = 131072;
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const blocked = (code, message) => Object.assign(new Error(message), { code, status: 409, definitive: true });
const invalid = () => blocked('WRITE_POLICY_INVALID', 'Execution restrictions could not be verified. Review the saved objectives.');

// Do not execute getters or silently discard unknown values while hashing.
function canonical(value, depth = 0) {
  if (depth > 12) throw invalid();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { if (value.length > SOURCE_MAX_BYTES) throw invalid(); return value; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw invalid(); return value; }
  if (!Array.isArray(value) && !plain(value)) throw invalid();
  const fields = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (fields.length > 1024 || fields.some(key => typeof key !== 'string' || !own(descriptors[key], 'value'))) throw invalid();
  if (Array.isArray(value)) {
    if (fields.length !== value.length + 1) throw invalid();
    return Array.from({ length: value.length }, (_, index) => {
      if (!own(descriptors, index)) throw invalid();
      return canonical(descriptors[index].value, depth + 1);
    });
  }
  return Object.fromEntries(fields.sort().map(key => [key, canonical(descriptors[key].value, depth + 1)]));
}
function serialized(value) {
  const result = JSON.stringify(canonical(value));
  if (Buffer.byteLength(result) > SOURCE_MAX_BYTES) throw invalid();
  return result;
}
const hash = value => crypto.createHash('sha256').update(serialized(value)).digest('hex');
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
const supported = write => write?.provider === 'shopify' && write?.input?.operation === 'product_content';

export function objectivePolicySourceFingerprint(state) {
  if (!plain(state)) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(state, 'businessObjectives');
  if (descriptor && !own(descriptor, 'value')) throw invalid();
  return hash(descriptor ? { present: true, objectives: descriptor.value } : { present: false });
}

export function captureObjectiveDispatchPolicy(state, write) {
  if (!supported(write)) return null;
  try {
    const sourceFingerprint = objectivePolicySourceFingerprint(state);
    // Full validation precedes selection. Invalid/foreign/duplicate objectives
    // cannot disappear from the applicable set by being filtered out first.
    const snapshot = businessObjectivesSnapshot(state);
    const matches = snapshot.objectives.filter(row => row.executionPolicy?.mode === 'enforce'
      && row.executionPolicy.scope.provider === write.provider && row.executionPolicy.scope.operation === write.input.operation
      && row.executionPolicy.scope.account === write.account);
    // Match outside the active window too. Pausing a restriction must stop its
    // actions, not remove the restriction and permit an unbound manual write.
    const policies = matches.map(({ effectiveStatus: _status, ...row }) => row).sort((a, b) => a.id.localeCompare(b.id));
    return freeze({ workspaceId: snapshot.workspaceId, sourceFingerprint, policies });
  } catch (error) {
    if (error?.code === 'WORKSPACE_MISMATCH') throw error;
    throw invalid();
  }
}

export function assertObjectivePolicySource(state, context) {
  if (context && (state?.workspace?.id !== context.workspaceId || objectivePolicySourceFingerprint(state) !== context.sourceFingerprint)) {
    throw blocked('WRITE_POLICY_SOURCE_CHANGED', 'Saved execution restrictions changed during this request. Review a new exact request.');
  }
}

export function protectObjectivePolicySource(state, context) {
  assertObjectivePolicySource(state, context);
  if (context && own(state, 'businessObjectives')) {
    // Supabase save snapshots are shallow while archives are awaited. Pin this
    // isolated request's source so an in-place edit cannot alter its CAS body.
    const descriptor = Object.getOwnPropertyDescriptor(state, 'businessObjectives');
    if (descriptor.configurable === false && descriptor.writable === false) { freeze(descriptor.value); return; }
    Object.defineProperty(state, 'businessObjectives', { value: freeze(JSON.parse(serialized(state.businessObjectives))),
      enumerable: true, configurable: false, writable: false });
  }
}

function proposalBody(write, context) {
  return {
    schema: OBJECTIVE_DISPATCH_PROPOSAL_SCHEMA, workspaceId: context.workspaceId, origin: 'owner_manual',
    writeId: write.id, provider: write.provider, operation: write.input.operation, inputDigest: write.digest,
    connectionId: write.connectionId, account: write.account, requestedBy: write.requestedBy,
    approvalKind: 'customer_facing_publish',
    policies: context.policies.map(row => ({ objectiveId: row.id, revision: row.revision, digest: hash(row) })),
    evidenceQualification: 'no_financial_execution_evidence'
  };
}

export function prepareObjectiveDispatchProposal(write, context) {
  if (!context || context.policies.length === 0) return null;
  const body = proposalBody(write, context), proposal = { ...body, digest: hash(body) };
  if (Buffer.byteLength(serialized(proposal)) > OBJECTIVE_DISPATCH_PROPOSAL_MAX_BYTES) throw blocked('WRITE_POLICY_PROPOSAL_TOO_LARGE', 'Execution restrictions exceed this request\'s safe size. Narrow their scope before preparing a change.');
  return freeze(proposal);
}

export function assertObjectiveDispatchBinding(write, approval, context) {
  if (!context) {
    if (own(write, 'objectivePolicyProposal')) throw invalid();
    return;
  }
  if (!own(write, 'objectivePolicyProposal')) {
    if (context.policies.length) throw blocked('WRITE_POLICY_REVIEW_REQUIRED', 'This request predates the current execution restrictions. Prepare a new exact request for owner review.');
    return; // Byte-identical legacy manual claim contracts stay usable.
  }
  const expected = prepareObjectiveDispatchProposal(write, context);
  if (!expected || serialized(write.objectivePolicyProposal) !== serialized(expected)) {
    throw blocked('WRITE_POLICY_REVIEW_REQUIRED', 'The execution restrictions or proposal changed. Prepare a new exact request for owner review.');
  }
  if (!approval || approval.payload?.objectivePolicyProposalDigest !== expected.digest
    || approval.type !== expected.approvalKind) throw blocked('WRITE_POLICY_APPROVAL_REQUIRED', 'The owner must approve this exact policy-bound proposal.');
}

export function assessObjectiveDispatchPolicy(write, context, now = Date.now()) {
  if (!context) return { allowed: true, blockers: [] };
  if (!Number.isSafeInteger(now) || now < 0) throw invalid();
  const blockers = [];
  const add = (code, message) => { if (!blockers.some(item => item.code === code)) blockers.push({ code, message }); };
  for (const objective of context.policies) {
    if (objective.executionPolicy.scope.connectionId !== write.connectionId) add('WRITE_POLICY_CONNECTION_CHANGED', 'The restricted Shopify connection changed. The owner must review its execution scope.');
    if (objective.status !== 'active' || now < Date.parse(objective.startsAt) || now >= Date.parse(objective.endsAt)) {
      add('WRITE_POLICY_NOT_ACTIVE', 'A matching execution restriction is paused or outside its active time window. No content change can run.');
    }
    const limits = objective.limits;
    if (limits.minGrossMarginPercent !== null || limits.maxMonthlyAdBudget !== null || limits.minStockCoverDays !== null || limits.profitFirst) {
      add('WRITE_POLICY_EVIDENCE_REQUIRED', 'This restriction requires qualified financial or stock evidence that is not available. Approval cannot override it.');
    }
  }
  const currencies = new Set(context.policies.map(row => row.limits.currency).filter(Boolean));
  if (currencies.size > 1) add('WRITE_POLICY_CONFLICT', 'Matching execution restrictions use different currencies. No conversion or financial comparison is assumed.');
  return { allowed: blockers.length === 0, blockers };
}

export function assertObjectiveDispatchAllowed(write, context, now = Date.now()) {
  const result = assessObjectiveDispatchPolicy(write, context, now);
  if (!result.allowed) throw blocked(result.blockers[0].code, result.blockers[0].message);
}
