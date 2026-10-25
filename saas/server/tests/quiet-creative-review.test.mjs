import test from 'node:test';
import assert from 'node:assert/strict';
import { quietCreativeFixture } from './quiet-creative-fixture.mjs';

test('protected approval expiry is checked again after the final asynchronous snapshot read',async()=>{
  const f=quietCreativeFixture();await f.ready();let admitted=false;
  f.hooks.afterRpc=name=>{if(name==='confirm')admitted=true;};
  f.hooks.get=()=>{if(admitted)f.clock(150000);};
  await assert.rejects(f.run('submit'));
  assert.equal(f.pilot.available(),true,'descriptor still open, shorter approval expired');
  assert.equal(f.posts.length,0,'expired protected approval must not reach provider');
  assert.equal(f.held,600,'consumed admission remains held');
});
