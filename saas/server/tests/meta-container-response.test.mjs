import test from 'node:test';
import assert from 'node:assert/strict';
import {boundedMetaContainerResponse,parseMetaContainerResponse} from '../lib/meta-container-response.mjs';
test('a response arriving after deadline is cancelled without opening its reader',async()=>{
 let settle,readers=0,cancelled=0;
 const pending=boundedMetaContainerResponse(()=>new Promise(resolve=>{settle=resolve;}),'123',5);
 await assert.rejects(pending,{code:'META_CONTAINER_OBSERVER_TIMEOUT'});
 settle({status:200,headers:new Headers({'Content-Type':'application/json'}),body:{getReader(){readers++;throw Error('late read');},cancel(){cancelled++;return Promise.resolve();}}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(readers,0);assert.equal(cancelled,1);
});
test('empty chunks cannot consume an unbounded microtask stream or starve the deadline',async()=>{
 let reads=0,cancelled=0;const body={getReader:()=>({read:async()=>{reads++;return {done:false,value:new Uint8Array(0)};},cancel:async()=>{cancelled++;}})};
 await assert.rejects(boundedMetaContainerResponse(async()=>({status:200,headers:new Headers({'Content-Type':'application/json'}),body}),'123',100),{code:'META_CONTAINER_OBSERVER_RESPONSE_INVALID'});
 assert.equal(reads,1);assert.equal(cancelled,1);
});
test('elapsed monotonic deadline is checked even when reads never yield to a timer',async()=>{
 let reads=0;const body={getReader:()=>({read:async()=>{reads++;const until=performance.now()+3;while(performance.now()<until){}return {done:false,value:new Uint8Array([32])};},cancel:async()=>{}})};
 await assert.rejects(boundedMetaContainerResponse(async()=>({status:200,headers:new Headers({'Content-Type':'application/json'}),body}),'123',5),{code:'META_CONTAINER_OBSERVER_TIMEOUT'});assert.ok(reads<=2);
});
test('declared oversized response is cancelled before body consumption',async()=>{
 let cancelled=0;await assert.rejects(boundedMetaContainerResponse(async()=>({status:200,headers:new Headers({'Content-Type':'application/json','Content-Length':'999999'}),body:{cancel:async()=>{cancelled++;},getReader(){throw Error('must not read');}}}),'123'),{code:'META_CONTAINER_OBSERVER_RESPONSE_LIMIT'});assert.equal(cancelled,1);
});
test('contradictory keys with the actual matching container ID cannot be collapsed by JSON.parse',()=>{
 assert.throws(()=>parseMetaContainerResponse('{"id":"123","status_code":"ERROR","status_code":"PUBLISHED"}','123'));
 assert.throws(()=>parseMetaContainerResponse('{"id":"123","id":"123","status_code":"PUBLISHED"}','123'));
 assert.throws(()=>parseMetaContainerResponse('\v{"id":"123","status_code":"PUBLISHED"}','123'));
 assert.throws(()=>parseMetaContainerResponse('{"id":"123",\u00a0"status_code":"PUBLISHED"}','123'));
});
