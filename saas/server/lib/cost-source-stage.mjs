import { types } from 'node:util';

export const COST_SOURCE_REVIEW_CONTRACT = 'runvara-cost-source-reviews/v1';
export const COST_SOURCE_REVIEW_PAUSED_MESSAGE = 'New cost source reviews are paused on this server. Saved costs and source history remain available. No financial action has been authorized.';

// Independent process-start admission. Opening other governed producers cannot
// enable this private metadata format before every serving reader is compatible.
const stages = new WeakMap();
export function createCostSourceStage(env = {}) {
  const field = env && typeof env === 'object' && !types.isProxy(env)
    ? Object.getOwnPropertyDescriptor(env, 'COST_SOURCE_REVIEW_CONTRACT') : null;
  const stage = Object.freeze(Object.create(null));
  stages.set(stage, Boolean(field && Object.hasOwn(field, 'value')
    && typeof field.value === 'string' && field.value === COST_SOURCE_REVIEW_CONTRACT));
  return stage;
}

export function costSourceCreationEnabled(stage) { return stages.get(stage) === true; }
export function assertCostSourceCreation(stage) {
  if (!costSourceCreationEnabled(stage)) throw Object.assign(new Error(COST_SOURCE_REVIEW_PAUSED_MESSAGE),
    { status: 503, code: 'COST_SOURCE_REVIEW_PAUSED', definitive: true });
}
