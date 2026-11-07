import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerProductReadinessWindow as create,OWNER_PRODUCT_READINESS_EXPIRY as EXPIRY} from '../lib/owner-product-readiness-window.mjs';
import {OWNER_PRODUCT_READINESS_FLAG as FLAG} from '../lib/owner-product-readiness.mjs';

function fixture(duration=300000) {
  const clock={wall:Date.parse('2026-11-05T12:00:00.000Z'),mono:1000},timers=[];
  const env={[FLAG]:'enabled/v1',[EXPIRY]:new Date(clock.wall+duration).toISOString()};
  const deps={wallNow:()=>clock.wall,monotonicNow:()=>clock.mono,
    setTimer:(fn,ms)=>{const timer={fn,ms,cleared:false};timers.push(timer);return timer;},
    clearTimer:timer=>{timer.cleared=true;}};
  return {clock,timers,env,deps,policy:create(env,deps)};
}
test('default OFF ignores any stale expiry and creates no capability',()=>{
  for(const value of [undefined,'disabled/v1'])assert.equal(create({[FLAG]:value,[EXPIRY]:'malformed'}),null);
});
for(const value of [undefined,null,'',true,{},'2026-11-05','2026-11-05T12:01:00Z','2026-11-05T12:01:00.000+00:00','2026-02-30T12:01:00.000Z']) {
  test(`missing or malformed expiry fails closed: ${JSON.stringify(value)}`,()=>{
    const f=fixture();assert.throws(()=>create({...f.env,[EXPIRY]:value},f.deps),{code:'QUIET_OWNER_PRODUCT_READINESS_INVALID'});
  });
}
test('maximum five minutes is inclusive; a longer window is rejected',()=>{
  assert.equal(fixture().policy.available(),true);
  assert.throws(()=>fixture(300001),{code:'QUIET_OWNER_PRODUCT_READINESS_INVALID'});
});
for(const delta of [0,-1,-86400000])test(`already expired configuration remains safely closed: ${delta}`,()=>{
  const f=fixture(delta);assert.equal(f.policy.available(),false);assert.throws(()=>f.policy.beginRead(),{code:'PRODUCT_READINESS_UNAVAILABLE'});
});
test('absolute deadline is preserved on restart; it is never a fresh five-minute grant',()=>{
  const f=fixture();f.clock.wall+=299999;f.clock.mono+=299999;
  const restarted=create(f.env,f.deps);assert.equal(restarted.available(),true);
  f.clock.wall++;f.clock.mono++;assert.equal(restarted.available(),false);
  assert.equal(create(f.env,f.deps).available(),false);
});
for(const kind of ['wall','mono'])test(`observed backward ${kind} clock latches closed`,()=>{
  const f=fixture();f.clock[kind]--;assert.equal(f.policy.available(),false);
  f.clock[kind]+=100;assert.equal(f.policy.available(),false);
});
test('expiry cannot reopen after a backward wall-clock adjustment',()=>{
  const f=fixture();f.clock.wall+=300000;assert.equal(f.policy.available(),false);
  f.clock.wall-=300000;assert.equal(f.policy.available(),false);
});
test('monotonic expiry closes a stalled wall clock',()=>{
  const f=fixture();f.clock.mono+=300000;assert.equal(f.policy.available(),false);
});
for(const kind of ['wall','mono'])test(`invalid ${kind} clock fails closed`,()=>{
  const f=fixture();f.clock[kind]=NaN;assert.equal(f.policy.available(),false);
});
test('environment mutation cannot extend the captured deadline',()=>{
  const f=fixture();f.env[EXPIRY]=new Date(f.clock.wall+600000).toISOString();f.clock.wall+=300000;
  assert.equal(f.policy.available(),false);
});
test('client budget is an integer no greater than either server clock remainder',()=>{
  const f=fixture();assert.equal(f.policy.remainingMs(),300000);
  f.clock.wall+=1000;assert.equal(f.policy.remainingMs(),299000);
  f.clock.mono+=2000.25;assert.equal(f.policy.remainingMs(),297999);
});
test('client budget is zero after expiry and cannot reopen after rollback',()=>{
  const f=fixture();f.clock.mono+=300000;assert.equal(f.policy.remainingMs(),0);
  f.clock.mono-=300000;f.clock.wall-=60000;assert.equal(f.policy.remainingMs(),0);
});
test('already-expired configuration exposes zero client budget',()=>{
  assert.equal(fixture(-1).policy.remainingMs(),0);
});
test('one 30-second budget covers all three reads and propagates the same abort signal',async()=>{
  const f=fixture(),read=f.policy.beginRead(),signals=[];assert.equal(f.timers[0].ms,30000);
  for(let i=0;i<2;i++)await read.run(signal=>{signals.push(signal);f.clock.mono+=10000;return i;});
  await assert.rejects(read.run(signal=>{signals.push(signal);f.clock.mono+=10000;return 'too late';}),{code:'PRODUCT_READINESS_UNAVAILABLE'});
  assert.equal(signals.length,3);assert.ok(signals.every(s=>s===read.signal));assert.equal(read.signal.aborted,true);
  assert.equal(f.policy.available(),true,'a read timeout does not renew or consume the overall absolute deadline');read.dispose();assert.equal(f.timers[0].cleared,true);
});
test('read deadline is the smaller remaining window, not thirty seconds per fetch',async()=>{
  const f=fixture(4000),read=f.policy.beginRead();assert.equal(f.timers[0].ms,4000);
  f.clock.mono+=4000;await assert.rejects(read.run(()=>assert.fail('must not start')),{code:'PRODUCT_READINESS_UNAVAILABLE'});read.dispose();
});
test('timer abort rejects a stalled transport even if that transport ignores cancellation',async()=>{
  const f=fixture(),read=f.policy.beginRead();let release;
  const pending=read.run(()=>new Promise(resolve=>release=resolve));await Promise.resolve();
  f.timers[0].fn();await assert.rejects(pending,{code:'PRODUCT_READINESS_UNAVAILABLE'});
  assert.equal(read.signal.aborted,true);release('late result');read.dispose();
});
test('client cancellation and disposal never allow a later read',async()=>{
  const f=fixture(),read=f.policy.beginRead();read.cancel();
  await assert.rejects(read.run(()=>assert.fail('must not run')),{code:'PRODUCT_READINESS_UNAVAILABLE'});
  read.dispose();assert.equal(f.timers[0].cleared,true);
  const second=f.policy.beginRead();second.dispose();assert.throws(second.assertActive,{code:'PRODUCT_READINESS_UNAVAILABLE'});
});
test('permit expiry after a read awaits suppresses the returned data',async()=>{
  const f=fixture(),read=f.policy.beginRead();
  await assert.rejects(read.run(()=>{f.clock.wall+=300000;return {private:'must not escape'};}),{code:'PRODUCT_READINESS_UNAVAILABLE'});read.dispose();
});
test('real elapsed-time deadline cancels a stalled read without shutdown or log polling',async()=>{
  const now=Date.now(),policy=create({[FLAG]:'enabled/v1',[EXPIRY]:new Date(now+100).toISOString()}, {
    setTimer:(fn,ms)=>({timer:setTimeout(fn,ms)}),clearTimer:handle=>clearTimeout(handle.timer)
  });
  const read=policy.beginRead();
  try {await assert.rejects(read.run(()=>new Promise(()=>{})),{code:'PRODUCT_READINESS_UNAVAILABLE'});assert.equal(read.signal.aborted,true);}
  finally{read.dispose();}
});
