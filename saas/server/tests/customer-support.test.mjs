import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildSupportReply, classifySupportIntent, findCustomerOrder } from '../lib/customer-support.mjs';

const hash=value=>crypto.createHash('sha256').update(value.toLowerCase()).digest('hex');

test('classifies common support intents',()=>{
  assert.equal(classifySupportIntent('Where is my order?'),'order_status');
  assert.equal(classifySupportIntent('Can I get a VAT invoice?'),'business');
  assert.equal(classifySupportIntent('Please change my delivery address'),'escalate');
});

test('requires both order reference and checkout email',()=>{
  const state={orders:[{provider:'shopify',name:'#1001',customerEmailHash:hash('buyer@example.com'),financialStatus:'PAID',fulfillmentStatus:'UNFULFILLED'}]};
  assert.equal(findCustomerOrder(state.orders,{orderNumber:'1001',email:'wrong@example.com'}),null);
  assert.equal(findCustomerOrder(state.orders,{orderNumber:'1001',email:'buyer@example.com'}).name,'#1001');
});

test('returns a verified order status link without exposing email',()=>{
  const state={orders:[{provider:'shopify',name:'#1001',customerEmailHash:hash('buyer@example.com'),financialStatus:'PAID',fulfillmentStatus:'FULFILLED',statusPageUrl:'https://example.com/status/secure'}]};
  const result=buildSupportReply(state,{message:'track my order',orderNumber:'#1001',email:'buyer@example.com'});
  assert.equal(result.matchedOrder,true);
  assert.match(result.reply,/dispatched|fulfilled/i);
  assert.match(result.reply,/https:\/\/example.com\/status\/secure/);
  assert.doesNotMatch(result.reply,/buyer@example.com/);
});

test('escalates sensitive changes rather than claiming execution',()=>{
  const result=buildSupportReply({orders:[]},{message:'change my delivery address'});
  assert.equal(result.needsHuman,true);
  assert.match(result.reply,/human check/i);
});

