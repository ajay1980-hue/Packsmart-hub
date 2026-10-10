import crypto from 'node:crypto';
import { META_WRITES } from './meta-capabilities.mjs';

// Compatibility only: this runtime cannot create or authorize policy-bound
// writes. Keep future authorities opaque and fail closed instead of interpreting
// their absence in a narrow dispatch projection as permission.
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const blocked = (code = 'WRITE_POLICY_UNSUPPORTED') => Object.assign(new Error('This saved execution authority requires a newer runtime. No new write was sent.'),
  { code, status: 409, definitive: true });
const MAX_BYTES = 131072;

export function objectivePolicyCopy(value, depth = 0) {
  if (depth > 16) throw blocked('WRITE_POLICY_INVALID');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length <= MAX_BYTES) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!plain(value) && !Array.isArray(value)) throw blocked('WRITE_POLICY_INVALID');
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.length > 2048 || keys.some(key => typeof key !== 'string' || !own(descriptors[key], 'value'))) throw blocked('WRITE_POLICY_INVALID');
  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1) throw blocked('WRITE_POLICY_INVALID');
    return Array.from({ length: value.length }, (_, index) => {
      if (!own(descriptors, index)) throw blocked('WRITE_POLICY_INVALID');
      return objectivePolicyCopy(descriptors[index].value, depth + 1);
    });
  }
  return Object.fromEntries(keys.sort().map(key => [key, objectivePolicyCopy(descriptors[key].value, depth + 1)]));
}
function serialized(value) {
  const text = JSON.stringify(objectivePolicyCopy(value));
  if (Buffer.byteLength(text) > MAX_BYTES) throw blocked('WRITE_POLICY_INVALID');
  return text;
}
function source(state) {
  const descriptor = Object.getOwnPropertyDescriptor(state, 'businessObjectives');
  if ((!descriptor && 'businessObjectives' in state) || descriptor && !own(descriptor, 'value')) throw blocked('WRITE_POLICY_INVALID');
  return descriptor ? { present: true, objectives: descriptor.value } : { present: false };
}
const fingerprint = state => crypto.createHash('sha256').update(serialized(source(state))).digest('hex');
const authorityFields = ['origin', 'objectiveRef', 'objectivePolicyProposal', 'objectivePolicyBinding', 'policyBinding', 'executionPolicy', 'financialEvidence', 'schema', 'version'];
export function assertLegacyObjectiveEnvelope(write, approval) {
  for (const record of write === undefined ? [] : [write, write?.input]) {
    if (!plain(record) || authorityFields.some(key => key in record) || Reflect.ownKeys(record).some(key => typeof key === 'string' && /^objective/.test(key))) throw blocked();
  }
  if (write !== undefined && !((write.provider === 'shopify'
    && ['product_content', 'internal_note', 'product_tags_add', 'product_tags_remove'].includes(write.input.operation))
    || (write.provider === 'meta' && META_WRITES.includes(write.input.operation)))) throw blocked('WRITE_UNSUPPORTED');
  if (approval && (!plain(approval) || approval.source === 'objective-content'
    || authorityFields.some(key => key in approval) || Reflect.ownKeys(approval).some(key => typeof key === 'string' && /^objective/.test(key)))) throw blocked();
  if (approval?.payload && (!plain(approval.payload) || Reflect.ownKeys(approval.payload).some(key =>
    write !== undefined ? !['connectionWriteId', 'digest', 'workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'workspace', 'tenant'].includes(key)
      : typeof key !== 'string' || authorityFields.includes(key) || /^objective/.test(key)))) throw blocked();
}
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const OBJECTIVE_FIELDS = ['id', 'revision', 'workspaceId', 'tenantId', 'title', 'metric', 'baseline', 'target', 'direction', 'startsAt', 'endsAt', 'status', 'limits', 'createdAt', 'updatedAt', 'executionPolicy'];
export function captureLegacyObjectivePolicy(state, write) {
  const sourceFingerprint = fingerprint(state), original = source(state);
  const rows = original.present ? objectivePolicyCopy(original.objectives) : [];
  if (!Array.isArray(rows) || rows.length > 50) throw blocked('WRITE_POLICY_INVALID');
  const ids = new Set();
  for (const row of rows) {
    if (!exact(row, OBJECTIVE_FIELDS) || typeof row.id !== 'string' || ids.has(row.id)
      || row.workspaceId !== state.workspace?.id || own(row, 'tenantId') && row.tenantId !== state.workspace.id) throw blocked('WRITE_POLICY_INVALID');
    ids.add(row.id);
    if (!own(row, 'executionPolicy')) continue;
    const policy = row.executionPolicy;
    if (!exact(policy, ['schema', 'mode', 'scope']) || policy.schema !== 'runvara-objective-execution-policy/v1') throw blocked();
    if (policy.mode === 'preparation_only' && !own(policy, 'scope')) continue;
    if (policy.mode !== 'enforce' || !exact(policy.scope, ['provider', 'operation', 'connectionId', 'account'])) throw blocked();
    const scope = policy.scope;
    if (scope.provider !== 'shopify' || scope.operation !== 'product_content'
      || typeof scope.connectionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(scope.connectionId)
      || typeof scope.account !== 'string' || scope.account.length > 253 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(scope.account)) throw blocked();
    // A paused, expired, or reconnected restriction still applies to its exact
    // account/action. Changing connection IDs must not silently remove it.
    if (scope.provider === write.provider && scope.operation === write.input.operation && scope.account === write.account) throw blocked();
  }
  return Object.freeze({ workspaceId: state.workspace.id, sourceFingerprint });
}
export function assertLegacyObjectiveSource(state, context) {
  if (state.workspace?.id !== context.workspaceId || fingerprint(state) !== context.sourceFingerprint) throw blocked('WRITE_POLICY_SOURCE_CHANGED');
}
