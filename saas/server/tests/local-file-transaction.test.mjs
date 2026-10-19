import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {localFileTransaction} from '../lib/local-file-transaction.mjs';

async function fixture(t) {
  const parent=path.resolve(os.tmpdir()),prefix='runvara-lock-regression-';
  const directory=await fs.mkdtemp(path.join(parent,prefix));
  t.after(async()=>{
    const resolved=path.resolve(directory);
    assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith(prefix));
    await fs.rm(resolved,{recursive:true,force:true});
  });
  const file=path.join(directory,'state.json');
  return {file,lock:file+'.transaction-lock'};
}

test('Windows transient EPERM retries exclusive acquisition before entering the callback',async t=>{
  const f=await fixture(t),original=fs.open,error=Object.assign(new Error('synthetic denial'),{code:'EPERM'});
  let attempts=0,entered=0;
  fs.open=async function(file,...args){
    if(file===f.lock){assert.equal(args[0],'wx');if(++attempts<=2)throw error;}
    return original.call(this,file,...args);
  };
  try {
    const operation=localFileTransaction(f.file,async()=>{
      entered++;assert.equal(attempts,3);assert.ok(await fs.stat(f.lock));return 'acquired';
    });
    if(process.platform==='win32')assert.equal(await operation,'acquired');
    else await assert.rejects(operation,value=>value===error);
  } finally {fs.open=original;}
  assert.equal(entered,process.platform==='win32'?1:0);
  await assert.rejects(fs.stat(f.lock),{code:'ENOENT'});
});

test('permanent EPERM remains bounded, preserves the error and never enters the callback',async t=>{
  const f=await fixture(t),original=fs.open,error=Object.assign(new Error('synthetic permanent denial'),{code:'EPERM'});
  let attempts=0,entered=0;
  fs.open=async function(file,...args){if(file===f.lock){attempts++;throw error;}return original.call(this,file,...args);};
  try {await assert.rejects(localFileTransaction(f.file,()=>entered++),value=>value===error);}
  finally {fs.open=original;}
  assert.equal(attempts,process.platform==='win32'?200:1);assert.equal(entered,0);
  await assert.rejects(fs.stat(f.lock),{code:'ENOENT'});
});

test('other acquisition errors are immediate and never enter the callback',async t=>{
  const f=await fixture(t),original=fs.open,error=Object.assign(new Error('synthetic access denial'),{code:'EACCES'});
  let attempts=0,entered=0;
  fs.open=async function(file,...args){if(file===f.lock){attempts++;throw error;}return original.call(this,file,...args);};
  try {await assert.rejects(localFileTransaction(f.file,()=>entered++),value=>value===error);}
  finally {fs.open=original;}
  assert.equal(attempts,1);assert.equal(entered,0);
});

test('an existing lock is never removed or stolen after bounded contention',async t=>{
  const f=await fixture(t);await fs.writeFile(f.lock,'retained owner',{flag:'wx'});let entered=0;
  await assert.rejects(localFileTransaction(f.file,()=>entered++),{code:'LOCAL_STATE_LOCKED'});
  assert.equal(entered,0);assert.equal(await fs.readFile(f.lock,'utf8'),'retained owner');
});

test('EPERM followed by an existing lock cannot enter until the holder releases it',async t=>{
  const f=await fixture(t),original=fs.open,error=Object.assign(new Error('synthetic contention'),{code:'EPERM'});
  await fs.writeFile(f.lock,'current holder',{flag:'wx'});let attempts=0,entered=0,contended;
  const seenContention=new Promise(resolve=>contended=resolve);
  fs.open=async function(file,...args){
    if(file===f.lock){
      attempts++;if(attempts===1&&process.platform==='win32')throw error;
      try{return await original.call(this,file,...args);}catch(failure){if(failure.code==='EEXIST')contended();throw failure;}
    }
    return original.call(this,file,...args);
  };
  const waiting=localFileTransaction(f.file,()=>{entered++;return 'acquired';});
  // Propagate an early failure instead of leaving an unbounded signal wait.
  const failed=waiting.then(()=>{throw Error('Entered before owner release');},failure=>{throw failure;});
  try {
    await Promise.race([seenContention,failed]);
    assert.equal(entered,0);assert.equal(await fs.readFile(f.lock,'utf8'),'current holder');
    await fs.unlink(f.lock);assert.equal(await waiting,'acquired');assert.equal(entered,1);
  } finally {fs.open=original;}
  await assert.rejects(fs.stat(f.lock),{code:'ENOENT'});
});

test('callback EPERM is never replayed and the acquired lock is released',async t=>{
  const f=await fixture(t),error=Object.assign(new Error('synthetic callback denial'),{code:'EPERM'});let entered=0;
  await assert.rejects(localFileTransaction(f.file,()=>{entered++;throw error;}),value=>value===error);
  assert.equal(entered,1);await assert.rejects(fs.stat(f.lock),{code:'ENOENT'});
});

test('release EPERM is preserved without retrying the callback or removing an uncertain lock',async t=>{
  const f=await fixture(t),original=fs.unlink,error=Object.assign(new Error('synthetic release denial'),{code:'EPERM'});let entered=0,removals=0;
  fs.unlink=async function(file,...args){if(file===f.lock){removals++;throw error;}return original.call(this,file,...args);};
  try {await assert.rejects(localFileTransaction(f.file,()=>entered++),value=>value===error);}
  finally {fs.unlink=original;}
  assert.equal(entered,1);assert.equal(removals,1);assert.ok(await fs.stat(f.lock));
});
