import {randomUUID} from 'node:crypto';
import {publicationFixture} from './marketing-publication-fixture.mjs';
import {buildMetaLedgerFixtureProposal, metaLedgerDigest, META_LEDGER_CONTRACT,
  prepareMetaLedgerCommand, metaLedgerCommandBody} from '../lib/meta-publication-ledger.mjs';
export async function ledgerFixture(t, account = '101', dailyLimit = 2) {
  const f = await publicationFixture(t, 'ledger-' + randomUUID());
  const state = await f.get(); state.connectionWrites ||= []; state.connections[0].metadata.accountId = account;
  state.marketing.settings.dailyOrganicLimit = dailyLimit;
  const binding = buildMetaLedgerFixtureProposal(state, f.campaignId, f.selection, f.session, {
    environment: 'test', writeId: 'ledger-write-' + randomUUID(), requestId: 'ledger-request-' + randomUUID(),
    claimId: 'ledger-claim-' + randomUUID(), approvalId: 'ledger-approval-' + randomUUID(), approvalRevision: 1,
    asset: {sha256: 'a'.repeat(64), byteLength: 321, mediaType: 'image/png', deliveryDigest: 'b'.repeat(64)}});
  state.approvals.push({id: binding.approvalId, type: 'protected_meta_publication', workspaceId: f.workspaceId,
    status: 'approved', decidedBy: f.session.userId, revision: 1,
    payload: {contract: META_LEDGER_CONTRACT, bindingDigest: metaLedgerDigest(binding)}});
  let head = null;
  const command = (kind = 'reserve', phase = 'proposal', data = {}, admissionDigest = null) =>
    prepareMetaLedgerCommand(state, binding, f.session, {kind, phase, requestId: kind === 'reserve' ? binding.requestId : kind + '-' + randomUUID(),
      data, admissionDigest, expectedHead: kind === 'settle' ? null : head});
  return {...f, state, binding, command, raw: (...args) => JSON.parse(metaLedgerCommandBody(command(...args)).p_request),
    accept: proof => {head = proof.digest; return proof;}, setHead: digest => {head = digest;}};
}
