import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeError } from '../lib/security.mjs';
import { publicConnectionWrite } from '../lib/action-display.mjs';
import { objectiveContentHarness, until, pause, deferred } from './objective-content-ui-fixture.mjs';

const hostile = '<img src=x onerror="window.receiptLeak=true"> PRIVATE_RECEIPT_SOURCE_CANARY';
const review = ' Review the existing request before taking further action.';
const reasons = {
  CONTENT_RECEIPT_CAPACITY_EXHAUSTED: 'Protected content history is full.',
  CONTENT_RECEIPT_STATE_CAPACITY_EXHAUSTED: 'Workspace history has no room to safely retain this content change.',
  CONTENT_RECEIPT_TOO_LARGE: 'This content change is too large to retain safely.',
  CONTENT_RECEIPT_SOURCE_UNAVAILABLE: 'The saved source for this content change is unavailable.',
  CONTENT_RECEIPT_UNAVAILABLE: 'Protected content history is unavailable.',
  CONTENT_RECEIPT_INVALID: 'Runvara could not validate the saved record for this content change.',
  CONTENT_RECEIPT_ACTOR_REQUIRED: 'Runvara could not verify the authorised owner for this saved content change.',
  CONTENT_RECEIPT_IDENTITY_CONFLICT: 'The saved content request no longer matches its protected record.',
  CONTENT_RECEIPT_GUARD_REQUIRED: 'Required protection for this content change could not be verified.',
  CONTENT_RECEIPT_ACK_INVALID: 'Runvara could not confirm the saved record for this content change.',
  CONTENT_RECEIPT_COMMIT_UNCONFIRMED: 'Shopify may have applied the change, but Runvara could not confirm its saved completion.'
};
const beforeSend = 'Runvara stopped this request before sending a change to Shopify. ';

test('known receipt errors use fixed phase-neutral public copy at both client and server failure statuses', () => {
  for (const [code, reason] of Object.entries(reasons)) for (const status of [403,409,413,503]) {
    const error = Object.assign(new Error(hostile), { code, status, source:hostile, receipt:{private:hostile} });
    assert.deepEqual(sanitizeError(error), { status, code, publicMessage:reason + review });
    assert.equal(error.message, hostile);
  }
});

test('receipt allowlist is exact and preserves every other sanitizer policy', () => {
  for (const code of ['CONTENT_RECEIPT_FUTURE', 'CONTENT_RECEIPT_TOO_LARGE extra', '__proto__', 'constructor', 'toString', 'WRITE_ALREADY_ATTEMPTED']) {
    assert.deepEqual(sanitizeError({status:503,code,message:hostile}), {status:503,code,publicMessage:'Internal server error'});
    assert.deepEqual(sanitizeError({status:409,code,message:'Existing refusal'}), {status:409,code,publicMessage:'Existing refusal'});
  }
  assert.deepEqual(sanitizeError({}), {status:500,code:'INTERNAL_ERROR',publicMessage:'Internal server error'});
  assert.deepEqual(sanitizeError({status:400}), {status:400,code:'REQUEST_ERROR',publicMessage:'Request failed'});
  assert.equal(sanitizeError({status:400,code:'x'.repeat(100),message:'y'.repeat(300)}).code.length,80);
  assert.equal(sanitizeError({status:400,message:'y'.repeat(300)}).publicMessage.length,240);
});

async function harness(t, { role='owner', provider='shopify', status='ready', input, id='write_receipt_feedback' } = {}) {
  const h = await objectiveContentHarness(t,{role});
  h.row = {id,provider,status,requiresApproval:true,approvalId:'approval_receipt_feedback',
    input:input || {operation:'product_content',productId:'gid://shopify/Product/10',title:'Reviewed content',description:'Exact reviewed description'}};
  h.bootstrap.connectionWrites = [publicConnectionWrite(h.row)];
  h.route = '/api/connection-writes/' + id + '/execute';
  h.explicitRoutes.set('/api/connection-centre',async()=>Response.json({channels:h.bootstrap.connectionCentre,writes:h.bootstrap.connectionWrites,autopilotEnabled:false}));
  h.explicitRoutes.set(h.route,async(...args)=>h.execute(...args));
  h.execute = async()=>{throw new Error('Set the synthetic execute response explicitly');};
  h.reply = (result, httpStatus=200) => {
    if(result.write) h.bootstrap.connectionWrites = [publicConnectionWrite({...h.row,...result.write})];
    return Response.json(result,{status:httpStatus});
  };
  await h.login(); h.controls.setView('channels'); h.w.RunvaraConnections.open(provider);
  h.button = ()=>h.d.querySelector('[data-connection-action="execute"]');
  h.start = h.calls.length;
  h.assertCalls = expected => assert.deepEqual(h.calls.slice(h.start).map(({route,method,body})=>({route,method,body})),expected);
  h.expectedSuccessCalls = [{route:h.route,method:'POST',body:'{}'},{route:'/api/bootstrap',method:'GET',body:undefined},{route:'/api/connection-centre',method:'GET',body:undefined}];
  return h;
}

