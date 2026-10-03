import crypto from 'node:crypto';
import { decryptCredentials, encryptCredentials } from './security.mjs';

export const CANVA_SCOPES = Object.freeze(['asset:read', 'asset:write', 'design:meta:read', 'design:content:read', 'design:content:write', 'brandtemplate:meta:read', 'brandtemplate:content:read']);
export const canvaError = (message, code = 'CANVA_AUTH_REQUIRED', status = 422) => Object.assign(new Error(message), { code, status });

export function readCanvaCredentials(state, env) {
  const encrypted = state.marketing?.providers?.canva?.encryptedCredentials;
  if (!encrypted) return {};
  try { return decryptCredentials(encrypted, env.CREDENTIALS_KEY); }
  catch { throw canvaError('Saved Canva credentials need reconnecting.', 'CANVA_CREDENTIALS_INVALID'); }
}

export function canvaApplication(state, env) {
  const credentials = readCanvaCredentials(state, env);
  // Shared application credentials do not share user tokens across tenants.
  return { clientId: credentials.clientId || env.CANVA_CLIENT_ID, clientSecret: credentials.clientSecret || env.CANVA_CLIENT_SECRET };
}

export function canvaRedirect(env) {
  const url = new URL(env.APP_PUBLIC_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw canvaError('A secure production URL is required.', 'CANVA_OAUTH_NOT_CONFIGURED', 409);
  return `${url.origin}/api/marketing/providers/canva/oauth/callback`;
}

export function canvaOAuthReady(state, env) {
  try { const app = canvaApplication(state, env); canvaRedirect(env); return Boolean(app.clientId && app.clientSecret && String(env.CREDENTIALS_KEY || '').length >= 32); }
  catch { return false; }
}

export function saveCanvaApplication(state, body, env, actor) {
  if (String(env.CREDENTIALS_KEY || '').length < 32) throw canvaError('Credential encryption is unavailable.', 'CREDENTIAL_ENCRYPTION_REQUIRED', 503);
  const clientId = String(body.clientId || '').trim(), clientSecret = String(body.clientSecret || '').trim();
  if (!/^[A-Za-z0-9_-]{5,200}$/.test(clientId) || clientSecret.length < 20 || clientSecret.length > 8192 || /\s/.test(clientSecret)) throw canvaError('Enter the Canva application client ID and secret.', 'CANVA_APPLICATION_INVALID', 400);
  const record = state.marketing.providers.canva || {}, old = readCanvaCredentials(state, env);
  const credentials = old.clientId === clientId ? { ...old, clientId, clientSecret } : { clientId, clientSecret, brandTemplateId: old.brandTemplateId };
  state.marketing.providers.canva = { ...record, status: 'action_required', encryptedCredentials: encryptCredentials(credentials, env.CREDENTIALS_KEY), updatedAt: new Date().toISOString(), updatedBy: actor, lastTestStatus: null, lastError: null };
  // A changed application invalidates any pending authorisation for the old app.
  state.oauthChallenges = (state.oauthChallenges || []).filter(item => item.provider !== 'marketing_canva');
}

export function canvaAuthorizationUrl(state, env, token, verifier) {
  if (!canvaOAuthReady(state, env)) throw canvaError('Configure the Canva application first.', 'CANVA_OAUTH_NOT_CONFIGURED', 409);
  const url = new URL('https://www.canva.com/api/oauth/authorize');
  url.search = new URLSearchParams({ client_id: canvaApplication(state, env).clientId, redirect_uri: canvaRedirect(env), response_type: 'code', scope: CANVA_SCOPES.join(' '), state: token, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  return url.toString();
}

export async function requestCanvaTokens(state, env, form, fetchImpl = fetch) {
  const app = canvaApplication(state, env);
  if (!app.clientId || !app.clientSecret) throw canvaError('Configure the Canva application before reconnecting.', 'CANVA_OAUTH_NOT_CONFIGURED', 409);
  let response, payload;
  try {
    response = await fetchImpl('https://api.canva.com/rest/v1/oauth/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
    payload = await response.json();
  } catch { throw canvaError('Canva token renewal is temporarily unavailable. Try again.', 'CANVA_TOKEN_UNAVAILABLE', 502); }
  // Do not reflect upstream token endpoint messages or payloads into logs/UI.
  if (!response.ok) throw canvaError(response.status < 500 && response.status !== 429 ? 'Canva access could not be renewed. Reconnect Canva.' : 'Canva is temporarily unavailable. Try again later.', response.status < 500 && response.status !== 429 ? 'CANVA_AUTH_REQUIRED' : 'CANVA_TOKEN_UNAVAILABLE', 422);
  if (!payload.access_token || !payload.refresh_token || !Number.isFinite(Number(payload.expires_in)) || Number(payload.expires_in) <= 0) throw canvaError('Canva returned incomplete access. Reconnect.', 'CANVA_TOKEN_RESPONSE_INVALID');
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: Date.now() + Number(payload.expires_in) * 1000, scopes: String(payload.scope || CANVA_SCOPES.join(' ')).split(/\s+/).filter(Boolean), mode: 'oauth' };
}

export function storeCanvaTokens(state, env, tokens) {
  const record = state.marketing.providers.canva;
  record.encryptedCredentials = encryptCredentials({ ...readCanvaCredentials(state, env), ...tokens }, env.CREDENTIALS_KEY);
  record.updatedAt = new Date().toISOString();
  record.status = 'configured'; record.lastError = null; record.lastTestStatus = null;
}

// Call under the existing workspace lock. Persist rotated single-use refresh
// tokens before issuing any creative or health request that could subsequently fail.
export async function refreshCanvaCredentials(state, env, { force = false, persist = async () => {}, fetchImpl = fetch } = {}) {
  const record = state.marketing?.providers?.canva;
  if (record?.status === 'disconnected') throw canvaError('Reconnect Canva first.', 'CANVA_DISCONNECTED', 409);
  const old = readCanvaCredentials(state, env);
  if (!force && (!old.expiresAt || old.expiresAt > Date.now() + 60000)) return old;
  if (!old.refreshToken) throw canvaError('Canva requires sign-in to renew access.', 'CANVA_AUTH_REQUIRED');
  const tokens = await requestCanvaTokens(state, env, { grant_type: 'refresh_token', refresh_token: old.refreshToken }, fetchImpl);
  storeCanvaTokens(state, env, tokens);
  record.lastRefreshAt = new Date().toISOString();
  await persist();
  return { ...old, ...tokens };
}
