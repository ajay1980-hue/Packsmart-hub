import {randomUUID} from 'node:crypto';
import {ownerState,maintenanceFixture,SECRET} from './maintenance-login-fixture.mjs';
import {createSessionToken,verifySessionToken} from '../lib/security.mjs';
import {PARCEL2GO_ENTRY_PATH} from '../lib/parcel2go-credential-entry.mjs';
export const ID='packsmart-solutions',CLIENT='synthetic-p2g-entry-client',VALUE='synthetic-p2g-entry-secret';
export function entryEnv(state,overrides={}){const opened=Date.now();return {RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_PARCEL2GO_CREDENTIAL_ENTRY:'enabled/v1',RUNVARA_PARCEL2GO_ENTRY_REQUEST_ID:randomUUID(),
  RUNVARA_PARCEL2GO_ENTRY_EXPECTED_REVISION:state._revision,RUNVARA_PARCEL2GO_ENTRY_OPENED_AT:new Date(opened).toISOString(),RUNVARA_PARCEL2GO_ENTRY_EXPIRES_AT:new Date(opened+300000).toISOString(),
  RUNVARA_PARCEL2GO_ENTRY_EXPECTED_CLIENT_ID:CLIENT,RUNVARA_PARCEL2GO_ENTRY_TERMS_REFERENCE:'synthetic-approved-terms',RUNVARA_PARCEL2GO_ENTRY_CONNECTION_ID:'synthetic-entry-connection',RUNVARA_PARCEL2GO_ENTRY_ACCOUNT_ID:'synthetic-sandbox-account',...overrides};}
export async function fixture(t,options={}){
  const state=options.state||ownerState(ID),env=entryEnv(state,options.env),logs=[];
  if(t)t.mock.method(console,'error',v=>logs.push(String(v)));
  const f=await maintenanceFixture({...options,states:[state,ownerState('beta')],env});t?.after(f.close);
  const token=createSessionToken({userId:state.users[0].id,workspaceId:state.workspace.id,email:'synthetic@example.test',role:state.users[0].role,sessionVersion:1},SECRET),session=verifySessionToken(token,SECRET),cookie='__Host-packsmart_session='+token;
  const body={requestId:env.RUNVARA_PARCEL2GO_ENTRY_REQUEST_ID,expectedRevision:state._revision,clientId:CLIENT,clientSecret:VALUE,confirmed:true};
  const submit=(value=body,extra={})=>f.request(PARCEL2GO_ENTRY_PATH,{method:'POST',cookie,body:value,headers:{Origin:new URL(f.config.APP_PUBLIC_URL).origin,'X-CSRF-Token':session.csrf},...extra});
  return {...f,state,env,token,session,cookie,body,logs,submit,status:()=>f.request(PARCEL2GO_ENTRY_PATH,{cookie})};
}
