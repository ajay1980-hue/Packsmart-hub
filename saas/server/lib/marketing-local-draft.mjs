import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { types } from 'node:util';
import { isLocalFileStore, withLocalFileState } from './store.mjs';
import { assertMetaPublicationOwner, metaPublicationChoices } from './marketing-publication.mjs';
import { reviewMetaMarketingCampaign } from './marketing-campaign-review.mjs';
import { assertManualContentScope } from './manual-content-target.mjs';
import { objectiveCanonicalDigest as digest } from './objective-dispatch-policy.mjs';
import { contentWriteSnapshot } from './content-write-identity.mjs';
import { snapshotLocalJpeg, JPEG_MAX_BYTES } from './marketing-jpeg.mjs';

const capabilities = new WeakMap(), hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (code, status=409) => Object.assign(new Error(code), {code,status});
const requestValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);
const closed = () => { throw fail('LOCAL_DRAFT_STORAGE_CLOSED'); };
const baseBlockers = ['LOCAL_STORAGE_NOT_PRODUCTION_ACCEPTED','PROVIDER_DELIVERY_UNVERIFIED','EXACT_PUBLICATION_APPROVAL_REQUIRED','PUBLISHING_CLOSED'];
function context(state, campaignId, pageId, session) {
  assertMetaPublicationOwner(state, session);
  const choices = metaPublicationChoices(state, campaignId, session);
  const review = reviewMetaMarketingCampaign(state, campaignId);
  const campaign = state.marketing.campaigns.find(row=>row.id===campaignId);
  const pages = choices.pages;
  const selected = pages.filter(row=>row.pageId===(pageId || pages[0]?.pageId));
  if (selected.length !== 1) throw fail('LOCAL_DRAFT_TARGET_UNAVAILABLE');
  const connection = state.connections.filter(row=>row.provider==='meta');
  if (connection.length !== 1 || !/^\d{1,32}$/.test(connection[0].metadata?.accountId)) throw fail('LOCAL_DRAFT_TARGET_UNAVAILABLE');
  const target = { connectionId:connection[0].id, account:connection[0].metadata.accountId, ...selected[0] };
  const caption = campaign.copy?.longCaption;
  if (typeof caption !== 'string' || !caption.trim() || caption.length > 2200 || !caption.isWellFormed()) throw fail('LOCAL_DRAFT_CAPTION_INVALID');
  const costs = state.economics?.[review.product.current?.sku] || state.economics?.[review.product.current?.variantId] || {};
  assertManualContentScope(costs, state.workspace.id);
  const source = { workspaceId:state.workspace.id, campaignId, product:campaign.product, copy:campaign.copy,
    channels:campaign.channels, current:review.product.current, costs, target,
    marketing:state.marketing.settings, metaSettings:state.connectionSettings?.meta ?? null,
    connectionStatus:connection[0].status, scopes:connection[0].metadata?.grantedScopes ?? [] };
  const blockers = [...baseBlockers, ...review.publishing.blockers.map(row=>typeof row==='string'?row:row.code)];
  return {campaignId, caption, target, pages, sourceRevision:digest(source), eligibility:review.eligibility,
    blockers:[...new Set(blockers)], publishingEnabled:false, storage:'local_review_only', imageOrigin:'owner_upload_not_verified_canva_export'};
}
// No HTTP or environment parser can mint this capability. Only an explicitly
// composed local server using the real FileStore can supply it.
export async function createLocalDraftStorage({store, root, environment}) {
  if (environment !== 'local' || !isLocalFileStore(store) || typeof root !== 'string' || !path.isAbsolute(root)) closed();
  root = path.resolve(root);
  await safeDirectory(path.dirname(root));
  try { await fs.mkdir(root, {mode:0o700}); } catch(error) { if(error.code!=='EEXIST')throw error; }
  await safeDirectory(root);
  const stateFile=path.resolve(store.filePath);
  await safeDirectory(path.dirname(stateFile));
  const binding=Buffer.from(JSON.stringify({schema:'runvara-local-draft-store/v1',stateFileDigest:hash(Buffer.from(process.platform==='win32'?stateFile.toLowerCase():stateFile))}));
  const marker=path.join(root,'.store.json');
  try{const handle=await fs.open(marker,'wx',0o600);try{await handle.writeFile(binding);await handle.sync();}finally{await handle.close();}}
  catch(error){if(error.code!=='EEXIST')throw error;}
  if(!(await readFileBounded(marker,512)).equals(binding))throw fail('LOCAL_DRAFT_STORAGE_CONFLICT');
  const stat = await fs.lstat(root);
  const capability = Object.freeze(Object.create(null));
  capabilities.set(capability,{store,root,stateFile,binding,identity:[stat.dev,stat.ino]});
  return capability;
}
export function assertLocalDraftStorage(capability, store, env, forbiddenRoot) {
  const config = capabilities.get(capability);
  if (!config || config.store!==store || !isLocalFileStore(store) || env.NODE_ENV==='production'
    || env.SUPABASE_URL || env.SUPABASE_SERVICE_ROLE_KEY) closed();
  if (forbiddenRoot) {
    const relative=path.relative(path.resolve(forbiddenRoot),config.root);
    if (!relative || !relative.startsWith('..'+path.sep) && relative!=='..' && !path.isAbsolute(relative)) closed();
  }
  return true;
}
async function safeDirectory(directory) {
  for (let current=directory;;current=path.dirname(current)) {
    const stat=await fs.lstat(current);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('LOCAL_DRAFT_PATH_UNSAFE');
    if(path.dirname(current)===current)break;
  }
}
async function checkRoot(config) {
  if(path.resolve(config.store.filePath)!==config.stateFile)throw fail('LOCAL_DRAFT_STORAGE_CONFLICT');
  await safeDirectory(config.root);
  const stat=await fs.lstat(config.root);
  if(stat.dev!==config.identity[0]||stat.ino!==config.identity[1])throw fail('LOCAL_DRAFT_PATH_UNSAFE');
  if(!(await readFileBounded(path.join(config.root,'.store.json'),512)).equals(config.binding))throw fail('LOCAL_DRAFT_STORAGE_CONFLICT');
}
function configuration(capability) { const value=capabilities.get(capability);if(!value)closed();return value; }
function address(config, session, requestId) {
  if(!requestValid(requestId))throw fail('LOCAL_DRAFT_REQUEST_INVALID',400);
  return path.join(config.root,hash(Buffer.from(session.workspaceId+'\0'+requestId)));
}
async function readFileBounded(file,max) {
  const before=await fs.lstat(file);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>max)throw fail('LOCAL_DRAFT_CORRUPT');
  const handle=await fs.open(file,'r');
  try {
    const stat=await handle.stat();
    if(stat.ino!==before.ino||stat.dev!==before.dev||stat.size!==before.size)throw fail('LOCAL_DRAFT_CORRUPT');
    const bytes=Buffer.alloc(stat.size);
    const result=await handle.read(bytes,0,bytes.length,0);
    if(result.bytesRead!==bytes.length)throw fail('LOCAL_DRAFT_CORRUPT');
    return bytes;
  } finally { await handle.close(); }
}
async function retained(config, session, campaignId, requestId) {
  const directory=address(config,session,requestId);
  try { await safeDirectory(directory); } catch(error) { if(error.code==='ENOENT')return null;throw error; }
  let record;
  try { record=JSON.parse(await readFileBounded(path.join(directory,'draft.json'),65536)); } catch {throw fail('LOCAL_DRAFT_CORRUPT');}
  const {integrity,...body}=record;
  if(integrity!==digest(body)||record.schema!=='runvara-local-review-draft/v1'||record.workspaceId!==session.workspaceId
    ||record.campaignId!==campaignId||record.requestId!==requestId||record.actorId!==session.userId
    ||record.publishingEnabled!==false||record.executedExternally!==false||record.storage!=='local_review_only')throw fail('LOCAL_DRAFT_CORRUPT');
  const bytes=await readFileBounded(path.join(directory,'image.jpg'),JPEG_MAX_BYTES);
  if(bytes.length!==record.asset.byteLength||hash(bytes)!==record.asset.sha256)throw fail('LOCAL_DRAFT_CORRUPT');
  return {record,bytes};
}
function projection(record,current) {
  const stale=record.sourceRevision!==current.sourceRevision;
  return {...record,stale,blockers:[...new Set([...record.blockers,...current.blockers,...(stale?['SOURCE_CHANGED_SINCE_SAVE']:[])])],publishingEnabled:false};
}
function historicalContext(state,record,session) {
  assertMetaPublicationOwner(state,session);
  try{return context(state,record.campaignId,record.target.pageId,session);}
  catch(error){return {sourceRevision:null,blockers:['CURRENT_SOURCE_UNAVAILABLE',error.code || 'LOCAL_DRAFT_SOURCE_INVALID']};}
}
export async function localDraftContext(capability,campaignId,pageId,session) {
  const config=configuration(capability);
  return withLocalFileState(config.store,session.workspaceId,state=>{
    assertMetaPublicationOwner(state,session);
    try{return {sourceAvailable:true,...context(state,campaignId,pageId,session)};}
    catch(error){return {sourceAvailable:false,publishingEnabled:false,pages:[],target:null,caption:'',eligibility:{missingCostFields:[]},
      blockers:['CURRENT_SOURCE_UNAVAILABLE',error.code||'LOCAL_DRAFT_SOURCE_INVALID'],notice:'The current campaign or destination is unavailable. Existing local drafts can still be reopened.'};}
  });
}
export async function saveLocalDraft(capability,campaignId,input,session) {
  const config=configuration(capability);
  const keys=['requestId','sourceRevision','pageId','jpegBase64'];
  if(!input||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))
    ||Reflect.ownKeys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(input,key),'value')))throw fail('LOCAL_DRAFT_INPUT_INVALID',400);
  contentWriteSnapshot({requestId:input.requestId,sourceRevision:input.sourceRevision,pageId:input.pageId});
  if(Object.keys(input).length!==keys.length
    ||!requestValid(input.requestId)||!/^[a-f0-9]{64}$/.test(input.sourceRevision)
    ||!/^\d{1,32}$/.test(input.pageId)||typeof input.jpegBase64!=='string'
    ||input.jpegBase64.length>Math.ceil(JPEG_MAX_BYTES/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.jpegBase64))throw fail('LOCAL_DRAFT_INPUT_INVALID',400);
  const bytes=Buffer.from(input.jpegBase64,'base64');
  if(bytes.toString('base64')!==input.jpegBase64)throw fail('LOCAL_DRAFT_INPUT_INVALID',400);
  const requestDigest=digest({campaignId,requestId:input.requestId,sourceRevision:input.sourceRevision,pageId:input.pageId,assetSha256:hash(bytes)});
  const check = state => context(state,campaignId,input.pageId,session);
  // Authorize before expensive decode; exact replay still reauthorizes and
  // verifies retained bytes. Changed source cannot create a new draft.
  const replay=await withLocalFileState(config.store,session.workspaceId,async state=>{
    assertMetaPublicationOwner(state,session);await checkRoot(config);
    const previous=await retained(config,session,campaignId,input.requestId);
    if(previous){if(previous.record.requestDigest!==requestDigest)throw fail('LOCAL_DRAFT_REQUEST_CONFLICT');return projection(previous.record,historicalContext(state,previous.record,session));}
    const current=check(state);
    if(current.sourceRevision!==input.sourceRevision)throw fail('LOCAL_DRAFT_SOURCE_CHANGED');
    return null;
  });
  if(replay)return replay;
  const image=await snapshotLocalJpeg(bytes);
  return withLocalFileState(config.store,session.workspaceId,async state=>{
    assertMetaPublicationOwner(state,session);await checkRoot(config);
    const previous=await retained(config,session,campaignId,input.requestId);
    if(previous){if(previous.record.requestDigest!==requestDigest)throw fail('LOCAL_DRAFT_REQUEST_CONFLICT');return projection(previous.record,historicalContext(state,previous.record,session));}
    const current=check(state);
    if(current.sourceRevision!==input.sourceRevision)throw fail('LOCAL_DRAFT_SOURCE_CHANGED');
    // Includes orphan staging directories; a crash consumes capacity safely.
    if((await fs.readdir(config.root)).filter(name=>name!=='.store.json').length>=128)throw fail('LOCAL_DRAFT_STORAGE_FULL',507);
    const record={schema:'runvara-local-review-draft/v1',workspaceId:session.workspaceId,campaignId,requestId:input.requestId,
      actorId:session.userId,actorSessionVersion:session.sessionVersion,createdAt:new Date().toISOString(),requestDigest,
      sourceRevision:current.sourceRevision,caption:current.caption,target:current.target,asset:image.descriptor,
      imageOrigin:current.imageOrigin,blockers:current.blockers,storage:'local_review_only',publishingEnabled:false,executedExternally:false};
    record.integrity=digest(record);
    const stage=path.join(config.root,'.pending-'+crypto.randomUUID());await fs.mkdir(stage,{mode:0o700});
    for(const [name,value] of [['image.jpg',image.bytes],['draft.json',Buffer.from(JSON.stringify(record))]]) {
      const handle=await fs.open(path.join(stage,name),'wx',0o600);
      try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}
    }
    await checkRoot(config);await safeDirectory(stage);
    // Recheck even while holding the shared current-writer lock. An older or
    // external writer does not participate; local composition must exclude it.
    if(check(await config.store.get(session.workspaceId)).sourceRevision!==input.sourceRevision)throw fail('LOCAL_DRAFT_SOURCE_CHANGED');
    await fs.rename(stage,address(config,session,input.requestId));
    return projection(record,check(await config.store.get(session.workspaceId)));
  });
}
export async function readLocalDraft(capability,campaignId,requestId,session,{image=false}={}) {
  const config=configuration(capability);
  return withLocalFileState(config.store,session.workspaceId,async state=>{
    assertMetaPublicationOwner(state,session);await checkRoot(config);
    const saved=await retained(config,session,campaignId,requestId);
    if(!saved)return {found:false,requestId,publishingEnabled:false};
    const current=historicalContext(await config.store.get(session.workspaceId),saved.record,session);
    return image?{bytes:saved.bytes}: {found:true,draft:projection(saved.record,current)};
  });
}
