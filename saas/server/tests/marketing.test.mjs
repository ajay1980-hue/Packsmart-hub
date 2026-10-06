import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkspaceState } from '../lib/store.mjs';
import { draftMarketingCampaign, ensureMarketing, marketingPlannerCycle, marketingProviderStatus, marketingPublishingReadiness, updateMarketingSettings } from '../lib/marketing.mjs';
import { newCreativeRequest } from '../lib/creative-safety.mjs';

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

test('campaign cap never deletes existing drafts, owner content, claims or upstream IDs', () => {
  const state = stateWithProduct(); ensureMarketing(state);
  state.marketing.campaigns = Array.from({ length: 199 }, (_, index) => {
    const campaignId = `campaign_saved_${index}`;
    return { id: campaignId, status: 'draft', copy: { headline: `Saved owner content ${index}` }, publish: { status: 'not_requested' }, creativeRequests: [newCreativeRequest({ workspaceId: state.workspace.id,
      campaignId, provider: 'runway', kind: 'product_video', formats: [] })] };
  });
  const originals = structuredClone(state.marketing.campaigns);
  const next = draftMarketingCampaign(state);
  assert.equal(state.marketing.campaigns.length, 200); assert.equal(state.marketing.campaigns[0].id, next.id);
  assert.deepEqual(state.marketing.campaigns.slice(1), originals);
  const before = structuredClone(state.marketing.campaigns);
  assert.throws(() => draftMarketingCampaign(state), { code: 'CREATIVE_HISTORY_RETENTION_REQUIRED' });
  assert.deepEqual(state.marketing.campaigns, before, 'Even never-dispatched owner drafts must not be evicted');
  Object.assign(state.marketing.campaigns[199].creativeRequests[0], { status: 'in_progress', taskId: 'existing_task', safety: { preserved: 'uncertain-claim' } });
  const withClaim = structuredClone(state.marketing.campaigns);
  assert.throws(() => draftMarketingCampaign(state), { code: 'CREATIVE_HISTORY_RETENTION_REQUIRED' });
  assert.deepEqual(state.marketing.campaigns, withClaim);
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
  const status = marketingProviderStatus(stateWithProduct(), { CANVA_ACCESS_TOKEN: 'x', CANVA_BRAND_TEMPLATE_ID: 'y', RUNWAY_API_KEY: 'z' });
  assert.equal(status.canva.configured, true);
  assert.equal(status.runway.configured, true);
});


test('publisher readiness reports connection separately from implemented write capability', () => {
  const state = stateWithProduct();
  state.connections = [{ provider: 'meta', status: 'connected' }];
  const readiness = marketingPublishingReadiness(state);
  assert.equal(readiness.channels.meta.connected, true);
  assert.equal(readiness.channels.meta.publisherImplemented, false);
  assert.equal(readiness.ready, false);
});

test('TikTok Shop connection is not misrepresented as social publishing capability', () => {
  const state = stateWithProduct();
  state.connections = [{ provider: 'tiktok_shop', status: 'connected' }];
  const readiness = marketingPublishingReadiness(state);
  assert.equal(readiness.channels.tiktok_shop.connected, true);
  assert.equal(readiness.channels.tiktok_shop.publisherImplemented, false);
  assert.match(readiness.channels.tiktok_shop.reason, /separate TikTok capability/);
});
