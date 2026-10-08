// These are display projections, never signed proposals or execution authority.
// Keep every level allowlisted: stored records may acquire private fields later.
export const OBJECTIVE_CONTENT_DISPLAY_SCHEMA = 'runvara-objective-content-display/v1';

function field(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  // Optional malformed display material must not invoke accessors or turn a
  // confirmed provider result into a failed response.
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch { return undefined; }
}
function hasField(value, key) {
  try { return Boolean(value && typeof value === 'object' && Object.hasOwn(value, key)); }
  catch { return false; }
}
const string = value => typeof value === 'string';
const nullableString = value => value === null || string(value);
const number = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value);
const boolean = value => typeof value === 'boolean';
function copy(target, source, keys, accepts = string) {
  for (const key of keys) {
    const value = field(source, key);
    if (accepts(value)) target[key] = value;
  }
  return target;
}
function stringArray(value) {
  if (!Array.isArray(value)) return undefined;
  // Do not retain a partial exact input if one member is malformed.
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = arrayItem(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !string(descriptor.value)) return undefined;
    result.push(descriptor.value);
  }
  return result;
}
function arrayItem(value, index) {
  try { return Object.getOwnPropertyDescriptor(value, index); }
  catch { return undefined; }
}
function rows(value, project) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = arrayItem(value, index);
    if (descriptor && Object.hasOwn(descriptor, 'value')) result.push(project(descriptor.value));
  }
  return result;
}
function publicInput(provider, input) {
  const operation = field(input, 'operation'), result = {};
  if (provider === 'shopify') {
    if (!['product_content', 'internal_note', 'product_tags_add', 'product_tags_remove'].includes(operation)) return result;
    copy(result, input, ['operation', 'productId']);
    if (operation === 'product_content') copy(result, input, ['title', 'description']);
    else if (operation === 'internal_note') copy(result, input, ['note']);
    else for (const key of ['tags', 'expectedTags']) {
      const values = stringArray(field(input, key));
      if (values) result[key] = values;
    }
  } else if (provider === 'meta') {
    switch (operation) {
      case 'catalog_product_create':
        copy(result, input, ['operation', 'catalogId', 'name', 'description', 'retailerId', 'brand', 'category', 'url', 'imageUrl', 'currency', 'availability', 'condition', 'visibility']);
        copy(result, input, ['priceMinor'], integer);
        break;
      case 'catalog_product_update':
        copy(result, input, ['operation', 'catalogId', 'productId', 'name', 'description']);
        break;
      case 'catalog_visibility':
        copy(result, input, ['operation', 'catalogId', 'productId', 'visibility']);
        break;
      case 'catalog_inventory':
        copy(result, input, ['operation', 'catalogId', 'productId', 'availability']);
        copy(result, input, ['quantity'], integer);
        break;
      case 'instagram_publish':
        copy(result, input, ['operation', 'pageId', 'instagramId', 'caption', 'imageUrl']);
        break;
      case 'facebook_publish':
        copy(result, input, ['operation', 'pageId', 'message', 'link']);
        break;
      case 'facebook_update':
        copy(result, input, ['operation', 'pageId', 'message', 'postId']);
        break;
    }
  }
  return result;
}
function sourceDisplay(write) {
  const proposal = field(write, 'objectivePolicyProposal'), schema = field(proposal, 'schema'), origin = field(proposal, 'origin');
  if (!hasField(write, 'objectivePolicyProposal') && !hasField(write, 'source') && !hasField(write, 'origin')) return undefined;
  if (schema === 'runvara-objective-dispatch-proposal/v1' && origin === 'owner_manual'
    && !hasField(proposal, 'source') && !hasField(write, 'source') && !hasField(write, 'origin')) return undefined;
  const objective = schema === 'runvara-objective-dispatch-proposal/v2' || origin === 'owner_objective_content';
  const result = { schema: OBJECTIVE_CONTENT_DISPLAY_SCHEMA, origin: objective ? 'owner_objective_content' : 'unknown', status: 'unavailable' };
  if (!objective || schema !== 'runvara-objective-dispatch-proposal/v2' || origin !== 'owner_objective_content') return result;
  const source = field(proposal, 'source');
  const input = field(write, 'input');
  const refs = copy({}, source, ['objectiveId', 'jobId', 'reportId', 'opportunityId', 'productId']);
  copy(refs, source, ['objectiveRevision'], integer);
  if (field(write, 'provider') !== 'shopify' || field(input, 'operation') !== 'product_content'
    || field(proposal, 'provider') !== 'shopify' || field(proposal, 'operation') !== 'product_content'
    || field(source, 'schema') !== 'runvara-objective-content-source/v1'
    || !/^objective_[0-9a-f-]{36}$/.test(refs.objectiveId || '') || !(refs.objectiveRevision > 0)
    || !/^job_[A-Za-z0-9_-]{1,100}$/.test(refs.jobId || '') || !/^objective_review_[0-9a-f]{32}$/.test(refs.reportId || '')
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(refs.opportunityId || '') || !/^gid:\/\/shopify\/Product\/\d+$/.test(refs.productId || '')
    || refs.productId.length > 100 || refs.productId !== field(input, 'productId')) return result;
  return { schema: OBJECTIVE_CONTENT_DISPLAY_SCHEMA, origin: 'owner_objective_content', status: 'available',
    objectiveId: refs.objectiveId, objectiveRevision: refs.objectiveRevision, jobId: refs.jobId,
    reportId: refs.reportId, opportunityId: refs.opportunityId, productId: refs.productId };
}

