import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { beginConnectionSync, connectionSettings, connectionReadAttempts, shopifyOrderReadHold, shopifyOrderReadPolicyBlocked } from './connection-centre.mjs';
import { validateImportedData } from './connection-doctor.mjs';
import { shopifyOrderRecoveryDisplayObservation } from './shopify-order-source.mjs';
import { createShopifyOrderRecoveryBinding, createShopifyOrderRecoveryStage, resumeShopifyOrderRecoveryStage,
  createShopifyOrderRecoveryCapability, getShopifyOrderRecoveryStage } from './shopify-order-recovery.mjs';
import { ORDER_RECOVERY_CONTRACT, orderRecoveryError, prepareOrderRecoveryContext, orderRecoveryAcknowledgement, validateOrderRecoveryActor } from './shopify-order-recovery-store.mjs';

const clone = structuredClone;
const markerSchema = 'shopify-order-recovery-marker/v1';
const safeWindow = window => window ? {requestedLowerBound:window.requestedLowerBound,requestedUpperBound:window.requestedUpperBound,sortKey:window.sortKey,reverse:window.reverse} : null;
const stamp = () => new Date().toISOString();
export function orderRecoveryActor(session) {
  return validateOrderRecoveryActor({id:session.sub,sessionVersion:Number(session.sessionVersion || 1),sessionDigest:crypto.createHash('sha256').update(JSON.stringify(session)).digest('hex'),expiresAt:new Date(session.exp * 1000).toISOString()});
}
export function orderRecoveryAvailable(store, env) {
  return env.SHOPIFY_ORDER_RECOVERY_CONTRACT === ORDER_RECOVERY_CONTRACT && store.provider === 'supabase' && store.orderRecoveryCapability === ORDER_RECOVERY_CONTRACT
    && ['readOrderRecovery','appendOrderRecovery','getOrderRecoveryContext','save'].every(key=>typeof store[key] === 'function');
}
function activeActor(state, actor) {
  const matches = state.users?.filter(user=>user?.id === actor.id) || [];
  if (state.workspace?.id == null || matches.length !== 1 || !['owner','admin'].includes(matches[0].role) || matches[0].active === false || matches[0].passwordChangeRequired
    || Number(matches[0].sessionVersion || 1) !== actor.sessionVersion || Date.parse(actor.expiresAt) <= Date.now()) throw orderRecoveryError('ACTOR_INVALID',403);
  return matches[0];
}
function currentSource(state, integrations, binding, { admission = null } = {}) {
  const settings = connectionSettings(state,'shopify');
  const records = state.connections?.filter(record=>record.provider === 'shopify') || [];
  if (records.length !== 1 || !records[0].encryptedCredentials || !records[0].id || settings.disconnected || !settings.areas.includes('orders')) throw orderRecoveryError('SOURCE_UNAVAILABLE');
  if (shopifyOrderReadHold(state,'shopify',integrations) || shopifyOrderReadPolicyBlocked(state,integrations,['orders'])) throw orderRecoveryError('SOURCE_HELD');
  const expiry = integrations.connectionAccessExpiry?.(records[0]);
  if (expiry !== null && expiry !== undefined && (!Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now() + 60000)) throw orderRecoveryError('AUTH_REFRESH_REQUIRED');
  if (!integrations.shopifyConfig?.(state)?.accessToken) throw orderRecoveryError('AUTH_REFRESH_REQUIRED');
  const current = createShopifyOrderRecoveryBinding(state,integrations,{startedAt:binding.startedAt});
  if (!isDeepStrictEqual(current,binding)) throw orderRecoveryError('SOURCE_CHANGED');
  const doctor = state.connectionDoctor?.shopify || {}, debt = connectionReadAttempts(doctor);
  if (!Number.isSafeInteger(debt) || debt < 0 || debt > 5 || !admission && (doctor.exhausted === true || debt >= 5)) throw orderRecoveryError('BUDGET_EXHAUSTED');
  if (admission) {
    const runs = state.connectionSyncs?.filter(run=>run.id === admission.runId) || [], run = runs[0];
    const marker = state.integrationStatus?.shopify?.orderRecovery;
    if (runs.length !== 1 || run.provider !== 'shopify' || run.status !== 'running' || run.leaseUntil !== admission.leaseUntil || Date.parse(admission.leaseUntil) <= Date.now()
      || run.actor !== admission.actorId || !Array.isArray(run.areas) || run.areas.length !== 1 || run.areas[0] !== 'orders' || debt !== admission.attempt
      || marker?.schema !== markerSchema || marker.runId !== run.id || marker.stageId !== run.orderRecoveryStageId || !['reading','complete'].includes(marker.status)) throw orderRecoveryError('AUTHORITY_CHANGED');
  } else if ((state.connectionSyncs || []).some(run=>run.provider === 'shopify' && run.status === 'running' && Date.parse(run.leaseUntil)>Date.now()) || Date.parse(doctor.leaseUntil)>Date.now()) throw orderRecoveryError('LEASE_ACTIVE');
  return records[0];
}
function publicStage(stage) {
  if (!stage) return null;
  const times = stage.pageCaptureTimes || stage.pages?.map(page=>page.capturedAt) || [];
  return {status:stage.status,pageCount:stage.pageCount ?? stage.pages.length,orderCount:stage.ordersRead ?? stage.pages.reduce((sum,page)=>sum+page.orders.length,0),
    originalStartedAt:stage.binding.startedAt,lastCapturedAt:times.at(-1) || null,continued:stage.continued,snapshotConsistency:'unverified',window:safeWindow(stage.binding.window)};
}
export function publicOrderRecoveryObservation(state) {
  return shopifyOrderRecoveryDisplayObservation(state);
}
function resultDTO(workspaceId, stage, status, code = null) {
  const publicValue = publicStage(stage);
  return {schema:'runvara-order-recovery-result/v1',workspaceId,status,originalStartedAt:publicValue.originalStartedAt,lastCapturedAt:publicValue.lastCapturedAt,
    continued:publicValue.continued,snapshotConsistency:'unverified',code};
}
function completeFirstSync(state, binding, now) {
  const first = state.connectionFirstSync?.shopify;
  if (!binding.firstSync || !first || !Object.hasOwn(first.areas || {},'orders')) return;
  first.areas.orders = 'completed';
  first.failures = {...first.failures}; delete first.failures.orders;
  first.validation = validateImportedData(state,'shopify',{areas:Object.keys(first.areas)});
  const allComplete = Object.values(first.areas).every(value=>value === 'completed') && !Object.keys(first.failures).length && first.validation.ok;
  first.status = allComplete ? 'completed' : 'partial';
  first.completedAt = now;
}