for (const code of Object.keys(reasons)) test('actual Apply callback shows a fixed pre-send refusal for '+code, async t => {
  const h = await harness(t),pending=deferred();
  h.execute=()=>pending.promise;
  h.button().click();h.button().click();
  assert.equal(h.calls.filter(call=>call.route===h.route).length,1,'disabled Apply does not send a second request');
  const result={executedExternally:false,write:{status:'failed',dispatchBlocked:true,errorCode:code,message:hostile,receipt:{source:hostile}}};
  pending.resolve(h.reply(result));
  const expected=code==='CONTENT_RECEIPT_COMMIT_UNCONFIRMED'
    ? 'Runvara stopped this request before sending a change to Shopify, but could not confirm its saved record.' + review
    : beforeSend+reasons[code]+review;
  await until(()=>h.el('global-error').textContent===expected);
  assert.equal(h.el('connection-feedback').textContent,expected);
  assert.equal(h.d.querySelector('.connection-write .warn').textContent,expected);
  assert.equal(h.button(),null);h.assertCalls(h.expectedSuccessCalls);
  assert.equal(h.d.body.innerHTML.includes(hostile),false);assert.equal(h.w.receiptLeak,undefined);
});

for(const flag of [false,undefined,'true',1]) test('receipt code without strict blocked proof stays phase-neutral: '+String(flag),async t=>{
  const h=await harness(t),code='CONTENT_RECEIPT_CAPACITY_EXHAUSTED';
  h.execute=async()=>h.reply({executedExternally:false,write:{status:'failed',errorCode:code,dispatchBlocked:flag,message:hostile}});
  h.button().click();await until(()=>h.el('global-error').textContent===reasons[code]+review);
  assert.equal(h.el('connection-feedback').textContent,reasons[code]+review);h.assertCalls(h.expectedSuccessCalls);
});

for(const code of Object.keys(reasons)) test('real app API preserves '+code+' for safe execute error feedback',async t=>{
  const h=await harness(t);
  // Even a hostile upstream message cannot become UI copy for these codes.
  h.execute=async()=>h.reply({error:hostile,code,receipt:{source:hostile}},503);
  h.button().click();await until(()=>h.el('global-error').textContent===reasons[code]+review);
  assert.equal(h.el('connection-feedback').textContent,reasons[code]+review);
  assert.equal(h.d.body.innerHTML.includes(hostile),false);assert.equal(h.w.receiptLeak,undefined);
  assert.equal(h.button().disabled,false,'existing catch behavior is preserved');
  h.assertCalls([{route:h.route,method:'POST',body:'{}'}]);
  await pause();h.assertCalls([{route:h.route,method:'POST',body:'{}'}]);
});

for(const code of ['CONTENT_RECEIPT_FUTURE','__proto__','constructor','toString',null]) test('unrecognized returned receipt code retains generic failure copy: '+code,async t=>{
  const h=await harness(t);
  h.execute=async()=>h.reply({executedExternally:false,write:{status:'failed',dispatchBlocked:true,errorCode:code,error:hostile,source:hostile}});
  h.button().click();await until(()=>h.el('global-error').textContent==='Check the result in Shopify. This request will not be repeated.');
  assert.equal(h.el('connection-feedback').textContent,'');assert.equal(h.d.body.innerHTML.includes(hostile),false);
  h.assertCalls(h.expectedSuccessCalls);
});

test('unknown thrown errors keep their existing sanitized behavior',async t=>{
  const h=await harness(t),safe=sanitizeError({code:'CONTENT_RECEIPT_FUTURE',status:503,message:hostile});
  h.execute=async()=>h.reply({error:safe.publicMessage,code:safe.code},safe.status);
  h.button().click();await until(()=>h.el('global-error').textContent==='Internal server error');
  assert.equal(h.el('connection-feedback').textContent,'Internal server error');h.assertCalls([{route:h.route,method:'POST',body:'{}'}]);
});

for(const observed of [false,true]) test('processing message is unchanged with observation error '+observed,async t=>{
  const h=await harness(t,{provider:'meta',status:'processing',input:{operation:'instagram_publish',pageId:'page-1',instagramId:'ig-1',caption:'Reviewed',imageUrl:'https://example.test/image.jpg'}});
  h.execute=async()=>h.reply({executedExternally:false,write:{status:'processing',observationErrorCode:observed?'OBSERVATION_UNKNOWN':null,errorCode:'CONTENT_RECEIPT_CAPACITY_EXHAUSTED'}});
  h.button().click();const expected=observed?'Instagram status could not be verified. Its saved container is retained; check again after a minute.':'Instagram is preparing the image. Check publishing progress after a minute.';
  await until(()=>h.el('global-success').textContent===expected);assert.equal(h.el('connection-feedback').textContent,'');h.assertCalls(h.expectedSuccessCalls);
});

test('confirmed completion takes precedence and retains existing success copy',async t=>{
  const h=await harness(t);
  h.execute=async()=>h.reply({executedExternally:true,write:{status:'completed',errorCode:'CONTENT_RECEIPT_COMMIT_UNCONFIRMED',dispatchBlocked:true}});
  h.button().click();await until(()=>h.el('global-success').textContent==='Shopify confirmed the change.');
  assert.equal(h.el('connection-feedback').textContent,'');assert.equal(h.button(),null);h.assertCalls(h.expectedSuccessCalls);
});

for(const options of [{role:'admin'},{role:'member'},{role:'viewer'},{status:'pending_approval'},{status:'failed'},{status:'uncertain'},{status:'completed'},{id:'invalid/id'},{input:{operation:'product_content',productId:'gid://shopify/Product/10',title:'Missing description'}}]) test('receipt feedback leaves Apply gates intact: '+JSON.stringify(options),async t=>{
  const h=await harness(t,options);assert.equal(h.button(),null);
  const forged=h.d.createElement('button');forged.dataset.connectionAction='execute';forged.dataset.provider='shopify';forged.dataset.write=h.row.id;
  h.el('connection-detail').append(forged);forged.click();await pause();h.assertCalls([]);
});
