import test from 'node:test';
import assert from 'node:assert/strict';
import { publicApproval, publicConnectionWrite } from '../lib/action-display.mjs';
import { createMetaPublicationLocalAsset } from '../lib/marketing-publication.mjs';
import { publicationFixture } from './marketing-publication-fixture.mjs';
import { png } from './marketing-publication-asset-fixture.mjs';
import { objectiveContentHarness } from './objective-content-ui-fixture.mjs';

async function proposal(t) {
  const f = await publicationFixture(t, 'publication-ui');
  await f.change(state => { state.marketing.campaigns[0].copy.longCaption += '\nExact caption <img src=x onerror="window.injected=true">'; });
  f.assetSnapshot = createMetaPublicationLocalAsset(await f.get(), f.campaignId, f.selection, f.session, png(), 'image/png');
  await f.prepare(await f.body());
  const state = await f.get();
  return { write: publicConnectionWrite(state.connectionWrites[0]), approval: publicApproval(state.approvals[0]) };
}
for (const role of ['owner','admin','member','viewer']) test(role + ' can inspect the exact simulated proposal without image fetch or added authority', async t => {
  const h = await objectiveContentHarness(t,{role}), records = await proposal(t);
  h.bootstrap.connectionWrites = [records.write]; h.bootstrap.approvals = [records.approval];
  const before = JSON.stringify(records);
  await h.login(); h.controls.setView('approvals');
  const card = h.el('approval-list'), details = card.querySelector('.publication-approval-details');
  assert.ok(details);
  for (const value of [records.approval.payload.publication.caption, 'meta-fixture','101','202','303',
    'https://example.test/canva-complete.jpg', records.approval.payload.publication.asset.localSnapshot.sha256,
    records.approval.payload.publication.asset.localSnapshot.pixelSha256]) assert.ok(details.textContent.includes(value), value);
  assert.match(details.textContent,/Local simulation only/);
  assert.match(details.textContent,/no remote preview fetched/);
  assert.match(details.textContent,/does not verify provider access or authorise a live post/);
  assert.equal(details.querySelector('img,script,iframe,a'),null);
  assert.equal(card.querySelectorAll('[data-decision]').length,role==='owner'?2:0);
  assert.equal(h.w.injected,undefined);
  assert.equal(JSON.stringify(records),before);
  assert.equal(h.calls.some(call=>call.route.endsWith('/execute')||call.route.endsWith('/decision')),false);
});

test('simulation statuses never offer Apply or claim live confirmation, including an injected click', async t => {
  const h = await objectiveContentHarness(t), records = await proposal(t);
  await h.login();
  for (const status of ['ready','processing','completed','uncertain']) {
    const write = structuredClone(records.write), approval = structuredClone(records.approval);
    write.status = status; approval.status = 'approved'; approval.executionStatus = status;
    if (status==='completed') write.result = {externalId:'900000002',simulated:true};
    h.bootstrap.connectionWrites=[write];h.bootstrap.approvals=[approval];
    h.w.RunvaraConnections.render(h.bootstrap);h.controls.setView('channels');h.w.RunvaraConnections.open('meta');
    const card = h.d.querySelector('.connection-write');
    assert.match(card.textContent,/Local simulation only. No live post was made/);
    assert.equal(card.querySelector('[data-connection-action="execute"]'),null);
    assert.doesNotMatch(card.textContent,/Confirmed channel reference|Instagram is preparing your image/);
    if(status==='completed') assert.match(card.textContent,/Simulated result reference: 900000002/);
    if(status==='uncertain') assert.match(card.textContent,/simulated outcome is uncertain.*will not repeat an uncertain write/);
    const forged=h.d.createElement('button');for(const [key,value] of Object.entries({connectionAction:'execute',provider:'meta',write:write.id}))forged.dataset[key]=value;
    card.append(forged);forged.click();
    assert.equal(h.calls.some(call=>call.route.endsWith('/execute')),false);
    h.el('connection-close').click();
  }
});

test('partial or missing Meta asset arrays leave the connection panel usable without granting permissions', async t => {
  const h = await objectiveContentHarness(t);await h.login();
  const writesBefore = h.calls.filter(call=>call.method==='POST').length;
  for (const assets of [{pages:[]},{catalogs:[]},null,{pages:null,catalogs:{}}]) {
    const data=structuredClone(h.bootstrap),channel=data.connectionCentre.find(row=>row.id==='meta');
    channel.configured=true;channel.meta.assets=assets;channel.meta.grantedScopes=['instagram_basic','instagram_content_publish','pages_read_engagement'];
    channel.settings.permissionMode='approval_gated';
    h.w.RunvaraConnections.render(data);h.controls.setView('channels');h.w.RunvaraConnections.open('meta');
    assert.equal(h.el('connection-dialog').open,true);
    assert.match(h.el('connection-detail').textContent,/No Pages authorised/);
    assert.match(h.el('connection-detail').textContent,/No catalogues authorised/);
    assert.equal(h.calls.filter(call=>call.method==='POST').length,writesBefore);
    h.el('connection-close').click();
  }
});

