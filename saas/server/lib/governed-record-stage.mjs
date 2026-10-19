import { types } from 'node:util';

export const GOVERNED_RECORD_PRODUCER_CONTRACT = 'runvara-governed-record-producers/v1';
export const GOVERNED_RECORDS_PAUSED_MESSAGE = 'New governed records are paused on this server. Existing records remain available for review and exact reconciliation.';

// This is process-start admission, not persisted authority or a live fleet latch.
// Only constructor-owned identities can enable producers; copying or forging
// the public shape cannot open a service's default-closed boundary.
const stages = new WeakMap();
export function createGovernedRecordStage(env = {}) {
  const field = env && typeof env === 'object' && !types.isProxy(env)
    ? Object.getOwnPropertyDescriptor(env, 'GOVERNED_RECORD_PRODUCER_CONTRACT') : null;
  const stage = Object.freeze(Object.create(null));
  stages.set(stage, Boolean(field && Object.hasOwn(field, 'value')
    && typeof field.value === 'string' && field.value === GOVERNED_RECORD_PRODUCER_CONTRACT));
  return stage;
}

export function governedRecordCreationEnabled(stage) {
  return stages.get(stage) === true;
}

export function assertGovernedRecordCreation(stage) {
  if (!governedRecordCreationEnabled(stage)) throw Object.assign(
    new Error(GOVERNED_RECORDS_PAUSED_MESSAGE),
    { status: 503, code: 'GOVERNED_RECORDS_PAUSED', definitive: true });
}

const record = value => value !== null && typeof value === 'object';
const own = (value, key) => record(value) && Object.hasOwn(value, key);
function data(value, key) {
  if (!record(value)) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && Object.hasOwn(field, 'value') ? field.value : undefined;
}

// Presence is intentional: null, unknown versions and malformed companions
// must never turn retained governed authority into an ordinary manual request.
// This is conservative classification only; existing validators still decide
// whether an admitted record supplies any valid authority.
export function hasGovernedConnectionWriteMarkers(write, approval) {
  if (types.isProxy(write) || types.isProxy(approval)) return true;
  const input = data(write, 'input');
  if (types.isProxy(input) || data(write, 'provider') === 'shopify' && data(input, 'operation') === 'product_content' && own(input, 'schema')) return true;
  if (['objectivePolicyProposal', 'objectiveRef', 'policyBinding', 'executionPolicy', 'financialEvidence']
    .some(key => own(write, key))) return true;
  const payload = data(approval, 'payload');
  if (types.isProxy(payload) || own(payload, 'objectivePolicyProposalDigest')) return true;
  return [write, approval, payload].some(row => own(row, 'objectivePolicyProposal')
    || own(row, 'objectivePolicyProposalDigest')
    || ['owner_objective_content', 'objective-content'].includes(data(row, 'origin'))
    || ['owner_objective_content', 'objective-content'].includes(data(row, 'source')));
}
