import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {ledgerFixture} from './meta-publication-ledger-fixture.mjs';
import {metaLedgerText, metaLedgerDigest, metaLedgerRequestFingerprint, metaLedgerCommandBody, commitMetaLedgerCommand,
  prepareMetaLedgerSettlement, metaLedgerFixtureOutcome, readMetaLedgerDecision,
  META_LEDGER_CONTRACT, META_LEDGER_PROVENANCE} from '../lib/meta-publication-ledger.mjs';
function ack(command, overrides = {}) {
  const text = metaLedgerCommandBody(command).p_request, r = JSON.parse(text);
  const event = {contract: META_LEDGER_CONTRACT, provenance: META_LEDGER_PROVENANCE,
    workspaceId: r.workspaceId, writeId: r.writeId, sequence: r.kind === 'reserve' ? 1 : 2,
    requestId: r.requestId, kind: r.kind, phase: r.phase, actor: r.actor, bindingDigest: metaLedgerDigest(r.binding),
    requestFingerprint: metaLedgerRequestFingerprint(r), previousDigest: r.expectedHead,
    admissionDigest: r.admissionDigest, data: r.data, at: '2026-10-19T00:00:00.000Z', containerId: null, publicationAdmission: null, containerConflict: false,
    phaseContract: META_LEDGER_CONTRACT, approvalDigest: 'c'.repeat(64)};
  Object.assign(event, overrides);
  return {contract: META_LEDGER_CONTRACT, provenance: META_LEDGER_PROVENANCE, eventText: metaLedgerText(event),
    digest: metaLedgerDigest(event), replayed: false, transportPermitted: false};
}
test('no live issuer or arbitrary command capability; default adapter never calls fetch', async () => {
  await assert.rejects(commitMetaLedgerCommand({}), {code: 'META_LEDGER_CLOSED'});
  assert.throws(() => metaLedgerCommandBody({}), {code: 'META_LEDGER_PROOF_REQUIRED'});
  assert.throws(() => prepareMetaLedgerSettlement({}, 'request', {}), {code: 'META_LEDGER_PROOF_REQUIRED'});
});
for (const [name, value] of Object.entries({unsafe: 9007199254740992, negativeZero: -0, decimal: 0.5, nul: '\0', loneSurrogate: '\ud800', invalidKey: {'not-ascii-key': true}})) {
  test('canonical grammar rejects ' + name, () => assert.throws(() => metaLedgerText({value})));
}
test('proposals stay outside the old executable queue and retain exact encoded asset and approval identity', async t => {
  const f = await ledgerFixture(t); const before = structuredClone(f.state);
  const command = f.command(), raw = JSON.parse(metaLedgerCommandBody(command).p_request);
  assert.deepEqual(f.state, before); assert.deepEqual(f.state.connectionWrites, []);
  assert.equal(raw.binding.asset.sha256, 'a'.repeat(64)); assert.equal(raw.binding.asset.providerDeliveryVerified, false);
  f.state.users[0].disabled = true; assert.throws(() => f.command(), {code: 'META_LEDGER_AUTHORITY'});
});
for (const [name, change] of [
  ['stock', s => s.products[0].variants[0].inventory = 0],
  ['cost', s => delete s.economics.BAGS],
  ['approval', s => s.approvals.at(-1).status = 'rejected'],
  ['target', s => s.connections[0].metadata.assets.pages[0].instagram.id = '999'],
  ['session', s => s.users[0].sessionVersion = 2],
  ['disabled string', s => s.users[0].disabled = 'false'],
  ['caption', s => s.marketing.campaigns[0].copy += ' changed']]) {
  test('existing pre-admission gate rejects changed ' + name, async t => {
    const f = await ledgerFixture(t); change(f.state); assert.throws(() => f.command());
  });
}
test('valid ACK binds exact command; retained and replayed evidence never authorizes transport', async t => {
  const f = await ledgerFixture(t), command = f.command();
  const proof = f.accept(await commitMetaLedgerCommand(command, {request: async () => Response.json(ack(command))}));
  assert.equal(proof.transportPermitted, false); assert.equal(proof.providerReadPerformed, false);
  const admit = f.command('admit', 'container');
  const admission = await commitMetaLedgerCommand(admit, {request: async () => Response.json(ack(admit))});
  const settlement = prepareMetaLedgerSettlement(admission, 'settlement-test', metaLedgerFixtureOutcome('container', '90001'));
  const raw = JSON.parse(metaLedgerCommandBody(settlement).p_request);
  assert.equal(raw.expectedState, null); assert.equal(raw.admissionDigest, admission.digest);
});
for (const [name, overrides] of Object.entries({phase: {phase: 'publish'}, actor: {actor: {userId: 'someone', sessionVersion: 1}},
  data: {data: {operator: true}}, binding: {bindingDigest: '0'.repeat(64)}, extra: {extra: true}, time: {at: '2026-02-31T00:00:00.000Z'}})) {
  test('forged ACK ' + name + ' yields exact lookup then unknown, no resend', async t => {
    const f = await ledgerFixture(t), command = f.command(), calls = [];
    await assert.rejects(commitMetaLedgerCommand(command, {request: async name => {
      calls.push(name); return Response.json(ack(command, overrides));
    }}), {code: 'META_LEDGER_COMMIT_UNKNOWN'});
    assert.deepEqual(calls, ['runvara_commit_meta_ledger_v1', 'runvara_lookup_meta_ledger_v1']);
  });
}
test('duplicate ACK keys, oversized or invalid UTF-8 cannot become protected proof', async t => {
  const f = await ledgerFixture(t), command = f.command();
  for (const body of [JSON.stringify(ack(command)).replace('"replayed":false', '"replayed":false,"replayed":true'),
    ' '.repeat(54000), Uint8Array.of(0xff)]) {
    await assert.rejects(commitMetaLedgerCommand(command, {request: async () => new Response(body, {headers: {'content-type': 'application/json'}})}), {code: 'META_LEDGER_COMMIT_UNKNOWN'});
  }
});
test('lost ACK recovery is one exact lookup with no second commit', async t => {
  const f = await ledgerFixture(t), command = f.command(), calls = [];
  const proof = await commitMetaLedgerCommand(command, {request: async (name, body) => {
    calls.push(name); if (calls.length === 1) throw Error('lost ACK');
    assert.equal(JSON.parse(body.p_request).requestFingerprint, metaLedgerRequestFingerprint(JSON.parse(metaLedgerCommandBody(command).p_request)));
    return Response.json({...ack(command), replayed: true});
  }});
  assert.equal(proof.recovered, true); assert.equal(proof.transportPermitted, false); assert.equal(calls.length, 2);
});
test('fresh retained disclosure handles session rotation without rewriting historical actor; revocation after await blocks it', async t => {
  const f = await ledgerFixture(t), command = f.command(); const response = ack(command);
  f.state.users[0].sessionVersion = 2; f.session.sessionVersion = 2;
  let reads = 0;
  const retained = await readMetaLedgerDecision(command, f.session, {request: async (_name, body) => {
    assert.equal(JSON.parse(body.p_request).actor.sessionVersion, 2); return Response.json(response);
  }, loadFreshState: async () => {reads++; return structuredClone(f.state);}});
  assert.equal(reads, 2); assert.equal(retained.event.actor.sessionVersion, 1);
  await assert.rejects(readMetaLedgerDecision(command, f.session, {request: async () => {
    f.state.users[0].disabled = true; return Response.json(response);
  }, loadFreshState: async () => structuredClone(f.state)}), {code: 'META_LEDGER_AUTHORITY'});
});
test('PUBLISHED container status is never a unique media result or a resend grant', () => {
  const outcome = metaLedgerFixtureOutcome('read', null, 'PUBLISHED');
  assert.equal(outcome.resultId, null); assert.equal(outcome.outcome, 'unresolved_do_not_resend'); assert.equal(outcome.replayPermitted, false);
  assert.throws(() => metaLedgerFixtureOutcome('read', '123', 'PUBLISHED'));
});
test('empty chunks and stalled cancellation cannot hang evidence parsing', {timeout: 2000}, async t => {
  const f = await ledgerFixture(t), command = f.command(); let cancels = 0;
  await assert.rejects(commitMetaLedgerCommand(command, {request: async () => ({status: 200, redirected: false,
    headers: new Headers({'content-type': 'application/json'}), body: {getReader: () => ({
      read: async () => ({done: false, value: new Uint8Array()}), cancel: () => {cancels++; return new Promise(() => {});}})}})}), {code: 'META_LEDGER_COMMIT_UNKNOWN'});
  assert.equal(cancels, 2);
});
test('ignored request abort reaches one exact lookup at the bounded deadline', {timeout: 15000}, async t => {
  const f = await ledgerFixture(t), command = f.command(); let calls = 0, firstSignal;
  const proof = await commitMetaLedgerCommand(command, {request: async (_name, _body, {signal}) => {
    calls++; if (calls === 1) {firstSignal = signal; return new Promise(() => {});} return Response.json(ack(command));
  }});
  assert.equal(firstSignal.aborted, true); assert.equal(calls, 2); assert.equal(proof.recovered, true); assert.equal(proof.transportPermitted, false);
});
