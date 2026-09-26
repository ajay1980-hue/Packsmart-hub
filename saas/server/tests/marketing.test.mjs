import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkspaceState } from '../lib/store.mjs';
import { draftMarketingCampaign, ensureMarketing, marketingPlannerCycle, marketingProviderStatus, updateMarketingSettings } from '../lib/marketing.mjs';

function stateWithProduct() {
  const state = seedWorkspaceState({}, { workspaceId: 'packsmart-solutions', email: 'owner@example.com' });
  state.products = [{
    id: 'p1',
    externalId: 'p1',
    title: 'Premium Mailing Bags',
    handle: 'premium-mailing-bags',
    status: 'active',
    image: 'https://cdn.shopify.com/example.jpg',
    variants: [{
      id: 'v1',
      externalId: 'v1',
      sku: 'MAIL-001',
      title: '100 pack',
      price: 20,
      inventory: 50,
      available: true
    }]
  }];
  state.economics['MAIL-001'] = {
    landed: 6,
    packing: 0.5,
    handling: 0.5,
    delivery: 1,
    paymentFee: 0.2,
    channelFee: 0.2,
    advertising: 0,
    otherVariable: 0,
    marginFloor: 20
  };
  return state;
}

test('marketing state defaults to guarded mode with paid ads disabled', () => {
  const state = stateWithProduct();
  const marketing = ensureMarketing(state);
  assert.equal(marketing.settings.mode, 'guarded');
  assert.equal(marketing.settings.allowPaidAds, false);
  assert.equal(marketing.settings.autoPublishOrganic, false);
});

test('campaign drafting selects only a profitable in-stock product and creates creative requests', () => {
  const state = stateWithProduct();
  const campaign = draftMarketingCampaign(state, { now: new Date('2026-09-26T09:00:00Z') });
  assert.equal(campaign.product.sku, 'MAIL-001');
  assert.equal(campaign.status, 'draft');
  assert.equal(campaign.publish.approvalRequired, true);
  assert.equal(campaign.publish.status, 'not_requested');
  assert.deepEqual(campaign.creativeRequests.map(item => item.provider), ['canva', 'runway']);
  assert.match(campaign.copy.longCaption, /Packsmart Solutions/);
});

test('planner prepares no more than one campaign per day', () => {
  const state = stateWithProduct();
  const first = marketingPlannerCycle(state, { now: new Date('2026-09-26T08:00:00Z') });
  const second = marketingPlannerCycle(state, { now: new Date('2026-09-26T12:00:00Z') });
  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(second.reason, 'CAMPAIGN_ALREADY_PREPARED_TODAY');
  assert.equal(state.marketing.campaigns.length, 1);
});

test('automatic organic publishing cannot be enabled outside automatic mode', () => {
  const state = stateWithProduct();
  assert.throws(() => updateMarketingSettings(state, { autoPublishOrganic: true }, 'owner'), error => error.code === 'MARKETING_MODE_REQUIRED');
  updateMarketingSettings(state, { mode: 'automatic', autoPublishOrganic: true }, 'owner');
  assert.equal(state.marketing.settings.autoPublishOrganic, true);
});

test('paid advertising cannot be enabled by Marketing Autopilot', () => {
  const state = stateWithProduct();
  assert.throws(() => updateMarketingSettings(state, { allowPaidAds: true }, 'owner'), error => error.code === 'PAID_ADS_APPROVAL_REQUIRED');
});

test('provider readiness is based on Runvara server credentials, not ChatGPT connections', () => {
  const status = marketingProviderStatus({ CANVA_ACCESS_TOKEN: 'x', CANVA_BRAND_TEMPLATE_ID: 'y', RUNWAY_API_KEY: 'z' });
  assert.equal(status.canva.configured, true);
  assert.equal(status.runway.configured, true);
});