export function createOrderRecoveryRunner({store,integrations,env}) {
  const selections = new Map(), unknown = new Map();
  const available = () => orderRecoveryAvailable(store,env);
  const clearExpired = () => { for (const [key,value] of selections) if (value.expiresMs<=Date.now()) selections.delete(key); };
  async function preview(state,actor) {
    activeActor(state,actor);
    const workspaceId = state.workspace.id;
    const base = {schema:'runvara-order-recovery-preview/v1',workspaceId,available:available(),selection:null,expiresAt:null,originalStartedAt:null,window:null,stage:null,canStart:false,canResume:false,reason:null};
    if (!base.available) return {...base,reason:'ORDER_RECOVERY_UNAVAILABLE'};
    const read = await store.readOrderRecovery(workspaceId,actor,null,{view:'summary'});
    const unresolved = unknown.get(workspaceId);
    if (unresolved) {
      let proof = null;
      if (unresolved.reconciliation && typeof store.lookupOrderRecovery === 'function') {
        // This is a new explicit review, never an automatic retry loop.
        try { proof = await store.lookupOrderRecovery(workspaceId,actor,unresolved.reconciliation); } catch {}
      }
      const uncertainRun = state.connectionSyncs?.find(run=>run.id === unresolved.runId);
      const failedRun = unresolved.kind === 'failure' && read.stage?.id === unresolved.stageId && (uncertainRun?.status === 'failed' || Date.parse(uncertainRun?.leaseUntil)<=Date.now());
      if (proof || failedRun || ['reserve','append'].includes(unresolved.kind) && read.stage?.id === unresolved.stageId || unresolved.kind === 'reserve' && read.stage === null) unknown.delete(workspaceId);
    }
    const binding = read.stage?.binding || createShopifyOrderRecoveryBinding(state,integrations,{startedAt:stamp()});
    Object.assign(base,{originalStartedAt:binding.startedAt,window:safeWindow(binding.window),stage:publicStage(read.stage)});
    let reason = unknown.has(workspaceId) ? 'ORDER_RECOVERY_UNKNOWN' : read.mode !== 'enforced' ? 'ORDER_RECOVERY_UNAVAILABLE' : null;
    if (!reason && read.stage && !['reading','failed','complete'].includes(read.stage.status)) reason = `ORDER_RECOVERY_${read.stage.status.toUpperCase()}`;
    if (!reason && !read.stage && read.quota.unfinishedStages >= 8) reason = 'ORDER_RECOVERY_CAPACITY_EXHAUSTED';
    if (!reason && read.quota.logicalBytes >= read.quota.maxBytes - 8192) reason = 'ORDER_RECOVERY_GLOBAL_CAPACITY_EXHAUSTED';
    if (!reason) try { currentSource(state,integrations,binding); } catch (error) { reason = error.code || 'ORDER_RECOVERY_SOURCE_UNAVAILABLE'; }
    if (reason) return {...base,reason};
    clearExpired(); while (selections.size >= 256) selections.delete(selections.keys().next().value);
    const selection = crypto.randomBytes(32).toString('base64url'), expiresMs = Math.min(Date.now()+300000,Date.parse(actor.expiresAt));
    selections.set(selection,{workspaceId,actor:clone(actor),revision:state._revision,binding:clone(binding),stageId:read.stage?.id || null,stageRevision:read.stage?.revision || 0,expiresMs});
    return {...base,selection,expiresAt:new Date(expiresMs).toISOString(),canStart:!read.stage,canResume:Boolean(read.stage)};
  }
  async function run(state,actor,action,body) {
    if (!available()) throw orderRecoveryError('UNAVAILABLE',503);
    activeActor(state,actor);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.selection !== 'string') throw orderRecoveryError('SELECTION_INVALID');
    const selected = selections.get(body.selection); selections.delete(body.selection);
    if (!selected || selected.workspaceId !== state.workspace.id || selected.revision !== state._revision || !isDeepStrictEqual(selected.actor,actor)
      || !['start','resume'].includes(action) || (action === 'resume') !== Boolean(selected.stageId)) throw orderRecoveryError('SELECTION_INVALID');
    if (selected.expiresMs <= Date.now()) throw orderRecoveryError('SELECTION_EXPIRED');
    if (unknown.has(state.workspace.id)) throw orderRecoveryError('UNKNOWN',503,false);
    const workspaceId = state.workspace.id;
    currentSource(state,integrations,selected.binding);
    const read = await store.readOrderRecovery(workspaceId,actor,selected.stageId,{view:'full'});
    if (read.mode !== 'enforced') throw orderRecoveryError('UNAVAILABLE',503);
    if ((read.stage?.id || null) !== selected.stageId || (read.stage?.revision || 0) !== selected.stageRevision || read.stage && !isDeepStrictEqual(read.stage.binding,selected.binding)) throw orderRecoveryError('SELECTION_INVALID');
    activeActor(state,actor); currentSource(state,integrations,selected.binding);
    const stageId = selected.stageId || `sorstage_${crypto.randomUUID()}`;
    const priorDoctor = clone(state.connectionDoctor?.shopify || {}), attempt = connectionReadAttempts(priorDoctor)+1;
    const run = beginConnectionSync(state,'shopify',{areas:['orders'],actor:actor.id,integrations}); run.orderRecoveryStageId = stageId;
    const admission = {runId:run.id,leaseUntil:run.leaseUntil,attempt,workspaceRevision:state._revision,actorId:actor.id,actorSessionVersion:actor.sessionVersion,sessionDigest:actor.sessionDigest};
    let stage = read.stage ? resumeShopifyOrderRecoveryStage(read.stage,admission) : createShopifyOrderRecoveryStage({id:stageId,binding:selected.binding,admission});
    state.connectionDoctor = {...state.connectionDoctor,shopify:{...priorDoctor,attempts:attempt,exhausted:attempt>=5,orderReadBinding:clone(selected.binding.source)}};
    state.integrationStatus = {...state.integrationStatus,shopify:{...state.integrationStatus?.shopify,orderRecovery:{schema:markerSchema,stageId,runId:run.id,status:stage.status,attempt}}};
    const descriptor = {kind:'reserve',stageId,admission,actor,expectedStageRevision:selected.stageRevision,binding:selected.binding,expectedStatus:stage.status};
    try { state = await store.save(workspaceId,state,{ownedSnapshot:true,protectedOrderRecovery:descriptor}); }
    catch (error) {
      if (error.definitive === false) {
        const result = resultDTO(workspaceId,stage,'unknown','ORDER_RECOVERY_UNKNOWN');
        unknown.set(workspaceId,{stageId,kind:'reserve',reconciliation:error.reconciliation,publicResult:result}); return result;
      }
      throw error;
    }
    const context = prepareOrderRecoveryContext(state,actor.id,selected.binding.source.connectionId,run.id);
    const assertCurrent = async () => {
      activeActor(state,actor);
      if (Date.parse(admission.leaseUntil)<=Date.now()) throw orderRecoveryError('LEASE_EXPIRED');
      const fresh = await store.getOrderRecoveryContext(workspaceId,context,{actor,stageId});
      activeActor(fresh,actor); currentSource(fresh,integrations,selected.binding,{admission});
    };
    const capability = createShopifyOrderRecoveryCapability({stage,atomicAppend:true,assertCurrent,appendPage:async (page,nextStage) => {
      const result = await store.appendOrderRecovery(workspaceId,{kind:'append',stageId,admission,actor,expectedStageRevision:stage.revision,page,expectedStatus:nextStage?.status || 'paused'});
      if (result.ack.status === 'paused' && nextStage?.status !== 'paused') { stage = {...stage,revision:result.ack.stageRevision,status:'paused',logicalBytes:result.ack.logicalBytes}; throw orderRecoveryError('CAPACITY_EXHAUSTED'); }
      stage = nextStage;
    }});
    const admittedSnapshot = clone(state), previousStatus = clone(state.integrationStatus.shopify), previousConnections = clone(state.connections), chargedDoctor = clone(state.connectionDoctor.shopify);
    let imported = false, finalizationStarted = false;
    try {
      await integrations.syncShopify(state,{areas:['orders'],orderRecovery:capability});
      imported = true;
      stage = getShopifyOrderRecoveryStage(capability);
      if (stage.status !== 'complete') throw orderRecoveryError('INCOMPLETE');
      await assertCurrent();
      const now = stamp(), admittedRun = state.connectionSyncs.find(item=>item.id === run.id);
      Object.assign(admittedRun,{status:'completed',stage:'Finished',completedAt:now,errorCode:null});
      const first = state.connectionFirstSync?.shopify;
      const unrelatedFailures = [...new Set([...(previousStatus.failedAreas || []),...Object.keys(first?.failures || {}),...Object.entries(first?.areas || {}).filter(([,status])=>status !== 'completed').map(([area])=>area)])].filter(area=>area!=='orders');
      state.connections = previousConnections;
      state.connectionDoctor.shopify = chargedDoctor;
      state.integrationStatus.shopify = {...previousStatus,status:unrelatedFailures.length ? 'degraded' : 'connected',lastSyncAt:stage.binding.startedAt,lastSuccessfulSyncAt:stage.binding.startedAt,
        lastError:unrelatedFailures.length ? previousStatus.lastError ?? null : null,failedAreas:unrelatedFailures,areaSuccessAt:{...previousStatus.areaSuccessAt,orders:stage.binding.startedAt},
        orderReadAttempt:{status:'complete',at:stage.binding.startedAt,retryable:false},orderRecovery:{...previousStatus.orderRecovery,status:'committed'}};
      delete state.integrationStatus.shopify.orderReadHold;
      completeFirstSync(state,stage.binding,now);
      // Only the five RPC contract can promote canonical orders and release
      // page storage. A normal save or mutable manifest cannot prove completion.
      finalizationStarted = true;
      const finalState = await store.save(workspaceId,state,{ownedSnapshot:true,protectedOrderRecovery:{kind:'finalize',stageId,admission,actor,expectedStageRevision:stage.revision,expectedStatus:'committed'}});
      if (!orderRecoveryAcknowledgement(finalState)) throw orderRecoveryError('COMMIT_UNCONFIRMED',503,false);
      return resultDTO(workspaceId,stage,'committed');
    } catch (error) {
      if (error.definitive === false || error.code === 'ORDER_RECOVERY_COMMIT_UNCONFIRMED') {
        const result = resultDTO(workspaceId,stage,'unknown','ORDER_RECOVERY_UNKNOWN');
        unknown.set(workspaceId,{stageId,kind:error.reconciliation?.expected.kind || 'finalize',reconciliation:error.reconciliation,publicResult:result});
        return result;
      }
      // A definite provider failure before an exhausted traversal can finish
      // this lease. Persist only the detached admission snapshot; never any
      // candidate order data, unknown mutation or failed final transaction.
      if (!imported && !finalizationStarted && ['reading','paused'].includes(stage.status) && !/AUTHORITY|SOURCE_CHANGED|CONFIGURATION_CHANGED|CONTEXT|LEASE|PERSISTENCE|SUPABASE/.test(error.code || '')) {
        try {
          await assertCurrent();
          const failedAt = stamp(),failedRun = admittedSnapshot.connectionSyncs.find(item=>item.id === run.id);
          Object.assign(failedRun,{status:'failed',stage:'Needs attention',completedAt:failedAt,errorCode:error.code || 'ORDER_RECOVERY_READ_FAILED'});
          admittedSnapshot.integrationStatus.shopify={...previousStatus,status:'degraded',lastFailureAt:failedAt,lastError:error.code || 'ORDER_RECOVERY_READ_FAILED',orderRecovery:{...previousStatus.orderRecovery,status:stage.status === 'paused' ? 'paused' : 'failed'}};
          if (/^SHOPIFY_ORDER_SOURCE_/.test(error.code || '')) admittedSnapshot.integrationStatus.shopify.orderReadHold={code:error.code,at:failedAt,binding:clone(stage.binding.source)};
          await store.save(workspaceId,admittedSnapshot,{ownedSnapshot:true,beforeCommit:()=>{activeActor(admittedSnapshot,actor);if(Date.parse(admission.leaseUntil)<=Date.now())throw orderRecoveryError('LEASE_EXPIRED');}});
        } catch (failure) {
          // Failed failure-bookkeeping is still charged. A later explicit
          // read may settle it, but this request never retries the provider.
          if (/PERSISTENCE|SUPABASE|UNCONFIRMED/.test(failure.code || '') || failure.definitive === false) {
            const result = resultDTO(workspaceId,stage,'unknown','ORDER_RECOVERY_UNKNOWN');
            unknown.set(workspaceId,{stageId,runId:run.id,kind:'failure',publicResult:result});return result;
          }
        }
      }
      return resultDTO(workspaceId,stage,'interrupted',/^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'ORDER_RECOVERY_READ_FAILED');
    }
  }
  return {available,preview,run};
}
