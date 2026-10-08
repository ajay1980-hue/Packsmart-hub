// Shopify product_content compatibility only. These are the existing producers'
// JSON.stringify preimages, not a new persisted digest or an authority validator.
import { OBJECTIVE_DISPATCH_PROPOSAL_SCHEMA, OBJECTIVE_CONTENT_PROPOSAL_SCHEMA } from './objective-dispatch-policy.mjs';
import { validateObjectiveContentSource } from './objective-content-source.mjs';
import { types } from 'node:util';

// A compared row must fit the existing 2 MiB workspace storage ceiling. Keep
// the dispatcher's existing maximum recursive scope depth (32). The node cap
// cannot exclude JSON fitting that byte limit: each child costs at least two
// bytes, apart from the root. Do not use the smaller, lossy evidence DTO limits.
export const CONTENT_WRITE_SNAPSHOT_MAX_BYTES = 2097152;
export const CONTENT_WRITE_SNAPSHOT_MAX_DEPTH = 32;
const MAX_NODES = CONTENT_WRITE_SNAPSHOT_MAX_BYTES / 2 + 1;
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && !types.isProxy(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const changed = () => Object.assign(new Error('The exact content request changed. Review a new request.'),
  { code: 'WRITE_REQUEST_CHANGED', status: 409, definitive: true });

// Return immutable text captured now. Only object key order is insignificant;
// every value, key, absence and array position survives. Descriptors are checked
// before values are read, so getters and toJSON are never invoked.
export function contentWriteSnapshot(value) {
  const active = new Set(), chunks = [], pending = [];
  let bytes = 0, nodes = 0;
  const append = text => {
    bytes += Buffer.byteLength(text);
    if (bytes > CONTENT_WRITE_SNAPSHOT_MAX_BYTES) throw changed();
    // Batch small tokens instead of retaining one array entry per delimiter or
    // scalar. A near-limit numeric array must not create millions of chunks.
    pending.push(text);
    if (pending.length === 1024) { chunks.push(pending.join('')); pending.length = 0; }
  };
  const visit = (item, depth) => {
    if (depth > CONTENT_WRITE_SNAPSHOT_MAX_DEPTH || ++nodes > MAX_NODES) throw changed();
    if (item === null || typeof item === 'boolean') { append(JSON.stringify(item)); return; }
    if (typeof item === 'string') {
      if (item.length > CONTENT_WRITE_SNAPSHOT_MAX_BYTES) throw changed();
      append(JSON.stringify(item)); return;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw changed();
      append(Object.is(item, -0) ? '-0' : JSON.stringify(item)); return;
    }
    if (types.isProxy(item)) throw changed();
    const array = Array.isArray(item);
    if ((!array && !plain(item)) || array && Object.getPrototypeOf(item) !== Array.prototype || active.has(item)) throw changed();
    active.add(item);
    if (array) {
      const length = Object.getOwnPropertyDescriptor(item, 'length').value;
      // Every index is checked below; exactly length + 1 own keys therefore
      // leaves no room for a symbol or decorated property. Discard the key
      // list immediately instead of retaining it during the whole traversal.
      if (length + 1 > MAX_NODES || Reflect.ownKeys(item).length !== length + 1) throw changed();
      append('[');
      for (let index = 0; index < length; index++) {
        const field = Object.getOwnPropertyDescriptor(item, index);
        if (!field || !own(field, 'value') || !field.enumerable) throw changed();
        if (index) append(',');
        visit(field.value, depth + 1);
      }
      append(']');
    } else {
      const keys = Reflect.ownKeys(item);
      if (keys.length > MAX_NODES || keys.some(key => typeof key !== 'string')) throw changed();
      append('{');
      for (const [index, key] of keys.sort().entries()) {
        if (key.length > CONTENT_WRITE_SNAPSHOT_MAX_BYTES) throw changed();
        // Read one descriptor at a time. A complete descriptor map costs far
        // more memory than the accepted JSON for a wide object or array.
        const field = Object.getOwnPropertyDescriptor(item, key);
        if (!field || !own(field, 'value') || !field.enumerable) throw changed();
        if (index) append(',');
        append(JSON.stringify(key)); append(':'); visit(field.value, depth + 1);
      }
      append('}');
    }
    active.delete(item);
  };
  visit(value, 0);
  if (pending.length) chunks.push(pending.join(''));
  return chunks.join('');
}

function record(value) {
  if (!plain(value)) throw changed();
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !own(fields[key], 'value') || !fields[key].enumerable)) throw changed();
  return fields;
}
function ordered(value, keys) {
  const fields = record(value);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !own(fields, key))) throw changed();
  return Object.fromEntries(keys.map(key => [key, fields[key].value]));
}
const inputKeys = ['productId', 'operation', 'title', 'description'];
const proposalKeys = ['schema', 'workspaceId', 'origin', 'writeId', 'provider', 'operation', 'inputDigest', 'connectionId',
  'account', 'requestedBy', 'approvalKind', 'policies', 'evidenceQualification'];
const sourceKeys = ['schema', 'objectiveId', 'objectiveRevision', 'objectiveDigest', 'jobId', 'jobIdentityDigest', 'reportId',
  'payloadDigest', 'resultDigest', 'actorId', 'actorSessionVersion', 'inputFingerprint', 'opportunityId', 'opportunityDigest',
  'productId', 'productDigest', 'approvalSourceDigest'];

