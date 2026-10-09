import crypto from 'node:crypto';
import { validateShopifyOrderRecoveryStage } from './shopify-order-recovery.mjs';

export const ORDER_RECOVERY_CONTRACT = 'runvara-order-recovery/v1';
export const ORDER_RECOVERY_LIMITS = Object.freeze({ summary: 32768, full: 2162688, raw: 2162688, encoded: 4325440, ack: 2048, input: 8192 });
const acknowledgements = new WeakMap();
export function recordOrderRecoveryAcknowledgement(state, result) { acknowledgements.set(state, result); }
export function orderRecoveryAcknowledgement(state) { return acknowledgements.get(state) || null; }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const exact = (value, keys) => object(value) && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
export const orderRecoveryError = (reason, status = 409, definitive = true) => Object.assign(new Error(`Shopify order recovery needs review (${reason}).`), { code: `ORDER_RECOVERY_${reason}`, status, definitive });
export function validateOrderRecoveryActor(actor) {
  if (!exact(actor, ['id', 'sessionVersion', 'sessionDigest', 'expiresAt']) || !id(actor.id) || !Number.isSafeInteger(actor.sessionVersion) || actor.sessionVersion < 1 || !/^[a-f0-9]{64}$/.test(actor.sessionDigest) || !iso(actor.expiresAt)) throw orderRecoveryError('ACTOR_INVALID', 403);
  return structuredClone(actor);
}
export function validateOrderRecoveryCommit(descriptor) {
  if (!object(descriptor) || !['reserve', 'finalize', 'append'].includes(descriptor.kind) || !id(descriptor.stageId)
    || !Number.isSafeInteger(descriptor.expectedStageRevision) || descriptor.expectedStageRevision < 0 || !object(descriptor.admission)) throw orderRecoveryError('INVALID');
  const result = structuredClone(descriptor), a = result.admission;
  const statuses = result.kind === 'finalize' ? ['committed'] : result.kind === 'reserve' ? ['reading','complete'] : ['reading','complete','paused'];
  if (!statuses.includes(result.expectedStatus)) throw orderRecoveryError('INVALID');
  result.actor = validateOrderRecoveryActor(result.actor);
  if (!exact(a, ['runId','leaseUntil','attempt','workspaceRevision','actorId','actorSessionVersion','sessionDigest']) || !id(a.runId) || !iso(a.leaseUntil)
    || !Number.isSafeInteger(a.attempt) || a.attempt < 1 || a.attempt > 5 || !id(a.workspaceRevision)
    || a.actorId !== result.actor.id || a.actorSessionVersion !== result.actor.sessionVersion || a.sessionDigest !== result.actor.sessionDigest) throw orderRecoveryError('INVALID');
  if (result.kind === 'reserve' && !object(result.binding) || result.kind === 'append' && !object(result.page)) throw orderRecoveryError('INVALID');
  return result;
}
const fingerprint = raw => `sha256:${crypto.createHash('sha256').update(raw, 'utf8').digest('hex')}`;
export function prepareOrderRecoveryTransaction(workspaceId, state, expectedRevision, descriptor) {
  descriptor = validateOrderRecoveryCommit(descriptor);
  if (!id(workspaceId)) throw orderRecoveryError('INVALID');
  const mutation = { schema: ORDER_RECOVERY_CONTRACT, kind: descriptor.kind, workspaceId, stageId: descriptor.stageId,
    admission: descriptor.admission, expectedStageRevision: descriptor.expectedStageRevision, actor: descriptor.actor };
  if (descriptor.kind === 'append') Object.assign(mutation, { page: descriptor.page });
  else {
    if (!id(expectedRevision) || !id(state?._revision) || state._revision === expectedRevision || state.workspace?.id !== workspaceId) throw orderRecoveryError('INVALID');
    Object.assign(mutation, { expectedRevision, nextRevision: state._revision, state });
    if (descriptor.kind === 'reserve') mutation.binding = descriptor.binding;
  }
  const raw = JSON.stringify(mutation), body = JSON.stringify({ p_request: raw });
  if (Buffer.byteLength(raw) > ORDER_RECOVERY_LIMITS.raw || Buffer.byteLength(body) > ORDER_RECOVERY_LIMITS.encoded) throw orderRecoveryError('TOO_LARGE', 413);
  const requestFingerprint = fingerprint(raw);
  const lookup = { schema: ORDER_RECOVERY_CONTRACT, workspaceId, stageId: descriptor.stageId, actor: descriptor.actor, kind: descriptor.kind, requestFingerprint };
  const lookupRaw = JSON.stringify(lookup);
  if (Buffer.byteLength(lookupRaw) > ORDER_RECOVERY_LIMITS.input) throw orderRecoveryError('TOO_LARGE', 413);
  return Object.freeze({ descriptor, body, lookupBody: JSON.stringify({ p_request: lookupRaw }), pathname: `rpc/runvara_${descriptor.kind}_order_recovery`,
    expected: Object.freeze({ schema:'shopify-order-recovery-ack/v1', kind:descriptor.kind, workspaceId,stageId:descriptor.stageId,requestFingerprint,
      stageRevision:descriptor.expectedStageRevision + 1, expectedRevision: descriptor.kind === 'append' ? null : expectedRevision, nextRevision: descriptor.kind === 'append' ? null : state._revision }) });
}
function checkedAck(value, transaction, lookup = false) {
  const expected = transaction.expected;
  if (!exact(value, [...Object.keys(expected), 'logicalBytes', 'status', 'replayed']) || bytes(value) > ORDER_RECOVERY_LIMITS.ack
    || Object.entries(expected).some(([key, item]) => value[key] !== item) || !Number.isSafeInteger(value.logicalBytes) || value.logicalBytes < 0 || value.logicalBytes > 2097152
    || typeof value.replayed !== 'boolean' || lookup && !value.replayed
    || !(value.status === transaction.descriptor.expectedStatus || transaction.descriptor.kind === 'append' && value.status === 'paused')) throw orderRecoveryError('COMMIT_UNCONFIRMED', 503, false);
  return Object.freeze(structuredClone(value));
}
function deterministic(cause) {
  const code = cause?.databaseCode;
  if (['P0Q01','P0Q02','P0Q03','P0Q04','P0Q05'].includes(code)) return orderRecoveryError(({ P0Q01:'INVALID',P0Q02:'AUTHORITY_CHANGED',P0Q03:'CAPACITY_OR_MODE',P0Q04:'CONFLICT',P0Q05:'PROTECTED_WRITE' })[code], code === 'P0Q02' ? 403 : 409);
  if (['42P01','42883','42703','42501','PGRST202','PGRST203','PGRST204'].includes(code) || [401,403,404].includes(cause?.httpStatus)) return orderRecoveryError('UNAVAILABLE',503);
  if (cause?.httpStatus === 413) return orderRecoveryError('TOO_LARGE',413);
  if (/^(22|23)/.test(code || '') || [400,422].includes(cause?.httpStatus)) return orderRecoveryError('INVALID');
  return null;
}
// A transport exception never authorizes another mutation or provider request.
// The locking exact lookup settles an already-started transaction; a later
// admission is the fence for an old request that has not reached the database.
export async function commitOrderRecoveryTransaction(transaction, request) {
  try {
    const ack = checkedAck(await request('state_commit', transaction.pathname, { method:'POST',body:transaction.body,maxResponseBytes:ORDER_RECOVERY_LIMITS.ack }), transaction);
    return { ack, recovered:ack.replayed };
  } catch (cause) {
    const refused = deterministic(cause);
    if (refused) throw refused;
    try {
      const result = await request('state_read','rpc/runvara_lookup_order_recovery',{ method:'POST',body:transaction.lookupBody,maxResponseBytes:ORDER_RECOVERY_LIMITS.ack });
      if (result !== null) return { ack:checkedAck(result,transaction,true), recovered:true };
    } catch { /* No exact immutable proof; never use the mutable manifest. */ }
    const error = orderRecoveryError('COMMIT_UNCONFIRMED',503,false);
    // Compact exact identity only. Never retain the candidate, credentials,
    // mutation body or pages in the process-local uncertainty guard.
    error.reconciliation = Object.freeze({ expected:transaction.expected,expectedStatus:transaction.descriptor.expectedStatus });
    throw error;
  }
}
export async function lookupOrderRecovery(request, workspaceId, actor, identity) {
  actor = validateOrderRecoveryActor(actor);
  const expected = identity?.expected;
  if (!object(expected) || expected.workspaceId !== workspaceId || !id(expected.stageId) || !['reserve','append','finalize'].includes(expected.kind)
    || !/^sha256:[a-f0-9]{64}$/.test(expected.requestFingerprint)) throw orderRecoveryError('INVALID');
  const raw = JSON.stringify({schema:ORDER_RECOVERY_CONTRACT,workspaceId,stageId:expected.stageId,actor,kind:expected.kind,requestFingerprint:expected.requestFingerprint});
  if (Buffer.byteLength(raw)>ORDER_RECOVERY_LIMITS.input) throw orderRecoveryError('TOO_LARGE',413);
  const result = await request('state_read','rpc/runvara_lookup_order_recovery',{method:'POST',body:JSON.stringify({p_request:raw}),maxResponseBytes:ORDER_RECOVERY_LIMITS.ack});
  return result === null ? null : checkedAck(result,{expected,descriptor:{kind:expected.kind,expectedStatus:identity.expectedStatus}},true);
}
export async function readOrderRecovery(request, workspaceId, actor, stageId = null, { view = 'summary' } = {}) {
  actor = validateOrderRecoveryActor(actor);
  if (!id(workspaceId) || !(stageId === null || id(stageId)) || !['summary','full'].includes(view)) throw orderRecoveryError('INVALID');
  const raw = JSON.stringify({ schema:ORDER_RECOVERY_CONTRACT,workspaceId,stageId,actor,view });
  if (Buffer.byteLength(raw) > ORDER_RECOVERY_LIMITS.input) throw orderRecoveryError('TOO_LARGE',413);
  const limit = ORDER_RECOVERY_LIMITS[view];
  const result = await request('state_read','rpc/runvara_read_order_recovery',{ method:'POST',body:JSON.stringify({p_request:raw}),maxResponseBytes:limit });
  if (!exact(result,['schema','mode','stage','quota']) || result.schema !== 'shopify-order-recovery-read/v1' || !['prepared','enforced','paused'].includes(result.mode) || bytes(result) > limit
    || !exact(result.quota,['unfinishedStages','logicalBytes','maxStages','maxBytes']) || result.quota.maxStages !== 8 || result.quota.maxBytes !== 16777216
    || !Number.isSafeInteger(result.quota.unfinishedStages) || result.quota.unfinishedStages < 0 || result.quota.unfinishedStages > 8
    || !Number.isSafeInteger(result.quota.logicalBytes) || result.quota.logicalBytes < 4096 || result.quota.logicalBytes > result.quota.maxBytes) throw orderRecoveryError('READ_INVALID',503);
  const stage = result.stage;
  if (stage !== null) {
    if (!object(stage) || stage.binding?.workspaceId !== workspaceId || stageId !== null && stage.id !== stageId) throw orderRecoveryError('READ_INVALID',503);
    if (view === 'full') validateShopifyOrderRecoveryStage(stage);
    else if (!exact(stage,['schema','id','binding','revision','status','admissions','legacyBytes','logicalBytes','continued','pageCount','ordersRead','lastCapturedAt','pageCaptureTimes','snapshotConsistency'])
      || stage.schema !== 'shopify-order-recovery-stage/v1' || stage.snapshotConsistency !== 'unverified' || !Number.isSafeInteger(stage.logicalBytes) || stage.logicalBytes < 1 || stage.logicalBytes > 2097152
      || !Number.isSafeInteger(stage.legacyBytes) || stage.legacyBytes < 2 || stage.legacyBytes > 2097152
      || !Number.isSafeInteger(stage.pageCount) || stage.pageCount < 0 || stage.pageCount > 10 || !Number.isSafeInteger(stage.ordersRead) || stage.ordersRead < 0 || stage.ordersRead > 500
      || !Array.isArray(stage.pageCaptureTimes) || stage.pageCaptureTimes.length !== stage.pageCount || stage.pageCaptureTimes.some(value=>!iso(value)) || !(stage.lastCapturedAt === null || iso(stage.lastCapturedAt))
      || !['reading','complete','failed','paused','unknown','committed','superseded'].includes(stage.status) || !id(stage.id) || !Number.isSafeInteger(stage.revision) || stage.revision < 1
      || !Array.isArray(stage.admissions) || !stage.admissions.length || stage.admissions.length > 5 || typeof stage.continued !== 'boolean') throw orderRecoveryError('READ_INVALID',503);
  }
  return structuredClone(result);
}

