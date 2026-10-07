import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { deriveOperations, buildDailyBrief, OPERATIONS_CALCULATION_VERSION } from '../lib/operations.mjs';
import { deriveBusinessState } from '../lib/business-state.mjs';
import { runCommander, runSpecialist, agentTeamSnapshot } from '../lib/agents.mjs';
import { draftMarketingCampaign } from '../lib/marketing.mjs';
import { inspectOrderPeriod, summarizeOrderInspection, orderFinancialView, ORDER_EVIDENCE_PRESENTATION_LIMITS } from '../lib/order-analytics.mjs';
import { validateImportedData } from '../lib/connection-doctor.mjs';
import { connectionCentre } from '../lib/connection-centre.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken } from '../lib/security.mjs';

const now = new Date('2026-10-07T12:00:00.000Z');
const costs = { landed: '30', packing: '0', handling: '0', delivery: '0', paymentFee: '0', channelFee: '0', advertising: '0', otherVariable: '0' };
function order(id, total = '100', extra = {}) {
  return { id, provider: 'shopify', currency: 'GBP', createdAt: '2026-10-07T10:00:00.000Z', financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED',
    total, currentTotal: total, tax: '0', currentTax: '0', refunds: '0', discounts: '0', shippingCharged: '0',
    lineItems: [{ id: `line-${id}`, sku: 'A', quantity: 1, net: total }], ...extra };
}
function fixture() {
  const state = seedWorkspaceState({}, { workspaceId: 'order-consumer-fixture' });
  state.orders = [order('costed'), order('uncosted', '900', { lineItems: [{ sku: 'B', quantity: 1, net: '900' }] }), order('usd', '0.000001', { currency: 'USD', provider: 'ebay' })];
  state.economics = { A: costs };
  state.products = [{ id: 'product', title: 'Recorded packaging product', provider: 'shopify', status: 'active', image: 'https://example.invalid/image.jpg', variants: [{ id: 'one', sku: 'A', price: 100, inventory: 50 }, { id: 'two', sku: 'A', price: 100, inventory: 50 }] }];
  state.advertisingCosts = [{ channel: 'shopify', spend: 20, attributableRevenue: 100, date: now.toISOString() }];
  return state;
}
const gbp = evidence => evidence.groups.find(group => group.provider === 'shopify' && group.currency === 'GBP' && group.financialStatus === 'PAID' && !group.cancelled);

test('operations, business state, brief and specialists share exact recorded cohorts without business profit', async () => {
  const state = fixture(), original = structuredClone(state);
  const metrics = deriveOperations(state, { now });
  for (const period of [metrics.today, metrics.last7d, metrics.last30d]) {
    for (const field of ['revenue', 'knownRevenue', 'grossProfit', 'operatingProfit', 'margin', 'refunds', 'profitCoverage']) assert.equal(period[field], null, field);
    const group = gbp(period.importedOrderEvidence);
    assert.equal(group.recordedAmounts.netTotal.knownSubtotal, '1000');
    assert.deepEqual(group.costNumbers.orderCoverage, { numerator: 1, denominator: 2 });
    assert.deepEqual(group.costNumbers.netTotalCoverage, { numerator: '100', denominator: '1000' });
    assert.equal(group.financialQualification.contributionProfit, null);
    assert.equal(group.currencyStatus, 'unverified_recorded_code');
    assert.equal(period.importedOrderEvidence.completeness.sourcePeriod, 'unverified');
  }
  assert.equal(metrics.last30d.importedOrderEvidence.groups.find(group => group.currency === 'USD').recordedAmounts.netTotal.knownSubtotal, '0.000001');
  assert.equal(metrics.advertising.spend, null);
  assert.equal(metrics.channels.find(channel => channel.id === 'shopify').profitAfterAdvertising, null);
  assert.deepEqual(metrics.channels[0].evidenceRef, { period: 'last30d', provider: 'shopify' });
  assert.equal(metrics.revenueSignals.periodRef, 'last30d');
  assert.ok(metrics.productRows.every(item => item.units30d === null && item.revenue30d === null && item.stockCoverDays === null));
  assert.ok(metrics.orderProfitability.every(item => item.profitability.contribution === null));
  const business = deriveBusinessState(state, { now });
  assert.equal(business.commerce.revenue30d, null);
  assert.equal(gbp(business.commerce.importedOrderEvidence).recordedAmounts.netTotal.knownSubtotal, '1000');
  assert.equal(business.profitability.profitCoveragePercent, null);
  assert.equal(business.inventory.risks[0]?.units30d ?? null, null);
  const brief = buildDailyBrief(state, { now });
  assert.equal(brief.calculationVersion, OPERATIONS_CALCULATION_VERSION);
  assert.match(brief.summary, /GBP.*1000 recorded net subtotal/);
  assert.match(brief.summary, /USD.*0\.000001 recorded net subtotal/);
  assert.match(brief.summary, /Source period unverified/);
  assert.doesNotMatch(brief.summary, /£|70%|£70/);
  const command = await runCommander(state, 'Review revenue and profit', { now });
  for (const agentId of ['finance', 'sales']) {
    const finding = command.results.find(item => item.agentId === agentId).finding;
    assert.match(finding, /1000 recorded net subtotal/);
    assert.match(finding, /Source period unverified/);
    assert.doesNotMatch(finding, /£|estimated operating contribution/);
  }
  assert.deepEqual(state.orders, original.orders);
  assert.deepEqual(state.economics, original.economics);
});

