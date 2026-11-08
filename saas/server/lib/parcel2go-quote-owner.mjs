import {createHash} from 'node:crypto';
import {createParcel2GoSandboxPolicy,createParcel2GoSandboxCandidate} from './parcel2go-sandbox.mjs';
import {assertQuietOwnerWorkspace} from './quiet-owner-workspace.mjs';
import {metaStrictJson} from './meta-publication-bounded.mjs';
export const PARCEL2GO_QUOTE_PATH='/api/owner/parcel2go-sandbox-quote';
export const PARCEL2GO_QUOTE_FLAG='RUNVARA_QUIET_PARCEL2GO_SANDBOX_QUOTE';
const windows=new WeakMap(),uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=code=>{throw Object.assign(new Error('Sandbox quote stopped. Check the saved receipt; never repeat an uncertain attempt.'),{status:409,code:'PARCEL2GO_'+code});};
const descriptorKeys=['REQUEST_ID','EXPECTED_REVISION','OPENED_AT','EXPIRES_AT','EXPECTED_CLIENT_ID','TERMS_REFERENCE','CONNECTION_ID','ACCOUNT_ID','ADMISSION_REQUEST_ID','DATA_CONTRACT','SCOPE_POLICY'];
const configKeys=[PARCEL2GO_QUOTE_FLAG,'RUNVARA_STARTUP_MODE','RUNVARA_QUIET_OWNER_WORKSPACE','RUNVARA_QUIET_PARCEL2GO_CREDENTIAL_ENTRY','RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE','RUNVARA_QUIET_SHOPIFY_CATALOGUE',...descriptorKeys.map(k=>'RUNVARA_PARCEL2GO_QUOTE_'+k)];
export function createParcel2GoQuoteWindow(env){
  const flag=env[PARCEL2GO_QUOTE_FLAG]??'disabled/v1';if(flag==='disabled/v1')return null;
  if(flag!=='enabled/v1'||env.RUNVARA_STARTUP_MODE!=='quiet'||env.RUNVARA_QUIET_OWNER_WORKSPACE!=='enabled/v1'
    ||['RUNVARA_QUIET_PARCEL2GO_CREDENTIAL_ENTRY','RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE','RUNVARA_QUIET_SHOPIFY_CATALOGUE'].some(k=>env[k]!==undefined&&env[k]!=='disabled/v1'))fail('QUOTE_CONFIG_INVALID');
  const get=k=>env['RUNVARA_PARCEL2GO_QUOTE_'+k];
  if(!uuid(get('ADMISSION_REQUEST_ID'))||get('DATA_CONTRACT')!=='synthetic-gbp-notregistered/v1'||get('SCOPE_POLICY')!=='public-api-only/no-openid-fallback/v1')fail('QUOTE_CONFIG_INVALID');
  const input={operation:'quote',requestId:get('REQUEST_ID'),expectedRevision:get('EXPECTED_REVISION'),collectionCountry:'GBR',deliveryCountry:'GBR',parcel:{measurementId:'synthetic-sandbox-parcel',measuredAt:get('OPENED_AT'),provenance:'synthetic_fixture',weightGrams:'250',lengthMm:'200',widthMm:'100',heightMm:'50',declaredValueDecimal:'12.30',currency:'GBP'}};
  const config={mode:'sandbox-quote/v1',startupMode:'quiet',operation:'quote',network:'sandbox-only/v1',quotePurpose:'synthetic-sandbox/v1',scopePolicy:get('SCOPE_POLICY'),requestId:get('REQUEST_ID'),expectedRevision:get('EXPECTED_REVISION'),openedAt:get('OPENED_AT'),expiresAt:get('EXPIRES_AT'),expectedClientId:get('EXPECTED_CLIENT_ID'),termsReference:get('TERMS_REFERENCE'),inputHash:hash(input),collectionVatStatus:'NotRegistered',deliveryVatStatus:'NotRegistered',accountCurrency:'GBP',binding:{workspaceId:'packsmart-solutions',connectionId:get('CONNECTION_ID'),accountId:get('ACCOUNT_ID'),environment:'sandbox'}};
  const policy=createParcel2GoSandboxPolicy(config),signature=configKeys.map(k=>env[k]);let closed=false,timer,runner;
  const close=()=>{closed=true;clearTimeout(timer);runner?.close();};
  const remainingMs=()=>{const n=closed?0:policy.remainingMs();if(n<=0)close();return n;};
  const assertConfigured=()=>{if(configKeys.some((k,i)=>env[k]!==signature[i]))close();if(remainingMs()<=0)fail('QUOTE_CLOSED');};
  const w=Object.freeze({expiresAt:policy.expiresAt,available:()=>remainingMs()>0,remainingMs,close,assertConfigured});
  windows.set(w,{config,policy,input,admissionId:get('ADMISSION_REQUEST_ID'),attempted:false,setRunner:r=>{runner=r;}});
  timer=setTimeout(close,remainingMs());timer.unref?.();return w;
}
function owner(auth){
  try{assertQuietOwnerWorkspace(auth,{inspectEvidence:false});}catch{fail('OWNER_REQUIRED');}
  const s=auth.session,rows=auth.state.users.filter(u=>u.id===s.sub);
  if(typeof s.sub!=='string'||!s.sub||rows.length!==1||rows[0].active!==true||!Number.isSafeInteger(s.sessionVersion)||rows[0].sessionVersion!==s.sessionVersion||!Number.isSafeInteger(s.exp)||s.exp*1000<=Date.now())fail('OWNER_REQUIRED');
}
export function parcel2GoQuoteStatus(window,auth){
  const p=windows.get(window);if(!p)return null;owner(auth);
  const c=p.config,state=auth.state,runs=state.parcel2goSandboxRuns,rows=Array.isArray(runs)?runs.filter(r=>r.requestId===c.requestId):[];
  const matches=r=>r.operation==='quote'&&r.connectionId===c.binding.connectionId&&r.accountId===c.binding.accountId&&r.environment==='sandbox'&&r.openedAt===c.openedAt&&r.expiresAt===c.expiresAt&&r.termsReference===c.termsReference;
  let outcome='not_started',quoteCount=null;
  if(rows.length){const r=rows[0];if(rows.length===1&&matches(r)&&r.status==='completed'&&r.responseSource==='sandbox-http'&&r.inputHash===c.inputHash&&/^[a-f0-9]{64}$/.test(r.projectionHash||'')&&Number.isSafeInteger(r.quoteCount)&&r.quoteCount>=0&&r.quoteCount<=50){outcome='completed';quoteCount=r.quoteCount;}else outcome='reconcile_no_replay';}
  else if(p.attempted||!Array.isArray(runs)||runs.length>=20||runs.some(r=>r.status==='reserved'))outcome='reconcile_no_replay';
  else{
    const connections=(state.connections||[]).filter(x=>x.provider==='parcel2go'||x.id===c.binding.connectionId),a=runs.filter(r=>r.requestId===p.admissionId),x=connections[0];
    if(connections.length!==1||x.id!==c.binding.connectionId||x.provider!=='parcel2go'||x.metadata?.account!==c.binding.accountId||x.metadata?.environment!=='sandbox'||x.metadata?.admissionRequestId!==p.admissionId||typeof x.encryptedCredentials!=='string'||a.length!==1||a[0].operation!=='admit_credentials'||a[0].status!=='completed'||a[0].accountId!==c.binding.accountId||a[0].connectionId!==c.binding.connectionId||a[0].environment!=='sandbox')outcome='binding_unverified';
    else if(state._revision!==c.expectedRevision)outcome='state_changed';
  }
  try{window.assertConfigured();}catch{} // Closed window retains read-only receipt recovery.
  const remainingMs=Math.max(0,Math.min(window.remainingMs(),auth.session.exp*1000-Date.now()));
  return Object.freeze({schema:'runvara-parcel2go-owner-quote/v1',requestId:c.requestId,expectedRevision:c.expectedRevision,accountId:c.binding.accountId,connectionId:c.binding.connectionId,environment:'sandbox',expiresAt:c.expiresAt,remainingMs,canSubmit:remainingMs>0&&outcome==='not_started',outcome,scope:'public-api',dataContract:'synthetic-gbp-notregistered/v1',quoteCount,quote:null});
}
export function parseParcel2GoQuoteSubmission(bytes){
  try{if(bytes.length>2048)fail('QUOTE_INPUT_INVALID');const b=metaStrictJson(bytes);
    if(!b||Array.isArray(b)||Object.keys(b).sort().join('|')!=='confirmed|expectedRevision|requestId'||b.confirmed!==true||!uuid(b.requestId)||!uuid(b.expectedRevision))fail('QUOTE_INPUT_INVALID');return b;
  }catch{fail('QUOTE_INPUT_INVALID');}
}
export async function runParcel2GoOwnerQuote({window,store,key,auth,body,assertCurrent,sandboxRequest}){
  const p=windows.get(window);if(!p||store.provider!=='supabase'||typeof assertCurrent!=='function')fail('DISABLED');owner(auth);window.assertConfigured();assertCurrent();
  const status=parcel2GoQuoteStatus(window,auth);if(!status.canSubmit||body.confirmed!==true||body.requestId!==status.requestId||body.expectedRevision!==status.expectedRevision)fail('QUOTE_NOT_ADMITTED');
  p.attempted=true;
  const runner=createParcel2GoSandboxCandidate({policy:p.policy,store,key,sandboxRequest,assertCurrent:()=>{window.assertConfigured();assertCurrent();}});p.setRunner(runner);
  try{
    const result=await runner.run({session:auth.session,csrf:auth.session.csrf,input:p.input});
    const current=await store.get(auth.session.workspaceId,{exactSnapshot:true});assertCurrent();
    const dto=parcel2GoQuoteStatus(window,{...auth,state:current});
    if(dto.outcome!=='completed'||current._revision!==result.revision)fail('QUOTE_UNCONFIRMED');
    return Object.freeze({...dto,quote:dto.remainingMs>0?result.quote:null});
  }finally{runner.close();p.setRunner(null);}
}
