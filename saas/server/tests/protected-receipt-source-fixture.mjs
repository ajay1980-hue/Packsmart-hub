import { reviewedActionFixture } from './reviewed-action-test-fixture.mjs';
import { digestReviewedActionValue } from '../lib/reviewed-action-evidence.mjs';
import { contentExecutionSourceIntent, CONTENT_EXECUTION_RECEIPT_CONTRACT, validateContentExecutionCommit } from '../lib/content-execution-receipt.mjs';

// Synthetic immutable row envelope. No database or provider transport is used.
export function protectedReceiptFixture(options = {}) {
  const fixture = options.fixture ?? reviewedActionFixture(options), source = fixture.source, c = source.context;
  const admissionBody = { schema: 'runvara-content-execution-admission/v1', workspaceId: c.workspaceId,
    attemptId: `content_attempt_${digestReviewedActionValue([c.workspaceId, c.claimId, c.phase])}`,
    writeId: c.writeId, requestId: c.requestId, claimId: c.claimId, claimIdentity: c.claimIdentity,
    authorityDigest: 'b'.repeat(64), actorId: c.executedBy,
    actorSessionVersion: c.proposal?.source?.actorSessionVersion ?? 3, phase: c.phase,
    dispatchRequestDigest: c.dispatchRequestDigest, intentDigest: contentExecutionSourceIntent(source),
    admittedAt: c.completedAt, reservedBytes: 40960 };
  const admission = { ...admissionBody, digest: digestReviewedActionValue(admissionBody) };
  const receiptBody = { schema: 'runvara-content-execution-receipt/v1', workspaceId: c.workspaceId,
    attemptId: admission.attemptId, admissionDigest: admission.digest, intentDigest: admission.intentDigest,
    observation: 'provider_confirmed', source };
  const receipt = { ...receiptBody, digest: digestReviewedActionValue(receiptBody) };
  validateContentExecutionCommit({ contract: CONTENT_EXECUTION_RECEIPT_CONTRACT, kind: 'finalize', admission, receipt });
  const evidence = { schema: 'runvara-outcome-content-source-private/v1', admission, receipt,
    commitRevision: '11111111-2222-3333-4444-555555555555' };
  const selector = { attemptId: receipt.attemptId, receiptDigest: receipt.digest, sourceDigest: source.digest };
  return { ...fixture, evidence, selector };
}