const CONTEXT_FIELDS = ['workspaceId','revision','actorId','connectionId','runId','actorIndex','connectionIndex','runIndex'];
export function prepareOrderRecoveryContext(state, actorId, connectionId, runId) {
  const unique = (rows, key, value) => { if (!Array.isArray(rows)) throw orderRecoveryError('CONTEXT_UNAVAILABLE',503); const indexes = rows.flatMap((row,index)=>row?.[key] === value ? [index] : []); if (indexes.length !== 1) throw orderRecoveryError('CONTEXT_UNAVAILABLE',503); return indexes[0]; };
  if (!id(state?._revision) || !id(state?.workspace?.id) || state.connections?.filter(row=>row?.provider === 'shopify').length !== 1) throw orderRecoveryError('CONTEXT_UNAVAILABLE',503);
  return Object.freeze({workspaceId:state.workspace.id,revision:state._revision,actorId,connectionId,runId,
    actorIndex:unique(state.users,'id',actorId),connectionIndex:unique(state.connections,'id',connectionId),runIndex:unique(state.connectionSyncs,'id',runId)});
}
export async function getOrderRecoveryContext(request, workspaceId, input, { actor,stageId } = {}) {
  const fail = () => orderRecoveryError('CONTEXT_UNAVAILABLE',503);
  if (!exact(input,CONTEXT_FIELDS) || input.workspaceId !== workspaceId || !['workspaceId','revision','actorId','connectionId','runId'].every(key=>id(input[key]))
    || !['actorIndex','connectionIndex','runIndex'].every(key=>Number.isSafeInteger(input[key]) && input[key]>=0 && input[key]<=4095)) throw fail();
  actor = validateOrderRecoveryActor(actor);
  if (!id(stageId) || actor.id !== input.actorId) throw fail();
  const raw = JSON.stringify({schema:ORDER_RECOVERY_CONTRACT,workspaceId,stageId,actor,view:'context',context:input});
  if (Buffer.byteLength(raw)>ORDER_RECOVERY_LIMITS.input) throw fail();
  let row;
  try { row = await request('state_read','rpc/runvara_read_order_recovery',{method:'POST',body:JSON.stringify({p_request:raw}),maxResponseBytes:ORDER_RECOVERY_LIMITS.summary}); }
  catch { throw fail(); }
  if (!exact(row,['schema','mode','workspace_id','revision','workspace','actor','connection','run','settings','doctor','status','firstSync','sourceGeneration']) || bytes(row)>ORDER_RECOVERY_LIMITS.summary
    || row.schema !== 'shopify-order-recovery-context/v1' || row.mode !== 'enforced' || row.workspace_id!==workspaceId || row.revision!==input.revision || row.workspace?.id!==workspaceId
    || row.actor?.id!==input.actorId || row.connection?.id!==input.connectionId || row.connection.provider!=='shopify' || row.run?.id!==input.runId || row.run.provider!=='shopify') throw fail();
  return { _revision:row.revision,workspace:row.workspace,users:[row.actor],connections:[row.connection],connectionSyncs:[row.run],connectionSettings:{shopify:row.settings || {}},connectionDoctor:{shopify:row.doctor || {}},integrationStatus:{shopify:row.status || {}},connectionFirstSync:{shopify:row.firstSync},channelData:{shopify:{orderReads:{lastSuccess:row.sourceGeneration}}} };
}
