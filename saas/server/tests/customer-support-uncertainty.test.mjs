import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {buildSupportReply} from '../lib/customer-support.mjs';
const email='synthetic@example.test';
const order={provider:'shopify',name:'#SYNTH-1',customerEmailHash:crypto.createHash('sha256').update(email).digest('hex')};
const input={message:'Where is my order?',orderNumber:'#SYNTH-1',email};
const reply=extra=>buildSupportReply({orders:[{...order,...extra}]},input);
function unknown(extra){
  const result=reply(extra);
  assert.match(result.reply,/\*\*not yet confirmed\*\*/);
  assert.doesNotMatch(result.reply,/being prepared|being processed|\*\*dispatched\*\*/);
  assert.equal(result.needsHuman,true);assert.equal(result.matchedOrder,true);
  assert.match(result.reply,/has not sent a message/);
}
for(const financialStatus of [undefined,'PAID','UNPAID','PENDING','AUTHORIZED','REFUNDED','VOIDED','UNKNOWN'])
  test(`missing fulfilment is unknown irrespective of financial status ${financialStatus}`,()=>unknown({financialStatus}));
for(const value of [undefined,null,'','   ','UNKNOWN','NOT_DELIVERED','UNRECOGNIZED_FULFILLED_STATUS',false,0,{},[], 'x'.repeat(81)])
  test(`missing or malformed fulfilment is unknown: ${JSON.stringify(value)}`,()=>unknown({fulfillmentStatus:value}));
const fields=['fulfillmentStatus','fulfilmentStatus','displayFulfillmentStatus'];
for(const first of fields)for(const second of fields.filter(x=>x!==first))
  test(`conflict is order independent: ${first} vs ${second}`,()=>unknown({[first]:'FULFILLED',[second]:'UNFULFILLED'}));
for(const [first,second] of [['FULFILLED','DELIVERED'],['PARTIAL','FULFILLED'],['UNKNOWN','FULFILLED'],['CANCELLED','UNFULFILLED']])
  test(`conflicting or unrecognized alias stops ${first}/${second}`,()=>unknown({fulfillmentStatus:first,displayFulfillmentStatus:second}));
for(const [first,second,status] of [['FULFILLED','SHIPPED','dispatched'],['UNFULFILLED','UNSHIPPED','not yet dispatched'],['PARTIAL','PARTIALLY_FULFILLED','partially dispatched'],['CANCELLED','CANCELED','cancelled']])
  test(`equivalent exact aliases preserve ${status}`,()=>{const r=reply({fulfillmentStatus:first,displayFulfillmentStatus:second,financialStatus:'REFUNDED'});assert.ok(r.reply.includes(`**${status}**`));assert.equal(r.needsHuman,false);});
test('unknown status keeps unique-match isolation and does not mutate saved records',()=>{
  const state={orders:[{...order,financialStatus:'PAID'}]}, before=structuredClone(state);
  assert.equal(buildSupportReply(state,{...input,email:'other@example.test'}).matchedOrder,undefined);
  assert.equal(buildSupportReply({orders:[...state.orders,...state.orders]},input).matchedOrder,undefined);
  assert.deepEqual(buildSupportReply(state,input),buildSupportReply(state,input));assert.deepEqual(state,before);
});
