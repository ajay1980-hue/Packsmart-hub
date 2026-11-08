// Synthetic credentials, database and issuer only; never inherits app secrets.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {maintenanceFixture,SECRET} from './maintenance-login-fixture.mjs';
import {catalogueState,ID,DOMAIN} from './shopify-catalogue-import-fixture.mjs';
import {encryptCredentials,decryptCredentials,createSessionToken,verifySessionToken} from '../lib/security.mjs';
import {SHOPIFY_TOKEN_PATH,TOKEN_DESTINATION} from '../lib/shopify-token-exchange.mjs';
export {ID,DOMAIN,SECRET,SHOPIFY_TOKEN_PATH};
export const CLIENT='9df2fc397d3f5ac01b66a46442fd20f9',KEY='synthetic-renewal-client-secret',OLD='synthetic-expired-access-token',NEW='synthetic-replacement-access-token';
export const SCOPES=['read_inventory','read_orders','read_products'];
export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const secretPattern=new RegExp([CLIENT,KEY,OLD,NEW,'encryptedCredentials','ciphertextDigest','storedCiphertextDigest','previousReceiptDigest'].join('|'));
export function expiredState({legacy=true,now=Date.now()}={}) {
  const s=catalogueState(),requestId=randomUUID(),issuedAt=now-86400000;
  const original={storeDomain:DOMAIN,clientId:CLIENT,clientSecret:KEY};
  const oldCipher=encryptCredentials(original,SECRET);
  const c=s.connections[0];
  c.encryptedCredentials=encryptCredentials({...original,mode:'client_credentials',accessToken:OLD,issuedAt,expiresAt:issuedAt+86399000,scopes:[...SCOPES],tokenExchangeRequestId:requestId},SECRET);
  c.updatedAt=new Date(issuedAt+100).toISOString();
  s.shopifyTokenExchanges=[{schema:'runvara-shopify-token-exchange/v1',requestId,status:'stored',actorId:s.users[0].id,sessionVersion:1,
    binding:{connectionId:c.id,domain:DOMAIN,apiVersion:'2026-07',appId:'gid://shopify/App/408091000833',installationId:'gid://shopify/AppInstallation/1161754673486',ciphertextDigest:digest(oldCipher),settingsDigest:digest(s.connectionSettings.shopify)},
    approvedScopes:[...SCOPES],returnedScopes:[...SCOPES],startedAt:new Date(issuedAt-100).toISOString(),expiresAt:new Date(issuedAt+100000).toISOString(),storedAt:c.updatedAt,tokenExpiresAt:issuedAt+86399000,
    ...(!legacy?{storedCiphertextDigest:digest(c.encryptedCredentials)}:{})}];
  s.economics={SYNTH:{landed:12,packing:0,notes:'preserve recorded costs'}};s.costHistory=[{id:'synthetic-cost-event'}];
  s.integrationStatus={shopify:{status:'preserve-source-status'},other:{status:'preserve-independent-status'}};
  return s;
}
export function alterCredentials(state,change){const c=state.connections[0],v=decryptCredentials(c.encryptedCredentials,SECRET);change(v);c.encryptedCredentials=encryptCredentials(v,SECRET);return v;}
export function renewalEnv(state,extra={}){return {RUNVARA_STARTUP_MODE:'quiet',RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE:'enabled/v1',
  RUNVARA_SHOPIFY_TOKEN_REQUEST_ID:randomUUID(),RUNVARA_SHOPIFY_TOKEN_EXPIRES_AT:new Date(Date.now()+300000).toISOString(),
  RUNVARA_SHOPIFY_TOKEN_EXPECTED_CLIENT_ID:CLIENT,RUNVARA_SHOPIFY_TOKEN_EXPECTED_SCOPES:SCOPES.join(','),
  RUNVARA_SHOPIFY_TOKEN_OPERATION:'renew_expired/v1',RUNVARA_SHOPIFY_TOKEN_PREVIOUS_REQUEST_ID:state.shopifyTokenExchanges[0]?.requestId,...extra};}
export const tokenResponse=extra=>Response.json({access_token:NEW,scope:SCOPES.join(','),expires_in:86399,...extra});
export async function renewalFixture(t,options={}) {
  const logs=[];if(t)for(const name of ['warn','error'])t.mock.method(console,name,(...x)=>logs.push(x.join(' ')));
  const state=options.state||expiredState(),env=renewalEnv(state,options.env),requests=[];
  const f=await maintenanceFixture({...options,states:[state],env,providerFetch:async(url,settings)=>{
    assert.equal(url,TOKEN_DESTINATION);assert.equal(settings.method,'POST');assert.equal(settings.redirect,'error');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(settings.body)),{grant_type:'client_credentials',client_id:CLIENT,client_secret:KEY});
    assert.ok(settings.signal);requests.push({destination:TOKEN_DESTINATION,method:'POST'});
    return options.providerFetch?options.providerFetch(f,requests.length):tokenResponse();
  }});
  t?.after(f.close);
  const token=createSessionToken({userId:state.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:'owner',sessionVersion:1},SECRET);
  const session=verifySessionToken(token,SECRET),cookie='__Host-packsmart_session='+token;
  const submit=(body={requestId:env.RUNVARA_SHOPIFY_TOKEN_REQUEST_ID,expectedRevision:f.fake.states.get(ID)._revision},extra={})=>f.request(SHOPIFY_TOKEN_PATH,{method:'POST',cookie,headers:{'X-CSRF-Token':session.csrf},body,...extra});
  return {...f,env,requests,logs,token,session,cookie,submit,status:()=>f.request(SHOPIFY_TOKEN_PATH,{cookie})};
}
