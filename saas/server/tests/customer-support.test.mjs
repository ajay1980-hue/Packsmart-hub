import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildSupportReply, classifySupportIntent } from '../lib/customer-support.mjs';

const email = 'buyer@example.test';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const order = { provider:'shopify', name:'#1001', customerEmailHash:hash(email), financialStatus:'PAID' };
const input = { message:'Where is my order?', orderNumber:'#1001', email };

for (const [value, expected] of [
  ['UNFULFILLED','not yet dispatched'], ['unfulfilled','not yet dispatched'],
  ['UNSHIPPED','not yet dispatched'],
  ['PARTIAL','partially dispatched'], ['PARTIALLY_FULFILLED','partially dispatched'],
  ['partially fulfilled','partially dispatched'], ['partially-fulfilled','partially dispatched'],
  ['PARTIALLY_SHIPPED','partially dispatched'], ['PARTIALLY_DISPATCHED','partially dispatched'],
  ['FULFILLED','dispatched'], [' fulfilled ','dispatched'], ['SHIPPED','dispatched'],
  ['IN_TRANSIT','dispatched'], ['in transit','dispatched'], ['DELIVERED','delivered'],
  ['CANCELLED','cancelled'], ['CANCELED','cancelled'],
  ['UNKNOWN','not yet confirmed'], ['NOT_DELIVERED','not yet confirmed'],
  ['UNRECOGNIZED_FULFILLED_STATUS','not yet confirmed'], ['AWAITING_SHIPPED','not yet confirmed'],
  ['<unknown>','not yet confirmed']
]) test(`customer support maps exact fulfillment status ${JSON.stringify(value)}`, () => {
  const state = { orders:[{ ...order, fulfillmentStatus:value }] };
  const before = structuredClone(state);
  const response = buildSupportReply(state,input);
  assert.equal(response.matchedOrder,true);
  assert.ok(response.reply.includes(`**${expected}**`),response.reply);
  assert.deepEqual(state,before);
});

test('customer support retains alternate saved status fields and safe missing-status fallback', () => {
  for (const field of ['fulfilmentStatus','displayFulfillmentStatus']) {
    assert.match(buildSupportReply({orders:[{...order,[field]:'PARTIALLY_FULFILLED'}]},input).reply,/\*\*partially dispatched\*\*/);
  }
  assert.match(buildSupportReply({orders:[order]},input).reply,/\*\*being prepared\*\*/);
  assert.match(buildSupportReply({orders:[{...order,financialStatus:'UNPAID'}]},input).reply,/\*\*being processed\*\*/);
});

test('customer support requires both order reference and matching email on a Shopify order', () => {
  const state = { orders:[{...order,fulfillmentStatus:'FULFILLED'}] };
  for (const changed of [{email:'other@example.test'},{orderNumber:'#1002'},{email:''},{orderNumber:''}]) {
    assert.notEqual(buildSupportReply(state,{...input,...changed}).matchedOrder,true);
  }
  assert.notEqual(buildSupportReply({orders:[{...order,provider:'ebay'}]},input).matchedOrder,true);
  assert.equal(buildSupportReply(state,{...input,email:' BUYER@EXAMPLE.TEST '}).matchedOrder,true);
});

test('customer support routes common requests safely',()=>{
  assert.equal(classifySupportIntent('Where is my order?'),'order_status');
  assert.equal(classifySupportIntent('Can I get a VAT invoice?'),'business');
  assert.equal(classifySupportIntent('Please change my delivery address'),'escalate');
});
