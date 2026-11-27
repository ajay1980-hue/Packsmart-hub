// Existing server and store; only synthetic state, credentials and issuer.
import assert from 'node:assert/strict';
import {maintenanceFixture,SECRET} from './maintenance-login-fixture.mjs';
import {expiredState,renewalEnv,tokenResponse,ID,secretPattern} from './shopify-token-renewal-fixture.mjs';
import {createSessionToken,verifySessionToken} from '../lib/security.mjs';
import {RUNTIME_RENEWAL_CONNECTION} from '../lib/shopify-renewal-runtime-permit.mjs';
export {ID,SECRET,secretPattern};
export const BASE='/api/owner/shopify-runtime-renewal';
export async function runtimeOwnerFixture(t,options={}){
  const state=options.state??expiredState({legacy:false});state.connections[0].id=RUNTIME_RENEWAL_CONNECTION;state.shopifyTokenExchanges[0].binding.connectionId=RUNTIME_RENEWAL_CONNECTION;
  const env={...renewalEnv(state),RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE:'disabled/v1',RUNVARA_OWNER_SHOPIFY_RUNTIME_RENEWAL:'enabled/v1',...options.env},issued=[];
  const f=await maintenanceFixture({...options,states:[state],env,providerFetch:async(url,init)=>{
    assert.equal(url,'https://wavtzm-vy.myshopify.com/admin/oauth/access_token');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');issued.push({method:init.method});
    return options.issuer?options.issuer(f):tokenResponse();
  }});t?.after(f.close);
  const token=createSessionToken({userId:state.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:state.users[0].role,sessionVersion:1},SECRET),session=verifySessionToken(token,SECRET);
  const secure=f.config.NODE_ENV==='production'||f.config.APP_PUBLIC_URL.startsWith('https:'),cookie=(secure?'__Host-packsmart_session':'packsmart_session')+'='+token;
  const call=(action,body,extra={})=>f.request(BASE+'/'+action,{method:body===undefined?'GET':'POST',cookie,...(body===undefined?{}:{body}),...extra,headers:{Origin:new URL(f.config.APP_PUBLIC_URL).origin,'X-CSRF-Token':session.csrf,...extra.headers}});
  const review=async()=>{const r=await call('review');assert.equal(r.status,200,JSON.stringify(r.payload));return r.payload.review;};
  const approve=async()=>{const r=await call('approve',await review());assert.equal(r.status,200,JSON.stringify(r.payload));return {requestId:r.payload.approval.requestId,expectedRevision:r.payload.expectedRevision};};
  return {...f,state,issued,token,session,cookie,call,review,approve};
}
