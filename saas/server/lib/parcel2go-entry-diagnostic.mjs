// Per-request, fixed labels only. Never accept exception messages, codes or data.
const stages=new Set(['request','origin','csrf','owner_auth','body','workspace_lock','fresh_owner_auth','review_binding','credential_admission','saved_status','status_read','status_review','window']);
const causes=new Set(['refused','unavailable','deadline','cancelled']);
export function createEntryDiagnostic(now){
 const start=now();let stage='request',cause;
 return Object.freeze({
  at(value){if(stages.has(value))stage=value;},
  reason(value){if(cause===undefined&&causes.has(value))cause=value;},
  report(){const elapsed=now()-start;return {schema:'parcel2go-entry-diagnostic/v1',stage,cause:cause??'unavailable',durationMs:Number.isFinite(elapsed)?Math.max(0,Math.min(4000,Math.floor(elapsed))):0};}
 });
}
