import test from 'node:test';
import assert from 'node:assert/strict';
import { objectiveContentHarness } from './objective-content-ui-fixture.mjs';
import { publicationFixture } from './marketing-publication-fixture.mjs';
import { jpegFixture } from './marketing-local-jpeg-fixture.mjs';
const until=async fn=>{for(let i=0;i<150;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Local draft UI did not settle');};
async function fixture(t,role='owner') {
  const h=await objectiveContentHarness(t,{role}),f=await publicationFixture(t,'local-ui'),state=await f.get();
  h.bootstrap.marketing.campaigns=state.marketing.campaigns;
  const route='/api/marketing/campaigns/'+f.campaignId+'/local-review-drafts';
  const context={available:true,caption:'Exact <img src=x onerror="window.injected=true"> caption',sourceRevision:'a'.repeat(64),target:{pageId:'202',instagramId:'303'},
    pages:[{pageId:'202',instagramId:'303'},{pageId:'404',instagramId:'505'}],blockers:['PUBLISHING_CLOSED'],eligibility:{missingCostFields:['actual outbound delivery cost']}};
  h.explicitRoutes.set(route+'/context',()=>Response.json(context));
  h.record=body=>({requestId:body.requestId,caption:context.caption,target:context.target,asset:{sha256:'b'.repeat(64)},blockers:context.blockers,stale:false,publishingEnabled:false});
  h.explicitRoutes.set(route,(_url,options)=>Response.json(h.record(JSON.parse(options.body))));
  h.openDraft=async()=>{h.controls.setView('marketing');h.d.querySelector('[data-local-draft-open]').click();await until(()=>h.d.querySelector('[data-local-draft-form]'));return h.d.querySelector('[data-local-draft-form]');};
  h.selectFile=form=>Object.defineProperty(form.elements.image,'files',{configurable:true,value:[new h.w.File([jpegFixture()],'existing.jpg',{type:'image/jpeg'})]});
  h.submitDraft=form=>form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
  await h.login();return {...h,route,context};
}
for(const role of ['admin','member','viewer'])test(role+' has no local draft create action',async t=>{
  const h=await fixture(t,role);assert.equal(h.d.querySelector('[data-local-draft-open]'),null);assert.equal(h.calls.filter(c=>c.route.startsWith(h.route)).length,0);
});
test('owner explicitly saves existing JPEG; labels, missing costs and escaped caption remain honest',async t=>{
  const h=await fixture(t),form=await h.openDraft();assert.equal(h.calls.filter(c=>c.route===h.route).length,0);
  assert.match(form.textContent,/No generation, approval, upload to a provider or posting/);assert.match(form.textContent,/actual outbound delivery cost/);
  h.selectFile(form);h.submitDraft(form);await until(()=>form.localDraftSaved);
  const panel=form.querySelector('[data-local-draft-result]');assert.ok(panel.textContent.includes(h.context.caption));assert.equal(panel.querySelector('img,script,iframe'),null);
  assert.match(panel.textContent,/not production accepted/);assert.equal(h.w.injected,undefined);
  assert.equal(h.calls.filter(c=>c.route===h.route).length,1);
  assert.ok([...Array(h.w.sessionStorage.length)].every((_,i)=>!h.w.sessionStorage.key(i).includes('csrf')));
});
test('uncertain save retains exact request and byte body; explicit retry creates no new request reference',async t=>{
  const h=await fixture(t),bodies=[];
  h.explicitRoutes.set(h.route,(_url,options)=>{bodies.push(options.body);if(bodies.length===1)throw Error('synthetic response lost');return Response.json(h.record(JSON.parse(options.body)));});
  const form=await h.openDraft();h.selectFile(form);h.submitDraft(form);
  await until(()=>form.querySelector('[data-local-draft-save]').textContent==='Retry same save');
  const reference=form.elements.reference.value;assert.match(reference,/^[a-f0-9-]{36}$/);assert.equal(form.elements.image.disabled,true);assert.equal(form.elements.page.disabled,true);
  h.submitDraft(form);await until(()=>form.localDraftSaved);assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.equal(form.elements.reference.value,reference);
});
test('saved reference survives reload and explicitly reopens authenticated bytes',async t=>{
  const h=await fixture(t),form=await h.openDraft();h.selectFile(form);h.submitDraft(form);await until(()=>form.localDraftSaved);
  const requestId=form.elements.reference.value,record=h.record(form.localDraftPending);
  h.explicitRoutes.set(h.route+'/requests/'+requestId,()=>Response.json({found:true,draft:{...record,stale:true,blockers:['SOURCE_CHANGED_SINCE_SAVE']}}));
  h.explicitRoutes.set(h.route+'/requests/'+requestId+'/image',()=>Response.json({mediaType:'image/jpeg',base64:jpegFixture().toString('base64')}));
  await h.login();const reopened=await h.openDraft();assert.equal(reopened.elements.reference.value,requestId);
  assert.equal(reopened.querySelector('img'),null);reopened.querySelector('[data-local-draft-reopen]').click();await until(()=>reopened.querySelector('img'));
  assert.match(reopened.querySelector('[data-local-draft-result]').textContent,/saved source has changed/);
  assert.ok(reopened.querySelector('img').src.startsWith('data:image/jpeg;base64,'));
});
test('changing destination clears the old source and rejects late context after session replacement',async t=>{
  const h=await fixture(t),form=await h.openDraft();let resolve;
  h.explicitRoutes.set(h.route+'/context?pageId=404',()=>new Promise(done=>resolve=done));
  form.elements.page.value='404';form.elements.page.dispatchEvent(new h.w.Event('change',{bubbles:true}));await until(()=>resolve);
  assert.equal(form.localDraftContext,null);assert.equal(form.querySelector('[data-local-draft-save]').disabled,true);
  await h.login();resolve(Response.json({...h.context,caption:'OLD-SESSION-SECRET'}));await new Promise(done=>setTimeout(done,30));
  assert.ok(!h.d.body.textContent.includes('OLD-SESSION-SECRET'));assert.equal(h.calls.filter(c=>c.route===h.route).length,0);
});
test('default storage closure has no upload or save form',async t=>{
  const h=await fixture(t);h.explicitRoutes.set(h.route+'/context',()=>Response.json({available:false,notice:'Local JPEG storage unavailable; publishing closed.'}));
  h.d.querySelector('[data-local-draft-open]').click();await until(()=>h.d.querySelector('.publication-selection').textContent.includes('unavailable'));
  assert.equal(h.d.querySelector('[data-local-draft-form]'),null);assert.equal(h.calls.filter(c=>c.method==='POST'&&c.route===h.route).length,0);
});
test('removed campaign remains reopenable and unavailable source keeps new saving closed',async t=>{
  const h=await fixture(t),form=await h.openDraft();h.selectFile(form);h.submitDraft(form);await until(()=>form.localDraftSaved);
  const id=form.elements.reference.value,record=h.record(form.localDraftPending);
  h.bootstrap.marketing.campaigns=[];
  h.explicitRoutes.set(h.route+'/context',()=>Response.json({available:true,sourceAvailable:false,pages:[],target:null,caption:'',eligibility:{missingCostFields:[]},blockers:['CURRENT_SOURCE_UNAVAILABLE'],notice:'The current campaign or destination is unavailable. Existing local drafts can still be reopened.'}));
  h.explicitRoutes.set(h.route+'/requests/'+id,()=>Response.json({found:true,draft:{...record,stale:true}}));
  h.explicitRoutes.set(h.route+'/requests/'+id+'/image',()=>Response.json({mediaType:'image/jpeg',base64:jpegFixture().toString('base64')}));
  await h.login();assert.equal(h.d.querySelector('[data-local-draft-open]').textContent,'Reopen retained local draft');
  const recovery=await h.openDraft();assert.equal(recovery.querySelector('[data-local-draft-save]').disabled,true);
  recovery.querySelector('[data-local-draft-reopen]').click();await until(()=>recovery.querySelector('img'));assert.match(recovery.textContent,/saved source has changed/);
});
test('selecting a file during destination refresh does not strand the new source',async t=>{
  const h=await fixture(t),form=await h.openDraft();let resolve;
  h.explicitRoutes.set(h.route+'/context?pageId=404',()=>new Promise(done=>resolve=done));
  form.elements.page.value='404';form.elements.page.dispatchEvent(new h.w.Event('change',{bubbles:true}));await until(()=>resolve);
  h.selectFile(form);form.elements.image.dispatchEvent(new h.w.Event('change',{bubbles:true}));
  resolve(Response.json({...h.context,target:{pageId:'404',instagramId:'505'}}));
  await until(()=>!form.querySelector('[data-local-draft-save]').disabled);assert.equal(form.localDraftContext.target.pageId,'404');
});
