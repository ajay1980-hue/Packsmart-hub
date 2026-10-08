import { createHash } from 'node:crypto';
import { businessObjectivesSnapshot, OBJECTIVE_STATUSES } from './business-objectives.mjs';
import { objectiveCanonicalDigest, OBJECTIVE_CONTENT_PROPOSAL_SCHEMA, OBJECTIVE_DISPATCH_PROPOSAL_SCHEMA,
  OBJECTIVE_DISPATCH_PROPOSAL_MAX_BYTES } from './objective-dispatch-policy.mjs';
import { validateObjectiveContentSource, objectiveContentApprovalDigest } from './objective-content-source.mjs';

// Only retained data is inspected here. Never reconstruct a review, load a job,
// inspect credentials/owners, evaluate policy, or call a current-source validator.
export const RETAINED_REQUEST_GRAPH_BYTES = Object.freeze({ summary: 16 * 1024, detail: 64 * 1024 });
const WRITE_STATUSES = new Set(['pending_approval', 'ready', 'executing', 'processing', 'completed', 'uncertain', 'failed', 'rejected']);
const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected']);
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = () => Object.assign(new Error('Retained graph record is invalid'), { code: 'RETAINED_GRAPH_RECORD_INVALID' });
const mismatch = () => Object.assign(new Error('Workspace identity mismatch'), { code: 'WORKSPACE_MISMATCH', status: 403 });
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && value === value.trim() ? value : null;
const hashPattern = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const digestInput = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
const archived = row => row.status === 'archived' || row.archived === true || Boolean(row.archivedAt);
const revision = value => Number.isSafeInteger(value) && value >= 1 ? value : null;

function descriptors(value) {
  if (!plain(value)) throw invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128 || keys.some(key => typeof key !== 'string')) throw invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !own(fields[key], 'value') || !fields[key].enumerable)) throw invalid();
  return fields;
}
function scope(fields, workspaceId) {
  for (const key of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'workspace', 'tenant']) {
    if (!own(fields, key)) continue;
    const value = fields[key].value;
    if (['workspace', 'tenant'].includes(key) && plain(value)) {
      const nested = descriptors(value);
      if (nested.id?.value !== workspaceId) throw mismatch();
    } else if (value !== workspaceId) throw mismatch();
  }
}
// A preflight cap applies BEFORE either canonical hash/serialization. The graph
// already bounds source rows globally; each consumed tree has bounded fields,
// depth, values and UTF-8 bytes, including data that the schema later rejects.
function boundedData(value, workspaceId, budget, depth = 0) {
  if (--budget.values < 0 || depth > 12 || budget.bytes < 0) throw invalid();
  if (value !== null && typeof value === 'object' && depth > 0) budget.consume();
  if (value === null || typeof value === 'boolean') { budget.bytes -= 5; return value; }
  if (typeof value === 'string') {
    if (value.length > budget.bytes) throw invalid();
    budget.bytes -= Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (budget.bytes < 0) throw invalid();
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) { budget.bytes -= 24; return value; }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > budget.nestedLimit || Reflect.ownKeys(value).length !== value.length + 1) throw invalid();
    budget.bytes -= value.length + 2;
    if (budget.bytes < 0) throw invalid();
    const result = [];
    for (let index = 0; index < value.length; index++) {
      const field = Object.getOwnPropertyDescriptor(value, index);
      if (!field || !own(field, 'value')) throw invalid();
      if (field.value === null || typeof field.value !== 'object') budget.consume();
      result.push(boundedData(field.value, workspaceId, budget, depth + 1));
    }
    return result;
  }
  const fields = descriptors(value); scope(fields, workspaceId);
  const result = Object.create(null);
  for (const [key, field] of Object.entries(fields)) {
    if (key.length > budget.bytes) throw invalid();
    budget.bytes -= Buffer.byteLength(JSON.stringify(key), 'utf8') + 4;
    if (budget.bytes < 0) throw invalid();
    result[key] = boundedData(field.value, workspaceId, budget, depth + 1);
  }
  return result;
}

export function retainedCollection(state, key) {
  const field = Object.getOwnPropertyDescriptor(state, key);
  return !field ? undefined : own(field, 'value') ? field.value : {}; // Invalid collection, no accessor execution.
}
export function inspectRetainedGraphRow(value, workspaceId, collection, { shallow = false, consume = () => {}, nestedLimit = 25 } = {}) {
  const fields = descriptors(value); scope(fields, workspaceId);
  const budget = { values: 4096, bytes: 131072, consume, nestedLimit };
  if (!shallow && collection !== 'connectionWrites') return boundedData(value, workspaceId, budget);
  // Provider results, errors and other arbitrary write bodies are not consumed.
  // Validate all consumed nested scope before considering provider/origin/status.
  const result = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
  if (!shallow) for (const key of ['input', 'objectivePolicyProposal']) if (own(fields, key)) result[key] = boundedData(fields[key].value, workspaceId, budget, 1);
  return result;
}

