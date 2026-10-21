import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {contentWriteSnapshot} from './content-write-identity.mjs';
import {isLocalFileStore,updateLocalMetaObserver} from './store.mjs';
import {assertMetaPublicationOwner} from './marketing-publication.mjs';
import {assertManualContentScope} from './manual-content-target.mjs';
import {connectionSettings} from './connection-centre.mjs';
import {metaMethods} from './meta-commerce.mjs';
import {metaReceiptActor,metaReceiptProjection,protectedMetaReceiptProjection,protectedMetaPublicationAdmission} from './meta-publication-receipt.mjs';
import {validateMetaObservationAnchor} from './meta-publication-observation.mjs';
import {META_CONTAINER_STATUSES,metaContainerError as fail} from './meta-container-response.mjs';

export const META_CONTAINER_OBSERVER_CONTRACT='runvara-local-mocked-meta-container-reader/v1';
export const META_CONTAINER_OBSERVER_LIMITS=Object.freeze({responseBytes:4096,timeoutMs:5000,cadenceMs:60000,windowMs:300000,containerAttempts:5,workspaceAttempts:32,globalAttempts:128,concurrency:2});
const harnesses=new WeakMap();
const sha=value=>createHash('sha256').update(contentWriteSnapshot(value)).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const requestId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{16,80}$/.test(value);
function exact(value,keys){contentWriteSnapshot(value);if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw fail('INPUT_INVALID',400);}
function clock(h){const time=h.now();if(!Number.isSafeInteger(time)||time<0||time>Date.parse('9999-12-31T23:50:00Z'))throw fail('CLOCK_INVALID');return time;}
function harness(capability){const h=harnesses.get(capability);if(!h||path.resolve(h.store.filePath)!==h.filePath||fs.realpathSync(h.filePath)!==h.realPath)throw fail('CLOSED');return h;}
// No credential resolver, production issuer, global-fetch fallback, scheduler
// hook or environment switch exists. Only explicit trusted test composition.
export function createMetaContainerObserverMock({store,receiptStore,fetchImpl,environment,now=Date.now,timeoutMs=5000}){
  if(environment!=='test'||!isLocalFileStore(store)||typeof receiptStore?.readProtectedMetaPublication!=='function'
    ||typeof fetchImpl!=='function'||fetchImpl===globalThis.fetch||typeof now!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000)throw fail('CLOSED');
  const filePath=path.resolve(store.filePath);if(!fs.lstatSync(filePath).isFile()||fs.lstatSync(filePath).isSymbolicLink())throw fail('CLOSED');
  const capability=Object.freeze(Object.create(null));harnesses.set(capability,{store,receiptStore,fetchImpl,filePath,realPath:fs.realpathSync(filePath),now,timeoutMs});return capability;
}
export function assertMetaContainerObserverMock(capability,store,env){const h=harness(capability);if(h.store!==store||env.NODE_ENV!=='test')throw fail('CLOSED');}
const result=row=>({contract:META_CONTAINER_OBSERVER_CONTRACT,requestId:row.requestId,anchor:row.anchor,
  statusCode:row.statusCode,errorCode:row.errorCode,observedAt:row.observedAt,
  attemptState:row.state,requiresReview:row.hold,outcome:'unresolved_do_not_resend',resultId:null,
  simulated:true,transportMocked:true,providerReadPerformed:false,executedExternally:false,publishingEnabled:false,replayPermitted:false});
