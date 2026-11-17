import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parcel2GoWorkspaceFingerprint as fingerprint,PARCEL2GO_WORKSPACE_LIMITS as limits} from '../lib/parcel2go-workspace-fingerprint.mjs';
import {parcel2GoCanonicalHash as operationHash,parcel2GoCanonicalJson as operationJson} from '../lib/parcel2go-live-canonical.mjs';
import {metaStrictJson} from '../lib/meta-publication-bounded.mjs';

test('streaming workspace digest covers strict sorted JSON with its own domain',()=>{
 const value={z:[3,'é\\\n"',false],a:{b:1,c:null}},reordered={a:{c:null,b:1},z:[3,'é\\\n"',false]};
 const expected=createHash('sha256').update('parcel2go-workspace-persistence/v1\0').update(operationJson(value)).digest('hex');
 assert.equal(fingerprint(value),expected);assert.equal(fingerprint(reordered),expected);assert.notEqual(fingerprint(value),operationHash(value));
 assert.equal(fingerprint(Object.assign(Object.create(null),value)),expected);
});
for(const kind of ['nested','array-order','type','revision','tenant'])test('workspace digest changes for '+kind,()=>{
 const before={workspace:{id:'synthetic'},_revision:'synthetic-revision',items:[1,2],nested:{value:1}},after=structuredClone(before);
 if(kind==='nested')after.nested.value=2;if(kind==='array-order')after.items.reverse();if(kind==='type')after.nested.value='1';if(kind==='revision')after._revision+='-changed';if(kind==='tenant')after.workspace.id+='-changed';
 assert.notEqual(fingerprint(before),fingerprint(after));
});
test('byte bound counts encoded Unicode, escapes, keys and JSON punctuation',()=>{
 const exact={x:'x'.repeat(limits.bytes-24)};assert.equal(Buffer.byteLength(JSON.stringify(exact))+16,limits.bytes);assert.match(fingerprint(exact),/^[a-f0-9]{64}$/);
 assert.throws(()=>fingerprint({x:exact.x+'x'}));
 for(const char of ['é','\n','"']){const size=Buffer.byteLength(JSON.stringify(char))-2,count=Math.floor((limits.bytes-24)/size),value={x:char.repeat(count)};assert.ok(Buffer.byteLength(JSON.stringify(value))+16<=limits.bytes);fingerprint(value);assert.throws(()=>fingerprint({x:value.x+char}));}
 assert.throws(()=>fingerprint({['x'.repeat(limits.bytes)]:0}));
});
test('JSONB decimal expansion cannot evade the exact-reader byte budget',()=>{
 for(const value of [1e308,-1e308,5e-324]){fingerprint({values:Array(100).fill(value)});assert.throws(()=>fingerprint({values:Array(7200).fill(value)}));}
});
test('node bound accounts for exact-store response envelope',()=>{
 const exact={items:Array(limits.nodes-2).fill(0)};fingerprint(exact);assert.deepEqual(metaStrictJson(Buffer.from(JSON.stringify([{state:exact}]))),[{state:exact}]);
 exact.items.push(0);assert.throws(()=>fingerprint(exact));assert.throws(()=>metaStrictJson(Buffer.from(JSON.stringify([{state:exact}]))));
});
test('depth bound accounts for exact-store response envelope',()=>{
 let exact=null;for(let i=0;i<limits.depth;i++)exact={x:exact};fingerprint(exact);metaStrictJson(Buffer.from(JSON.stringify([{state:exact}])));
 exact={x:exact};assert.throws(()=>fingerprint(exact));assert.throws(()=>metaStrictJson(Buffer.from(JSON.stringify([{state:exact}]))));
});
test('operation canonical byte, node and depth limits remain unchanged',()=>{
 for(const value of [{x:'x'.repeat(70000)},{x:Array(6000).fill(0)}]){assert.throws(()=>operationHash(value));fingerprint(value);}
 let value=null;for(let i=0;i<22;i++)value={x:value};assert.throws(()=>operationHash(value));fingerprint(value);
});
test('non-JSON and lossy values fail closed',()=>{
 for(const value of [undefined,NaN,Infinity,-Infinity,-0,1n,()=>{},Symbol('x'),new Date(),new Map(),new Set(),/x/,new Uint8Array(1)])assert.throws(()=>fingerprint({x:value}));
 for(const value of ['\0','\ud800','\udfff']){assert.throws(()=>fingerprint({x:value}));assert.throws(()=>fingerprint({[value]:1}));}
 assert.throws(()=>fingerprint(JSON.parse('{"__proto__":1}')));
});
test('getters, toJSON and Proxy traps never execute',()=>{
 let calls=0;const getter={};Object.defineProperty(getter,'x',{enumerable:true,get(){calls++;return 1;}});
 const proxy=new Proxy({},{get(){calls++;return 1;},getPrototypeOf(){calls++;return Object.prototype;},ownKeys(){calls++;return [];}});
 for(const value of [getter,proxy,{x:proxy},{toJSON(){calls++;return {};}}])assert.throws(()=>fingerprint(value));
 assert.equal(calls,0);
});
test('hidden properties, symbols and sparse/extended arrays cannot escape the digest',()=>{
 assert.throws(()=>fingerprint(Object.defineProperty({},'hidden',{value:1})));assert.throws(()=>fingerprint({[Symbol('private')]:1}));
 for(const value of [new Array(2),Object.assign([1],{extra:2}),Object.defineProperty([1],'hidden',{value:2})])assert.throws(()=>fingerprint({x:value}));
 const huge=new Array(2**32-1);assert.throws(()=>fingerprint({huge}));
});
test('cycles reject while repeated noncyclic JSON is represented each time',()=>{
 const shared={a:1};assert.equal(fingerprint({items:[shared,shared]}),fingerprint({items:[{a:1},{a:1}]}));shared.self=shared;assert.throws(()=>fingerprint(shared));
});
