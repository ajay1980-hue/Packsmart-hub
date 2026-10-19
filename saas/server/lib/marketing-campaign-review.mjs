import { deriveOperations } from './operations.mjs';
import { ensureMarketing, marketingProductChecks, marketingPublishingReadiness } from './marketing.mjs';

const error = (code, status, message) => Object.assign(new Error(message), { code, status });
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);

// An observation of retained workspace data, never an approval, allowance, OAuth
// capability or dispatch envelope. No credentials, provider probes or writes.
export function reviewMetaMarketingCampaign(state, campaignId) {
  const campaigns = (state.marketing?.campaigns || []).filter(row => row.id === campaignId);
  if (!campaigns.length) throw error('MARKETING_CAMPAIGN_NOT_FOUND', 404, 'Marketing campaign not found');
  if (campaigns.length !== 1) throw error('MARKETING_CAMPAIGN_AMBIGUOUS', 409, 'Resolve the duplicate campaign identity before review');
  const campaign = campaigns[0];
  const saved = campaign.product || {};
  // Normalize settings on a private container. The request must not normalize
  // or otherwise modify the stored workspace, campaigns or provider records.
  const view = { settings: state.settings, marketing: { settings: state.marketing?.settings }, connections: state.connections };
  const { settings } = ensureMarketing(view);
  const channel = marketingPublishingReadiness(view).channels.meta;
  // The catalogue display projection can synthesize a variant ID from its SKU.
  // Require an actual retained ID first; display fallbacks are not identity.
  // Keep the importer's id-then-externalId precedence, without accepting SKU.
  const retainedTarget = identity(saved.productId) && identity(saved.variantId)
    && (state.products || []).some(product => product.id === saved.productId
      && (product.variants || []).some(variant => identity(variant.id || variant.externalId)
        && (variant.id || variant.externalId) === saved.variantId));
  const targets = retainedTarget
    ? deriveOperations(state).productRows.filter(row => row.productId === saved.productId && row.id === saved.variantId)
    : [];
  const targetStatus = targets.length === 1 ? 'found' : targets.length ? 'ambiguous' : 'missing';
  const row = targets.length === 1 ? targets[0] : null;
  const checks = row ? marketingProductChecks(state, row, settings) : null;
  const eligible = checks !== null && Object.values(checks).every(Boolean);
  const current = row ? { productId: row.productId, variantId: row.id, sku: row.sku, title: row.productTitle,
    variantTitle: row.title, image: row.productImage || row.image || null, price: row.price,
    inventory: row.inventory, contribution: row.contribution, margin: row.margin } : null;
  const changedFields = current ? ['sku', 'title', 'variantTitle', 'image', 'price']
    .filter(field => saved[field] !== current[field]) : [];
  const blockers = ['PUBLISHER_NOT_IMPLEMENTED', 'PUBLISH_TARGET_AND_SCOPES_UNVERIFIED', 'EXACT_PUBLICATION_APPROVAL_REQUIRED'];
  if (!settings.enabled) blockers.push('MARKETING_AUTOPILOT_OFF');
  if (!settings.channels.meta) blockers.push('MARKETING_CHANNEL_DISABLED');
  if (!campaign.channels?.includes('meta')) blockers.push('CAMPAIGN_CHANNEL_NOT_SELECTED');
  if (!channel.connected) blockers.push('META_NOT_CONNECTED');
  if (!row) blockers.push(targetStatus === 'ambiguous' ? 'MARKETING_PRODUCT_AMBIGUOUS' : 'MARKETING_PRODUCT_NOT_FOUND');
  else if (!eligible) blockers.push('PRODUCT_NOT_ELIGIBLE');
  if (changedFields.length) blockers.push('DRAFT_PRODUCT_CHANGED');
  const approvals = (state.approvals || []).filter(item => item.id === campaign.publish?.approvalId
    && item.type === 'social_commerce_publish' && item.payload?.marketingCampaignId === campaign.id);
  const recordedApprovalStatus = approvals.length === 1 && ['pending', 'approved', 'rejected', 'expired'].includes(approvals[0].status)
    ? approvals[0].status : 'unverified';
  return {
    schema: 'runvara-marketing-campaign-review/v1',
    workspaceId: state.workspace.id, campaignId: campaign.id, channel: 'meta', observationalOnly: true,
    basis: 'retained_workspace_snapshot',
    product: { targetStatus, current, changedFields },
    eligibility: { eligible, checks, minInventory: settings.minInventory, minMarginPercent: settings.minMarginPercent,
      missingCostFields: row ? [...row.missingFields] : [],
      inventoryBasis: row?.inventory == null ? 'count_unavailable_existing_availability_rule' : 'recorded_variant_count',
      costEvidence: 'recorded_amounts_only_sources_not_verified', customerShippingIncluded: false, orderProfitEstablished: false },
    publishing: { ready: false, publisherImplemented: channel.publisherImplemented, connectionRecordedConnected: channel.connected,
      targetAndWriteScopesVerified: false, recordedApprovalStatus, approvalConfersDispatchAuthority: false, blockers },
    creatives: { newSubmissionsEnabled: false, reason: 'CREATIVE_ALLOWANCE_REQUIRED' }
  };
}