function ledger(value){
  if(value===undefined||value===null)return {contract:META_CONTAINER_OBSERVER_CONTRACT,attempts:[]};
  exact(value,['contract','attempts']);if(value.contract!==META_CONTAINER_OBSERVER_CONTRACT||!Array.isArray(value.attempts)||value.attempts.length>32)throw fail('LEDGER_INVALID');
  const ids=new Set();for(const row of value.attempts){
    exact(row,['requestId','selection','anchor','actor','startedAt','state','hold','statusCode','errorCode','observedAt']);
    validateMetaObservationAnchor(row.anchor);exact(row.actor,['userId','sessionVersion']);metaReceiptActor(row.actor);
    if(!requestId(row.requestId)||ids.has(row.requestId)||!digest(row.selection)||!Number.isSafeInteger(row.startedAt)||row.startedAt<0
      ||!['reserved','complete','unknown'].includes(row.state)||typeof row.hold!=='boolean'
      ||row.statusCode!==null&&!META_CONTAINER_STATUSES.includes(row.statusCode)
      ||row.errorCode!==null&&!/^META_CONTAINER_OBSERVER_[A-Z_]{1,50}$/.test(row.errorCode)
      ||row.observedAt!==null&&(!Number.isSafeInteger(row.observedAt)||row.observedAt<row.startedAt)
      ||row.state==='reserved'&&(!row.hold||row.statusCode!==null||row.errorCode!==null||row.observedAt!==null)
      ||row.state==='complete'&&(row.hold||row.statusCode===null||row.errorCode!==null||row.observedAt===null)
      ||row.state==='unknown'&&(row.statusCode!==null||row.errorCode===null))throw fail('LEDGER_INVALID');
    ids.add(row.requestId);
  }return structuredClone(value);
}
function current(state,session,proof,writeId){
  assertMetaPublicationOwner(state,session);
  const projection=protectedMetaReceiptProjection(proof,session.workspaceId,writeId),anchor=protectedMetaPublicationAdmission(proof,session.workspaceId,writeId);
  if(!anchor||!['uncertain','executing'].includes(projection.write.status))throw fail('NO_KNOWN_RECEIPT');
  validateMetaObservationAnchor(anchor);
  if(contentWriteSnapshot(metaReceiptProjection(state,writeId))!==contentWriteSnapshot(projection))throw fail('RECEIPT_CHANGED');
  const records=state.connections?.filter(row=>row.provider==='meta')||[],connection=records[0],settings=connectionSettings(state,'meta');
  if(records.length!==1||connection.id!==anchor.connectionId||connection.status!=='connected'||connection.metadata?.accountId!==anchor.account
    ||settings.disconnected||!Number.isSafeInteger(settings.revision)||settings.revision<0||!settings.metaPageIds?.includes(anchor.pageId))throw fail('SOURCE_CHANGED');
  assertManualContentScope(connection,session.workspaceId);assertManualContentScope(settings,session.workspaceId);
  const pages=connection.metadata?.assets?.pages?.filter(row=>row.id===anchor.pageId)||[],scopes=connection.metadata?.grantedScopes;
  if(pages.length!==1||pages[0].instagram?.id!==anchor.instagramId||!Array.isArray(scopes)
    ||['instagram_basic','instagram_content_publish'].some(scope=>!scopes.includes(scope)))throw fail('SOURCE_CHANGED');
  const source={anchor,actor:metaReceiptActor(session),settingsRevision:settings.revision,scopes:[...scopes].sort()};
  return {anchor,selection:sha(source)};
}
async function proofFor(h,session,writeId){
  assertMetaPublicationOwner(await h.store.get(session.workspaceId),session);
  const proof=await h.receiptStore.readProtectedMetaPublication(session.workspaceId,writeId,session);
  harnessPath(h);assertMetaPublicationOwner(await h.store.get(session.workspaceId),session);return proof;
}
function harnessPath(h){if(path.resolve(h.store.filePath)!==h.filePath||fs.realpathSync(h.filePath)!==h.realPath)throw fail('CLOSED');}
async function update(h,session,callback){harnessPath(h);return updateLocalMetaObserver(h.store,session.workspaceId,callback,h.filePath);}
async function disclose(h,writeId,session,input,value){
  // Settlement and lock release both await I/O. Repeat current authority and
  // source proof after those awaits, including the retained-request fast path.
  try {
    const proof=await proofFor(h,session,writeId),state=await h.store.get(session.workspaceId);
    const selected=current(state,session,proof,writeId);harnessPath(h);
    if(selected.selection!==input.selection||contentWriteSnapshot(value.anchor)!==contentWriteSnapshot(selected.anchor))throw fail('SELECTION_STALE');
    return value;
  }catch{throw fail('AUTHORITY_CHANGED',403);}
}
export async function previewMetaContainerObserver(capability,writeId,session){
  const h=harness(capability),proof=await proofFor(h,session,writeId),state=await h.store.get(session.workspaceId);
  const selected=current(state,session,proof,writeId),retained=ledger(state.integrationStatus?.meta?.containerObserver);
  return {contract:META_CONTAINER_OBSERVER_CONTRACT,...selected,liveEnabled:false,transportMocked:true,
    attempts:retained.attempts.filter(row=>row.anchor.writeId===writeId&&contentWriteSnapshot(row.actor)===contentWriteSnapshot(metaReceiptActor(session))).map(result)};
}
export async function runMetaContainerObserver(capability,writeId,session,input){
  exact(input,['requestId','selection']);if(!requestId(input.requestId)||!digest(input.selection))throw fail('INPUT_INVALID',400);
  const h=harness(capability),proof=await proofFor(h,session,writeId);
  let admitted;
  try {admitted=await update(h,session,(state,peers)=>{
    const selected=current(state,session,proof,writeId),own=ledger(state.integrationStatus?.meta?.containerObserver);
    const prior=own.attempts.find(row=>row.requestId===input.requestId);
    if(prior){if(prior.selection!==input.selection||contentWriteSnapshot(prior.anchor)!==contentWriteSnapshot(selected.anchor)||contentWriteSnapshot(prior.actor)!==contentWriteSnapshot(metaReceiptActor(session)))throw fail('REQUEST_CONFLICT');
      return {unchanged:true,value:{retained:result(prior)}};}
    if(selected.selection!==input.selection)throw fail('SELECTION_STALE');
    const time=clock(h),all=peers.flatMap(value=>ledger(value).attempts);
    if(all.some(row=>row.startedAt>time))throw fail('CLOCK_INVALID');
    if(own.attempts.length>=32||all.length>=128)throw fail('CAPACITY');
    const account=all.filter(row=>row.anchor.account===selected.anchor.account);
    const container=all.filter(row=>row.anchor.containerId===selected.anchor.containerId);
    if(container.length>=5||container.length&&time-Math.min(...container.map(row=>row.startedAt))>=300000)throw fail('ATTEMPTS_EXHAUSTED');
    if(all.filter(row=>row.hold).length>=2||account.some(row=>row.hold))throw fail('BUSY',429);
    if(account.some(row=>time-row.startedAt<60000))throw fail('CADENCE',429);
    const row={requestId:input.requestId,selection:input.selection,anchor:selected.anchor,actor:metaReceiptActor(session),startedAt:time,
      state:'reserved',hold:true,statusCode:null,errorCode:null,observedAt:null};own.attempts.push(row);
    return {ledger:ledger(own),value:{row}};
  });}catch(error){if(error?.code?.startsWith('META_CONTAINER_OBSERVER_')||error?.code==='WRITE_ACTOR_CHANGED')throw error;throw fail('ADMISSION_UNKNOWN',503);}
  if(admitted.retained)return disclose(h,writeId,session,input,admitted.retained);
  let response=null,errorCode=null,hold=false;
  try{
    const fresh=await proofFor(h,session,writeId);
    await update(h,session,(state)=>{const selected=current(state,session,fresh,writeId),own=ledger(state.integrationStatus?.meta?.containerObserver);
      const row=own.attempts.find(item=>item.requestId===input.requestId);
      if(selected.selection!==input.selection||contentWriteSnapshot(row)!==contentWriteSnapshot(admitted.row))throw fail('SELECTION_STALE');
      return {unchanged:true,value:true};});
    // The lock-release await can itself permit a revocation/configuration save.
    // Re-read authority, receipt and reservation after it, just before send.
    const sendProof=await proofFor(h,session,writeId),sendState=await h.store.get(session.workspaceId);
    const selected=current(sendState,session,sendProof,writeId),sendRow=ledger(sendState.integrationStatus?.meta?.containerObserver).attempts.find(row=>row.requestId===input.requestId);
    if(selected.selection!==input.selection||contentWriteSnapshot(sendRow)!==contentWriteSnapshot(admitted.row))throw fail('SELECTION_STALE');
    harnessPath(h);
    response=await metaMethods.metaRequest.call({fetch:h.fetchImpl,env:{META_CLIENT_SECRET:'synthetic-meta-observer-secret'}},
      '/'+admitted.row.anchor.containerId,'synthetic-meta-observer-token',{query:{fields:'id,status_code'},containerStatusRead:true,readTimeoutMs:h.timeoutMs});
  }catch(error){errorCode=/^META_CONTAINER_OBSERVER_(?:TIMEOUT|RESPONSE_UNKNOWN|RESPONSE_INVALID|RESPONSE_LIMIT|RATE_LIMITED|ACCESS_DENIED)$/.test(error?.code||'')?error.code:'META_CONTAINER_OBSERVER_AUTHORITY_CHANGED';hold=['META_CONTAINER_OBSERVER_TIMEOUT','META_CONTAINER_OBSERVER_RATE_LIMITED','META_CONTAINER_OBSERVER_ACCESS_DENIED'].includes(errorCode);}
  let finalProof;
  try{finalProof=await proofFor(h,session,writeId);}catch{errorCode='META_CONTAINER_OBSERVER_AUTHORITY_CHANGED';response=null;}
  let denied=false;
  try{return await update(h,session,(state)=>{
    const own=ledger(state.integrationStatus?.meta?.containerObserver),row=own.attempts.find(item=>item.requestId===input.requestId);
    if(contentWriteSnapshot(row)!==contentWriteSnapshot(admitted.row))throw fail('ADMISSION_UNKNOWN',503);
    try{if(current(state,session,finalProof,writeId).selection!==input.selection)throw fail('SELECTION_STALE');}
    catch{denied=true;errorCode='META_CONTAINER_OBSERVER_AUTHORITY_CHANGED';response=null;}
    const observedAt=clock(h);if(observedAt<row.startedAt)throw fail('CLOCK_INVALID');
    Object.assign(row,{state:errorCode?'unknown':'complete',hold,statusCode:response?.status_code??null,errorCode,observedAt});
    return {ledger:ledger(own),value:result(row)};
  }).then(value=>{if(denied)throw fail('AUTHORITY_CHANGED',403);return disclose(h,writeId,session,input,value);});}
  catch(error){if(error?.code==='META_CONTAINER_OBSERVER_AUTHORITY_CHANGED')throw error;throw fail('COMMIT_UNKNOWN',503);}
}
