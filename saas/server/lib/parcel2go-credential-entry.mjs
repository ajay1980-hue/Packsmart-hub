import {createParcel2GoSandboxPolicy,createParcel2GoSandboxCandidate} from './parcel2go-sandbox.mjs';
import {assertQuietOwnerWorkspace} from './quiet-owner-workspace.mjs';
import {metaStrictJson} from './meta-publication-bounded.mjs';
export const PARCEL2GO_ENTRY_PATH='/api/owner/parcel2go-credentials';
export const PARCEL2GO_ENTRY_FLAG='RUNVARA_QUIET_PARCEL2GO_CREDENTIAL_ENTRY';
const fail=code=>{throw Object.assign(new Error('Private credential admission stopped. Check saved status; do not repeat an uncertain request.'),{status:409,code:'PARCEL2GO_'+code});};
const windows=new WeakMap();
export function createParcel2GoCredentialWindow(env){
  const flag=env[PARCEL2GO_ENTRY_FLAG]??'disabled/v1';if(flag==='disabled/v1')return null;
  if(flag!=='enabled/v1'||env.RUNVARA_STARTUP_MODE!=='quiet'||env.RUNVARA_QUIET_OWNER_WORKSPACE!=='enabled/v1')fail('ENTRY_CONFIG_INVALID');
  if(['RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE','RUNVARA_QUIET_SHOPIFY_CATALOGUE'].some(k=>env[k]==='enabled/v1'))fail('ENTRY_CONFIG_INVALID');
  const config={mode:'credential-entry/v1',startupMode:'quiet',operation:'admit_credentials',
    requestId:env.RUNVARA_PARCEL2GO_ENTRY_REQUEST_ID,expectedRevision:env.RUNVARA_PARCEL2GO_ENTRY_EXPECTED_REVISION,
    openedAt:env.RUNVARA_PARCEL2GO_ENTRY_OPENED_AT,expiresAt:env.RUNVARA_PARCEL2GO_ENTRY_EXPIRES_AT,
    expectedClientId:env.RUNVARA_PARCEL2GO_ENTRY_EXPECTED_CLIENT_ID,termsReference:env.RUNVARA_PARCEL2GO_ENTRY_TERMS_REFERENCE,
    binding:{workspaceId:'packsmart-solutions',connectionId:env.RUNVARA_PARCEL2GO_ENTRY_CONNECTION_ID,accountId:env.RUNVARA_PARCEL2GO_ENTRY_ACCOUNT_ID,environment:'sandbox'}};
  const policy=createParcel2GoSandboxPolicy(config),w=Object.freeze({available:policy.available,remainingMs:policy.remainingMs,expiresAt:policy.expiresAt});
  windows.set(w,{config,policy,attempted:false});return w;
}
function owner(auth){
  try{assertQuietOwnerWorkspace(auth,{inspectEvidence:false});}catch{fail('OWNER_REQUIRED');}
  const s=auth.session,u=auth.state.users.find(u=>u.id===s.sub);
  if(typeof s.sub!=='string'||!s.sub||!Number.isSafeInteger(s.sessionVersion)||s.sessionVersion<1||u?.active!==true||u.sessionVersion!==s.sessionVersion
    ||!Number.isSafeInteger(s.exp)||s.exp*1000<=Date.now())fail('OWNER_REQUIRED');
}
export function parcel2GoEntryStatus(window,auth){
  const p=windows.get(window);if(!p)return null;owner(auth);
  const {state,session}=auth,{config:c}=p,runs=state.parcel2goSandboxRuns||[];
  let outcome='not_started';
  const rows=Array.isArray(runs)?runs.filter(r=>r.requestId===c.requestId):[];
  const row=rows[0],matched=rows.length===1&&row.operation==='admit_credentials'&&row.connectionId===c.binding.connectionId&&row.accountId===c.binding.accountId&&row.environment==='sandbox';
  const saved=(state.connections||[]).filter(c=>c.provider==='parcel2go'&&c.id===p.config.binding.connectionId&&c.metadata?.account===p.config.binding.accountId&&c.metadata?.environment==='sandbox'&&c.metadata?.admissionRequestId===p.config.requestId&&typeof c.encryptedCredentials==='string');
  if(rows.length)outcome=matched&&row.status==='completed'&&saved.length===1?'stored':'reconcile_no_replay';
  else if(p.attempted||!Array.isArray(runs)||runs.length>=20||runs.some(r=>r.status==='reserved'))outcome='reconcile_no_replay';
  else if((state.connections||[]).some(x=>x.provider==='parcel2go'||x.id===c.binding.connectionId))outcome='connection_exists';
  else if(state._revision!==c.expectedRevision)outcome='state_changed';
  const remainingMs=Math.max(0,Math.min(window.remainingMs(),session.exp*1000-Date.now()));
  return Object.freeze({schema:'runvara-parcel2go-credential-entry/v1',requestId:c.requestId,expectedRevision:c.expectedRevision,
    accountId:c.binding.accountId,connectionId:c.binding.connectionId,environment:'sandbox',expiresAt:c.expiresAt,remainingMs,
    canSubmit:remainingMs>0&&outcome==='not_started',outcome,providerCalls:false,scope:'public-api'});
}
export function parseParcel2GoEntry(bytes){
  try{
    if(bytes.length>12288)fail('ENTRY_INPUT_INVALID');const b=metaStrictJson(bytes);
    if(!b||Array.isArray(b)||Object.keys(b).sort().join('|')!=='clientId|clientSecret|confirmed|expectedRevision|requestId'||b.confirmed!==true)fail('ENTRY_INPUT_INVALID');
    for(const k of ['clientId','clientSecret'])if(typeof b[k]!=='string'||b[k].length<8||b[k].length>4096||/[\x00-\x20\x7f]/.test(b[k]))fail('ENTRY_INPUT_INVALID');
    return b;
  }catch{fail('ENTRY_INPUT_INVALID');}
}
export async function saveParcel2GoEntry({window,store,key,auth,body,assertCurrent=()=>{}}){
  const p=windows.get(window);if(!p||store.provider!=='supabase')fail('DISABLED');owner(auth);
  const status=parcel2GoEntryStatus(window,auth);
  if(!status.canSubmit||body.confirmed!==true||body.requestId!==status.requestId||body.expectedRevision!==status.expectedRevision||body.clientId!==p.config.expectedClientId)fail('ENTRY_NOT_ADMITTED');
  p.attempted=true;
  const runner=createParcel2GoSandboxCandidate({policy:p.policy,store,key,assertCurrent});
  // No transport parameter exists at this owner route. This operation cannot
  // exchange a token or quote; credentials leave the browser only for Runvara.
  await runner.run({session:auth.session,csrf:auth.session.csrf,credentials:{clientId:body.clientId,clientSecret:body.clientSecret,token:null}});
  const current=await store.get(auth.session.workspaceId,{exactSnapshot:true});assertCurrent();
  return parcel2GoEntryStatus(window,{...auth,state:current});
}