test('status, cancellation, refund, exact UTC boundary and cross-provider conflicts remain visible', () => {
  const state = fixture();
  state.orders = [order('same'), order('same'), order('same', '12', { provider: 'ebay' }),
    order('conflict', '50'), order('conflict', '60', { createdAt: '2026-01-01T00:00:00.000Z' }),
    order('at-end', '999', { createdAt: now.toISOString() }), order('future', '999', { createdAt: '2026-10-08T00:00:00Z' }),
    order('refund', '7', { financialStatus: 'PARTIALLY_REFUNDED', refunds: '3', cancelledAt: '2026-10-07T11:00:00Z' }),
    order('authorized', '80', { financialStatus: 'AUTHORIZED' }), order('missing-currency', '60', { currency: null })];
  const metrics = deriveOperations(state, { now }), evidence = metrics.last30d.importedOrderEvidence;
  assert.equal(metrics.last30d.orders, 5);
  assert.equal(evidence.counts.identicalDuplicateRows, 1);
  assert.equal(evidence.counts.conflictingIdentities, 1);
  assert.equal(evidence.completeness.eligibilityResolved, false);
  assert.equal(gbp(evidence).recordedAmounts.netTotal.knownSubtotal, '100');
  assert.equal(gbp(evidence).recordedAmounts.netTotal.completeCohortTotal, null);
  assert.equal(evidence.groups.find(group => group.currency === null).recordedAmounts.netTotal.knownSubtotal, null);
  assert.equal(evidence.groups.find(group => group.financialStatus === 'PARTIALLY_REFUNDED').cancelled, true);
  assert.equal(metrics.refundedOrders30d, 1);
  assert.ok(evidence.groups.every(group => group.financialQualification.collectedCash === null));
});

test('UTC midnight and unavailable collections never become business-zero claims', () => {
  const state = fixture();
  const midnight = deriveOperations(state, { now: new Date('2026-10-07T00:00:00Z') });
  assert.equal(midnight.today.orders, 0);
  assert.equal(midnight.today.reason, 'empty_utc_interval');
  assert.equal(midnight.today.period.startAt, midnight.today.period.endAt);
  assert.equal(midnight.today.revenue, null);
  assert.equal(midnight.today.numericCostCoverage.orderCoverage, null);
  assert.match(buildDailyBrief(state, { now: new Date('2026-10-07T00:00:00Z') }).summary, /empty UTC interval/);
  delete state.orders;
  const unavailable = deriveOperations(state, { now });
  assert.equal(unavailable.last30d.orders, null);
  assert.equal(unavailable.last30d.numericCostCoverage.completeOrders, null);
  assert.equal(unavailable.last30d.revenue, null);
  assert.equal(deriveOperations({}, { now }).last30d.reason, 'workspace_unavailable');
});

