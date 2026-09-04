import crypto from 'node:crypto';

export const RISKY_ACTION_TYPES = new Set([
  'spend_money',
  'supplier_order',
  'refund',
  'major_price_change',
  'live_external_action'
]);

export function requiresApproval(type) {
  return RISKY_ACTION_TYPES.has(String(type || '').trim());
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

export function createSessionToken({ userId, workspaceId, email }, secret, ttlSeconds = 60 * 60 * 12) {
  if (!secret) throw new Error('SESSION_SECRET is required');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userId,
    workspaceId,
    email,
    iat: now,
    exp: now + ttlSeconds
  };
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifySessionToken(token, secret) {
  if (!token || !secret) return null;
  const [encoded, signature] = String(token).split('.');
  if (!encoded || !signature) return null;
  const expected = sign(encoded, secret);
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp <= now || !payload.workspaceId || !payload.sub) return null;
    return payload;
  } catch {
    return null;
  }
}

function encryptionKey(secret) {
  if (!secret) throw new Error('CREDENTIALS_KEY is required');
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptCredentials(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(value ?? {}), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map(part => part.toString('base64url')).join('.');
}

export function decryptCredentials(encrypted, secret) {
  const [ivRaw, tagRaw, ciphertextRaw] = String(encrypted || '').split('.');
  if (!ivRaw || !tagRaw || !ciphertextRaw) throw new Error('Invalid encrypted credentials');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(secret),
    Buffer.from(ivRaw, 'base64url')
  );
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
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}
