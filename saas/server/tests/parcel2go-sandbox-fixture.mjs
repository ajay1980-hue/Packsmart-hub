import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {ownerState,SECRET} from './maintenance-login-fixture.mjs';
import {fakeSupabase} from './fake-supabase.mjs';
import {createStore} from '../lib/store.mjs';
import {createParcel2GoSandboxCandidate,createParcel2GoSandboxPolicy} from '../lib/parcel2go-sandbox.mjs';
import {sealParcel2GoCredentials} from '../lib/parcel2go-quote-foundation.mjs';
export const ID='packsmart-solutions',KEY=SECRET,CLIENT='synthetic-p2g-client',SECRET_VALUE='synthetic-p2g-client-secret',TOKEN='synthetic-p2g-access-token';
export const binding={workspaceId:ID,connectionId:'synthetic-p2g',accountId:'synthetic-sandbox-account',environment:'sandbox'};
export const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const quoteBody=()=>({Quotes:[{Service:{Slug:'example-24h',Name:'untrusted',Overview:'<script>bad</script>'},TotalPrice:12.66,TotalPriceExVat:10.55,TotalVat:2.11,UnitPrice:9.55,CurrencyCode:'GBP',CutOff:'2026-11-09T10:00:00Z'}]});
export function input(revision,requestId,now){return{operation:'quote',requestId,expectedRevision:revision,collectionCountry:'GBR',deliveryCountry:'GBR',parcel:{measurementId:'synthetic-measured',measuredAt:new Date(now-1000).toISOString(),provenance:'measured_packed_parcel',weightGrams:'250',lengthMm:'200',widthMm:'100',heightMm:'50',declaredValueDecimal:'12.30',currency:'GBP'}};}
export function fixture(options={}){
  let now=Date.now(),mono=1000;const state=options.state||ownerState(ID),requestId=randomUUID();
  const session={workspaceId:ID,sub:state.users[0].id,sessionVersion:1,exp:Math.floor(now/1000)+3600,csrf:'synthetic-csrf-at-least-16'};
  const credentials={clientId:CLIENT,clientSecret:SECRET_VALUE,token:null},operation=options.operation||'quote';
  if(operation==='quote'&&!options.state){
    const envelope=sealParcel2GoCredentials({auth:{session,state:{workspace:state.workspace,users:state.users}},trustedBinding:binding,value:credentials,key:KEY,now});
    const admissionRequestId=randomUUID();
    state.connections=[{id:binding.connectionId,provider:'parcel2go',metadata:{account:binding.accountId,environment:'sandbox',admissionRequestId},encryptedCredentials:envelope.encryptedCredentials}];
    state.parcel2goSandboxRuns=[{requestId:admissionRequestId,operation:'admit_credentials',status:'completed',connectionId:binding.connectionId,accountId:binding.accountId,environment:'sandbox'}];
  }
  const intent=input(state._revision,requestId,now),config={mode:'offline-fixture/v2',startupMode:'quiet',operation,requestId,expectedRevision:state._revision,binding,
    openedAt:new Date(now).toISOString(),expiresAt:new Date(now+300000).toISOString(),expectedClientId:CLIENT,termsReference:'synthetic-terms-approval',
    inputHash:digest(intent),collectionVatStatus:'NotRegistered',deliveryVatStatus:'NotRegistered',accountCurrency:'GBP',...options.config};
  const fake=fakeSupabase({initialStates:[state],fault:options.fault}),calls=[],providerCalls=[];
  const transport=async(url,settings)=>{assert.equal(new URL(url).origin,'https://parcel2go.supabase.invalid');calls.push({url,settings});return options.intercept?options.intercept(url,settings,()=>fake.fetchImpl(url,settings),fake):fake.fetchImpl(url,settings);};
  const store=createStore({SUPABASE_URL:'https://parcel2go.supabase.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only',CREDENTIALS_KEY:KEY},{fetchImpl:transport});
  const clocks={now:()=>now,monotonic:()=>mono};
  const make=(custom={})=>createParcel2GoSandboxCandidate({policy:createParcel2GoSandboxPolicy(config,clocks),store,key:KEY,fixtureTransport:async(url,settings)=>{
    providerCalls.push({url,settings});
    if(options.provider)return options.provider(url,settings,fake);
    return Response.json(url.endsWith('/token')?{access_token:TOKEN,token_type:'Bearer',expires_in:3600,scope:'public-api'}:quoteBody());
  },...custom});
  const candidate=make(),args={session,csrf:session.csrf,input:intent,credentials};
  return {state,session,args,intent,config,store,fake,calls,providerCalls,candidate,make,run:()=>candidate.run(args),
    setTime:t=>now=t,advance:ms=>{now+=ms;mono+=ms;},getTime:()=>now,setMono:m=>mono=m};
}
