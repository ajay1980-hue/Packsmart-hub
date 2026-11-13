import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createParcel2GoLiveHttpsCandidate as create} from '../lib/parcel2go-live-https-candidate.mjs';
const start=Date.parse('2026-11-11T20:00:00Z');
const bodies={token:new URLSearchParams({grant_type:'client_credentials',scope:'public-api',client_id:'fixture-client',client_secret:'fixture-secret'}).toString(),quote:JSON.stringify({CollectionAddress:{Country:'GBR',VatStatus:'NotRegistered',Postcode:'SW1A 1AA'},DeliveryAddress:{Country:'GBR',VatStatus:'Individual',Postcode:'M1 1AE'},Parcels:[{Weight:5,Length:45,Width:30,Height:25,Value:15.15}]})};
const hashes=Object.fromEntries(Object.entries(bodies).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')]));
function setup(t,opts={},response={}){const calls=[];t.mock.method(https,'request',(url,options,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{calls.push({url:String(url),options,body});queueMicrotask(()=>{const res=new PassThrough();res.headers={'content-type':'application/json'};res.statusCode=response.status||200;res.complete=true;callback(res);if(!res.destroyed)res.end('{}');});};return req;});const h=create({mode:'approved-https-candidate/v1',expiresAt:new Date(start+1000).toISOString(),approvedBodyHashes:hashes,assertAuthorized:()=>true,now:()=>start,monotonic:()=>1,...opts});return {h,calls};}
const args=operation=>({operation,body:bodies[operation],timeoutMs:100,...(operation==='quote'?{token:'fixture-token'}:{})});
test('default disabled never reaches https or inspects request',async t=>{t.mock.method(https,'request',()=>assert.fail('network'));await assert.rejects(create().send({get operation(){assert.fail('inspected');}}));});
test('synthetic issuer and quote use fixed destinations with strict TLS and no agent',async t=>{const {h,calls}=setup(t);await h.send(args('token'));await h.send(args('quote'));await assert.rejects(h.send(args('quote')));assert.equal(calls.length,2);assert.deepEqual(calls.map(c=>c.url),['https://www.parcel2go.com/auth/connect/token','https://www.parcel2go.com/api/quotes']);for(const c of calls){assert.equal(c.options.rejectUnauthorized,true);assert.equal(c.options.minVersion,'TLSv1.2');assert.equal(c.options.agent,false);}});
for(const value of [false,undefined,Promise.resolve(true)])test('non-true or pending admission refuses request '+String(value),async t=>{const {h,calls}=setup(t,{assertAuthorized:()=>value});await assert.rejects(h.send(args('token')));assert.equal(calls.length,0);});
test('altered approved body fails closed without network',async t=>{const {h,calls}=setup(t);await assert.rejects(h.send({...args('token'),body:bodies.token+'x'}));await assert.rejects(h.send(args('token')));assert.equal(calls.length,0);});
test('revocation between issuer and quote prevents quote',async t=>{let allowed=true;const {h,calls}=setup(t,{assertAuthorized:()=>allowed});await h.send(args('token'));allowed=false;await assert.rejects(h.send(args('quote')));assert.equal(calls.length,1);});
test('revocation on response refuses response and next request',async t=>{let checks=0;const {h,calls}=setup(t,{assertAuthorized:()=>++checks===1});await assert.rejects(h.send(args('token')));await assert.rejects(h.send(args('quote')));assert.equal(calls.length,1);});
for(const clock of ['wall','monotonic','rollback'])test('expiry/rollback '+clock,async t=>{let wall=start,mono=1;const {h,calls}=setup(t,{now:()=>wall,monotonic:()=>mono});if(clock==='wall')wall+=1000;if(clock==='monotonic')mono+=1000;if(clock==='rollback')wall--;await assert.rejects(h.send(args('token')));assert.equal(calls.length,0);});
test('redirect is not followed or retried',async t=>{const {h,calls}=setup(t,{}, {status:302});await assert.rejects(h.send(args('token')));await assert.rejects(h.send(args('token')));assert.equal(calls.length,1);});
test('explicit close prohibits sends',async t=>{const {h,calls}=setup(t);h.close();await assert.rejects(h.send(args('token')));assert.equal(calls.length,0);});
for(const mutation of ['wall-expiry','monotonic-expiry','close','wall-rollback','monotonic-rollback'])test('post-response admission '+mutation+' discards and zeroes response',async t=>{
 let wall=start,mono=1,checks=0,responseBytes;
 const concat=Buffer.concat;
 t.mock.method(Buffer,'concat',function(...args){const result=concat.apply(Buffer,args);if(result.toString()==='{}')responseBytes=result;return result;});
 const {h,calls}=setup(t,{now:()=>wall,monotonic:()=>mono,assertAuthorized:()=>{
  if(++checks===2){
   if(mutation==='wall-expiry')wall+=1000;
   if(mutation==='monotonic-expiry')mono+=1000;
   if(mutation==='close')h.close();
   if(mutation==='wall-rollback')wall--;
   if(mutation==='monotonic-rollback')mono--;
  }
  return true;
 }});
 await assert.rejects(h.send(args('token')));
 assert.ok(responseBytes);assert.deepEqual([...responseBytes],[0,0]);
 await assert.rejects(h.send(args('quote')));assert.equal(calls.length,1);
});
for(const phase of ['before-request','after-response'])test('rejected async admission '+phase+' fails closed without unhandled rejection',async t=>{
 let checks=0;
 const {h,calls}=setup(t,{assertAuthorized:()=>{
  checks++;
  if(phase==='before-request'||checks===2)return Promise.reject(new Error('synthetic async admission failure'));
  return true;
 }});
 await assert.rejects(h.send(args('token')));
 // node:test fails this case on an unhandled rejection, including after send.
 await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(h.send(args('quote')));
 assert.equal(calls.length,phase==='before-request'?0:1);
});
