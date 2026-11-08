import { createQuietApprovalPilot, PILOT_BASE } from './quiet-approval-pilot.mjs';
import { createQuietCreativePilot, creativePilotAction } from './quiet-creative-pilot.mjs';
import { createCataloguePolicy, CATALOGUE_PATH } from './shopify-catalogue-import.mjs';
import { SHOPIFY_DIAGNOSTIC_PATH } from './shopify-credential-metadata.mjs';
import { createShopifyTokenPolicy, SHOPIFY_TOKEN_PATH } from './shopify-token-exchange.mjs';
import { PRODUCT_ONLY_SUPPORT_PATH } from './support-product-facts.mjs';
import { OWNER_PRODUCT_READINESS_PATH, OWNER_PRODUCT_READINESS_FLAG } from './owner-product-readiness.mjs';
import { createOwnerProductReadinessWindow } from './owner-product-readiness-window.mjs';
import { createParcel2GoCredentialWindow, PARCEL2GO_ENTRY_PATH } from './parcel2go-credential-entry.mjs';
import { createParcel2GoQuoteWindow, PARCEL2GO_QUOTE_PATH } from './parcel2go-quote-owner.mjs';

// Construction-time admission only. Quiet startup cannot be reopened by a
// request, tenant setting, worker option, or later environment mutation.
export function createStartupPolicy(env, staticPathnames) {
  const mode = env.RUNVARA_STARTUP_MODE === undefined ? 'normal' : env.RUNVARA_STARTUP_MODE;
  if (mode !== 'normal' && mode !== 'quiet') {
    throw Object.assign(new Error('RUNVARA_STARTUP_MODE must be normal or quiet'), { code: 'STARTUP_MODE_INVALID' });
  }
  const staticPaths = new Set(staticPathnames);
  const quiet = mode === 'quiet';
  const ownerWorkspace = env.RUNVARA_QUIET_OWNER_WORKSPACE === undefined ? 'disabled/v1' : env.RUNVARA_QUIET_OWNER_WORKSPACE;
  if (!['disabled/v1', 'enabled/v1'].includes(ownerWorkspace) || (ownerWorkspace === 'enabled/v1' && !quiet)) {
    throw Object.assign(new Error('Owner workspace requires quiet mode and an exact enabled/v1 or disabled/v1 value'), { code: 'QUIET_OWNER_WORKSPACE_INVALID' });
  }
  const quietOwnerWorkspace = quiet && ownerWorkspace === 'enabled/v1';
  const productReadiness=env[OWNER_PRODUCT_READINESS_FLAG]===undefined?'disabled/v1':env[OWNER_PRODUCT_READINESS_FLAG];
  if(!['disabled/v1','enabled/v1'].includes(productReadiness)||(productReadiness==='enabled/v1'&&!quietOwnerWorkspace)) {
    throw Object.assign(new Error('Product readiness requires quiet owner workspace and an exact switch'),{code:'QUIET_OWNER_PRODUCT_READINESS_INVALID'});
  }
  const productReadinessWindow=createOwnerProductReadinessWindow(env);
  const shopifyDiagnostic = env.RUNVARA_QUIET_SHOPIFY_DIAGNOSTIC === undefined ? 'disabled/v1' : env.RUNVARA_QUIET_SHOPIFY_DIAGNOSTIC;
  if (!['disabled/v1', 'enabled/v1'].includes(shopifyDiagnostic) || (shopifyDiagnostic === 'enabled/v1' && !quietOwnerWorkspace)) {
    throw Object.assign(new Error('Shopify diagnostic requires quiet owner workspace and an exact switch'), { code: 'QUIET_SHOPIFY_DIAGNOSTIC_INVALID' });
  }
  const quietShopifyDiagnostic = shopifyDiagnostic === 'enabled/v1';
  const ownerLogin = env.RUNVARA_QUIET_OWNER_LOGIN === undefined ? 'disabled/v1' : env.RUNVARA_QUIET_OWNER_LOGIN;
  if (!['disabled/v1', 'enabled/v1'].includes(ownerLogin) || (ownerLogin === 'enabled/v1' && !quiet)) {
    throw Object.assign(new Error('Quiet owner login requires quiet mode and an exact enabled/v1 or disabled/v1 value'), { code: 'QUIET_OWNER_LOGIN_INVALID' });
  }
  const quietOwnerLogin = quiet && ownerLogin === 'enabled/v1';
  const commercePreview = env.RUNVARA_QUIET_COMMERCE_PREVIEW === undefined ? 'disabled/v1' : env.RUNVARA_QUIET_COMMERCE_PREVIEW;
  if (!['disabled/v1', 'enabled/v1'].includes(commercePreview) || (commercePreview === 'enabled/v1' && !quiet)) {
    throw Object.assign(new Error('Quiet commerce preview requires quiet mode and an exact enabled/v1 or disabled/v1 value'), { code: 'QUIET_COMMERCE_PREVIEW_INVALID' });
  }
  const quietCommercePreview = quiet && commercePreview === 'enabled/v1';
  const publicSupport = env.RUNVARA_QUIET_PUBLIC_SUPPORT === undefined ? 'disabled/v1' : env.RUNVARA_QUIET_PUBLIC_SUPPORT;
  if (!['disabled/v1', 'enabled/v1'].includes(publicSupport) || (publicSupport === 'enabled/v1' && !quiet)) {
    throw Object.assign(new Error('Quiet public support requires quiet mode and an exact enabled/v1 or disabled/v1 value'), { code: 'QUIET_PUBLIC_SUPPORT_INVALID' });
  }
  const quietPublicSupport = quiet && publicSupport === 'enabled/v1';
  const supportProducts=env.RUNVARA_QUIET_SUPPORT_PRODUCTS===undefined?'disabled/v1':env.RUNVARA_QUIET_SUPPORT_PRODUCTS;
  if(!['disabled/v1','enabled/v1'].includes(supportProducts)||(supportProducts==='enabled/v1'&&!quietPublicSupport)) {
    throw Object.assign(new Error('Product support requires enabled quiet public support and an exact switch'),{code:'QUIET_SUPPORT_PRODUCTS_INVALID'});
  }
  const quietSupportProducts=supportProducts==='enabled/v1';
  const productOnlySupport=env.RUNVARA_QUIET_PRODUCT_ONLY_SUPPORT===undefined?'disabled/v1':env.RUNVARA_QUIET_PRODUCT_ONLY_SUPPORT;
  if(!['disabled/v1','enabled/v1'].includes(productOnlySupport)||(productOnlySupport==='enabled/v1'&&!quiet)) {
    throw Object.assign(new Error('Product-only support requires quiet mode and an exact switch'),{code:'QUIET_PRODUCT_ONLY_SUPPORT_INVALID'});
  }
  const quietProductOnlySupport=quiet&&productOnlySupport==='enabled/v1';
  const approvalPilot = createQuietApprovalPilot(env);
  const creativePilot = createQuietCreativePilot(env);
  const catalogue = createCataloguePolicy(env);
  const shopifyTokenExchange = createShopifyTokenPolicy(env);
  const parcel2goCredentialWindow = createParcel2GoCredentialWindow(env);
  const parcel2goQuoteWindow = createParcel2GoQuoteWindow(env);
  return Object.freeze({
    mode,
    quiet,
    quietOwnerWorkspace,
    get quietOwnerProductReadiness() { return !!productReadinessWindow?.available(); },
    productReadinessWindow,
    quietShopifyDiagnostic,
    quietOwnerLogin,
    quietCommercePreview,
    quietPublicSupport,
    quietSupportProducts,
    quietProductOnlySupport,
    approvalPilot,
    creativePilot,
    catalogue,
    shopifyTokenExchange,
    parcel2goCredentialWindow,
    parcel2goQuoteWindow,
    allowsRequest(method, pathname) {
      if(pathname===PARCEL2GO_QUOTE_PATH)return Boolean(quietOwnerWorkspace&&parcel2goQuoteWindow&&(method==='GET'||method==='POST'&&parcel2goQuoteWindow.available()));
      if(pathname===PARCEL2GO_ENTRY_PATH)return Boolean(quietOwnerWorkspace&&parcel2goCredentialWindow&&(method==='GET'||method==='POST'&&parcel2goCredentialWindow.available()));
      if (!quiet) return true;
      if (productReadinessWindow?.available() && method === 'GET' && pathname === OWNER_PRODUCT_READINESS_PATH) return true;
      if (shopifyTokenExchange && pathname === SHOPIFY_TOKEN_PATH && (method === 'GET' || method === 'POST' && shopifyTokenExchange.available())) return true;
      if (quietShopifyDiagnostic && method === 'GET' && pathname === SHOPIFY_DIAGNOSTIC_PATH) return true;
      if (catalogue && pathname === CATALOGUE_PATH && (method === 'GET' || method === 'POST' && catalogue.available())) return true;
      if (quietOwnerWorkspace && method === 'GET' && pathname === '/api/bootstrap') return true;
      if (quietPublicSupport && ['OPTIONS', 'POST'].includes(method) && pathname === '/api/public/support') return true;
      if (quietProductOnlySupport && ['OPTIONS', 'POST'].includes(method) && pathname === PRODUCT_ONLY_SUPPORT_PATH) return true;
      if (creativePilot?.available() && creativePilotAction(method, pathname)) return true;
      if (approvalPilot?.available() && method === 'POST' && ['request', 'reconcile', 'reject'].some(action => pathname === PILOT_BASE + action)) return true;
      if (method === 'GET' && pathname === '/api/auth/session') return true;
      if (quietCommercePreview && method === 'GET' && pathname === '/api/maintenance/commerce') return true;
      if (quietOwnerLogin && method === 'POST' && pathname === '/api/auth/login') return true;
      return (method === 'GET' || method === 'HEAD')
        && (pathname === '/api/health' || staticPaths.has(pathname));
    }
  });
}

export const QUIET_STARTUP_RESPONSE = Object.freeze({
  error: 'New work is temporarily paused for an update. Earlier work may still be running.',
  code: 'STARTUP_QUIET_MODE'
});
