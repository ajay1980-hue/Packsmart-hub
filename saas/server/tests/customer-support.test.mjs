import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySupportIntent } from '../lib/customer-support.mjs';

test('customer support routes common requests safely',()=>{
  assert.equal(classifySupportIntent('Where is my order?'),'order_status');
  assert.equal(classifySupportIntent('Can I get a VAT invoice?'),'business');
  assert.equal(classifySupportIntent('Please change my delivery address'),'escalate');
});