export function publicConnectionWrite(write) {
  const result = copy({}, write, ['id', 'requestId', 'provider', 'digest', 'connectionId', 'account', 'requestedBy', 'approvalId', 'status', 'createdAt', 'startedAt', 'completedAt']);
  copy(result, write, ['observationErrorCode', 'errorCode'], nullableString);
  copy(result, write, ['requiresApproval', 'dispatchBlocked'], boolean);
  result.input = publicInput(result.provider, field(write, 'input'));
  const storedResult = field(write, 'result');
  if (storedResult && typeof storedResult === 'object' && !Array.isArray(storedResult)) {
    result.result = copy({}, storedResult, ['externalId', 'recovery'], nullableString);
    copy(result.result, storedResult, ['confirmed'], boolean);
  }
  const display = sourceDisplay(write);
  if (display) result.sourceDisplay = display;
  return result;
}
function publicEvidence(row) {
  return copy({}, row, ['type', 'id', 'detail', 'at'], nullableString);
}
function publicHistory(row) {
  const result = copy({}, row, ['status', 'actor', 'at', 'note', 'action', 'reason', 'expectedBenefit', 'risk'], nullableString);
  copy(result, row, ['revision'], integer);
  copy(result, row, ['financialImpact'], value => value === null || number(value));
  if (Array.isArray(field(row, 'evidence'))) result.evidence = rows(field(row, 'evidence'), publicEvidence);
  return result;
}
export function publicApproval(approval) {
  const result = copy({}, approval, ['id', 'type', 'action', 'reason', 'expectedBenefit', 'risk', 'requestedBy', 'source', 'agentId', 'workStatus', 'status', 'createdAt', 'decidedAt', 'decidedBy', 'decisionNote', 'executionStatus'], nullableString);
  copy(result, approval, ['financialImpact'], value => value === null || number(value));
  copy(result, approval, ['revision'], integer);
  copy(result, approval, ['executedExternally'], boolean);
  const payload = field(approval, 'payload');
  result.payload = copy({}, payload, ['connectionWriteId', 'opportunityId', 'experimentId', 'marketingCampaignId'], nullableString);
  copy(result.payload, payload, ['verifiedExperiment', 'legacyReviewRecorded'], boolean);
  result.evidence = rows(field(approval, 'evidence'), publicEvidence);
  result.history = rows(field(approval, 'history'), publicHistory);
  return result;
}
