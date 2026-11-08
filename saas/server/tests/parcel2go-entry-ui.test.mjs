import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
// Independent review's deterministic clock/DOM reproduction, converted to regressions.
class Node {constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.value='';this.checked=false;this.disabled=false;this.type='';this.textContent='';this.classList={add(){},remove(){}};}
 append(...n){this.children.push(...n);}prepend(...n){this.children.unshift(...n);}replaceChildren(...n){this.children=[...n];}setAttribute(k,v){this[k]=v;}addEventListener(k,f){this.listeners[k]=f;}
 querySelectorAll(s){return this.children.flatMap(x=>[...(s==='input'&&x.tagName==='input'?[x]:[]),...x.querySelectorAll(s)]);}
 querySelector(s){for(const x of this.children){if(s==='#'+x.id)return x;const y=x.querySelector(s);if(y)return y;}return null;}}
function fixture(){let now=0,seq=0,controller,response;const timers=new Map(),storage=new Map();
 const context={session:{ownerWorkspace:true,user:{role:'owner'},workspace:{id:'packsmart-solutions'}},closed:false,view:'channels'};
 const initial={schema:'runvara-parcel2go-credential-entry/v1',requestId:'11111111-1111-4111-8111-111111111111',expectedRevision:'22222222-2222-4222-8222-222222222222',accountId:'synthetic-account',connectionId:'synthetic-connection',environment:'sandbox',expiresAt:'2026-11-08T19:00:00.000Z',remainingMs:1000,canSubmit:true,outcome:'not_started',providerCalls:false,scope:'public-api'};
 const env={window:{confirm:()=>true},document:{createElement:tag=>new Node(tag)},performance:{now:()=>now},sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},AbortController,Date,
  setTimeout:(fn,ms)=>{const id=++seq;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(readFileSync(new URL('../../parcel2go-entry-ui.js',import.meta.url),'utf8'),env);
 controller=env.window.RunvaraParcel2GoEntry.create({getContext:()=>context,request:async()=>{controller.observe(response,now);return response;}});
 const root=new Node('article');controller.observe(initial,0);controller.mount(root,initial);
 return{controller,root,initial,context,timers,setNow:t=>{now=t;},advance(t){now=t;for(const[id,x]of [...timers])if(x.at<=now){timers.delete(id);x.fn();}},async status(dto){response=dto;await root.querySelector('#p2g-status').listeners.click();},type(){root.querySelector('#p2g-client-id').value='synthetic-client';root.querySelector('#p2g-client-secret').value='synthetic-secret';},secret:()=>root.querySelector('#p2g-client-secret')};
}
test('shortened server deadline immediately reschedules physical field clearing and disable',async()=>{
 const f=fixture();f.setNow(100);await f.status({...f.initial,remainingMs:200});f.setNow(250);f.type();f.advance(350);
 assert.equal(f.controller.allowsControl('p2g-client-secret'),false);assert.equal(f.secret().disabled,true);assert.equal(f.secret().value,'');
 assert.ok(![...f.timers.values()].some(t=>t.at===1000));
});
test('later status cannot extend previously shortened deadline',async()=>{
 const f=fixture();f.setNow(100);await f.status({...f.initial,remainingMs:200});f.setNow(150);await f.status({...f.initial,remainingMs:900});f.setNow(250);f.type();f.advance(301);
 assert.equal(f.secret().disabled,true);assert.equal(f.secret().value,'');assert.equal(f.controller.allowsControl('p2g-save'),false);
});
test('zero remaining status clears typed fields immediately',()=>{
 const f=fixture();f.type();f.controller.observe({...f.initial,remainingMs:0},0);assert.equal(f.secret().value,'');assert.equal(f.secret().disabled,true);
});
test('navigation clears timer and late observation cannot recreate private fields',()=>{
 const f=fixture();f.type();f.controller.clear();f.controller.observe({...f.initial,remainingMs:100},0);f.advance(500);assert.equal(f.root.children.length,0);assert.equal(f.timers.size,0);
});
test('another request identifier cannot alter current timer',()=>{
 const f=fixture();f.type();f.controller.observe({...f.initial,requestId:'33333333-3333-4333-8333-333333333333',remainingMs:0},0);f.advance(100);assert.equal(f.secret().disabled,false);assert.equal(f.secret().value,'synthetic-secret');f.advance(1001);assert.equal(f.secret().value,'');
});
