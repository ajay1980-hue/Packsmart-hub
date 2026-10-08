import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeError } from '../lib/security.mjs';

test('protected outcome source errors never expose reader payloads or suggest another provider action', () => {
  for (const [code, status] of [['OUTCOME_RECEIPT_INVALID', 409], ['OUTCOME_RECEIPT_TOO_LARGE', 413], ['OUTCOME_RECEIPT_STORAGE_UNAVAILABLE', 503]]) {
    const result = sanitizeError(Object.assign(new Error('PRIVATE_READER_CANARY synthetic admission and approval'), { code, status }));
    assert.equal(result.code, code);
    assert.equal(result.status, status);
    assert.ok(result.publicMessage.length > 20 && result.publicMessage.length <= 240);
    assert.doesNotMatch(result.publicMessage, /PRIVATE_READER_CANARY|admission|approval|Shopify may|before taking further action/);
  }
  assert.match(sanitizeError({ code: 'CONTENT_RECEIPT_COMMIT_UNCONFIRMED', status: 409 }).publicMessage, /Shopify may have applied/);
  assert.equal(sanitizeError({ code: 'OUTCOME_RECEIPT_UNKNOWN', status: 503, message: 'PRIVATE_READER_CANARY' }).publicMessage, 'Internal server error');
});
