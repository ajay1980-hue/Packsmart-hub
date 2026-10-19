import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { publicationFixture } from './marketing-publication-fixture.mjs';
import { createStore } from '../lib/store.mjs';
import { createMetaPublicationPreparationSimulation, prepareMetaMarketingPublication } from '../lib/marketing-publication.mjs';
import { prepareMetaReceiptTransaction, commitMetaReceiptTransaction, assertMetaReceiptAcknowledgement,
  validateMetaReceiptDescriptor, META_RECEIPT_CONTRACT, META_RECEIPT_READ_MAX } from '../lib/meta-publication-receipt.mjs';

async function protectedFixture(t){
 const f=await publicationFixture(t),state=await f.get(),body=await f.body();
 const preparationSimulation=createMetaPublicationPreparationSimulation(state,f.campaignId,body,f.session,{protectedReceipts:true});
 await prepareMetaMarketingPublication(state,f.campaignId,body,f.session,{durableStore:true,preparationSimulation,persist:o=>f.store.save(f.workspaceId,state,o)});
 await f.approve();return f;
}
async function transactionFixture(t){
 const f=await protectedFixture(t);let descriptor,state;
 await assert.rejects(f.execute({persist:(run,options)=>{state=run.state;descriptor=options.protectedMetaCommit;throw Error('capture only');}}),/capture only/);
 const expectedRevision=state._revision,next=structuredClone(state);next._revision=randomUUID();
 return {...f,state,descriptor,transaction:prepareMetaReceiptTransaction(f.workspaceId,next,expectedRevision,descriptor)};
}
test('protected local preparation binds exact approval, and FileStore cannot acknowledge dispatch',async t=>{
 const f=await protectedFixture(t),state=await f.get(),write=state.connectionWrites[0];
 assert.equal(write.marketingPublication.receiptContract,META_RECEIPT_CONTRACT);
 assert.deepEqual(state.approvals[0].payload.publication,write.marketingPublication);
 await assert.rejects(f.execute(),{code:'META_RECEIPT_UNAVAILABLE'});assert.equal(f.executions[0].simulation.observations().length,0);
 assert.equal((await f.get()).connectionWrites[0].status,'pending_approval');
});
test('serialized protected commit descriptors cannot select the Supabase save channel',async t=>{
 const f=await transactionFixture(t);let network=0;
 const store=createStore({SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only'},{fetchImpl:async()=>{network++;throw Error('unexpected request');}});
 await assert.rejects(store.save(f.workspaceId,f.state,{protectedMetaCommit:structuredClone(f.descriptor)}),{code:'META_RECEIPT_INVALID'});assert.equal(network,0);
});
test('a plain matching state and JSON acknowledgement cannot mint the private save proof',async t=>{
 const f=await transactionFixture(t);assert.throws(()=>assertMetaReceiptAcknowledgement(f.state,f.descriptor),{code:'META_RECEIPT_ACK_INVALID'});
 await assert.rejects(f.execute({persist:async run=>{run.state._revision=randomUUID();return structuredClone(run.state);}}),{code:'META_RECEIPT_ACK_INVALID'});
 assert.equal(f.executions.at(-1).simulation.observations().length,0);
});
test('exact transaction success preserves frozen fingerprint and uses one mutation',async t=>{
 const f=await transactionFixture(t),calls=[];
 const result=await commitMetaReceiptTransaction(f.transaction,async(operation,path,settings)=>{calls.push({operation,path,settings});return {...f.transaction.expected,replayed:false};});
 assert.equal(result.recovered,false);assert.equal(calls.length,1);assert.equal(calls[0].operation,'state_commit');assert.equal(calls[0].settings.body,f.transaction.body);
 assert.ok(Object.isFrozen(f.transaction));assert.equal(JSON.parse(JSON.parse(f.transaction.body).p_request).descriptor.eventText,f.descriptor.eventText);
});
for(const variant of ['lost','malformed','mismatched'])test(`ambiguous ${variant} acknowledgement does one exact read and no mutation retry`,async t=>{
 const f=await transactionFixture(t),calls=[];
 const result=await commitMetaReceiptTransaction(f.transaction,async(operation,path,settings)=>{
  calls.push({operation,path,settings});if(calls.length===1){if(variant==='lost')throw Error('synthetic lost ack');if(variant==='malformed')return {};return {...f.transaction.expected,eventDigest:'0'.repeat(64),replayed:false};}
  return {...f.transaction.expected,replayed:true};
 });
 assert.equal(result.recovered,true);assert.deepEqual(calls.map(c=>c.operation),['state_commit','state_read']);assert.equal(calls[1].settings.body,f.transaction.lookupBody);
});
for(const lookup of [null,{},'wrong',false])test(`unproven lookup ${JSON.stringify(lookup)} leaves uncertainty without a third request`,async t=>{
 const f=await transactionFixture(t);let count=0;
 await assert.rejects(commitMetaReceiptTransaction(f.transaction,async()=>{if(++count===1)throw Error('synthetic lost ack');return lookup;}),{code:'META_RECEIPT_COMMIT_UNKNOWN'});assert.equal(count,2);
});
test('deterministic SQL rejection does not invoke reconciliation or ordinary persistence',async t=>{
 const f=await transactionFixture(t);let count=0;
 await assert.rejects(commitMetaReceiptTransaction(f.transaction,async()=>{count++;throw Object.assign(Error('refused'),{databaseCode:'P0M05'});}),{code:'META_RECEIPT_PROTECTED_WRITE'});assert.equal(count,1);
});
test('descriptor getters, mutated bytes, extra fields and unknown contracts fail before persistence',async t=>{
 const f=await transactionFixture(t);let invoked=0;
 for(const descriptor of [{...f.descriptor,digest:'0'.repeat(64)},{...f.descriptor,extra:true},{...f.descriptor,contract:'other'},
  {get contract(){invoked++;return META_RECEIPT_CONTRACT;},digest:f.descriptor.digest,eventText:f.descriptor.eventText}])assert.throws(()=>validateMetaReceiptDescriptor(descriptor));
 assert.equal(invoked,0);assert.ok(META_RECEIPT_READ_MAX>=16*(32768*2+256));
});
