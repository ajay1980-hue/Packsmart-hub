import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { createLocalDraftStorage } from '../lib/marketing-local-draft.mjs';
import { publicationFixture } from './marketing-publication-fixture.mjs';
import { jpegFixture } from './marketing-local-jpeg-fixture.mjs';
const secret='synthetic-local-draft-session-secret-more-than-thirty-two-characters';
async function api(t,{enabled=true,quiet=false}={}) {
  const f=await publicationFixture(t);await f.change(state=>{state.marketing.campaigns[0].creativeRequests=[];state.users.push({...state.users[0],id:'admin',email:'admin@example.test',role:'admin'});});
  const localDraftStorage=enabled?await createLocalDraftStorage({store:f.store,root:path.join(path.dirname(f.env.SAAS_STATE_FILE),'drafts'),environment:'local'}):null;
  let external=0;
  const server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,...(quiet?{RUNVARA_STARTUP_MODE:'quiet'}:{})},
    {store:f.store,localDraftStorage,schedulerEnabled:false,agentOpsEnabled:false,fetchImpl:async()=>{external++;throw Error('External transport forbidden');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await server.packsmart.drain();await new Promise(resolve=>server.close(resolve));assert.equal(external,0);});
  const base='http://127.0.0.1:'+server.address().port,route='/api/marketing/campaigns/'+f.campaignId+'/local-review-drafts';
  f.token=async(role='owner',version=1)=>{const state=await f.get(),user=state.users.find(u=>u.role===role);return createSessionToken({workspaceId:f.workspaceId,userId:user.id,role,email:user.email,sessionVersion:version},secret);};
  f.request=async(url,{method='GET',auth,csrf,body}={})=>{const response=await fetch(base+url,{method,headers:{...(auth?{Cookie:'packsmart_session='+auth}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,cache:response.headers.get('cache-control'),body:await response.json()};};
  f.route=route;return f;
}
test('local draft API enforces owner/session/CSRF, exact input and authenticated byte reads',async t=>{
  const f=await api(t),auth=await f.token();
  assert.equal((await f.request(f.route+'/context')).status,401);
  assert.equal((await f.request(f.route+'/context',{auth:await f.token('admin')})).status,403);
  assert.equal((await f.request(f.route+'/context',{auth:await f.token('owner',2)})).status,401);
  const context=(await f.request(f.route+'/context',{auth})).body;assert.equal(context.available,true);
  const body={requestId:crypto.randomUUID(),pageId:'202',sourceRevision:context.sourceRevision,jpegBase64:jpegFixture().toString('base64')};
  assert.equal((await f.request(f.route,{method:'POST',auth,body})).status,403);
  const csrf=(await f.request('/api/auth/session',{auth})).body.csrf;
  assert.equal((await f.request(f.route,{method:'POST',auth,csrf,body:{...body,workspaceId:'foreign'}})).status,400);
  const saved=await f.request(f.route,{method:'POST',auth,csrf,body});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.publishingEnabled,false);
  const imageRoute=f.route+'/requests/'+body.requestId+'/image';
  assert.equal((await f.request(imageRoute)).status,401);
  const image=await f.request(imageRoute,{auth});assert.equal(image.status,200);assert.match(image.cache,/no-store/);assert.deepEqual(Buffer.from(image.body.base64,'base64'),jpegFixture());
  assert.equal((await f.request(f.route+'/context?workspaceId=foreign',{auth})).status,400);
  const state=await f.get();assert.equal((state.connectionWrites||[]).length,0);assert.equal((state.approvals||[]).length,0);
});
test('default composition advertises closure and never decodes or persists an HTTP draft',async t=>{
  const f=await api(t,{enabled:false}),auth=await f.token();
  assert.equal((await f.request(f.route+'/context',{auth})).body.available,false);
  const csrf=(await f.request('/api/auth/session',{auth})).body.csrf;
  const result=await f.request(f.route,{method:'POST',auth,csrf,body:{jpegBase64:'invalid'}});assert.equal(result.body.code,'LOCAL_DRAFT_STORAGE_CLOSED');
});
test('quiet startup still blocks new local draft mutations',async t=>{
  const f=await api(t,{quiet:true}),auth=await f.token(),csrf=(await f.request('/api/auth/session',{auth})).body.csrf;
  const result=await f.request(f.route,{method:'POST',auth,csrf,body:{}});assert.equal(result.status,503);
});
