import { decryptCredentials } from './security.mjs';
import { assertQuietOwnerWorkspace } from './quiet-owner-workspace.mjs';

export const SHOPIFY_DIAGNOSTIC_PATH = '/api/owner/shopify-credential-metadata';
const DOMAIN = 'wavtzm-vy.myshopify.com', VERSION = '2026-07';
const own = (value, key) => Object.hasOwn(value, key);
const token = value => typeof value === 'string' && value.length >= 16 && value.length <= 512 && !/\s/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;

// Metadata compatibility is NOT provider validity. Only established storage
// shapes from cleanShopifyCredentials / packTokens are recognized. In
// particular, null expiry by itself never establishes non-expiring access.
export function classifyShopifyCredential(value, now = Date.now()) {
  const result = { tokenPresent: false, credentialType: 'unknown', expiryState: 'unknown', expiresAt: null,
    metadataCompatible: false, providerUsability: 'unverified', code: 'TOKEN_METADATA_UNKNOWN' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  result.tokenPresent = typeof value.accessToken === 'string' && value.accessToken.length > 0;
  if (own(value, 'accessToken') && typeof value.accessToken !== 'string') { result.code = 'TOKEN_METADATA_INVALID'; return result; }
  if (!result.tokenPresent) {
    result.credentialType = typeof value.clientId === 'string' && !!value.clientId && typeof value.clientSecret === 'string' && !!value.clientSecret ? 'client_credentials' : 'missing';
    result.code = 'TOKEN_RENEWAL_REQUIRED'; return result;
  }
  if (!token(value.accessToken) || !Number.isFinite(now)) { result.code = 'TOKEN_METADATA_INVALID'; return result; }
  const oauth = value.mode === 'oauth';
  const direct = !own(value, 'mode') && !own(value, 'refreshToken') && !own(value, 'refreshTokenExpiresAt') && !own(value, 'scopes');
  const fields = oauth ? ['storeDomain','accessToken','mode','expiresAt','refreshToken','refreshTokenExpiresAt','scopes'] : ['storeDomain','accessToken','expiresAt'];
  // Mixing saved token and client-credential grants is ambiguous, never a
  // reason to invoke the token endpoint as a fallback.
  if (Object.keys(value).some(key => !fields.includes(key)) || (!oauth && !direct)) return result;
  result.credentialType = oauth ? 'oauth' : 'direct_access_token';
  if (oauth && (!Array.isArray(value.scopes) || value.scopes.some(s => typeof s !== 'string')
    || !own(value, 'refreshToken') || !(value.refreshToken === null || token(value.refreshToken))
    || !own(value, 'refreshTokenExpiresAt') || !(value.refreshTokenExpiresAt === null || timestamp(value.refreshTokenExpiresAt))
    || (value.refreshToken === null && value.refreshTokenExpiresAt !== null))) return result;
  if ((direct && !own(value, 'expiresAt')) || (oauth && value.expiresAt === null && value.refreshToken === null && value.refreshTokenExpiresAt === null)) {
    result.expiryState = 'non_expiring_metadata'; result.metadataCompatible = true; result.code = 'METADATA_COMPATIBLE'; return result;
  }
  if (!own(value, 'expiresAt') || value.expiresAt === null) return result;
  if (!timestamp(value.expiresAt)) { result.expiryState = 'malformed'; result.code = 'TOKEN_METADATA_INVALID'; return result; }
  result.expiresAt = new Date(value.expiresAt).toISOString();
  result.expiryState = value.expiresAt <= now ? 'expired' : value.expiresAt <= now + 60000 ? 'expiring' : 'future';
  result.metadataCompatible = result.expiryState === 'future';
  result.code = result.metadataCompatible ? 'METADATA_COMPATIBLE' : 'TOKEN_RENEWAL_REQUIRED';
  return result;
}

// Returns only a fixed allowlist, never credential contents, ciphertext,
// fingerprints, provider error text or arbitrary stored strings. No I/O here.
export function shopifyCredentialDiagnostic(auth, integrations, env) {
  assertQuietOwnerWorkspace(auth);
  if (!Number.isFinite(auth.session.exp) || auth.session.exp * 1000 <= Date.now()) {
    throw Object.assign(new Error('Current owner session required'), { status: 401, code: 'SHOPIFY_DIAGNOSTIC_SESSION_EXPIRED' });
  }
  const rows = auth.state.connections?.filter(c => c.provider === 'shopify') || [];
  const connection = rows.length === 1 ? rows[0] : null;
  const result = { schema: 'runvara-shopify-credential-metadata/v1', credentialPresent: Boolean(connection?.encryptedCredentials),
    bindingMatches: Boolean(connection?.id && connection.metadata?.shopDomain === DOMAIN && !auth.state.connectionSettings?.shopify?.disconnected),
    configMatches: false, ...classifyShopifyCredential(null) };
  if (!result.credentialPresent || !result.bindingMatches) return result;
  let credentials;
  try { credentials = decryptCredentials(connection.encryptedCredentials, env.CREDENTIALS_KEY); }
  catch { return { ...result, code: 'CREDENTIAL_UNREADABLE' }; }
  Object.assign(result, classifyShopifyCredential(credentials));
  try {
    const config = integrations.shopifyConfig(auth.state);
    result.configMatches = config.connection?.id === connection.id && config.workspaceId === auth.session.workspaceId
      && config.domain === DOMAIN && config.apiVersion === VERSION;
  } catch { /* No stored strings or underlying errors leave this boundary. */ }
  if (!result.configMatches) { result.metadataCompatible = false; result.code = 'SOURCE_CONFIG_MISMATCH'; }
  return result;
}
