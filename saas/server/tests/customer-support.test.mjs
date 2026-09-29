import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildSupportReply, classifySupportIntent, findCustomerOrder } from '../lib/customer-support.mjs';

const hash=value=>crypto.createHash('sha256').update(value.toLowerCase()).digest('hex');

test('support intent and privacy safeguards',()=>{
  assert.equal(classifySupportIntent('Where is my order?'),'order_status');
  assert.equal(classifySupportIntent('Can I get a VAT invoice?'),'business');
  assert.equal(classifySupportIntent('Please change my delivery address'),'escalate');

  const orders=[{provider:'shopify',name:'#1001',customerEmailHash:hash('buyer@example.com'),financialStatus:'PAID',fulfillmentStatus:'SHIPPED',statusPageUrl:'https://example.com/status/secure'}];
  assert.equal(findCustomerOrder(orders,{orderNumber:'1001',email:'wrong@example.com'}),null);
  assert.equal(findCustomerOrder(orders,{orderNumber:'1001',email:'buyer@example.com'}).name,'#1001');

  const tracked=buildSupportReply({orders},{message:'track my order',orderNumber:'#1001',email:'buyer@example.com'});
  assert.equal(tracked.matchedOrder,true);
  assert.ok(tracked.reply.includes('https://example.com/status/secure'));
  assert.ok(!tracked.reply.includes('buyer@example.com'));

  const escalated=buildSupportReply({orders:[]},{message:'change my delivery address'});
  assert.equal(escalated.needsHuman,true);
  assert.ok(escalated.reply.toLowerCase().includes('human check'));
});
