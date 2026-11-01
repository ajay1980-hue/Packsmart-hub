import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerState, maintenanceFixture, SECRET } from './maintenance-login-fixture.mjs';
import { encryptCredentials, createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { CATALOGUE_PATH, CATALOGUE_QUERY } from '../lib/shopify-catalogue-import.mjs';
export const ID='packsmart-solutions', DOMAIN='wavtzm-vy.myshopify.com';
export function product(id=1,changes={}) {
  return {id:`gid://shopify/Product/${id}`,title:'Synthetic envelope',handle:'test-'+id,status:'ACTIVE',productType:'Packaging',description:'Synthetic only',updatedAt:'2026-11-01T12:00:00.000Z',totalInventory:12,
    featuredMedia:null,variants:{pageInfo:{hasNextPage:false},nodes:[{id:`gid://shopify/ProductVariant/${id}`,title:'Pack',sku:'TEST-'+id,price:'12.30',inventoryQuantity:12,availableForSale:true,requiresComponents:false}]},...changes};
}
export function page(nodes=[product()],more=false,cursor=null) { return {data:{shop:{id:'gid://shopify/Shop/123',myshopifyDomain:DOMAIN,currencyCode:'GBP'},products:{nodes,pageInfo:{hasNextPage:more,endCursor:cursor}}}}; }
export function response(body=page(),version='2026-07') { return Response.json(body,{headers:{'x-shopify-api-version':version}}); }
export function catalogueState() {
  const s=ownerState(ID); s.connections=[{id:'synthetic-shopify',provider:'shopify',metadata:{shopDomain:DOMAIN},encryptedCredentials:encryptCredentials({storeDomain:DOMAIN,accessToken:'synthetic-token-only'},SECRET)}];
  s.connectionSettings={shopify:{areas:['catalogue','inventory'],disconnected:false}}; return s;
}
export function catalogueEnv(overrides={}) { return {RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_SHOPIFY_CATALOGUE:'enabled/v1',RUNVARA_SHOPIFY_CATALOGUE_REQUEST_ID:randomUUID(),RUNVARA_SHOPIFY_CATALOGUE_EXPIRES_AT:new Date(Date.now()+300000).toISOString(),...overrides}; }
export async function fixture(t,options={}) {
  t?.mock.method(console,'error',()=>{});
  const env=catalogueEnv(options.env), state=options.state || catalogueState(), reads=[];
  const f=await maintenanceFixture({...options,states:[state,ownerState('beta')],env,providerFetch:async(url,settings)=>{
    assert.equal(url,`https://${DOMAIN}/admin/api/2026-07/graphql.json`); assert.equal(settings.method,'POST'); assert.equal(settings.redirect,'error');
    assert.equal(settings.headers['X-Shopify-Access-Token'],'synthetic-token-only');
    const input=JSON.parse(settings.body); assert.equal(input.query,CATALOGUE_QUERY); assert.doesNotMatch(input.query,/\b(orders|customers|mutation)\b/);
    reads.push(input); return options.providerFetch?options.providerFetch(input,reads.length):response();
  }});
  t?.after(f.close);
  const token=createSessionToken({userId:state.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:'owner',sessionVersion:1},SECRET);
  const session=verifySessionToken(token,SECRET), cookie='__Host-packsmart_session='+token;
  const submit=(body={requestId:env.RUNVARA_SHOPIFY_CATALOGUE_REQUEST_ID,expectedRevision:f.fake.states.get(ID)._revision},extra={})=>f.request(CATALOGUE_PATH,{method:'POST',cookie,headers:{'X-CSRF-Token':session.csrf},body,...extra});
  return {...f,reads,env,token,session,cookie,submit,status:()=>f.request(CATALOGUE_PATH,{cookie})};
}