export function contentInputPreimage(value) {
  const input = ordered(value, inputKeys);
  if (input.operation !== 'product_content' || typeof input.productId !== 'string' || input.productId.length > 100
    || !/^gid:\/\/shopify\/Product\/\d+$/.test(input.productId) || typeof input.title !== 'string' || !input.title
    || input.title !== input.title.trim() || input.title.length > 200 || typeof input.description !== 'string'
    || input.description.length > 10000) throw changed();
  return input;
}
function proposalPreimage(value, family) {
  const v2 = family === 'objective-v2';
  const proposal = ordered(value, [...proposalKeys, ...(v2 ? ['source', 'approvalId', 'approvalDigest'] : []), 'digest']);
  if (proposal.schema !== (v2 ? OBJECTIVE_CONTENT_PROPOSAL_SCHEMA : OBJECTIVE_DISPATCH_PROPOSAL_SCHEMA)
    || proposal.origin !== (v2 ? 'owner_objective_content' : 'owner_manual') || proposal.provider !== 'shopify'
    || proposal.operation !== 'product_content' || proposal.approvalKind !== 'customer_facing_publish'
    || proposal.evidenceQualification !== 'no_financial_execution_evidence'
    || proposalKeys.filter(key => key !== 'policies').some(key => typeof proposal[key] !== 'string')
    || typeof proposal.digest !== 'string' || !/^[0-9a-f]{64}$/.test(proposal.digest)) throw changed();
  // Snapshot checks density, descriptors, symbols and array prototype first.
  contentWriteSnapshot(proposal.policies);
  if (!Array.isArray(proposal.policies)) throw changed();
  proposal.policies = proposal.policies.map(policy => {
    const entry = ordered(policy, ['objectiveId', 'revision', 'digest']);
    if (typeof entry.objectiveId !== 'string' || !Number.isSafeInteger(entry.revision) || entry.revision < 1
      || typeof entry.digest !== 'string' || !/^[0-9a-f]{64}$/.test(entry.digest)) throw changed();
    return entry;
  });
  if (v2) {
    proposal.source = ordered(proposal.source, sourceKeys);
    validateObjectiveContentSource(proposal.source);
    if (typeof proposal.approvalId !== 'string' || typeof proposal.approvalDigest !== 'string'
      || !/^[0-9a-f]{64}$/.test(proposal.approvalDigest)) throw changed();
  }
  return proposal;
}
export function contentWritePreimage(write, contract) {
  const fields = record(write);
  const keys = ['id', 'requestId', 'provider', 'input', 'digest', 'connectionId', 'account', 'requestedBy', 'requiresApproval', 'approvalId'];
  if (keys.some(key => !own(fields, key)) || keys.filter(key => !['input', 'requiresApproval'].includes(key))
    .some(key => typeof fields[key].value !== 'string') || fields.provider.value !== 'shopify'
    || fields.requiresApproval.value !== true || !fields.approvalId.value) throw changed();
  const result = Object.fromEntries(keys.map(key => [key, fields[key].value]));
  result.input = contentInputPreimage(result.input);
  if (contract.family === 'manual') {
    if (own(fields, 'objectivePolicyProposal')) throw changed();
  } else {
    if (!own(fields, 'objectivePolicyProposal') || !['manual-v1-policy', 'objective-v2'].includes(contract.family)) throw changed();
    result.objectivePolicyProposal = proposalPreimage(fields.objectivePolicyProposal.value, contract.family);
  }
  return result;
}
export function contentApprovalPayloadPreimage(payload, contract) {
  const result = ordered(payload, ['connectionWriteId', 'digest', ...(contract.family === 'manual' ? [] : ['objectivePolicyProposalDigest'])]);
  if (Object.values(result).some(value => typeof value !== 'string')) throw changed();
  return result;
}
export function contentConsentPreimage(consent) {
  if (consent === undefined || consent === null) return null;
  const result = ordered(consent, ['actor', 'at', 'mode']);
  if (Object.values(result).some(value => typeof value !== 'string') || !['approval_gated', 'automatic'].includes(result.mode)) throw changed();
  return result;
}

// Select once, before an await. Unknown signed fields have no recoverable
// producer insertion order and must stay on the original path for the entire
// request. A selected contract never falls back when a later snapshot changes.
export function contentWriteIdentityContract(write, approval, consent) {
  // Malformed JSON is never a legacy signed layout. In particular, returning
  // null for a hidden or symbol field would let JSON.stringify erase it.
  contentWriteSnapshot(write); contentWriteSnapshot(approval);
  if (consent !== undefined) contentWriteSnapshot(consent);
  let contract;
  try {
    const fields = record(write);
    if (fields.provider?.value !== 'shopify') return null;
    let family = 'manual';
    if (own(fields, 'objectivePolicyProposal')) {
      const proposal = record(fields.objectivePolicyProposal.value);
      family = proposal.schema?.value === OBJECTIVE_CONTENT_PROPOSAL_SCHEMA ? 'objective-v2' : 'manual-v1-policy';
    }
    contract = Object.freeze({ family });
    contentWritePreimage(write, contract);
    const approvalFields = record(approval);
    if (!own(approvalFields, 'payload')) return null;
    contentApprovalPayloadPreimage(approvalFields.payload.value, contract);
    contentConsentPreimage(consent);
  } catch { return null; }
  return contract;
}

export function contentApprovalDecisionSnapshot(approval) {
  contentWriteSnapshot(approval);
  const fields = Object.getOwnPropertyDescriptors(approval);
  return contentWriteSnapshot(Object.fromEntries(Object.keys(fields)
    .filter(key => !['executedExternally', 'executionStatus', 'workStatus'].includes(key))
    .map(key => [key, fields[key].value])));
}