test('campaign-level review is visibly distinct from exact publication approval', async t => {
  const h=await objectiveContentHarness(t);
  h.bootstrap.connectionWrites=[];h.bootstrap.approvals=[publicApproval({id:'campaign-review',status:'pending',type:'social_commerce_publish',
    action:'Publish campaign',payload:{marketingCampaignId:'campaign-1'}})];
  await h.login();h.controls.setView('approvals');
  assert.match(h.el('approval-list').textContent,/Campaign-level review only.*exact destination and image still need separate approval/);
  assert.equal(h.el('approval-list').querySelector('.publication-approval-details'),null);
});

const eventually = async predicate => { for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('UI did not settle'); };
test('owner manually reads retained observations without automatic capture, apply or remote image access',async t=>{
 const h=await objectiveContentHarness(t),records=await proposal(t),write=records.write;
 write.observationHistoryAvailable=true;write.status='uncertain';h.bootstrap.connectionWrites=[write];
 const route='/api/connection-writes/'+write.id+'/meta-observations';
 const result={writeId:write.id,anchor:{containerId:'900000001'},observations:[{statusCode:'PUBLISHED <img src=x onerror="window.injected=true">',observedAt:'2026-10-18T12:00:00.000Z'}],
  replayPermitted:false,publishingEnabled:false,simulated:true,captureAvailable:false};
 h.explicitRoutes.set(route,()=>Response.json(result));await h.login();h.controls.setView('channels');h.w.RunvaraConnections.open('meta');
 assert.equal(h.calls.filter(call=>call.route===route).length,0);
 h.d.querySelector('[data-connection-action="meta-observations"]').click();await eventually(()=>h.el('meta-observation-'+write.id).textContent.includes('Media ID unknown'));
 const panel=h.el('meta-observation-'+write.id);assert.match(panel.textContent,/Do not resend/);assert.equal(panel.querySelector('img,script,iframe,a'),null);
 assert.equal(h.d.querySelector('[data-connection-action="meta-observation-capture"]'),null);assert.equal(h.w.injected,undefined);
 assert.deepEqual(h.calls.filter(call=>call.route===route).map(row=>row.method),['GET']);
});
test('simulated observation capture is explicit and retains its request ID after a lost reply',async t=>{
 const h=await objectiveContentHarness(t),records=await proposal(t),write=records.write;write.observationHistoryAvailable=true;write.status='uncertain';h.bootstrap.connectionWrites=[write];
 const route='/api/connection-writes/'+write.id+'/meta-observations',ids=[];
 const result={writeId:write.id,anchor:{containerId:'900000001'},observations:[],replayPermitted:false,publishingEnabled:false,simulated:true,captureAvailable:true};
 h.explicitRoutes.set(route,(_route,options)=>{if(options.method==='POST'){ids.push(JSON.parse(options.body).requestId);if(ids.length===1)throw Error('Synthetic reply lost');result.observations=[{requestId:ids[0],statusCode:'PUBLISHED',observedAt:'2026-10-18T12:00:00.000Z'}];}return Response.json(result);});
 await h.login();h.controls.setView('channels');h.w.RunvaraConnections.open('meta');
 const read=h.d.querySelector('[data-connection-action="meta-observations"]');read.click();await eventually(()=>h.d.querySelector('[data-connection-action="meta-observation-capture"]'));
 h.d.querySelector('[data-connection-action="meta-observation-capture"]').click();await eventually(()=>h.el('meta-observation-'+write.id).textContent.includes('Observation history unavailable'));
 assert.equal(ids.length,1);assert.match(h.el('meta-observation-'+write.id).textContent,/do not resend/);
 read.click();await eventually(()=>h.d.querySelector('[data-connection-action="meta-observation-capture"]'));
 h.d.querySelector('[data-connection-action="meta-observation-capture"]').click();await eventually(()=>h.el('meta-observation-'+write.id).textContent.includes('Media ID unknown'));
 assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);assert.equal(h.calls.some(row=>row.route.endsWith('/execute')),false);
});
test('a late observation reply after logout cannot repopulate the old account panel',async t=>{
 const h=await objectiveContentHarness(t),records=await proposal(t),write=records.write;write.observationHistoryAvailable=true;h.bootstrap.connectionWrites=[write];
 let resolve;const route='/api/connection-writes/'+write.id+'/meta-observations';h.explicitRoutes.set(route,()=>new Promise(done=>{resolve=done;}));
 await h.login();h.controls.setView('channels');h.w.RunvaraConnections.open('meta');h.d.querySelector('[data-connection-action="meta-observations"]').click();await eventually(()=>resolve);
 h.w.RunvaraConnections.endSession();resolve(Response.json({writeId:write.id,anchor:{containerId:'secret-old-account'},observations:[],replayPermitted:false,publishingEnabled:false,simulated:true}));
 await new Promise(done=>setTimeout(done,30));assert.ok(!h.d.body.textContent.includes('secret-old-account'));
});
test('campaign owner selects saved Page and creative then reads exact preview without creating a proposal',async t=>{
 const h=await objectiveContentHarness(t),f=await publicationFixture(t,'preview-ui'),state=await f.get();
 h.bootstrap.marketing.campaigns=state.marketing.campaigns;const campaign=state.marketing.campaigns[0];campaign.copy.longCaption='<b>Exact caption</b>';
 const base='/api/marketing/campaigns/'+campaign.id+'/publication/meta';
 h.explicitRoutes.set(base+'/choices',()=>Response.json({pages:[{pageId:'202',instagramId:'303'}],assets:[{creativeRequestId:f.selection.creativeRequestId,assetUrl:f.selection.assetUrl}]}));
 const preview=base+'/preview?'+new URLSearchParams(f.selection);h.explicitRoutes.set(preview,()=>Response.json({caption:campaign.copy.longCaption,target:{connectionId:'meta-fixture',pageId:'202',instagramId:'303'},asset:{url:f.selection.assetUrl}}));
 await h.login();h.controls.setView('marketing');h.d.querySelector('[data-publication-choices]').click();await eventually(()=>h.d.querySelector('[data-publication-preview]'));
 const form=h.d.querySelector('[data-publication-preview]');form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
 await eventually(()=>form.querySelector('.publication-preview-result').textContent.includes('no approval or post created'));
 const panel=form.querySelector('.publication-preview-result');assert.ok(panel.textContent.includes('<b>Exact caption</b>'));assert.equal(panel.querySelector('img,b,script,a'),null);
 assert.deepEqual(h.calls.filter(row=>row.route.startsWith(base)).map(row=>row.method),['GET','GET']);
});

