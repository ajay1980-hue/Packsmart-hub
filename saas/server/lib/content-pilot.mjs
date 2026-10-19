import { createHash } from 'node:crypto';
import { contentWriteSnapshot, contentInputPreimage } from './content-write-identity.mjs';
import { connectionSettings } from './connection-centre.mjs';
import { assertGovernedRecordCreation, governedRecordCreationEnabled } from './governed-record-stage.mjs';
import { descriptionEditPreimage, isDescriptionEdit } from './description-edit.mjs';

// Trusted composition only: no environment parser, HTTP issuer or workspace
// flag. A copied/serialized capability cannot admit any request. This narrows
// admission, never approval, objective policy, tenant or durable receipt checks.
const scopes = new WeakMap();
const commitPermits = new WeakMap();
export const CONTENT_PILOT_SCHEMA = 'runvara-single-content-pilot/v1';
export const DESCRIPTION_PILOT_SCHEMA = 'runvara-single-content-pilot/v2';
export const DESCRIPTION_PILOT_BASELINE_QUERY = 'query RunvaraDescriptionPilotBaseline($id: ID!) { product(id: $id) { id descriptionHtml updatedAt } }';
export const CONTENT_PILOT_BASELINE_QUERY = 'query RunvaraContentPilotBaseline($id: ID!) { product(id: $id) { id title descriptionHtml updatedAt } }';
const fail = (code = 'CONTENT_PILOT_SCOPE_MISMATCH') => Object.assign(new Error(code), { code, status: 409, definitive: true });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
function exact(value, keys) {
  // Reject proxies, accessors, exotic prototypes and non-JSON before reading.
  contentWriteSnapshot(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw fail('CONTENT_PILOT_INVALID');
}
export const contentPilotDescriptionHtml = description => `<p>${description.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/\n/g, '<br>')}</p>`;

export function createContentPilot(scope) {
  contentWriteSnapshot(scope);
  if (scope?.schema === DESCRIPTION_PILOT_SCHEMA) {
    exact(scope, ['schema', 'workspaceId', 'connectionId', 'account', 'productId', 'operation', 'requestId', 'requestedBy',
      'inputDigest', 'settingsRevision', 'expiresAt', 'input']);
    const input = descriptionEditPreimage(scope.input);
    if (!text(scope.workspaceId, 256) || !text(scope.connectionId, 160) || !text(scope.requestedBy, 160)
      || !text(scope.account, 253) || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(scope.account)
      || scope.productId !== input.productId || scope.operation !== input.operation
      || !text(scope.requestId, 100) || !/^[A-Za-z0-9_-]{16,100}$/.test(scope.requestId)
      || hash(input) !== scope.inputDigest || !Number.isSafeInteger(scope.settingsRevision) || scope.settingsRevision < 0
      || !stamp(scope.expiresAt)) throw fail('CONTENT_PILOT_INVALID');
    const capability = Object.freeze(Object.create(null));
    scopes.set(capability, { scope: structuredClone(scope), paused: false, attempt: null });
    return capability;
  }
  exact(scope, ['schema', 'workspaceId', 'connectionId', 'account', 'productId', 'operation', 'requestId', 'requestedBy',
    'inputDigest', 'settingsRevision', 'expiresAt', 'baseline', 'replacementDescription']);
  exact(scope.baseline, ['title', 'descriptionHtml', 'updatedAt']);
  if (scope.schema !== CONTENT_PILOT_SCHEMA || !text(scope.workspaceId, 256) || !text(scope.connectionId, 160)
    || !text(scope.requestedBy, 160) || !text(scope.account, 253) || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(scope.account)
    || !text(scope.productId, 100) || !/^gid:\/\/shopify\/Product\/\d+$/.test(scope.productId) || scope.operation !== 'product_content'
    || !text(scope.requestId, 100) || !/^[A-Za-z0-9_-]{16,100}$/.test(scope.requestId)
    || !text(scope.inputDigest, 64) || !/^[a-f0-9]{64}$/.test(scope.inputDigest)
    || !Number.isSafeInteger(scope.settingsRevision) || scope.settingsRevision < 0 || !stamp(scope.expiresAt)
    || !stamp(scope.baseline.updatedAt) || !text(scope.baseline.title, 200)
    || typeof scope.baseline.descriptionHtml !== 'string' || scope.baseline.descriptionHtml.length > 60007
    || typeof scope.replacementDescription !== 'string' || !scope.replacementDescription.trim()
    || scope.replacementDescription.length > 10000 || !scope.replacementDescription.isWellFormed()
    || /[\u0000-\u001f\u007f]/.test(scope.replacementDescription)
    // v1 receipts encode one escaped paragraph and also send the unchanged
    // title. Do not flatten richer HTML or silently reinterpret that contract.
    || !/^<p>(?:[^<]|<br>)*<\/p>$/.test(scope.baseline.descriptionHtml)
    || contentPilotDescriptionHtml(scope.replacementDescription) === scope.baseline.descriptionHtml) throw fail('CONTENT_PILOT_UNSUPPORTED_CONTENT');
  const input = { productId: scope.productId, operation: scope.operation, title: scope.baseline.title, description: scope.replacementDescription };
  if (hash(contentInputPreimage(input)) !== scope.inputDigest) throw fail('CONTENT_PILOT_INVALID');
  const capability = Object.freeze(Object.create(null));
  scopes.set(capability, { scope: structuredClone(scope), paused: false, attempt: null });
  return capability;
}

export function assertContentPilotConfiguration(pilot, stage) {
  if (!scopes.has(pilot)) throw fail('CONTENT_PILOT_INVALID');
  if (governedRecordCreationEnabled(stage)) throw fail('CONTENT_PILOT_BROAD_GATE_OPEN');
}
export function pauseContentPilot(pilot) {
  const entry = scopes.get(pilot);
  if (!entry) throw fail('CONTENT_PILOT_INVALID');
  entry.paused = true; // Deliberately no resume/reset; an attempt is not reusable.
}
export function assertContentPilotScope(pilot, state, write, attempt = null) {
  const entry = scopes.get(pilot);
  if (!entry) throw fail('CONTENT_PILOT_INVALID');
  if (entry.paused) throw fail('CONTENT_PILOT_PAUSED');
  if (Date.now() >= Date.parse(entry.scope.expiresAt)) throw fail('CONTENT_PILOT_EXPIRED');
  if (entry.attempt && entry.attempt !== attempt) throw fail('CONTENT_PILOT_ALREADY_ATTEMPTED');
  const s = entry.scope;
  contentWriteSnapshot(write);
  if (state.workspace?.id !== s.workspaceId || write.provider !== 'shopify' || write.input?.operation !== s.operation
    || write.input.productId !== s.productId || write.connectionId !== s.connectionId || write.account !== s.account
    || write.requestId !== s.requestId || write.requestedBy !== s.requestedBy || write.requiresApproval !== true
    || write.digest !== s.inputDigest || hash(contentInputPreimage(write.input)) !== s.inputDigest
    || (s.schema === DESCRIPTION_PILOT_SCHEMA ? !isDescriptionEdit(write.input)
      || contentWriteSnapshot(write.input) !== contentWriteSnapshot(s.input)
      : write.input.title !== s.baseline.title || write.input.description !== s.replacementDescription)
    || (write.objectivePolicyProposal && write.objectivePolicyProposal.origin !== 'owner_manual')
    || (connectionSettings(state, 'shopify').revision ?? 0) !== s.settingsRevision) throw fail();
  const matches = (state.connectionWrites || []).filter(row => row.requestId === s.requestId);
  if (matches.length > 1 || matches.length === 1 && matches[0].id !== write.id) throw fail();
}
export function beginContentPilotAttempt(pilot, state, write) {
  assertContentPilotScope(pilot, state, write);
  const attempt = Object.freeze(Object.create(null));
  scopes.get(pilot).attempt = attempt;
  return attempt;
}
export function contentPilotCommitPermit(pilot, attempt, state, write, descriptor) {
  assertContentPilotScope(pilot, state, write, attempt);
  if (descriptor.kind !== 'reserve' || descriptor.admission.writeId !== write.id
    || descriptor.admission.workspaceId !== state.workspace.id) throw fail();
  const permit = Object.freeze(Object.create(null));
  commitPermits.set(permit, { pilot, attempt, writeId: write.id, descriptor: contentWriteSnapshot(descriptor) });
  return permit;
}
export function assertContentReceiptProducer(stage, permit, state, descriptor) {
  if (descriptor.kind !== 'reserve') return;
  const binding = commitPermits.get(permit);
  if (binding) {
    if (binding.descriptor !== contentWriteSnapshot(descriptor)) throw fail();
    const rows = state.connectionWrites?.filter(row => row.id === binding.writeId) || [];
    if (rows.length !== 1) throw fail();
    assertContentPilotConfiguration(binding.pilot, stage);
    assertContentPilotScope(binding.pilot, state, rows[0], binding.attempt);
  } else {
    if (permit !== undefined || isDescriptionEdit(descriptor.sourceTemplate?.input)) throw fail('CONTENT_PILOT_REQUIRED');
    assertGovernedRecordCreation(stage);
  }
}
export function assertContentProducerAdmission(stage, pilot, state, write, attempt = null) {
  if (isDescriptionEdit(write?.input) && !scopes.has(pilot)) throw fail('CONTENT_PILOT_REQUIRED');
  if (pilot !== null && pilot !== undefined) {
    assertContentPilotConfiguration(pilot, stage);
    assertContentPilotScope(pilot, state, write, attempt);
  } else assertGovernedRecordCreation(stage);
}
export async function checkContentPilotBaseline(pilot, state, write, attempt, integrations, config) {
  assertContentPilotScope(pilot, state, write, attempt);
  const expected = scopes.get(pilot).scope;
  const description = expected.schema === DESCRIPTION_PILOT_SCHEMA;
  if (config.domain !== expected.account || config.workspaceId !== expected.workspaceId) throw fail();
  const result = await integrations.shopifyGraphql(description ? DESCRIPTION_PILOT_BASELINE_QUERY : CONTENT_PILOT_BASELINE_QUERY, { id: expected.productId }, config);
  assertContentPilotScope(pilot, state, write, attempt);
  const product = result?.product;
  if (!product || product.id !== expected.productId || !description && product.title !== expected.baseline.title
    || product.descriptionHtml !== (description ? expected.input.baselineHtml : expected.baseline.descriptionHtml)
    || product.updatedAt !== (description ? expected.input.baselineUpdatedAt : expected.baseline.updatedAt)) {
    throw fail('WRITE_BASELINE_CHANGED');
  }
  // This observation and productUpdate are NOT an atomic compare-and-set.
}
