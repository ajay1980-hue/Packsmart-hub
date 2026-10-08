import { canonicalReviewedActionJson } from './reviewed-action-evidence.mjs';
import { CONTENT_EXECUTION_RECEIPT_CONTRACT, CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA,
  CONTENT_EXECUTION_RECEIPT_ACK_MAX_BYTES, CONTENT_EXECUTION_RESERVED_BYTES,
  validateContentExecutionCommit, contentReceiptRequestFingerprint } from './content-execution-receipt.mjs';

export const CONTENT_RECEIPT_TRANSACTION_MAX_BYTES = 2162688;
export const CONTENT_RECEIPT_HTTP_BODY_MAX_BYTES = 4325440;
export const CONTENT_RECEIPT_LOOKUP_MAX_BYTES = 4096;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const failure = (code, status = 503, definitive = false) => Object.assign(new Error(code), { code, status, definitive });
const unconfirmed = () => failure('CONTENT_RECEIPT_COMMIT_UNCONFIRMED');

// Only documented database errors establish that this transaction was refused.
// A malformed/absent success response is ambiguous and needs exact evidence.
function deterministicFailure(cause) {
  const mapped = {
    P0R01: ['CONTENT_RECEIPT_INVALID', 409],
    P0R02: ['STATE_CONFLICT', 409],
    P0R03: ['CONTENT_RECEIPT_ACTOR_REQUIRED', 403],
    P0R04: ['CONTENT_RECEIPT_IDENTITY_CONFLICT', 409],
    P0R05: ['CONTENT_RECEIPT_CAPACITY_EXHAUSTED', 409],
    P0R06: ['CONTENT_RECEIPT_GUARD_REQUIRED', 409],
    P0R07: ['CONTENT_RECEIPT_UNAVAILABLE', 503],
    P0O01: ['CONTENT_RECEIPT_INVALID', 409],
    P0O10: ['CONTENT_RECEIPT_TOO_LARGE', 413]
  }[cause?.databaseCode];
  if (mapped) return failure(...mapped, true);
  if (['42P01', '42883', '42703', '42501', 'PGRST202', 'PGRST203', 'PGRST204'].includes(cause?.databaseCode)
    || [401, 403, 404].includes(cause?.httpStatus)) return failure('CONTENT_RECEIPT_UNAVAILABLE', 503, true);
  if (cause?.httpStatus === 413) return failure('CONTENT_RECEIPT_TOO_LARGE', 413, true);
  if (/^(22|23)/.test(cause?.databaseCode || '')) return failure('CONTENT_RECEIPT_INVALID', 409, true);
  if ([400, 422].includes(cause?.httpStatus)) return failure('CONTENT_RECEIPT_INVALID', 409, true);
  return null;
}