test('unavailable or malformed order collections cannot validate successfully or claim a zero connection count', () => {
  for (const orders of [undefined, null, {}, [null]]) {
    const state = fixture(); state.orders = orders;
    const validation = validateImportedData(state, 'shopify');
    assert.equal(validation.ok, false);
    assert.equal(validation.counts.orders, null);
    assert.ok(validation.problemAreas.includes('orders'));
    assert.ok(validation.unavailableAreas.includes('orders'));
    const channel = connectionCentre(state, { shopifyConfigured: () => false, ebayConfigured: () => false }).find(row => row.id === 'shopify');
    assert.equal(channel.counts.orders, null);
  }
  const empty = fixture(); empty.orders = [];
  assert.equal(validateImportedData(empty, 'shopify').counts.orders, 0);
});

test('marketing retains catalogue eligibility but cannot present duplicate-SKU historical sales', () => {
  const state = fixture();
  state.marketing.settings.enabled = true;
  const campaign = draftMarketingCampaign(state, { now });
  assert.equal(campaign.product.revenue30d, null);
  assert.match(campaign.evidence.find(item => item.type === 'sales_signal').detail, /attribution.*unavailable/);
  assert.doesNotMatch(campaign.evidence.find(item => item.type === 'sales_signal').detail, /£|0 units/);
  assert.equal(campaign.publish.approvalRequired, true);
});

test('presentation and order detail caps suppress completeness without losing exact partial diagnostics', () => {
  const state = fixture();
  state.orders = Array.from({ length: 130 }, (_, index) => order(`order-${index}`, '999999999999999999999999.999999', { currency: String.fromCharCode(65 + index % 26) + 'AA', lineItems: [{ sku: `sku-${index}`, quantity: 1, net: '1' }] }));
  const operations = deriveOperations(state, { now });
  const evidence = operations.last30d.importedOrderEvidence;
  assert.equal(evidence.groups.length, ORDER_EVIDENCE_PRESENTATION_LIMITS.groups);
  assert.equal(evidence.presentation.truncated, true);
  assert.equal(evidence.completeness.retainedCohortComplete, false);
  assert.ok(evidence.groups.every(group => group.recordedAmounts.netTotal.completeCohortTotal === null));
  assert.ok(evidence.groups.every(group => typeof group.recordedAmounts.netTotal.knownSubtotal === 'string'));
  assert.equal(operations.orderProfitability.length, 100);
  assert.equal(operations.orderDetailCoverage.complete, false);
  assert.equal(operations.orderDetailCoverage.availableRows, 130);
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 65000);
  assert.ok(Buffer.byteLength(JSON.stringify(deriveBusinessState(state, { now }))) < 85000);
});

