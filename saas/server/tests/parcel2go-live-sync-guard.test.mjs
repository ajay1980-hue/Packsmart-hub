import test from 'node:test';
import assert from 'node:assert/strict';
import {assertParcel2GoSynchronousCurrent as current} from '../lib/parcel2go-live-sync-guard.mjs';
test('synchronous void assertion is accepted once',()=>{let calls=0;current(()=>{calls++;});assert.equal(calls,1);});
test('throwing assertion remains rejected',()=>{const error=new Error('revoked');assert.throws(()=>current(()=>{throw error;}),x=>x===error);});
test('value-returning callback never means approval',()=>{for(const x of [true,false,0,1,'ok',null,{}])assert.throws(()=>current(()=>x));});
test('async assertions and rejecting promises are rejected, not awaited',async()=>{
 assert.throws(()=>current(async()=>{}));
 assert.throws(()=>current(()=>Promise.reject(new Error('revoked'))));
 await new Promise(r=>setImmediate(r));
});
test('pending thenable cannot allow work',async()=>{let called=0;assert.throws(()=>current(()=>({then(){called++;}})));await new Promise(r=>setImmediate(r));assert.equal(called,1);});
test('invalid callback types fail closed',()=>{for(const x of [null,undefined,true,{},''])assert.throws(()=>current(x));});
