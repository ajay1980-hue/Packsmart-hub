import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStore,seedWorkspaceState} from '../lib/store.mjs';
import {containerObserverFixture} from './meta-container-observer-fixture.mjs';

async function fixture(t){
 const parent=path.resolve(os.tmpdir()),prefix='runvara-rename-regression-',directory=await fs.mkdtemp(path.join(parent,prefix));
 t.after(async()=>{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith(prefix));await fs.rm(resolved,{recursive:true,force:true});});
 const file=path.join(directory,'state.json'),store=createStore({SAAS_STATE_FILE:file});
 for(const id of ['alpha','beta'])await store.save(id,seedWorkspaceState({},{workspaceId:id,email:id+'@example.test',passwordHash:'synthetic'}));
 const before=await fs.readFile(file,'utf8'),state=await store.get('alpha');state.workspace.name='Replacement regression';
 return {directory,file,store,before,state};
}

test('transient Windows replacement denial retries the same bytes while retaining the lock and other tenant',async t=>{
 const f=await fixture(t),original=fs.rename,error=Object.assign(new Error('synthetic replacement denial'),{code:'EPERM'});let attempts=0;const sources=[],pending=[];
 fs.rename=async function(from,to,...args){if(to===f.file){attempts++;sources.push(from);pending.push(await fs.readFile(from,'utf8'));assert.ok(await fs.stat(f.file+'.transaction-lock'));if(attempts<=2){assert.equal(await fs.readFile(f.file,'utf8'),f.before);throw error;}}return original.call(this,from,to,...args);};
 try{if(process.platform==='win32')await f.store.save('alpha',f.state);else await assert.rejects(f.store.save('alpha',f.state),value=>value===error);}finally{fs.rename=original;}
 assert.equal(new Set(sources).size,1);assert.equal(new Set(pending).size,1);assert.equal(attempts,process.platform==='win32'?3:1);
 if(process.platform==='win32'){assert.equal((await f.store.get('alpha')).workspace.name,'Replacement regression');assert.equal(f.state._revision,JSON.parse(pending[0]).alpha._revision);assert.deepEqual(JSON.parse(await fs.readFile(f.file,'utf8')).beta,JSON.parse(f.before).beta);}
 await assert.rejects(fs.stat(f.file+'.transaction-lock'),{code:'ENOENT'});
});

test('permanent replacement denial remains bounded and retains the prior state',async t=>{
 const f=await fixture(t),original=fs.rename,error=Object.assign(new Error('synthetic permanent replacement denial'),{code:'EPERM'});let attempts=0;
 fs.rename=async function(from,to,...args){if(to===f.file){attempts++;throw error;}return original.call(this,from,to,...args);};
 try{await assert.rejects(f.store.save('alpha',f.state),value=>value===error);}finally{fs.rename=original;}
 assert.equal(attempts,process.platform==='win32'?50:1);assert.equal(await fs.readFile(f.file,'utf8'),f.before);
 await assert.rejects(fs.stat(f.file+'.transaction-lock'),{code:'ENOENT'});
});

test('non-EPERM replacement errors fail immediately without changing state',async t=>{
 const f=await fixture(t),original=fs.rename,error=Object.assign(new Error('synthetic replacement access failure'),{code:'EACCES'});let attempts=0;
 fs.rename=async function(from,to,...args){if(to===f.file){attempts++;throw error;}return original.call(this,from,to,...args);};
 try{await assert.rejects(f.store.save('alpha',f.state),value=>value===error);}finally{fs.rename=original;}
 assert.equal(attempts,1);assert.equal(await fs.readFile(f.file,'utf8'),f.before);
});

