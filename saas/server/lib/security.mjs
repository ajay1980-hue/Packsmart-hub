import crypto from 'node:crypto';

export const SESSION_COOKIE = '__Host-packsmart_session';
export const DEV_SESSION_COOKIE = 'packsmart_session';

export const RISKY_ACTION_TYPES = new Set([
  'spend_money',
  'advertising_spend',
  'supplier_order',
  'refund',
  'major_price_change',
  'paid_service_purchase',
  'live_external_action',
  'risky_marketplace_action',
  'social_commerce_publish',
  'social_advertising_change'
]);

const PASSWORD_MIN_LENGTH = 14;
const PASSWORD_MAX_LENGTH = 256;

export function requiresApproval(type) {
  return RISKY_ACTION_TYPES.has(String(type || '').trim().toLowerCase());
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function createSessionToken({ userId, workspaceId, email, role = 'member', csrf, sessionVersion = 1 }, secret, ttlSeconds = 60 * 60 * 12) {
  if (!secret || String(secret).length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(userId),
    workspaceId: String(workspaceId),
    email: normalizeEmail(email),
    role: String(role),
    csrf: csrf || crypto.randomBytes(24).toString('base64url'),
    sessionVersion: Number(sessionVersion) || 1,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + ttlSeconds
  };
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifySessionToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!token || !secret || String(secret).length < 32) return null;
  const [encoded, signature, extra] = String(token).split('.');
  if (!encoded || !signature || extra) return null;
  const expected = sign(encoded, secret);
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp <= nowSeconds || payload.iat > nowSeconds + 60) return null;
    if (!payload.workspaceId || !payload.sub || !payload.csrf || !payload.email) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const result = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
}

export function sessionCookie(token, { secure = true, maxAge = 60 * 60 * 12 } = {}) {
  const name = secure ? SESSION_COOKIE : DEV_SESSION_COOKIE;
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie({ secure = true } = {}) {
  const name = secure ? SESSION_COOKIE : DEV_SESSION_COOKIE;
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function tokenFromRequest(req, { allowBearer = false, secure = true } = {}) {
  const cookies = parseCookies(req.headers.cookie || '');
  const cookieToken = cookies[secure ? SESSION_COOKIE : DEV_SESSION_COOKIE];
  if (cookieToken) return cookieToken;
  if (!allowBearer) return '';
  const authorization = String(req.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

export function assertCsrf(req, session, publicUrl) {
  const expected = String(session?.csrf || '');
  const supplied = String(req.headers['x-csrf-token'] || '');
  if (!expected || !safeEqual(expected, supplied)) {
    throw Object.assign(new Error('Invalid request token'), { status: 403, code: 'CSRF_INVALID' });
  }
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  let expectedOrigin;
  try { expectedOrigin = new URL(publicUrl).origin; } catch { expectedOrigin = ''; }
  if (!expectedOrigin || origin !== expectedOrigin) {
    throw Object.assign(new Error('Request origin denied'), { status: 403, code: 'ORIGIN_DENIED' });
  }
  return true;
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 254);
}

export function validatePassword(value) {
  const password = String(value || '');
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw Object.assign(new Error(`Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`), { status: 400 });
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    throw Object.assign(new Error('Password must include upper-case, lower-case, number and symbol characters'), { status: 400 });
  }
  return password;
}

export function hashPassword(value, { salt = crypto.randomBytes(16), cost = 16384 } = {}) {
  const password = validatePassword(value);
  const derived = crypto.scryptSync(password, salt, 64, { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${cost}$${Buffer.from(salt).toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(value, encoded) {
  try {
    const [scheme, costRaw, saltRaw, hashRaw, extra] = String(encoded || '').split('$');
    if (scheme !== 'scrypt' || !costRaw || !saltRaw || !hashRaw || extra) return false;
    const cost = Number(costRaw);
    if (!Number.isInteger(cost) || cost < 16384 || cost > 131072) return false;
    const expected = Buffer.from(hashRaw, 'base64url');
    const actual = crypto.scryptSync(String(value || ''), Buffer.from(saltRaw, 'base64url'), expected.length, {
      N: cost, r: 8, p: 1, maxmem: 256 * 1024 * 1024
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function encryptionKey(secret) {
  if (!secret || String(secret).length < 32) throw new Error('CREDENTIALS_KEY must contain at least 32 characters');
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptCredentials(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? {}), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${[iv, tag, ciphertext].map(part => part.toString('base64url')).join('.')}`;
}

export function decryptCredentials(encrypted, secret) {
  const [version, ivRaw, tagRaw, ciphertextRaw, extra] = String(encrypted || '').split('.');
  if (version !== 'v1' || !ivRaw || !tagRaw || !ciphertextRaw || extra) throw new Error('Invalid encrypted credentials');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextRaw, 'base64url')),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

export function publicConnection(connection) {
  return {
    id: connection.id,
    provider: connection.provider,
    label: connection.label,
    status: connection.status,
    capabilities: connection.capabilities || [],
    metadata: sanitizePublicMetadata(connection.metadata),
    lastSyncAt: connection.lastSyncAt || null,
    lastError: connection.lastError || null,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}

function sanitizePublicMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const allowed = ['account', 'shopDomain', 'marketplaceId', 'itemCount', 'draftCount', 'listingCount', 'channel'];
  return Object.fromEntries(allowed.filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]]));
}

export function sanitizeError(error) {
  const status = Number(error?.status) || 500;
  const publicMessage = status >= 500 ? 'Internal server error' : String(error?.message || 'Request failed').slice(0, 240);
  return { status, publicMessage, code: String(error?.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR')).slice(0, 80) };
}

export class SlidingWindowLimiter {
  constructor({ limit = 8, windowMs = 15 * 60 * 1000, blockMs = 15 * 60 * 1000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
    this.entries = new Map();
  }

  check(key, now = Date.now()) {
    const normalized = String(key || 'unknown').slice(0, 300);
    const current = this.entries.get(normalized) || { attempts: [], blockedUntil: 0 };
    if (current.blockedUntil > now) return { allowed: false, retryAfterMs: current.blockedUntil - now };
    current.attempts = current.attempts.filter(timestamp => timestamp > now - this.windowMs);
    if (current.attempts.length >= this.limit) {
      current.blockedUntil = now + this.blockMs;
      this.entries.set(normalized, current);
      return { allowed: false, retryAfterMs: this.blockMs };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  fail(key, now = Date.now()) {
    const normalized = String(key || 'unknown').slice(0, 300);
    const current = this.entries.get(normalized) || { attempts: [], blockedUntil: 0 };
    current.attempts = current.attempts.filter(timestamp => timestamp > now - this.windowMs);
    current.attempts.push(now);
    if (current.attempts.length >= this.limit) current.blockedUntil = now + this.blockMs;
    this.entries.set(normalized, current);
  }

  reset(key) {
    this.entries.delete(String(key || 'unknown').slice(0, 300));
  }
}
