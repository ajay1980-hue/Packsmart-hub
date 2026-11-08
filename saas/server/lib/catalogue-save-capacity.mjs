import crypto from 'node:crypto';
import { compactDailyBrief } from './operations.mjs';

const rejected = new WeakSet();
export const compactStateBytes = state => Buffer.byteLength(JSON.stringify(state),'utf8');
export const isCatalogueCapacityRejection = error => rejected.has(error);
export function retainedConnectionSyncs(state, limit) {
  const syncs=state.connectionSyncs || [], marker=state.integrationStatus?.shopify?.orderRecovery;
  const pinned=marker?.status!=='committed' && marker?.runId ? syncs.find(run=>run.id===marker.runId) : null;
  const kept=[],archived=[];
  for(const run of syncs) {
    const room=limit-(pinned && !kept.includes(pinned) && run!==pinned ? 1 : 0);
    if(run===pinned || kept.length<room)kept.push(run);else archived.push(run);
  }
  return {kept,archived};
}
export function legacyBriefProjection(brief) {
  if(Object.hasOwn(brief,'archive') || compactStateBytes(brief)<=65536)return brief;
  return {...compactDailyBrief(brief),archive:{table:'operations_briefs',id:brief.id,sha256:crypto.createHash('sha256').update(JSON.stringify(brief)).digest('hex')}};
}
export function saveBookkeeping(state,at) {
  state.workspace.updatedAt=at;
  state.integrationStatus.supabase={status:'connected',detail:'Authoritative workspace state committed.',lastSyncAt:at,lastError:null};
  state.integrationStatus.reporting={...state.integrationStatus.reporting,status:'degraded',detail:'Reporting refresh pending; authoritative state is durable.'};
}
// Pure planning only. Required archives must still be acknowledged by the real
// writer before these projections can be committed. No simulated ack escapes.
export function planCatalogueSaveCapacity(state,{currentBytes,existing,limits,at,briefPlan,retainedAutomationRuns}) {
  const projection=structuredClone(state);
  projection.audit=(projection.audit||[]).slice(0,limits.audit);
  projection.workRecords=(projection.workRecords||[]).slice(0,limits.workRecords);
  projection.connectionSyncs=existing?retainedConnectionSyncs(projection,limits.connectionSyncs).kept:(projection.connectionSyncs||[]).slice(0,limits.connectionSyncs);
  projection.agentRuns=(projection.agentRuns||[]).slice(0,limits.agentRuns);
  projection.dailyBriefs=(projection.dailyBriefs||[]).slice(0,limits.dailyBriefs).map(brief=>existing?legacyBriefProjection(brief):brief);
  if(retainedAutomationRuns)projection.automationRuns=structuredClone(retainedAutomationRuns);
  saveBookkeeping(projection,at);
  const successful=structuredClone(projection),maximum=structuredClone(projection);
  for(const candidate of briefPlan?.candidates || []) {
    if(candidate.index>=projection.dailyBriefs.length)continue;
    successful.dailyBriefs[candidate.index]=structuredClone(candidate.stub);
    // Any subset of optional archive/read acknowledgements can fail. Size each
    // retained element independently, including the older mandatory stub path.
    if(compactStateBytes(candidate.stub)>compactStateBytes(maximum.dailyBriefs[candidate.index])) maximum.dailyBriefs[candidate.index]=structuredClone(candidate.stub);
  }
  const result=Object.freeze({currentBytes,candidateBytes:compactStateBytes(successful),maximumCandidateBytes:compactStateBytes(maximum),hardBytes:limits.hard});
  if(!Number.isSafeInteger(currentBytes) || currentBytes<0 || result.maximumCandidateBytes>=limits.hard) {
    const error=Object.assign(new Error('Catalogue state exceeds its safe capacity.'),{code:'SHOPIFY_CATALOGUE_CAPACITY_REVIEW_REQUIRED',status:409});
    rejected.add(error);throw error;
  }
  return result;
}