test('a commit guard revoked during replacement backoff stops the retry and preserves the prior state',async t=>{
 const f=await fixture(t),original=fs.rename,error=Object.assign(new Error('synthetic replacement denial'),{code:'EPERM'});let attempts=0,revoked=false;
 fs.rename=async function(from,to,...args){if(to===f.file){attempts++;if(attempts===1){revoked=true;throw error;}}return original.call(this,from,to,...args);};
 try{await assert.rejects(f.store.save('alpha',f.state,{beforeCommit:()=>{if(revoked)throw Object.assign(new Error('synthetic authority changed'),{code:'TEST_AUTHORITY_CHANGED'});}}),{code:process.platform==='win32'?'TEST_AUTHORITY_CHANGED':'EPERM'});}finally{fs.rename=original;}
 assert.equal(attempts,1);assert.equal(await fs.readFile(f.file,'utf8'),f.before);
});

test('a lost replacement acknowledgement stays uncertain and cannot overwrite the committed revision',async t=>{
 const f=await fixture(t),original=fs.rename,error=Object.assign(new Error('synthetic lost replacement ACK'),{code:'EPERM'});let attempts=0;
 fs.rename=async function(from,to,...args){if(to===f.file){attempts++;const result=await original.call(this,from,to,...args);if(attempts===1)throw error;return result;}return original.call(this,from,to,...args);};
 try{await assert.rejects(f.store.save('alpha',f.state),{code:process.platform==='win32'?'ENOENT':'EPERM'});}finally{fs.rename=original;}
 assert.equal(attempts,process.platform==='win32'?2:1);assert.equal((await f.store.get('alpha')).workspace.name,'Replacement regression');
 await assert.rejects(f.store.save('alpha',f.state),{code:'STATE_CONFLICT'});
});

test('observer reservation replacement retry still permits only one mocked transport attempt',async t=>{
 const f=await containerObserverFixture(t),input=await f.input(),original=fs.rename,error=Object.assign(new Error('synthetic reservation replacement denial'),{code:'EPERM'});let denied=false;
 fs.rename=async function(from,to,...args){if(to===f.store.filePath&&!denied){denied=true;throw error;}return original.call(this,from,to,...args);};
 try{if(process.platform==='win32')await f.run(input);else await assert.rejects(f.run(input),{code:'META_CONTAINER_OBSERVER_ADMISSION_UNKNOWN'});}finally{fs.rename=original;}
 assert.equal(denied,true);assert.equal(f.calls.length,process.platform==='win32'?1:0);
 if(process.platform==='win32'){await f.run(input);assert.equal(f.calls.length,1);assert.equal((await f.get()).integrationStatus.meta.containerObserver.attempts.length,1);}
});

test('caller mutation during replacement backoff cannot diverge returned state from the pending bytes',async t=>{
 const f=await fixture(t),original=fs.rename,error=Object.assign(new Error('synthetic replacement denial'),{code:'EPERM'});let attempts=0;
 fs.rename=async function(from,to,...args){if(to===f.file){attempts++;if(attempts===1){f.state.products.push({id:'late-product',title:'Changed during backoff'});throw error;}}return original.call(this,from,to,...args);};
 try{await assert.rejects(f.store.save('alpha',f.state),{code:process.platform==='win32'?'STATE_CONFLICT':'EPERM'});}finally{fs.rename=original;}
 assert.equal(attempts,1);assert.equal(await fs.readFile(f.file,'utf8'),f.before);
});

test('retry guard mutation cannot approve data different from the pending bytes',async t=>{
 const f=await fixture(t),original=fs.rename,error=Object.assign(new Error('synthetic replacement denial'),{code:'EPERM'});let attempts=0,backoff=false;
 fs.rename=async function(from,to,...args){if(to===f.file){attempts++;if(attempts===1){backoff=true;throw error;}}return original.call(this,from,to,...args);};
 try{await assert.rejects(f.store.save('alpha',f.state,{beforeCommit:snapshot=>{if(backoff)snapshot.products.push({id:'guard-product',title:'Changed by retry guard'});}}),{code:process.platform==='win32'?'STATE_CONFLICT':'EPERM'});}finally{fs.rename=original;}
 assert.equal(attempts,1);assert.equal(await fs.readFile(f.file,'utf8'),f.before);
});