test('changing the Page while or after previewing invalidates the old exact preview',async t=>{
 const h=await objectiveContentHarness(t),f=await publicationFixture(t,'preview-selection'),state=await f.get();h.bootstrap.marketing.campaigns=state.marketing.campaigns;
 const base='/api/marketing/campaigns/'+f.campaignId+'/publication/meta';
 h.explicitRoutes.set(base+'/choices',()=>Response.json({pages:[{pageId:'202',instagramId:'303'},{pageId:'404',instagramId:'505'}],assets:[{creativeRequestId:f.selection.creativeRequestId,assetUrl:f.selection.assetUrl}]}));
 let resolve;h.explicitRoutes.set(base+'/preview?'+new URLSearchParams(f.selection),()=>new Promise(done=>{resolve=done;}));
 await h.login();h.controls.setView('marketing');h.d.querySelector('[data-publication-choices]').click();await eventually(()=>h.d.querySelector('[data-publication-preview]'));
 const form=h.d.querySelector('[data-publication-preview]'),panel=form.querySelector('.publication-preview-result'),page=form.elements.page;
 const submit=()=>form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
 const change=value=>{page.value=value;page.dispatchEvent(new h.w.Event('change',{bubbles:true}));};
 const response=()=>Response.json({caption:'Old Page 202 exact caption',target:{connectionId:'meta-fixture',pageId:'202',instagramId:'303'},asset:{url:f.selection.assetUrl}});
 submit();await eventually(()=>resolve);change('1');resolve(response());await new Promise(done=>setTimeout(done,20));
 assert.match(panel.textContent,/Selection changed/);assert.ok(!panel.textContent.includes('Old Page 202'));
 change('0');resolve=null;submit();await eventually(()=>resolve);resolve(response());await eventually(()=>panel.textContent.includes('Old Page 202'));
 change('1');assert.match(panel.textContent,/Selection changed/);assert.ok(!panel.textContent.includes('Old Page 202'));
 assert.ok(h.calls.filter(row=>row.route.startsWith(base)).every(row=>row.method==='GET'));
});