export function retainedObjective(row, workspaceId, now) {
  const recordedStatus = OBJECTIVE_STATUSES.includes(row.status) ? row.status : 'unknown';
  try {
    if (archived(row)) return { recordedStatus, effectiveStatus: 'unknown', revision: revision(row.revision), invalid: true };
    // Normalize this single already-bounded row exactly as the v2 producer did.
    // This deliberately never revisits the full source collection.
    const { effectiveStatus, ...definition } = businessObjectivesSnapshot({ workspace: { id: workspaceId }, businessObjectives: [row] }, { now }).objectives[0];
    return { recordedStatus, effectiveStatus, revision: definition.revision, definitionDigest: objectiveCanonicalDigest(definition) };
  } catch (error) {
    if (error.code === 'WORKSPACE_MISMATCH') throw error;
    return { recordedStatus, effectiveStatus: 'unknown', revision: revision(row.revision), invalid: true };
  }
}
export const retainedWriteStatus = row => WRITE_STATUSES.has(row.status) ? row.status : 'unknown';

function proposal(write, workspaceId) {
  if (!own(write, 'objectivePolicyProposal')) return { origin: 'not_recorded' };
  const envelope = write.objectivePolicyProposal;
  if (!plain(envelope) || ![OBJECTIVE_DISPATCH_PROPOSAL_SCHEMA, OBJECTIVE_CONTENT_PROPOSAL_SCHEMA].includes(envelope.schema)) {
    return { origin: 'invalid', reason: 'unsupported_proposal' };
  }
  const v2 = envelope.schema === OBJECTIVE_CONTENT_PROPOSAL_SCHEMA;
  const fields = ['schema', 'workspaceId', 'origin', 'writeId', 'provider', 'operation', 'inputDigest', 'connectionId', 'account',
    'requestedBy', 'approvalKind', 'policies', 'evidenceQualification', 'digest', ...(v2 ? ['source', 'approvalId', 'approvalDigest'] : [])];
  try {
    if (!exact(envelope, fields) || Buffer.byteLength(JSON.stringify(envelope), 'utf8') > OBJECTIVE_DISPATCH_PROPOSAL_MAX_BYTES
      || envelope.workspaceId !== workspaceId || envelope.writeId !== write.id || envelope.provider !== 'shopify' || write.provider !== 'shopify'
      || envelope.operation !== 'product_content' || write.input?.operation !== 'product_content' || envelope.inputDigest !== write.digest
      || !hashPattern(write.digest) || envelope.connectionId !== write.connectionId || !id(write.connectionId)
      || envelope.account !== write.account || typeof write.account !== 'string' || write.account.length > 253 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(write.account)
      || envelope.requestedBy !== write.requestedBy || !id(write.requestedBy) || envelope.approvalKind !== 'customer_facing_publish'
      || envelope.evidenceQualification !== 'no_financial_execution_evidence' || write.requiresApproval !== true
      || envelope.origin !== (v2 ? 'owner_objective_content' : 'owner_manual') || !Array.isArray(envelope.policies) || !envelope.policies.length) throw invalid();
    if (!exact(write.input, ['productId', 'operation', 'title', 'description']) || typeof write.input.productId !== 'string'
      || !/^gid:\/\/shopify\/Product\/\d+$/.test(write.input.productId) || typeof write.input.title !== 'string' || !write.input.title.trim()
      || write.input.title !== write.input.title.trim() || write.input.title.length > 200 || typeof write.input.description !== 'string'
      || write.input.description.length > 10000 || digestInput({ productId: write.input.productId, operation: 'product_content', title: write.input.title,
        description: write.input.description }) !== write.digest) throw invalid();
    const seen = new Set();
    for (const policy of envelope.policies) {
      if (!exact(policy, ['objectiveId', 'revision', 'digest']) || typeof policy.objectiveId !== 'string' || !/^objective_[0-9a-f-]{36}$/.test(policy.objectiveId)
        || !revision(policy.revision) || !hashPattern(policy.digest) || seen.has(policy.objectiveId)) throw invalid();
      seen.add(policy.objectiveId);
    }
    const { digest, ...body } = envelope;
    if (!hashPattern(digest) || objectiveCanonicalDigest(body) !== digest) throw invalid();
    if (v2) {
      if (typeof write.id !== 'string' || !/^write_[A-Za-z0-9_-]{1,100}$/.test(write.id)
        || typeof write.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(write.requestId)
        || typeof write.connectionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(write.connectionId)
        || typeof write.approvalId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(write.approvalId)
        || write.input.productId.length > 100) throw invalid();
      validateObjectiveContentSource(envelope.source);
      const source = envelope.source;
      if (source.actorId !== write.requestedBy || source.productId !== write.input.productId
        || envelope.approvalId !== write.approvalId || !id(envelope.approvalId) || !hashPattern(envelope.approvalDigest)
        || !envelope.policies.some(policy => policy.objectiveId === source.objectiveId && policy.revision === source.objectiveRevision && policy.digest === source.objectiveDigest)) throw invalid();
    }
    return { origin: envelope.origin, envelope, source: v2 ? envelope.source : null };
  } catch (error) {
    if (error.code === 'WORKSPACE_MISMATCH') throw error;
    return { origin: 'invalid', reason: 'invalid_proposal' };
  }
}

