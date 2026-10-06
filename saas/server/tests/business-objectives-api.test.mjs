import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createPacksmartServer} from '../server.mjs';
import {seedWorkspaceState} from '../lib/store.mjs';
import {createSessionToken,verifySessionToken} from '../lib/security.mjs';

test('objectives are owner-only, revision protected, audited and tenant isolated', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'runvara-objectives-'));
  const secret = 'objective-api-test-secret-more-than-32-characters';
  const server = createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,CREDENTIALS_KEY:secret,SAAS_STATE_FILE:path.join(dir,'state.json')});
  const tokens = {};
  for (const id of ['alpha','beta','member']) {
    const state=seedWorkspaceState({}, {workspaceId:id,email:`${id}@example.test`,passwordHash:'fixture-only'});
    if(id==='member') state.users[0].role='member';
    await server.packsmart.store.save(id,state);
    tokens[id]=createSessionToken({workspaceId:id,userId:state.users[0].id,email:state.users[0].email,role:state.users[0].role,sessionVersion:1},secret);
  }
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  const request=async(route,{id='alpha',method='GET',body,csrf=true}={})=>{
    const headers={'Cookie':`packsmart_session=${tokens[id]}`,'Content-Type':'application/json'};
    if(csrf) headers['X-CSRF-Token']=verifySessionToken(tokens[id],secret).csrf;
    const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  let writes=0;const save=server.packsmart.store.save.bind(server.packsmart.store);
  server.packsmart.store.save=async(...args)=>{writes++;return save(...args);};
  const empty=await request('/api/business-objectives'); assert.equal(empty.status,200); assert.deepEqual(empty.body.objectives,[]); assert.equal(writes,0);
  const now=Date.now(), start=new Date(now-60000).toISOString(), end=new Date(now+30*86400000).toISOString();
  const definition={title:'Profitable packaging growth',metric:'revenue',baseline:100,target:125,direction:'increase',startsAt:start,endsAt:end,limits:{currency:'GBP',maxMonthlyAdBudget:0,minGrossMarginPercent:35,profitFirst:true}};
  assert.equal((await request('/api/business-objectives',{method:'PUT',csrf:false,body:definition})).status,403);
  assert.equal((await request('/api/business-objectives',{id:'member',method:'PUT',body:definition})).status,403);
  assert.equal((await request('/api/business-objectives',{method:'PUT',body:{...definition,workspaceId:'beta'}})).status,403);
  assert.equal(writes,0);
  const created=await request('/api/business-objectives',{method:'PUT',body:definition});assert.equal(created.status,200);
  const objective=created.body.objective;
  assert.equal(objective.limits.maxMonthlyAdBudget,0);assert.equal(objective.revision,1);
  const stored=await server.packsmart.store.get('alpha');
  assert.equal(stored.businessObjectives[0].id,objective.id);
  assert.ok(stored.audit.some(item=>item.type==='business_objective_configured'&&item.detail.objectiveId===objective.id));
  assert.deepEqual((await request('/api/business-objectives?workspaceId=alpha',{id:'beta'})).body.objectives,[]);
  assert.equal((await request('/api/business-objectives',{id:'beta',method:'PUT',body:{id:objective.id,revision:1,status:'paused'}})).status,404);
  const updated=await request('/api/business-objectives',{method:'PUT',body:{id:objective.id,revision:1,status:'paused'}});assert.equal(updated.status,200);assert.equal(updated.body.objective.revision,2);
  assert.equal((await request('/api/business-objectives',{method:'PUT',body:{id:objective.id,revision:1,status:'active'}})).status,409);
  const before=writes;
  const evaluated=await request('/api/business-objectives/evaluate',{method:'POST',body:{objectiveId:objective.id,kind:'prepare_report',mode:'internal_preparation',evidence:{}}});
  assert.equal(evaluated.status,200);assert.equal(evaluated.body.readyForPreparation,false);assert.equal(evaluated.body.safeguards.externalExecutionAllowed,false);
  assert.equal(writes,before,'evaluation never saves or executes');
  assert.equal((await request('/api/business-objectives/evaluate',{id:'member',method:'POST',body:{}})).status,403);
});
