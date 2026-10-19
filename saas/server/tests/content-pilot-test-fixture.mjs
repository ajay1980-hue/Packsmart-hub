import crypto from 'node:crypto';
import { contentJsonbFixture } from './content-jsonb-test-fixture.mjs';
import { createContentPilot, CONTENT_PILOT_SCHEMA, CONTENT_PILOT_BASELINE_QUERY, DESCRIPTION_PILOT_SCHEMA, DESCRIPTION_PILOT_BASELINE_QUERY } from '../lib/content-pilot.mjs';
import { createGovernedRecordStage } from '../lib/governed-record-stage.mjs';
import { CONTENT_EXECUTION_RECEIPT_CONTRACT, DESCRIPTION_EXECUTION_RECEIPT_CONTRACT, CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA,
  recordContentReceiptAcknowledgement } from '../lib/content-execution-receipt.mjs';

// Every persistence/provider operation here is synthetic. Private ACKs model
// the existing adapter boundary; this fixture does not claim real SQL proof.
export async function contentPilotFixture(options = {}) {
  let descriptionScope, descriptionPilot;
  const prepareOptions = options.descriptionInput ? (state, body) => {
    descriptionScope = { schema: DESCRIPTION_PILOT_SCHEMA, workspaceId: state.workspace.id,
      connectionId: body.target.connectionId, account: body.target.account, productId: body.productId,
      operation: body.operation, requestId: body.requestId, requestedBy: state.users[0].id,
      inputDigest: crypto.createHash('sha256').update(JSON.stringify(options.descriptionInput)).digest('hex'),
      settingsRevision: state.connectionSettings.shopify.revision, expiresAt: new Date(Date.now() + 600000).toISOString(),
      input: options.descriptionInput };
    descriptionPilot = createContentPilot(descriptionScope);
    return { governedRecordStage: createGovernedRecordStage({}), contentPilot: descriptionPilot };
  } : undefined;
  const f = await contentJsonbFixture({ contentInput: { title: 'Cup', description: 'An approved replacement paragraph.' }, ...options,
    ...(options.descriptionInput ? { contentInput: options.descriptionInput, prepareOptions } : {}) });
  const write = f.write;
  f.scope = { schema: CONTENT_PILOT_SCHEMA, workspaceId: f.state.workspace.id,
    connectionId: write.connectionId, account: write.account, productId: write.input.productId,
    operation: 'product_content', requestId: write.requestId, requestedBy: write.requestedBy,
    inputDigest: write.digest, settingsRevision: f.state.connectionSettings.shopify.revision,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    baseline: { title: 'Cup', descriptionHtml: '<p>Original paragraph.</p>', updatedAt: '2026-10-14T12:00:00Z' },
    replacementDescription: write.input.description };
  if (descriptionScope) f.scope = descriptionScope;
  f.pilot = descriptionPilot ?? createContentPilot(f.scope);
  f.closedStage = createGovernedRecordStage({});
  f.receiptCommits = []; f.receiptHooks = {};
  const save = f.store.save.bind(f.store);
  f.store.save = async (workspaceId, state, options) => {
    const descriptor = options?.protectedContentCommit, previous = state._revision;
    const ordinary = options ? { ...options } : undefined;
    if (ordinary) delete ordinary.protectedContentCommit;
    if (descriptor) { f.receiptCommits.push(descriptor); await f.receiptHooks.beforeCommit?.(descriptor); }
    const saved = await save(workspaceId, state, ordinary);
    if (descriptor) await f.receiptHooks.afterCommit?.(descriptor, saved);
    if (descriptor && !f.receiptHooks.omitAck) {
      const a = descriptor.admission;
      recordContentReceiptAcknowledgement(saved, descriptor, {
        schema: CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA, kind: descriptor.kind, workspaceId,
        attemptId: a.attemptId, admissionDigest: a.digest, intentDigest: a.intentDigest,
        requestFingerprint: crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),
        expectedRevision: previous, nextRevision: saved._revision,
        receiptDigest: descriptor.kind === 'finalize' ? descriptor.receipt.digest : null, reservedBytes: 40960, replayed: false
      });
    }
    return saved;
  };
  const graphql = f.service.shopifyGraphql.bind(f.service);
  f.baselineReads = [];
  f.service.shopifyGraphql = async (query, variables, config, options) => {
    if (![CONTENT_PILOT_BASELINE_QUERY, DESCRIPTION_PILOT_BASELINE_QUERY].includes(query)) return graphql(query, variables, config, options);
    f.baselineReads.push({ query, variables, domain: config.domain });
    const product = { id: write.input.productId, ...(descriptionScope ? { descriptionHtml: f.scope.input.baselineHtml, updatedAt: f.scope.input.baselineUpdatedAt } : f.scope.baseline) };
    return await f.hooks.baseline?.(product) ?? { product };
  };
  const run = f.run;
  f.run = (overrides = {}) => run({ governedRecordStage: f.closedStage, contentPilot: f.pilot,
    protectedContentReceipts: descriptionScope ? DESCRIPTION_EXECUTION_RECEIPT_CONTRACT : CONTENT_EXECUTION_RECEIPT_CONTRACT, ...overrides });
  return f;
}