export function projectRetainedRequests({ workspaceId, summaryOnly, objectives, writes, approvals, metadata, edge, unknown, digest, atField, now }) {
  const primary = items => {
    const index = new Map();
    for (const item of items) if (id(item.row.id)) {
      if (!index.has(item.row.id)) index.set(item.row.id, []);
      index.get(item.row.id).push(item);
    }
    return index;
  };
  const objectiveIndex = primary(objectives), approvalIndex = primary(approvals), writeIndex = primary(writes), requestIndex = new Map(), reciprocalIndex = new Map();
  const complete = collection => metadata(collection).totalKnown && !metadata(collection).truncated && !metadata(collection).invalid;
  for (const item of writes) if (id(item.row.requestId)) {
    if (!requestIndex.has(item.row.requestId)) requestIndex.set(item.row.requestId, []);
    requestIndex.get(item.row.requestId).push(item);
  }
  for (const item of approvals) if (id(item.row.payload?.connectionWriteId)) {
    const key = item.row.payload.connectionWriteId;
    if (!reciprocalIndex.has(key)) reciprocalIndex.set(key, []);
    reciprocalIndex.get(key).push(item);
  }
  for (const item of writes) if (!id(item.row.id) || !id(item.row.requestId) || retainedWriteStatus(item.row) === 'unknown') metadata('connectionWrites').invalid++;
  for (const item of approvals) if (!id(item.row.id)
    || reciprocalIndex.has(item.row.payload?.connectionWriteId) && !APPROVAL_STATUSES.has(item.row.status)) metadata('approvals').invalid++;
  const objectiveDetails = new Map(objectives.map(item => {
    const detail = retainedObjective(item.row, workspaceId, now);
    if (detail.invalid) metadata('businessObjectives').invalid++;
    return [item, detail];
  }));
  const result = {
    schema: 'runvara-retained-requests/v1', status: 'available',
    counts: { objectivesInspected: metadata('businessObjectives').scanned, requestsInspected: metadata('connectionWrites').scanned,
      projectedObjectives: 0, projectedRequests: 0, resolvedApprovalLinks: 0, resolvedObjectiveLinks: 0 },
    coverage: { complete: false, completeLifetimeHistoryClaimed: false, archiveReadsPerformed: 0, currentSourceChecked: false },
    omitted: { objectives: 0, requests: 0, relationships: 0, mappings: 0 }, limits: { byteLimit: RETAINED_REQUEST_GRAPH_BYTES[summaryOnly ? 'summary' : 'detail'] },
    objectives: objectives.filter(item => item.node).map(item => {
      const detail = objectiveDetails.get(item);
      Object.assign(item.node.attributes, { status: detail.recordedStatus, effectiveStatus: detail.effectiveStatus, revision: detail.revision });
      return { nodeId: item.node.id, recordedStatus: detail.recordedStatus, effectiveStatus: detail.effectiveStatus, revision: detail.revision };
    }), records: [],
    safeguards: { executionAuthorized: false, immutableExecutionProof: false, goalProgressEstablished: false, causalAttribution: false }
  };
  function unresolved(item, relation, reason, field) {
    unknown(item.node, relation, reason, atField(item.ref, field));
    return { status: 'unresolved', reason };
  }
  function target(index, collection, rawId) {
    if (!id(rawId)) return { reason: 'missing_reference' };
    const matches = index.get(rawId) || [];
    if (matches.length > 1) return { reason: 'ambiguous_reference' };
    if (matches.length === 1 && archived(matches[0].row)) return { reason: 'archived_reference' };
    if (matches.length === 1 && (collection === 'approvals' && !APPROVAL_STATUSES.has(matches[0].row.status)
      || collection === 'businessObjectives' && objectiveDetails.get(matches[0])?.invalid)) return { reason: 'invalid_record' };
    if (!complete(collection)) return { reason: 'target_index_incomplete' };
    if (!matches.length) return { reason: 'unresolved_reference' };
    return { item: matches[0] };
  }
  function connect(item, found, relation, field) {
    if (found.reason) return unresolved(item, relation, found.reason, field);
    if (!found.item.node) return unresolved(item, relation, 'target_outside_projection', field);
    return edge(item.node, found.item.node, relation, atField(item.ref, field), 'recorded-reciprocal-binding')
      ? { status: 'resolved', reason: null, targetNodeId: found.item.node.id }
      : unresolved(item, relation, 'edge_limit', field);
  }
  for (const item of writes) {
    if (!item.node) continue;
    const write = item.row, captured = proposal(write, workspaceId), approvalRelation = 'request_recorded_approval', objectiveRelation = 'request_recorded_objective';
    const ambiguous = writeIndex.get(write.id)?.length > 1 || requestIndex.get(write.requestId)?.length > 1;
    const sourceReason = !id(write.id) || !id(write.requestId) || retainedWriteStatus(write) === 'unknown' ? 'invalid_record'
      : ambiguous ? 'source_identity_ambiguous' : !complete('connectionWrites') ? 'source_index_incomplete' : null;
    const row = { nodeId: item.node.id, requestRef: `request_${digest([workspaceId, 'retained-request', id(write.requestId) || item.ref.pointer])}`,
      recordedStatus: retainedWriteStatus(write), origin: captured.origin,
      approval: { status: 'not_recorded', reason: null }, objective: { status: 'not_recorded', reason: null } };
    item.node.attributes.status = row.recordedStatus;
    if (id(write.approvalId) || write.requiresApproval === true) {
      const found = target(approvalIndex, 'approvals', write.approvalId);
      let reason = sourceReason || captured.reason || (found.item && !APPROVAL_STATUSES.has(found.item.row.status) ? 'invalid_record' : null) || found.reason;
      const approval = found.item?.row;
      if (!reason && (reciprocalIndex.get(write.id)?.length !== 1 || approval.payload?.connectionWriteId !== write.id
        || !hashPattern(write.digest) || !plain(write.input) || digestInput(write.input) !== write.digest || approval.payload?.digest !== write.digest || write.requiresApproval !== true)) reason = 'approval_binding_mismatch';
      if (!reason && captured.envelope && (approval.type !== captured.envelope.approvalKind
        || approval.payload.objectivePolicyProposalDigest !== captured.envelope.digest)) reason = 'approval_binding_mismatch';
      if (!reason && captured.source) {
        try {
          if (!exact(approval.payload, ['connectionWriteId', 'digest', 'objectivePolicyProposalDigest']) || approval.requestedBy !== write.requestedBy
            || approval.revision !== 1 || objectiveContentApprovalDigest(approval) !== captured.envelope.approvalDigest) reason = 'approval_binding_mismatch';
        } catch { reason = 'approval_binding_mismatch'; }
      }
      row.approval = reason ? unresolved(item, approvalRelation, reason, 'approvalId') : connect(item, found, approvalRelation, 'approvalId');
      if (row.approval.status === 'resolved') row.approval.recordedStatus = APPROVAL_STATUSES.has(approval.status) ? approval.status : 'unknown';
    }
    if (captured.reason) row.objective = unresolved(item, objectiveRelation, sourceReason || captured.reason, 'objectivePolicyProposal');
    else if (captured.source) {
      const source = captured.source, found = target(objectiveIndex, 'businessObjectives', source.objectiveId);
      const reason = sourceReason || (row.approval.status !== 'resolved' ? 'approval_binding_mismatch' : null) || found.reason
        || (objectiveDetails.get(found.item)?.invalid ? 'invalid_record' : null);
      row.objective = reason ? unresolved(item, objectiveRelation, reason, 'objectivePolicyProposal.source.objectiveId')
        : connect(item, found, objectiveRelation, 'objectivePolicyProposal.source.objectiveId');
      row.objective.recordedRevision = source.objectiveRevision;
      if (row.objective.status === 'resolved') {
        const detail = objectiveDetails.get(found.item);
        row.objective.savedRevision = detail.revision;
        row.objective.revisionComparison = detail.invalid ? 'unavailable' : detail.revision !== source.objectiveRevision ? 'saved_revision_changed'
          : detail.definitionDigest !== source.objectiveDigest ? 'saved_definition_changed' : 'matches_retained_definition';
      }
    }
    result.records.push(row);
  }
  return result;
}
