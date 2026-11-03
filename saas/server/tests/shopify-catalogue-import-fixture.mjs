import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerState, maintenanceFixture, SECRET } from './maintenance-login-fixture.mjs';
import { encryptCredentials, createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { CATALOGUE_PATH, CATALOGUE_QUERY } from '../lib/shopify-catalogue-import.mjs';
import { CATALOGUE_SHOP_ID, CATALOGUE_COMPONENT_QUERY } from '../lib/shopify-catalogue-evidence.mjs';
export const ID='packsmart-solutions', DOMAIN='wavtzm-vy.myshopify.com';
export function product(id=1,changes={}) {
  return {id:`gid://shopify/Product/${id}`,title:'Synthetic envelope',handle:'test-'+id,status:'ACTIVE',productType:'Packaging',description:'Synthetic only',updatedAt:'2026-11-01T12:00:00.000Z',onlineStoreUrl:`https://packsmartsolutions.com/products/test-${id}`,totalInventory:12,
    featuredMedia:null,variants:{pageInfo:{hasNextPage:false},nodes:[{id:`gid://shopify/ProductVariant/${id}`,title:'Pack',sku:'TEST-'+id,price:'12.30',inventoryQuantity:12,availableForSale:true,requiresComponents:false,updatedAt:'2026-11-01T12:00:00.000Z',selectedOptions:[{name:'Pack Size',value:'Pack of 25'}]}]},...changes};
}
export function page(nodes=[product()],more=false,cursor=null) { return {data:{shop:{id:CATALOGUE_SHOP_ID,myshopifyDomain:DOMAIN,currencyCode:'GBP'},products:{nodes,pageInfo:{hasNextPage:more,endCursor:cursor}}}}; }
export function componentNode(p,v){return {id:v.id,sku:v.sku,price:v.price,updatedAt:v.updatedAt,requiresComponents:v.requiresComponents,selectedOptions:structuredClone(v.selectedOptions),
  product:{id:p.id,status:p.status,onlineStoreUrl:p.onlineStoreUrl,updatedAt:p.updatedAt},productVariantComponents:{pageInfo:{hasNextPage:false,hasPreviousPage:false},nodes:v.requiresComponents?[{id:'synthetic-relation-'+v.id.split('/').at(-1),quantity:1,productVariant:{id:'gid://shopify/ProductVariant/'+(900000+Number(v.id.split('/').at(-1)))}}]:[]}};}
export function response(body=page(),version='2026-07') { return Response.json(body,{headers:{'x-shopify-api-version':version}}); }
export function catalogueState() {
  const s=ownerState(ID); s.connections=[{id:'synthetic-shopify',provider:'shopify',metadata:{shopDomain:DOMAIN},encryptedCredentials:encryptCredentials({storeDomain:DOMAIN,accessToken:'synthetic-token-only'},SECRET)}];
  s.connectionSettings={shopify:{areas:['catalogue','inventory'],disconnected:false}}; return s;
}
export function catalogueEnv(overrides={}) { return {RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_SHOPIFY_CATALOGUE:'enabled/v1',RUNVARA_SHOPIFY_CATALOGUE_REQUEST_ID:randomUUID(),RUNVARA_SHOPIFY_CATALOGUE_EXPIRES_AT:new Date(Date.now()+300000).toISOString(),...overrides}; }
export async function fixture(t,options={}) {
  t?.mock.method(console,'error',()=>{});
  const env=catalogueEnv(options.env), state=options.state || catalogueState(), reads=[],sources=new Map();let shop,catalogueReads=0;
  const f=await maintenanceFixture({...options,states:[state,ownerState('beta')],env,providerFetch:async(url,settings)=>{
    assert.equal(url,`https://${DOMAIN}/admin/api/2026-07/graphql.json`); assert.equal(settings.method,'POST'); assert.equal(settings.redirect,'error');
    assert.equal(settings.headers['X-Shopify-Access-Token'],'synthetic-token-only');
    const input=JSON.parse(settings.body); assert.ok([CATALOGUE_QUERY,CATALOGUE_COMPONENT_QUERY].includes(input.query)); assert.doesNotMatch(input.query,/\b(orders|customers|mutation)\b/);
    reads.push(input);
    if(input.query===CATALOGUE_QUERY){
      const result=await (options.providerFetch?options.providerFetch(input,++catalogueReads):response());
      const d=await result.clone().json();shop=d.data?.shop;
      for(const p of d.data?.products?.nodes||[])for(const v of p.variants?.nodes||[])sources.set(v.id,{p,v});return result;
    }
    const payload={data:{shop,nodes:input.variables.ids.map(id=>{const {p,v}=sources.get(id);return componentNode(p,v);})}};
    return options.componentFetch?options.componentFetch(payload,input,reads.length):response(payload);
  }});
  t?.after(f.close);
  const token=createSessionToken({userId:state.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:'owner',sessionVersion:1},SECRET);
  const session=verifySessionToken(token,SECRET), cookie='__Host-packsmart_session='+token;
  const submit=(body={requestId:env.RUNVARA_SHOPIFY_CATALOGUE_REQUEST_ID,expectedRevision:f.fake.states.get(ID)._revision},extra={})=>f.request(CATALOGUE_PATH,{method:'POST',cookie,headers:{'X-CSRF-Token':session.csrf},body,...extra});
  return {...f,reads,env,token,session,cookie,submit,status:()=>f.request(CATALOGUE_PATH,{cookie})};
}
