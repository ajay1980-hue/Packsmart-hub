import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalParcel2GoJson as canonical, parcel2GoCanonicalFingerprint as hash} from '../lib/parcel2go-live-canonical.mjs';
test('object key reorder preserves evidence fingerprint, including nested jsonb', () => {
  assert.equal(hash({a:1,b:{c:2,d:[3,4]}}),hash({b:{d:[3,4],c:2},a:1}));
  assert.notEqual(hash({a:[1,2]}),hash({a:[2,1]}));
  assert.notEqual(hash({a:1}),hash({a:'1'}));
});
test('plain and null-prototype JSON produce the same encoding', () => {
  const x=Object.assign(Object.create(null),{z:1,a:null});
  assert.equal(canonical(x),'{"a":null,"z":1}');
});
test('rejects non-JSON values and ambiguous numeric values', () => {
  for(const x of [undefined,NaN,Infinity,-0,1n,()=>{},Symbol('x'),new Date(),new Map(),new Set()]) assert.throws(()=>canonical(x));
});
test('rejects cycles but allows repeated noncyclic object values', () => {
  const x={a:1}; assert.equal(canonical([x,x]),'[{"a":1},{"a":1}]'); x.self=x; assert.throws(()=>canonical(x));
});
test('rejects accessors without invoking them and non-enumerable properties', () => {
  let invoked=false; const x={}; Object.defineProperty(x,'a',{enumerable:true,get(){invoked=true;return 1;}});
  assert.throws(()=>canonical(x)); assert.equal(invoked,false);
  assert.throws(()=>canonical(Object.defineProperty({},'hidden',{value:1})));
});
test('rejects symbol keys, dangerous member, sparse and extended arrays', () => {
  assert.throws(()=>canonical({[Symbol('key')]:1}));
  assert.throws(()=>canonical(JSON.parse('{"__proto__":1}')));
  assert.throws(()=>canonical(new Array(2)));
  const x=[1]; x.extra=2; assert.throws(()=>canonical(x));
});
test('bounded size, depth and node count reject oversized input', () => {
  assert.throws(()=>canonical('x'.repeat(65536)));
  let x=null; for(let i=0;i<22;i++) x={x}; assert.throws(()=>canonical(x));
  assert.throws(()=>canonical(Array(5001).fill(1)));
});
test('preserves Unicode and escape distinctions', () => {
  assert.equal(canonical({x:'é\\\n"'}),JSON.stringify({x:'é\\\n"'}));
  assert.notEqual(hash({x:'é'}),hash({x:'e\u0301'}));
});