/** Freeze transport once. Retries never rebuild state, a fence or an identity. */
export function prepareContentReceiptTransaction(workspaceId, state, expectedRevision, descriptor) {
  descriptor = validateContentExecutionCommit(descriptor);
  if (workspaceId !== descriptor.admission.workspaceId || state?.workspace?.id !== workspaceId
    || typeof expectedRevision !== 'string' || !UUID.test(expectedRevision)
    || typeof state?._revision !== 'string' || !UUID.test(state._revision) || state._revision === expectedRevision) {
    throw failure('CONTENT_RECEIPT_INVALID', 409, true);
  }
  if (Buffer.byteLength(JSON.stringify(state)) >= 2097152) throw failure('STATE_SIZE_LIMIT', 503, true);
  const raw = JSON.stringify({ contract: CONTENT_EXECUTION_RECEIPT_CONTRACT, kind: descriptor.kind, workspaceId,
    expectedRevision, nextRevision: state._revision, state, admission: descriptor.admission,
    ...(descriptor.kind === 'reserve' ? { sourceTemplate: descriptor.sourceTemplate } : { receipt: descriptor.receipt }) });
  const body = JSON.stringify({ p_request_json: raw });
  if (Buffer.byteLength(raw) > CONTENT_RECEIPT_TRANSACTION_MAX_BYTES || Buffer.byteLength(body) > CONTENT_RECEIPT_HTTP_BODY_MAX_BYTES) {
    throw failure('CONTENT_RECEIPT_TOO_LARGE', 413, true);
  }
  const requestFingerprint = contentReceiptRequestFingerprint(raw), a = descriptor.admission;
  const expectedAck = Object.freeze({ schema: CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA, kind: descriptor.kind,
    workspaceId, attemptId: a.attemptId, admissionDigest: a.digest, intentDigest: a.intentDigest,
    expectedRevision, nextRevision: state._revision, receiptDigest: descriptor.kind === 'finalize' ? descriptor.receipt.digest : null,
    reservedBytes: CONTENT_EXECUTION_RESERVED_BYTES, requestFingerprint });
  const lookupBody = JSON.stringify({ p_workspace_id: workspaceId, p_attempt_id: a.attemptId, p_kind: descriptor.kind,
    p_request_fingerprint: requestFingerprint, p_actor_id: a.actorId, p_actor_session_version: a.actorSessionVersion });
  if (Buffer.byteLength(lookupBody) > CONTENT_RECEIPT_LOOKUP_MAX_BYTES) throw failure('CONTENT_RECEIPT_TOO_LARGE', 413, true);
  return Object.freeze({ descriptor, body, lookupBody, expectedAck,
    pathname: `rpc/runvara_${descriptor.kind}_content_receipt` });
}

function checkedAck(ack, transaction, { lookup = false } = {}) {
  try {
    // Reject accessors, exotic objects, unknown fields and every altered binding.
    const json = canonicalReviewedActionJson(ack), keys = Object.keys(transaction.expectedAck);
    if (!ack || Array.isArray(ack) || Object.keys(ack).length !== keys.length + 1
      || !keys.every(key => Object.hasOwn(ack, key) && ack[key] === transaction.expectedAck[key])
      || !Object.hasOwn(ack, 'replayed') || typeof ack.replayed !== 'boolean' || lookup && !ack.replayed
      || Buffer.byteLength(json) > CONTENT_EXECUTION_RECEIPT_ACK_MAX_BYTES) throw unconfirmed();
    return Object.freeze(JSON.parse(json));
  } catch { throw unconfirmed(); }
}

/** At most two identical mutations and two compact exact reconciliation reads. */
export async function commitContentReceiptTransaction(transaction, request) {
  let uncertain = false, retryKind = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ack = checkedAck(await request('state_commit', transaction.pathname, {
        method: 'POST', body: transaction.body, maxResponseBytes: CONTENT_EXECUTION_RECEIPT_ACK_MAX_BYTES
      }, retryKind), transaction);
      return { ack, recovered: uncertain || ack.replayed };
    } catch (cause) {
      const deterministic = deterministicFailure(cause);
      if (deterministic && !uncertain) throw deterministic;
      if (cause?.databaseCode === '57014' && !uncertain) {
        // PostgreSQL reports that this statement was cancelled, not committed.
        if (attempt === 0) { retryKind = 'primary_statement_cancelled'; continue; }
        throw unconfirmed();
      }
      // A later denial or cancellation describes only that retry. Once an
      // earlier mutation was ambiguous it cannot prove the original rolled
      // back. Use the remaining exact lookup, then retain uncertainty.
      uncertain = true;
      try {
        const result = await request('state_read', 'rpc/runvara_read_content_receipt', {
          method: 'POST', body: transaction.lookupBody, maxResponseBytes: CONTENT_EXECUTION_RECEIPT_ACK_MAX_BYTES
        });
        if (result !== null) return { ack: checkedAck(result, transaction, { lookup: true }), recovered: true };
      } catch { /* No exact proof. No revision-only fallback or source read. */ }
      retryKind = 'primary_network_reconciled';
    }
  }
  throw unconfirmed();
}