test('rejected source rows never reach the editor and ambiguous refund fields cannot create follow-up evidence', () => {
  const state = fixture();
  state.orders = [null, order('foreign', '777', { workspaceId: 'other', customerEmail: 'foreign-secret@example.invalid' }),
    order('line-foreign', '888', { lineItems: [{ sku: 'A', quantity: 1, workspaceId: 'other' }] }),
    order('paid-refund', '99', { financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED', refunds: '1', customerEmail: 'private@example.invalid' })];
  const metrics = deriveOperations(state, { now });
  assert.equal(metrics.orderProfitability.length, 1);
  assert.equal(metrics.orderProfitability[0].id, 'paid-refund');
  assert.equal(metrics.customerServiceIssues, 0);
  assert.deepEqual(metrics.customerServiceItems, []);
  assert.equal(metrics.orderProfitability[0].recordedStatus.hasRecordedRefund, false);
  assert.equal(metrics.orderProfitability[0].refunds, '1', 'stored amount remains inspectable');
  assert.equal(metrics.orderDetailCoverage.truncated, true);
  assert.doesNotMatch(JSON.stringify(metrics), /foreign-secret|private@example/);
  assert.match(buildDailyBrief(state, { now }).summary, /eligibility unresolved.*partial scanned cohort/);
  delete state.orders;
  assert.match(runSpecialist('operations', state, { now }).finding, /evidence is unavailable/);
  assert.match(runSpecialist('customer_service', state, { now }).finding, /evidence is unavailable/);
});

test('editor DTOs contain only bounded primitive fields and old specialist reports stay explicitly historical', async () => {
  const state = fixture();
  state.orders = [order('safe', '100', { name: { privatePayload: 'private-object' }, currentTotal: { privatePayload: 'private-object' },
    customer: { workspaceId: 'other', email: 'private-object' }, lineItems: [{ sku: 'A', quantity: 1, name: { privatePayload: 'private-object' }, net: { privatePayload: 'private-object' }, title: 'x'.repeat(10000) }] })];
  const metrics = deriveOperations(state, { now }), detail = metrics.orderProfitability[0];
  assert.equal(detail.name, null);
  assert.equal(detail.currentTotal, null);
  assert.equal(detail.lineItems[0].net, null);
  assert.equal(detail.lineItems[0].title.length, 256);
  assert.doesNotMatch(JSON.stringify(metrics), /private-object/);
  assert.equal(detail.profitability.importedOrderEvidence.completeness.scanComplete, true);
  assert.equal(detail.profitability.importedOrderEvidence.completeness.eligibilityResolved, true);
  state.agentRuns = [{ id: 'legacy', summary: 'Old profit 70', status: 'Completed', completedAt: now.toISOString(), results: [{ agentId: 'finance', finding: 'Old profit 70', confidence: 1 }] }];
  const original = structuredClone(state.agentRuns);
  const team = agentTeamSnapshot(state);
  assert.equal(team.find(row => row.id === 'finance').historical, true);
  assert.match(team.find(row => row.id === 'commander').lastFinding, /Historical analysis/);
  assert.doesNotMatch(team.find(row => row.id === 'finance').lastFinding, /profit 70/);
  const run = await runCommander(state, 'Review revenue', { now });
  assert.equal(run.calculationVersion, OPERATIONS_CALCULATION_VERSION);
  assert.deepEqual(state.agentRuns, original);
});

test('bounded narratives expose scan limits and exclusion uncertainty before recorded subtotals', () => {
  const state = fixture();
  state.orders = Array.from({ length: 2001 }, (_, index) => order(`n-${index}`, '1'));
  const brief = buildDailyBrief(state, { now });
  assert.match(brief.summary, /2000 of 2001 retained snapshot rows scanned/);
  assert.match(brief.summary, /partial scanned cohort or clipped output/);
  assert.equal(brief.last30d.importedOrderEvidence.groups[0].recordedAmounts.netTotal.completeCohortTotal, null);
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) < 65536);
});

function parseCsvLine(line) {
  const cells = []; let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (quoted && line[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { cells.push(value); value = ''; } else value += c;
  }
  cells.push(value); return cells;
}

test('accounting export and order-cost API preserve records while withholding qualification and rejecting ambiguous writes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-order-cutover-'));
  const secret = 'order-cutover-fixture-secret-more-than-32-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, { schedulerEnabled: false, agentOpsEnabled: false });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const state = fixture();
  state.users[0].passwordChangeRequired = false;
  const createdAt = new Date(Date.now() - 3600000).toISOString();
  state.orders = [null, order('foreign', '777', { createdAt, workspaceId: 'other', customerEmail: 'foreign-secret@example.invalid' }), order('unique', '100', { createdAt, customer: { workspaceId: 'other', email: 'nested-private-customer' }, name: { email: 'nested-private-customer' } }), order('shared', '200', { createdAt }), order('shared', '300', { createdAt, provider: 'ebay', currency: 'USD' })];
  await server.packsmart.store.save(state.workspace.id, state);
  server.packsmart.integrations.syncAll = async () => assert.fail('Analytical read must not sync providers');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const cookie = `packsmart_session=${createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret)}`;
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrapResponse = await fetch(base + '/api/bootstrap', { headers: { Cookie: cookie } });
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.doesNotMatch(JSON.stringify(bootstrap.orders), /foreign-secret|foreign/);
  assert.equal(bootstrap.orders.length, 3);
  assert.equal(bootstrap.orderDetailCoverage.truncated, true);
  const csvResponse = await fetch(base + '/api/reports/accounting.csv', { headers: { Cookie: cookie } });
  assert.equal(csvResponse.status, 200);
  const lines = (await csvResponse.text()).trim().split('\r\n').map(parseCsvLine), headings = lines.shift();
  assert.ok(headings.includes('operating_contribution'));
  const csvRows = lines.map(line => { assert.equal(line.length, headings.length); return Object.fromEntries(headings.map((key, index) => [key, line[index]])); });
  assert.equal(csvRows.length, 3);
  assert.deepEqual(headings.slice(-2), ['refund_field_basis', 'tax_field_basis'], 'provenance is appended without moving compatibility columns');
  assert.ok(csvRows.every(row => row.refund_field_basis === 'unverified_may_be_derived' && row.tax_field_basis === 'unverified_original_or_current'));
  assert.ok(csvRows.every(row => row.gross_revenue === '' && row.net_revenue === '' && row.operating_contribution === '' && row.source_period_status === 'unverified' && row.financial_qualification === 'unavailable'));
  assert.deepEqual(csvRows.map(row => [row.channel, row.recorded_currency, row.recorded_net_total]), [['shopify', 'GBP', '100'], ['shopify', 'GBP', '200'], ['ebay', 'USD', '300']]);
  const update = async (id, csrf = bootstrap.csrf) => fetch(base + `/api/orders/${id}/economics`, { method: 'PUT', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ actualShippingCost: 5 }) });
  assert.equal((await update('unique', 'invalid')).status, 403);
  const denied = await update('shared');
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).code, 'ORDER_IDENTITY_UNQUALIFIED');
  const afterDenied = await server.packsmart.store.get(state.workspace.id);
  assert.ok(afterDenied.orders.filter(row => row?.id === 'shared').every(row => row.actualShippingCost === undefined));
  const accepted = await update('unique');
  assert.equal(accepted.status, 200);
  const result = await accepted.json();
  assert.equal(result.order.actualShippingCost, 5);
  assert.doesNotMatch(JSON.stringify(result), /nested-private-customer/);
  assert.equal(result.profitability.contribution, null);
  assert.equal(result.profitability.importedOrderEvidence.groups[0].recordedAmounts.netTotal.knownSubtotal, '100');
  const preserved = await server.packsmart.store.get(state.workspace.id);
  const storedUnique = preserved.orders.find(row => row?.id === 'unique');
  assert.equal(storedUnique.customer.email, 'nested-private-customer', 'the bounded DTO must not rewrite persisted source/customer fields');
  storedUnique.costOverrides = { workspaceId: 'foreign' };
  await server.packsmart.store.save(state.workspace.id, preserved);
  assert.equal((await update('unique')).status, 409, 'foreign override scope cannot be written through a local-ID route');
  const conflicting = await server.packsmart.store.get(state.workspace.id);
  conflicting.orders = [order('conflict', '1', { createdAt }), order('conflict', '2', { createdAt })];
  await server.packsmart.store.save(state.workspace.id, conflicting);
  const emptyIncomplete = await fetch(base + '/api/reports/accounting.csv', { headers: { Cookie: cookie } });
  assert.equal(emptyIncomplete.status, 409);
  assert.equal((await emptyIncomplete.json()).code, 'ORDER_EVIDENCE_INCOMPLETE');
});
