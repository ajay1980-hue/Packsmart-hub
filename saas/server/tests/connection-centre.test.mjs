import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken, decryptCredentials, encryptCredentials } from '../lib/security.mjs';
import { IntegrationService, mergeSelectedShopify } from '../lib/integrations.mjs';
import { connectionCentre, connectionDue, saveConnectionSettings, recoveryFor } from '../lib/connection-centre.mjs';
import { tiktokSignature } from '../lib/connector-oauth.mjs';
import { JSDOM, VirtualConsole } from 'jsdom';

const SESSION = 'connection-centre-test-session-secret-at-least-thirty-two';
const KEY = 'connection-centre-test-encryption-key-at-least-thirty-two';
const TOKEN = 'test-only-shopify-access-token-never-return-to-browser';
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: {'Content-Type':'application/json'} });
async function fixture(t, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'runvara-connections-'));
  const calls = [], flags = { invalid:false, delay:null, customerDenied:false, unknownWrite:false };
  const env = { NODE_ENV:'test', APP_PUBLIC_URL:'https://runvara.example.test', SESSION_SECRET:SESSION, CREDENTIALS_KEY:KEY, SAAS_STATE_FILE:path.join(directory,'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED:'false',
    SHOPIFY_OAUTH_ENABLED:'true', SHOPIFY_OAUTH_CLIENT_ID:'app-id-test', SHOPIFY_OAUTH_CLIENT_SECRET:'app-secret-test-only-32-characters',
    PINTEREST_OAUTH_ENABLED:'true', PINTEREST_CLIENT_ID:'pinterest-id', PINTEREST_CLIENT_SECRET:'pinterest-secret-test-only',
    GOOGLE_OAUTH_ENABLED:'true', GOOGLE_CLIENT_ID:'google-id', GOOGLE_CLIENT_SECRET:'google-secret-test-only',
    META_OAUTH_ENABLED:'true', META_CLIENT_ID:'meta-id', META_CLIENT_SECRET:'meta-secret-test-only',
    TIKTOK_SHOP_OAUTH_ENABLED:'true', TIKTOK_SHOP_APP_KEY:'test-app-key', TIKTOK_SHOP_APP_SECRET:'test-app-secret', TIKTOK_SHOP_SERVICE_ID:'test-service',
    EBAY_OAUTH_ENABLED:'true', EBAY_CLIENT_ID:'ebay-client-id-test', EBAY_CLIENT_SECRET:'ebay-client-secret-test-only', EBAY_REDIRECT_URI_NAME:'ebay-app-test-redirect', ...extra };
  const fetchImpl = async (url, options = {}) => {
    const uri = new URL(String(url)), body = options.body ? JSON.parse(options.headers?.['Content-Type'] === 'application/json' ? options.body : '{}') : {};
    calls.push({url:String(url),query:body.query || '',headers:options.headers,body:options.body,method:options.method || 'GET'});
    if (uri.hostname === 'graph.facebook.com' && flags.metaHandler) return flags.metaHandler(uri, options, body);
    if (uri.hostname.endsWith('.myshopify.com')) {
      if (uri.pathname.endsWith('/access_token')) return json({access_token:TOKEN,refresh_token:'new-refresh-token-test-only',expires_in:86400,scope:'read_products,read_inventory,read_orders,write_products'});
      if(flags.invalid) return json({errors:'secret error that must not be shown'},401);
      const query = body.query || '';
      if (query.includes('ConnectionIdentity')) return json({data:{shop:{id:'gid://shopify/Shop/1',name:'Alpha Store',myshopifyDomain:uri.hostname},currentAppInstallation:{accessScopes:[{handle:'read_products'},{handle:'write_products'}]}}});
      if (query.includes('Products')) {
        if(flags.readUnavailable) throw Object.assign(new Error('private failure must remain server-side'),{code:'ETIMEDOUT'});
        if(flags.delay) await flags.delay;
        return json({data:{products:{nodes:[{id:'gid://shopify/Product/1',title:'Live product',status:'ACTIVE',description:'Live description',totalInventory:8,variants:{nodes:[{id:'gid://shopify/ProductVariant/1',title:'Box',sku:'BOX-1',price:'20',inventoryQuantity:8}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}}}});
      }
      if (query.includes('Orders')) return json({data:{orders:{nodes:[],pageInfo:{hasNextPage:false}}}});
      if (query.includes('Customers')) return flags.customerDenied ? json({errors:[{message:'Access denied'}]}) : json({data:{customers:{nodes:[{id:'c1',createdAt:'2026-09-01',numberOfOrders:2}],pageInfo:{hasNextPage:false}}}});
      if (query.includes('RunvaraProductTags')) return json({data:{[query.includes('tagsAdd(')?'tagsAdd':'tagsRemove']:{node:{id:body.variables.id},userErrors:[]}}});
      if (query.includes('mutation')) {
        if(flags.unknownWrite) throw new TypeError('Network interrupted');
        return json({data:query.includes('InternalNote') ? {metafieldsSet:{metafields:[{id:'note-1'}],userErrors:[]}} : {productUpdate:{product:{id:'gid://shopify/Product/1'},userErrors:[]}}});
      }
    }
    if (uri.pathname.includes('token') || uri.pathname.includes('oauth/access_token')) {
      if(uri.hostname.includes('tiktok')) return json({code:0,data:{access_token:'tik-token',refresh_token:'tik-refresh',access_token_expire_in:Math.floor(Date.now()/1000)+86400,user_type:0,open_id:'tik-seller',granted_scopes:['seller.authorization.info']}});
      return json({access_token:'provider-access-test-only',refresh_token:'provider-refresh-test-only',expires_in:86400,scope:'user_accounts:read boards:read pins:read'});
    }
    if(uri.pathname.includes('/identity/v1/oauth2/token')) return json({access_token:'ebay-access',refresh_token:'ebay-refresh',expires_in:7200});
    if(uri.pathname.includes('/commerce/identity')) return json({username:'alpha-seller',userId:'ebay-user-1'});
    if(uri.pathname.includes('/sell/fulfillment')) return json({orders:[],total:0});
    if(uri.pathname.includes('/sell/inventory')) return json({inventoryItems:[],total:0});
    if(uri.pathname.includes('/sell/marketing')) return json({campaigns:[],total:0});
    if(uri.pathname.endsWith('/user_account')) return json({username:'pinterest-user'});
    if(uri.hostname.includes('pinterest')) return json({items:[{id:'pin-1',title:'Pin',name:'Board'}],bookmark:null});
    if(uri.pathname.endsWith('/channels')) return json({items:[{id:'youtube-1',snippet:{title:'My channel'},statistics:{videoCount:'3'}}]});
    if(uri.pathname.endsWith('/me/permissions')) return json({data:['pages_show_list','pages_read_engagement','instagram_basic'].map(permission=>({permission,status:'granted'}))});
    if(uri.pathname.endsWith('/me')) return json({id:'meta-user',name:'My pages'});
    if(uri.pathname.endsWith('/me/accounts')) return json({data:[{id:'page1',name:'My page',access_token:'MUST-NOT-STORE',instagram_business_account:{id:'ig1',username:'my-shop'}}]});
    if(uri.pathname.endsWith('/shops')) return json({code:0,data:{shops:[{id:'shop1',name:'My TikTok shop',region:'GB',cipher:'MUST-NOT-EXPOSE'}]}});
    if(uri.pathname === '/product/202502/products/search') return json({code:0,data:{products:[{id:'tt-product',title:'TikTok product',status:'ACTIVATE',skus:[{id:'tt-sku',seller_sku:'BOX-1',price:{currency:'GBP',sale_price:'20'},inventory:[{quantity:3}]}]}]}});
    if(uri.pathname === '/order/202309/orders/search') return json({code:0,data:{orders:[{id:'tt-order',status:'COMPLETED',create_time:1788220800}]}});
    throw new Error(`Unexpected fixture request: ${uri.origin}${uri.pathname}`);
  };
  const server = createPacksmartServer(env,{fetchImpl});
  const tenants = {};
  for(const name of ['alpha','beta']) {
    const state = seedWorkspaceState({}, {workspaceId:name,email:`${name}@example.test`,passwordHash:'fixture'});
    state.users.push({...state.users[0],id:`${name}-admin`,role:'admin'},{...state.users[0],id:`${name}-viewer`,role:'viewer'});
    state.products=[{id:'gid://shopify/Product/1',provider:'shopify',title:'Before',description:'Before',inventory:2,variants:[{id:'gid://shopify/ProductVariant/1',sku:'BOX-1',price:10,inventory:2,available:true}]}];
    state.orders=[{id:`${name}-historical`,provider:'shopify',actualShippingCost:3}];
    await server.packsmart.store.save(name,state); tenants[name]=state;
  }
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(route,{tenant='alpha',role='owner',method='GET',body,cookie,csrf=true}={}) {
    const user=tenants[tenant].users.find(user=>user.role===role);
    const token=createSessionToken({userId:user.id,workspaceId:tenant,email:user.email,role,sessionVersion:1},SESSION);
    const headers={Cookie:cookie || `__Host-packsmart_session=${token}`};
    if(csrf)headers['X-CSRF-Token']=verifySessionToken(token,SESSION).csrf;
    if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
    const raw=await response.text();let value;try{value=JSON.parse(raw);}catch{value=raw;}
    return {status:response.status,body:value,headers:response.headers};
  }
  const channel=async(provider='shopify',tenant='alpha')=>(await request('/api/connection-centre',{tenant})).body.channels.find(item=>item.id===provider);
  const connect=async()=>request('/api/connections',{method:'POST',body:{provider:'shopify',credentials:{storeDomain:'alpha.myshopify.com',accessToken:TOKEN}}});
  return {server,env,request,connect,channel,calls,flags,base,tenants};
}

test('Connect → selective sync → confirmed disconnect → reconnect preserves data and tenant isolation',async t=>{
  const f=await fixture(t); assert.equal((await f.connect()).status,200);
  assert.equal((await f.channel()).settings.permissionMode,'read_only');
  const encrypted=(await f.server.packsmart.store.get('alpha')).connections[0].encryptedCredentials;
  assert.ok(!JSON.stringify(encrypted).includes(TOKEN));assert.equal(decryptCredentials(encrypted,KEY).accessToken,TOKEN);
  assert.equal((await f.request('/api/connections/shopify/test',{method:'POST',body:{}})).status,200);
  let result=await f.request('/api/connections/shopify/sync',{method:'POST',body:{areas:['inventory']}});assert.equal(result.status,200);
  let saved=await f.server.packsmart.store.get('alpha');assert.equal(saved.products[0].inventory,8);assert.equal(saved.products[0].title,'Before');assert.equal(saved.products[0].variants[0].price,10);assert.equal(saved.orders[0].actualShippingCost,3);
  assert.equal(f.calls.filter(call=>call.query.includes('Orders')).length,0);
  const revision=(await f.channel()).settings.revision;
  assert.equal((await f.request('/api/connections/shopify/disconnect',{method:'POST',body:{revision}})).status,400);
  assert.equal((await f.request('/api/connections/shopify/disconnect',{method:'POST',body:{revision,confirm:'shopify'}})).status,200);
  assert.equal((await f.channel()).status,'disconnected');
  assert.equal((await f.request('/api/connections/shopify/sync',{method:'POST',body:{}})).status,409);
  saved=await f.server.packsmart.store.get('alpha');assert.equal(saved.products.length,1);assert.equal(saved.connections[0].encryptedCredentials,null);
  await f.connect();assert.equal((await f.request('/api/connections/shopify/sync',{method:'POST',body:{}})).status,200);
  const publicData=JSON.stringify((await f.request('/api/connection-centre')).body);assert.ok(!publicData.includes(TOKEN));assert.ok(!publicData.includes('encryptedCredentials'));
  assert.equal((await f.channel('shopify','beta')).status,'not_configured');assert.equal((await f.server.packsmart.store.get('beta')).products[0].inventory,2);
  assert.ok((await f.channel()).history.length>=2);
});

test('sync progress is durable and visible while remote reads run; invalid credentials retain previous data and recover',async t=>{
  const f=await fixture(t);await f.connect();
  let release; f.flags.delay=new Promise(resolve=>{release=resolve;});
  const pending=f.request('/api/connections/shopify/sync',{method:'POST',body:{areas:['products']}});
  for(let i=0;i<100&&!f.calls.some(call=>call.query.includes('Products'));i++)await new Promise(resolve=>setTimeout(resolve,10));
  const during=await f.channel();assert.equal(during.progress.status,'running');assert.equal(during.history[0].status,'running');
  release();await pending;f.flags.delay=null;
  const before=(await f.server.packsmart.store.get('alpha')).products;
  f.flags.invalid=true;
  const failed=await f.request('/api/connections/shopify/sync',{method:'POST',body:{}});assert.equal(failed.status,422);assert.match(failed.body.error,/needs reconnecting/);
  assert.deepEqual((await f.server.packsmart.store.get('alpha')).products,before);assert.equal((await f.channel()).status,'action_required');
  assert.equal((await f.channel()).history[0].status,'failed');
  f.flags.invalid=false;assert.equal((await f.request('/api/connections/shopify/sync',{method:'POST',body:{}})).status,200);assert.equal((await f.channel()).status,'connected');
});

test('sync schedules validate areas and revisions; turning auto sync off also stops bootstrap reads',async t=>{
  const f=await fixture(t);await f.connect();let channel=await f.channel();
  assert.equal((await f.request('/api/connections/shopify/settings',{method:'POST',body:{revision:channel.settings.revision,areas:['refunds']}})).status,400);
  assert.equal((await f.request('/api/connections/shopify/settings',{method:'POST',body:{revision:channel.settings.revision,areas:['orders'],autoSync:false,frequencyMinutes:60}})).status,200);
  assert.equal((await f.request('/api/connections/shopify/settings',{method:'POST',body:{revision:channel.settings.revision,autoSync:true}})).status,409);
  const before=f.calls.length;await f.request('/api/bootstrap');assert.equal(f.calls.length,before);
  const saved=await f.server.packsmart.store.get('alpha');assert.equal(connectionDue(saved,'shopify'),false);
  assert.equal((await f.request('/api/connections/shopify/test',{method:'POST',body:{},role:'viewer'})).status,403);
  assert.equal((await f.request('/api/connections/shopify/test',{method:'POST',body:{},csrf:false})).status,403);
});

test('write policies require owner consent, enforce exact approval and block financial or replayed writes',async t=>{
  const f=await fixture(t);await f.connect();await f.request('/api/connections/shopify/test',{method:'POST',body:{}});
  let channel=await f.channel();
  const body={operation:'product_content',productId:'gid://shopify/Product/1',title:'Approved title',description:'Reviewed description',requestId:'content-request-0001'};
  assert.equal((await f.request('/api/connections/shopify/writes',{method:'POST',body})).status,403);
  assert.equal((await f.request('/api/connections/shopify/settings',{method:'POST',body:{revision:channel.settings.revision,permissionMode:'automatic'},role:'admin'})).status,403);
  assert.equal((await f.request('/api/connections/shopify/settings',{method:'POST',body:{revision:channel.settings.revision,permissionMode:'automatic'}})).status,400);
  assert.equal((await f.request('/api/connections/shopify/settings',{method:'POST',body:{revision:channel.settings.revision,permissionMode:'approval_gated',confirmPermission:'shopify:approval_gated'}})).status,200);
  const proposal=(await f.request('/api/connections/shopify/writes',{method:'POST',body})).body.write;assert.ok(proposal.approvalId);
  const route=`/api/connection-writes/${proposal.id}/execute`;
  assert.equal((await f.request(route,{method:'POST',body:{}})).status,409);
  assert.equal((await f.request(route,{method:'POST',body:{},tenant:'beta'})).status,404);
  const approved=await f.request(`/api/approvals/${proposal.approvalId}/decision`,{method:'POST',body:{decision:'approved',revision:1}});assert.equal(approved.status,200);assert.equal(approved.body.approval.executionStatus,'ready');assert.equal(approved.body.executedExternally,false);assert.equal((await f.request('/api/connection-centre')).body.writes[0].status,'ready');
  assert.equal((await f.request(route,{method:'POST',body:{}})).body.executedExternally,true);
  await f.request(route,{method:'POST',body:{}});assert.equal(f.calls.filter(call=>call.query.includes('mutation')).length,1);
  channel=await f.channel();await f.request('/api/connections/shopify/settings',{method:'POST',body:{revision:channel.settings.revision,permissionMode:'automatic',confirmPermission:'shopify:automatic'}});
  const financial=await f.request('/api/connections/shopify/writes',{method:'POST',body:{...body,operation:'refund',requestId:'refund-request-0001'}});assert.equal(financial.status,422);
  const content=(await f.request('/api/connections/shopify/writes',{method:'POST',body:{...body,requestId:'content-request-0002'}})).body.write;assert.ok(content.approvalId,'automatic policy does not bypass customer-facing approval');
  const note=(await f.request('/api/connections/shopify/writes',{method:'POST',body:{operation:'internal_note',productId:body.productId,note:'Private note',requestId:'private-note-0001'}})).body.write;assert.equal(note.requiresApproval,false);
  f.flags.unknownWrite=true;assert.equal((await f.request(`/api/connection-writes/${note.id}/execute`,{method:'POST',body:{}})).body.write.status,'uncertain');
  assert.equal((await f.request(`/api/connection-writes/${note.id}/execute`,{method:'POST',body:{}})).status,409);
});

test('OAuth validates browser binding, HMAC, expiry, tenant, account and one-time state before saving credentials',async t=>{
  const f=await fixture(t);
  const start=await f.request('/api/integrations/shopify/oauth/start',{method:'POST',body:{storeDomain:'alpha.myshopify.com'}});assert.equal(start.status,200);
  const authUrl=new URL(start.body.authorizationUrl);assert.ok(!authUrl.searchParams.get('scope').includes('write'));
  const cookie=start.headers.get('set-cookie').split(';')[0];
  function callback(token=authUrl.searchParams.get('state'),shop='alpha.myshopify.com') {
    const url=new URL('/api/integrations/shopify/oauth/callback',f.base);url.search=new URLSearchParams({code:'single-use-code',shop,state:token,timestamp:String(Math.floor(Date.now()/1000))}).toString();
    const message=[...url.searchParams.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join('&');
    url.searchParams.set('hmac',crypto.createHmac('sha256',f.env.SHOPIFY_OAUTH_CLIENT_SECRET).update(message).digest('hex'));return url.pathname+url.search;
  }
  assert.equal((await f.request(callback(),{cookie:'wrong=browser'})).status,400);
  assert.equal((await f.request(callback(authUrl.searchParams.get('state')+'x'),{cookie})).status,400);
  assert.equal((await f.request(callback(),{cookie})).status,303);
  assert.equal((await f.request(callback(),{cookie})).status,400);
  const record=(await f.server.packsmart.store.get('alpha')).connections[0];assert.equal(record.metadata.shopDomain,'alpha.myshopify.com');assert.ok(!JSON.stringify(record.encryptedCredentials).includes(TOKEN));
  assert.equal((await f.server.packsmart.store.get('beta')).connections.length,0);
  const fresh=await f.request('/api/integrations/shopify/oauth/start',{method:'POST',body:{storeDomain:'beta.myshopify.com'}});
  const changed=await f.request(callback(new URL(fresh.body.authorizationUrl).searchParams.get('state'),'beta.myshopify.com'),{cookie:fresh.headers.get('set-cookie').split(';')[0]});
  assert.match(changed.headers.get('location'),/account-mismatch/);assert.equal((await f.server.packsmart.store.get('alpha')).connections[0].metadata.shopDomain,'alpha.myshopify.com');
});

for(const provider of ['pinterest','google_youtube','meta','tiktok_shop','ebay']) test(`${provider} uses the existing encrypted connection model and completes OAuth → test → read sync`,async t=>{
  const f=await fixture(t);
  const start=await f.request(`/api/integrations/${provider}/oauth/start`,{method:'POST',body:{}});assert.equal(start.status,200);
  const token=new URL(start.body.authorizationUrl).searchParams.get('state');
  const callback=await f.request(`/api/integrations/${provider}/oauth/callback?code=provider-code&state=${encodeURIComponent(token)}`,{cookie:start.headers.get('set-cookie').split(';')[0]});assert.equal(callback.status,303);assert.match(callback.headers.get('location'),/connected/);
  assert.equal((await f.request(`/api/connections/${provider}/test`,{method:'POST',body:{}})).status,200);
  const sync=await f.request(`/api/connections/${provider}/sync`,{method:'POST',body:{}});assert.equal(sync.status,200);
  const state=await f.server.packsmart.store.get('alpha');assert.equal(state.connections.length,1);assert.equal(state.connectionSettings[provider].permissionMode,'read_only');
  assert.ok(!JSON.stringify(state.channelData || {}).includes('MUST-NOT-'));
  assert.ok(!JSON.stringify((await f.request('/api/connection-centre')).body).includes('provider-access-test-only'));
});

test('refresh rotation stays encrypted and TikTok signatures match the provider’s published vector',async t=>{
  const f=await fixture(t);await f.connect();
  const state=await f.server.packsmart.store.get('alpha');state.connections[0].encryptedCredentials=encryptCredentials({mode:'oauth',storeDomain:'alpha.myshopify.com',accessToken:'expired-test-token',refreshToken:'old-test-refresh',expiresAt:Date.now()-1000},KEY);await f.server.packsmart.store.save('alpha',state);
  assert.equal((await f.request('/api/connections/shopify/refresh',{method:'POST',body:{}})).status,200);
  const saved=await f.server.packsmart.store.get('alpha');assert.equal(decryptCredentials(saved.connections[0].encryptedCredentials,KEY).refreshToken,'new-refresh-token-test-only');
  assert.equal(tiktokSignature('/authorization/202309/shops',{app_key:'29a39d',timestamp:'1623812664'},'','e59af819cc'),'b596b73e0cc6de07ac26f036364178ab16b0a907af13d43f0a0cd2345f582dc8');
});

test('expired, unsigned, cancelled and cross-provider OAuth callbacks cannot replace working credentials',async t=>{
  const f=await fixture(t);await f.connect();
  const original=(await f.server.packsmart.store.get('alpha')).connections[0].encryptedCredentials;
  const start=async()=>f.request('/api/integrations/shopify/oauth/start',{method:'POST',body:{storeDomain:'alpha.myshopify.com'}});
  let response=await start(), token=new URL(response.body.authorizationUrl).searchParams.get('state'), cookie=response.headers.get('set-cookie').split(';')[0];
  const route=`/api/integrations/shopify/oauth/callback?state=${encodeURIComponent(token)}&code=invalid&shop=alpha.myshopify.com&timestamp=${Math.floor(Date.now()/1000)}&hmac=invalid`;
  assert.match((await f.request(route,{cookie})).headers.get('location'),/failed/);
  assert.deepEqual((await f.server.packsmart.store.get('alpha')).connections[0].encryptedCredentials,original);
  response=await start();token=new URL(response.body.authorizationUrl).searchParams.get('state');cookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request(`/api/integrations/pinterest/oauth/callback?state=${encodeURIComponent(token)}&code=anything`,{cookie})).status,400);
  let state=await f.server.packsmart.store.get('alpha');state.oauthChallenges[0].expiresAt=new Date(Date.now()-1).toISOString();await f.server.packsmart.store.save('alpha',state);
  assert.equal((await f.request(`/api/integrations/shopify/oauth/callback?state=${encodeURIComponent(token)}&code=anything`,{cookie})).status,400);
  response=await start();token=new URL(response.body.authorizationUrl).searchParams.get('state');cookie=response.headers.get('set-cookie').split(';')[0];
  assert.match((await f.request(`/api/integrations/shopify/oauth/callback?state=${encodeURIComponent(token)}&error=access_denied`,{cookie})).headers.get('location'),/cancelled/);
  assert.deepEqual((await f.server.packsmart.store.get('alpha')).connections[0].encryptedCredentials,original);
  assert.equal((await f.request('/api/integrations/shopify/oauth/start',{method:'POST',body:{storeDomain:'alpha.myshopify.com',writeAccess:true}})).status,400);
  assert.equal((await f.request('/api/integrations/shopify/oauth/start',{method:'POST',role:'admin',body:{storeDomain:'alpha.myshopify.com',writeAccess:true,confirmWriteAccess:'shopify'}})).status,403);
});

test('partial reads retain unselected variants and per-channel scheduling respects pause and frequency',()=>{
  const previous=[{id:'p1',title:'Old',variants:[{id:'v1',price:7,inventory:2},{id:'v2',price:9,inventory:3}]}];
  const merged=mergeSelectedShopify(previous,[{id:'p1',title:'New',inventory:10,variants:[{id:'v1',price:20,inventory:10}]}],['inventory']);
  assert.equal(merged[0].title,'Old');assert.equal(merged[0].variants.length,2);assert.equal(merged[0].variants[0].price,7);assert.equal(merged[0].variants[0].inventory,10);
  const state=seedWorkspaceState(),now=new Date();state.integrationStatus.shopify={lastSyncAt:now.toISOString()};
  saveConnectionSettings(state,'shopify',{revision:0,frequencyMinutes:60,autoSync:true},state.users[0]);
  assert.equal(connectionDue(state,'shopify',new Date(now.getTime()+30*60000)),false);assert.equal(connectionDue(state,'shopify',new Date(now.getTime()+61*60000)),true);
  saveConnectionSettings(state,'shopify',{revision:1,autoSync:false},state.users[0]);assert.equal(connectionDue(state,'shopify',new Date(now.getTime()+2*86400000)),false);
});

test('eBay disconnect preserves the separate Manager; read selection retains listings, pricing and failure diagnostics',async t=>{
  const f=await fixture(t);const state=await f.server.packsmart.store.get('alpha');
  const manager=encryptCredentials({baseUrl:'https://manager.example.test',apiToken:'manager-token-test',expectedAccount:'alpha-seller'},KEY);
  state.connections=[{id:'manager',provider:'ebay',encryptedCredentials:manager,metadata:{account:'alpha-seller'}},{id:'oauth',provider:'ebay_oauth',encryptedCredentials:encryptCredentials({mode:'direct_oauth',refreshToken:'refresh-test',expectedAccount:'alpha-seller'},KEY),metadata:{account:'alpha-seller',listingCount:1}}];
  state.ebay={source:'ebay-oauth-readonly',listings:[{id:'listing1',sku:'A',price:20,quantity:8}],promotions:[{id:'campaign'}],coverage:{fullCatalogueAvailable:false,inventoryAvailable:false,offersAvailable:false,unavailableSurfaces:['inventory'],readDiagnostics:{inventory:{httpStatus:403}}}};
  await f.server.packsmart.store.save('alpha',state);
  assert.equal((await f.request('/api/connections/ebay/sync',{method:'POST',body:{areas:['orders']}})).status,200);
  const saved=await f.server.packsmart.store.get('alpha');assert.deepEqual(saved.ebay.listings,state.ebay.listings);assert.deepEqual(saved.ebay.promotions,state.ebay.promotions);assert.equal(saved.ebay.coverage.inventoryAvailable,false);assert.equal(saved.ebay.coverage.readDiagnostics.inventory.httpStatus,403);
  assert.ok(!f.calls.some(call=>call.url.includes('/sell/inventory')||call.url.includes('/sell/marketing')));
  assert.equal((await f.request('/api/connections/ebay/disconnect',{method:'POST',body:{revision:0,confirm:'ebay'}})).status,200);
  const disconnected=await f.server.packsmart.store.get('alpha');assert.deepEqual(disconnected.connections.find(item=>item.id==='manager').encryptedCredentials,manager);assert.equal(disconnected.connections.find(item=>item.id==='oauth').encryptedCredentials,null);
});

test('degraded eBay catalogue coverage stays explicit; disconnect cannot reactivate environment credentials or alter Manager',()=>{
  const state=seedWorkspaceState(), env={SHOPIFY_STORE_DOMAIN:'alpha.myshopify.com',SHOPIFY_ADMIN_ACCESS_TOKEN:TOKEN,EBAY_MANAGER_BASE_URL:'https://manager.example.test'};
  const service=new IntegrationService(env);state.ebay={source:'ebay-oauth-readonly',coverage:{fullCatalogueAvailable:false}};state.integrationStatus.ebay={status:'connected'};
  assert.equal(connectionCentre(state,service).find(item=>item.id==='ebay').status,'degraded');
  state.connectionSettings={shopify:{disconnected:true},ebay:{disconnected:true}};
  assert.equal(service.shopifyConfigured(state),false);assert.equal(service.shopifyRefreshAvailable(state),false);assert.equal(service.ebayConfigured(state),false);
});

test('customer interface opens cards, saves sync settings, confirms disconnect, reconnects and exposes honest setup actions',async t=>{
  const f=await fixture(t);await f.connect();await f.request('/api/connections/shopify/test',{method:'POST',body:{}});
  const errors=[], console=new VirtualConsole(); console.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(await fs.readFile(new URL('../../index.html',import.meta.url),'utf8'),{url:'https://runvara.example.test',runScripts:'outside-only',virtualConsole:console,pretendToBeVisual:true});
  t.after(()=>dom.window.close());const {window}=dom, document=window.document;
  window.Headers=Headers;window.AbortController=AbortController;window.scrollTo=()=>{};window.HTMLElement.prototype.scrollIntoView=()=>{};
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const user=f.tenants.alpha.users[0],token=createSessionToken({userId:user.id,workspaceId:'alpha',email:user.email,role:'owner',sessionVersion:1},SESSION);
  window.fetch=async(route,options={})=>{const headers=new Headers(options.headers);headers.set('Cookie',`__Host-packsmart_session=${token}`);return fetch(f.base+route,{...options,headers});};
  for(const file of ['presentation.js','connections-ui.js','control-ui.js','app.js'])window.eval(await fs.readFile(new URL(`../../${file}`,import.meta.url),'utf8'));
  const until=async(fn)=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail(`UI did not reach expected state: ${errors.join('; ')} ${document.querySelector('#global-error').textContent}`);};
  await until(()=>document.querySelectorAll('.connection-card').length===8);
  document.querySelector('[data-view="channels"]').click();
  document.querySelector('[data-provider="shopify"][data-connection-action="sync"]').click();
  await until(()=>document.getElementById('connection-feedback').textContent.includes('synced successfully'));
  assert.equal(document.getElementById('connection-dialog').open,true);
  const form=document.getElementById('connection-sync-settings');form.elements.autoSync.checked=false;form.elements.frequencyMinutes.value='60';
  for(const input of form.querySelectorAll('[name="areas"]'))input.checked=input.value==='orders';
  form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await until(async()=>(await f.channel()).settings.autoSync===false);
  await until(()=>document.getElementById('connection-feedback').textContent==='Settings saved.');
  document.querySelector('[data-connection-action="disconnect"]').click();
  assert.equal((await f.channel()).configured,true,'opening confirmation never disconnects');
  let confirmation=document.getElementById('connection-disconnect');confirmation.elements.confirm.checked=true;
  confirmation.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>document.getElementById('connection-feedback').textContent.startsWith('Disconnected.'));
  assert.equal((await f.channel()).status,'disconnected');
  assert.ok(document.getElementById('connection-onboarding'));
  document.getElementById('connection-close').click();
  document.querySelector('[data-provider="amazon"][data-connection-action="connect"]').click();
  assert.match(document.getElementById('connection-detail').textContent,/not been enabled yet/);
  document.querySelector('[data-connection-action="setup-request"]').click();
  await until(()=>document.getElementById('connection-detail').textContent.includes('Setup request recorded'));
  assert.deepEqual(errors,[]);
  window.fetch=async()=>json({error:'Authentication required',code:'AUTH_REQUIRED'},401);
  document.getElementById('connection-refresh').click();
  await until(()=>!document.getElementById('connection-dialog').open);
  assert.equal(document.getElementById('login-screen').classList.contains('hidden'),false);
  assert.match(document.getElementById('global-error').textContent,/Runvara session has expired/);
});

async function metaFixture(t) {
  const f=await fixture(t), permissions=['pages_show_list','pages_read_engagement','instagram_basic','catalog_management','business_management','pages_manage_posts','instagram_content_publish'];
  f.flags.metaPermissions=permissions;f.flags.mediaStatus='IN_PROGRESS';
  f.flags.metaHandler=(url,options,body)=>{
    const p=url.pathname.replace('/v26.0','');
    if(p==='/oauth/access_token')return json({access_token:'meta-private-user-token',expires_in:5000000});
    if(f.flags.metaInvalid)return json({error:{code:190,message:'private provider diagnostic'}},401);
    if(p==='/me')return json({id:'100',name:'Meta owner'});
    if(p==='/me/permissions')return json({data:f.flags.metaPermissions.map(permission=>({permission,status:'granted'}))});
    if(p==='/me/accounts')return json({data:[{id:'200',name:'Alpha Page',tasks:['CREATE_CONTENT'],access_token:'meta-private-page-token',instagram_business_account:{id:'300',username:'alpha'}}]});
    if(p==='/me/businesses')return json({data:[{id:'400',name:'Alpha Business'}]});
    if(p==='/400/owned_product_catalogs')return json({data:[{id:'500',name:'Alpha Catalogue',vertical:'commerce'}]});
    if(p==='/400/client_product_catalogs')return json({data:[]});
    if((options.method||'GET')==='POST'){
      if(f.flags.metaUnknown)throw new TypeError('connection lost');
      if(p==='/600')return json({success:true});
      if(p==='/500/products')return json({id:'601'});
      if(p==='/200/feed')return json({id:'200_700'});
      if(p==='/200_700')return json({success:true});
      if(p==='/300/media')return json({id:'800'});
      if(p==='/300/media_publish')return json({id:'900'});
    }
    if(p==='/500/products')return f.flags.metaReadFail ? json({error:{code:4}},429) : json({data:[{id:'600',retailer_id:'SKU',name:'Meta item',description:'Description',price:'12.99',currency:'GBP',inventory:5,availability:'in stock',retailer_product_group_id:'group'}]});
    if(p==='/600')return json({id:'600',product_catalog:{id:f.flags.wrongCatalog?'999':'500'}});
    if(p==='/200/published_posts')return json({data:[{id:'200_700',message:'Post'}]});
    if(p==='/300/content_publishing_limit')return json({data:[{quota_usage:0,config:{quota_total:100}}]});
    if(p==='/800')return json({status_code:f.flags.mediaStatus});
    throw new Error(`Unexpected Meta path ${p}`);
  };
  f.metaConnect=async()=>{
    const start=await f.request('/api/integrations/meta/oauth/start',{method:'POST',body:{catalogAccess:true,confirmCatalogAccess:'meta',writeAccess:true,confirmWriteAccess:'meta'}});
    assert.equal(start.status,200);
    const token=new URL(start.body.authorizationUrl).searchParams.get('state'),cookie=start.headers.get('set-cookie').split(';')[0];
    const callback=await f.request(`/api/integrations/meta/oauth/callback?state=${encodeURIComponent(token)}&code=test-code`,{cookie});
    assert.match(callback.headers.get('location'),/connected/);
  };
  await f.metaConnect();
  const channel=await f.channel('meta');
  assert.equal((await f.request('/api/connections/meta/settings',{method:'POST',body:{revision:channel.settings.revision,metaPageIds:['200'],metaCatalogIds:['500']}})).status,200);
  f.metaPolicy=async(mode='approval_gated')=>f.request('/api/connections/meta/settings',{method:'POST',body:{revision:(await f.channel('meta')).settings.revision,permissionMode:mode,confirmPermission:`meta:${mode}`}});
  f.metaPrepare=async(input)=>{
    const result=await f.request('/api/connections/meta/writes',{method:'POST',body:{...input,requestId:crypto.randomUUID()}});assert.equal(result.status,200,JSON.stringify(result.body));return result.body.write;
  };
  f.metaApprove=async(write)=>{assert.equal((await f.request(`/api/approvals/${write.approvalId}/decision`,{method:'POST',body:{decision:'approved',revision:1}})).status,200);};
  f.metaExecute=write=>f.request(`/api/connection-writes/${write.id}/execute`,{method:'POST',body:{}});
  return f;
}

test('Meta OAuth uses explicit permissions and encrypted tokens; sync/disconnect/reconnect preserves tenant isolation',async t=>{
  const f=await metaFixture(t), c=await f.channel('meta');
  assert.equal(c.settings.permissionMode,'read_only');assert.equal(c.oauthReady,true);
  assert.equal((await f.request('/api/integrations/meta/oauth/start',{method:'POST',body:{catalogAccess:true}})).status,400);
  assert.equal((await f.request('/api/integrations/meta/oauth/start',{role:'admin',method:'POST',body:{catalogAccess:true,confirmCatalogAccess:'meta'}})).status,403);
  const plain=await f.request('/api/integrations/meta/oauth/start',{method:'POST',body:{}});
  assert.ok(!new URL(plain.body.authorizationUrl).searchParams.get('scope').includes('catalog_management'));
  assert.equal((await f.request('/api/connections/meta/settings',{method:'POST',tenant:'beta',body:{revision:0,metaCatalogIds:['500']}})).status,409);
  assert.equal((await f.request('/api/connections/meta/sync',{method:'POST',body:{areas:['products','inventory','prices','posts']}})).status,200);
  let state=await f.server.packsmart.store.get('alpha');assert.equal(state.channelData.meta.products[0].quantity,5);
  assert.equal(state.channelData.meta.products[0].groupId,'group');
  assert.equal(decryptCredentials(state.connections[0].encryptedCredentials,KEY).accessToken,'meta-private-user-token');
  assert.ok(!JSON.stringify((await f.request('/api/connection-centre')).body).includes('meta-private'));
  assert.ok(!JSON.stringify(state.channelData).includes('meta-private'));
  assert.equal((await f.server.packsmart.store.get('beta')).channelData?.meta,undefined);
  f.flags.metaReadFail=true;assert.equal((await f.request('/api/connections/meta/sync',{method:'POST',body:{areas:['products']}})).status,422);
  state=await f.server.packsmart.store.get('alpha');assert.equal(state.channelData.meta.products[0].name,'Meta item');assert.equal((await f.channel('meta')).status,'degraded');
  f.flags.metaReadFail=false;
  assert.equal((await f.request('/api/connections/meta/sync',{method:'POST',body:{areas:['orders']}})).status,400);
  assert.equal((await f.request('/api/connections/meta/disconnect',{method:'POST',body:{revision:(await f.channel('meta')).settings.revision,confirm:'meta'}})).status,200);
  assert.equal((await f.channel('meta')).status,'disconnected');
  await f.metaConnect();assert.equal((await f.channel('meta')).settings.permissionMode,'read_only');
});

test('Meta stock writes require exact approval even in automatic mode, recheck asset ownership and never replay',async t=>{
  const f=await metaFixture(t);await f.request('/api/connections/meta/sync',{method:'POST',body:{areas:['products','inventory']}});await f.metaPolicy('automatic');
  const write=await f.metaPrepare({operation:'catalog_inventory',catalogId:'500',productId:'600',quantity:8,availability:'in stock'});
  assert.equal(write.requiresApproval,true);assert.equal((await f.metaExecute(write)).status,409);
  assert.equal((await f.request(`/api/connection-writes/${write.id}/execute`,{method:'POST',tenant:'beta',body:{}})).status,404);
  assert.equal((await f.request(`/api/connection-writes/${write.id}/execute`,{method:'POST',role:'admin',body:{}})).status,403);
  await f.metaApprove(write);const result=await f.metaExecute(write);assert.equal(result.body.executedExternally,true);
  await f.metaExecute(write);assert.equal(f.calls.filter(item=>new URL(item.url).pathname==='/v26.0/600' && item.method==='POST').length,1);
  assert.ok(f.calls.filter(item=>item.url.includes('graph.facebook.com') && !item.url.includes('oauth/access_token') && !item.url.includes('/debug_token?')).every(item=>!item.url.includes('meta-private') && item.url.includes('appsecret_proof=')));
  const wrong=await f.metaPrepare({operation:'catalog_visibility',catalogId:'500',productId:'600',visibility:'published'});await f.metaApprove(wrong);f.flags.wrongCatalog=true;
  assert.equal((await f.metaExecute(wrong)).body.executedExternally,false);assert.equal(f.calls.filter(item=>new URL(item.url).pathname==='/v26.0/600' && item.method==='POST').length,1);
});

test('Meta revoked scopes and expired credentials block writes and show recoverable errors',async t=>{
  const f=await metaFixture(t);await f.metaPolicy();const write=await f.metaPrepare({operation:'facebook_publish',pageId:'200',message:'Approved post'});await f.metaApprove(write);
  f.flags.metaPermissions=f.flags.metaPermissions.filter(scope=>scope!=='pages_manage_posts');
  assert.equal((await f.metaExecute(write)).body.executedExternally,false);assert.ok(!f.calls.some(item=>item.method==='POST' && item.url.includes('/feed')));
  f.flags.metaInvalid=true;assert.equal((await f.request('/api/connections/meta/test',{method:'POST',body:{}})).status,422);
  assert.match((await f.channel('meta')).recovery.message,/reconnect|connect|sign in/i);
  assert.ok(!JSON.stringify((await f.request('/api/connection-centre')).body).includes('private provider diagnostic'));
});

test('Meta creates hidden drafts, publishes Facebook posts and updates only this app’s workspace posts',async t=>{
  const f=await metaFixture(t);await f.metaPolicy();
  assert.equal((await f.request('/api/connections/meta/writes',{method:'POST',body:{operation:'facebook_update',pageId:'200',postId:'200_999',message:'No',requestId:crypto.randomUUID()}})).status,409);
  const draft=await f.metaPrepare({operation:'catalog_product_create',catalogId:'500',retailerId:'A',name:'Box',description:'Box description',brand:'Runvara',category:'Packaging',url:'https://shop.example.test/box',imageUrl:'https://shop.example.test/box.jpg',priceMinor:599,currency:'GBP'});
  assert.equal(draft.input.visibility,'staging');await f.metaApprove(draft);assert.equal((await f.metaExecute(draft)).body.executedExternally,true);
  const post=await f.metaPrepare({operation:'facebook_publish',pageId:'200',message:'Approved content'});await f.metaApprove(post);assert.equal((await f.metaExecute(post)).body.write.result.externalId,'200_700');
  const update=await f.metaPrepare({operation:'facebook_update',pageId:'200',postId:'200_700',message:'Updated content'});await f.metaApprove(update);assert.equal((await f.metaExecute(update)).body.executedExternally,true);
});

test('Instagram processing survives multiple checks with one container and one approved publication',async t=>{
  const f=await metaFixture(t);await f.metaPolicy();const write=await f.metaPrepare({operation:'instagram_publish',pageId:'200',message:'Caption',imageUrl:'https://shop.example.test/photo.jpg'});await f.metaApprove(write);
  assert.equal((await f.metaExecute(write)).body.write.status,'processing');assert.equal((await f.metaExecute(write)).body.write.status,'processing');
  const state=await f.server.packsmart.store.get('alpha');state.connectionWrites[0].providerState.checkAfter=0;await f.server.packsmart.store.save('alpha',state);f.flags.mediaStatus='FINISHED';
  assert.equal((await f.metaExecute(write)).body.executedExternally,true);await f.metaExecute(write);
  assert.equal(f.calls.filter(item=>new URL(item.url).pathname==='/v26.0/300/media' && item.method==='POST').length,1);
  assert.equal(f.calls.filter(item=>new URL(item.url).pathname==='/v26.0/300/media_publish' && item.method==='POST').length,1);
});

test('Meta uncertain writes cannot be replayed and request content cannot change after approval',async t=>{
  const f=await metaFixture(t);await f.metaPolicy();let write=await f.metaPrepare({operation:'facebook_publish',pageId:'200',message:'Reviewed'});await f.metaApprove(write);
  const state=await f.server.packsmart.store.get('alpha');state.connectionWrites[0].input.message='Tampered';await f.server.packsmart.store.save('alpha',state);assert.equal((await f.metaExecute(write)).status,409);
  write=await f.metaPrepare({operation:'facebook_publish',pageId:'200',message:'Network test'});await f.metaApprove(write);f.flags.metaUnknown=true;
  assert.equal((await f.metaExecute(write)).body.write.status,'uncertain');assert.equal((await f.metaExecute(write)).status,409);
  assert.equal(f.calls.filter(item=>new URL(item.url).pathname==='/v26.0/200/feed' && item.method==='POST').length,1);
});

test('Meta customer controls select assets, request scopes and prepare the exact stock change for approval',async t=>{
  const f=await metaFixture(t);await f.request('/api/connections/meta/sync',{method:'POST',body:{areas:['products','inventory']}});await f.metaPolicy();
  const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(await fs.readFile(new URL('../../index.html',import.meta.url),'utf8'),{url:'https://runvara.example.test',runScripts:'outside-only',virtualConsole:vc,pretendToBeVisual:true});t.after(()=>dom.window.close());
  const {window}=dom,doc=window.document;window.Headers=Headers;window.AbortController=AbortController;window.scrollTo=()=>{};window.HTMLElement.prototype.scrollIntoView=()=>{};
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  const user=f.tenants.alpha.users[0],token=createSessionToken({userId:user.id,workspaceId:'alpha',email:user.email,role:'owner',sessionVersion:1},SESSION);
  window.fetch=async(route,options={})=>{const headers=new Headers(options.headers);headers.set('Cookie',`__Host-packsmart_session=${token}`);return fetch(f.base+route,{...options,headers});};
  for(const file of ['presentation.js','connections-ui.js','control-ui.js','app.js'])window.eval(await fs.readFile(new URL(`../../${file}`,import.meta.url),'utf8'));
  const until=async(fn)=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail(errors.join('; ')||'Meta interface did not reach the expected state');};
  await until(()=>doc.querySelectorAll('.connection-card').length===8);doc.querySelector('[data-provider="meta"][data-connection-action="open"]').click();
  assert.equal(doc.querySelector('#connection-meta-assets [name=metaCatalogIds]').checked,true);
  assert.ok(doc.querySelector('#connection-onboarding [name=catalogAccess]'));assert.equal(doc.querySelector('#connection-onboarding [name=writeAccess]').checked,false);
  assert.match(doc.querySelector('#connection-detail').textContent,/27 October 2026/);
  const form=doc.querySelector('#connection-meta-write-form');form.elements.operation.value='catalog_inventory';form.elements.operation.dispatchEvent(new window.Event('change',{bubbles:true}));
  assert.equal(form.querySelector('[name=message]'),null);form.elements.catalogId.value='500';form.elements.productId.value='600';form.elements.quantity.value='17';
  form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>doc.querySelector('.connection-write'));
  const write=(await f.server.packsmart.store.get('alpha')).connectionWrites[0];assert.equal(write.input.quantity,17);assert.equal(write.status,'pending_approval');
  assert.equal(doc.querySelector('[data-connection-action=execute]'),null);assert.match(doc.querySelector('.connection-write').textContent,/17/);
  assert.ok(!f.calls.some(item=>item.method==='POST' && item.url.includes('/v26.0/600')));assert.deepEqual(errors,[]);
});

test('Meta Connect always targets standard Facebook OAuth and returns connected Pages and Instagram to the same workspace',async t=>{
  const f=await fixture(t,{META_LOGIN_CONFIG_ID:'business-config-test',META_AUTH_URL:'https://work.meta.com/',META_OAUTH_AUTHORIZE_URL:'https://work.meta.com/'});
  const start=await f.request('/api/integrations/meta/oauth/start',{method:'POST',body:{authorizationUrl:'https://work.meta.com/'}});assert.equal(start.status,200);
  const url=new URL(start.body.authorizationUrl);
  assert.equal(url.origin,'https://www.facebook.com');assert.equal(url.pathname,'/v26.0/dialog/oauth');
  assert.equal(url.searchParams.get('redirect_uri'),'https://runvara.example.test/api/integrations/meta/oauth/callback');
  assert.equal(url.searchParams.get('response_type'),'code');assert.equal(url.searchParams.get('config_id'),'business-config-test');
  assert.equal(url.searchParams.get('scope'),'pages_show_list,pages_read_engagement,instagram_basic');assert.ok(url.searchParams.get('state'));
  const callback=`/api/integrations/meta/oauth/callback?code=provider-code&state=${encodeURIComponent(url.searchParams.get('state'))}`,cookie=start.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.request(callback,{cookie:'wrong=browser'})).status,400);
  const returned=await f.request(callback,{cookie});assert.equal(returned.status,303);assert.match(returned.headers.get('location'),/^\/\?channel=meta&connection=connected/);
  assert.equal((await f.request(callback,{cookie})).status,400);
  assert.equal((await f.request('/api/connections/meta/test',{method:'POST',body:{}})).status,200);
  assert.equal((await f.request('/api/connections/meta/sync',{method:'POST',body:{areas:['accounts']}})).status,200);
  const channel=await f.channel('meta');assert.equal(channel.status,'connected');assert.equal(channel.meta.assets.pages[0].id,'page1');assert.equal(channel.meta.assets.pages[0].instagram.username,'my-shop');assert.equal(channel.meta.data.accounts[0].instagram.id,'ig1');
  assert.equal((await f.server.packsmart.store.get('beta')).connections.length,0);assert.ok(!JSON.stringify(channel).includes('MUST-NOT-STORE'));
});

test('Meta Connect UI refuses Meta Work, developer portals and lookalike OAuth destinations',async t=>{
  const f=await metaFixture(t),errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(await fs.readFile(new URL('../../index.html',import.meta.url),'utf8'),{url:'https://runvara.example.test',runScripts:'outside-only',virtualConsole:vc});t.after(()=>dom.window.close());
  const {window}=dom,doc=window.document;window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  window.eval(await fs.readFile(new URL('../../presentation.js',import.meta.url),'utf8'));
  window.eval(await fs.readFile(new URL('../../connections-ui.js',import.meta.url),'utf8'));
  let next='';
  window.RunvaraConnections.init({request:async()=>({authorizationUrl:next}),escapeHtml:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),date:String,notify:()=>{},reload:async()=>{},setView:()=>{}});
  window.RunvaraConnections.render({user:{role:'owner'},connectionCentre:[await f.channel('meta')],connectionWrites:[]});window.RunvaraConnections.open('meta',true);
  for(const target of ['https://work.meta.com/','https://business.facebook.com/business/loginpage/','https://www.facebook.com/login/','https://www.facebook.com.evil.example/v26.0/dialog/oauth','https://www.facebook.com@work.meta.com/v26.0/dialog/oauth']) {
    next=target;const form=doc.querySelector('#connection-onboarding');form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await new Promise(resolve=>setImmediate(resolve));
    assert.match(doc.querySelector('#connection-feedback').textContent,/No account was connected/);assert.equal(form.querySelector('button[type=submit]').disabled,false);assert.equal(window.location.href,'https://runvara.example.test/');
  }
  assert.match(doc.querySelector('#connection-onboarding').textContent,/No Meta Work account is needed/);assert.deepEqual(errors,[]);
});

test('connection diagnostics expose safe expiry and tenant audit summaries, never token material',async t=>{
  const f=await fixture(t);await f.connect();
  const state=await f.server.packsmart.store.get('alpha'), record=state.connections.find(item=>item.provider==='shopify');
  const credentials=decryptCredentials(record.encryptedCredentials,KEY);
  record.encryptedCredentials=encryptCredentials({...credentials,expiresAt:Date.now()+3600000},KEY);
  state.audit.unshift({id:'audit-safe',type:'connection_permissions_changed',createdAt:'2026-09-23T12:00:00Z',detail:{provider:'shopify',secret:'must-not-be-exposed'}});
  await f.server.packsmart.store.save('alpha',state);
  const value=await f.channel();
  assert.ok(value.accessExpiresAt);assert.equal(value.audit[0].id,'audit-safe');assert.equal(value.audit[0].detail,undefined);
  assert.doesNotMatch(JSON.stringify(value),/must-not-be-exposed|test-only-shopify-access-token/);
  const other=await f.request('/api/connection-centre',{tenant:'beta'});
  assert.doesNotMatch(JSON.stringify(other.body),/audit-safe/);
});

test('unsupported channel write modes are rejected without consent or settings mutations',()=>{
  const state=seedWorkspaceState();const before=JSON.stringify(state);
  assert.throws(()=>saveConnectionSettings(state,'google_youtube',{revision:0,permissionMode:'automatic',confirmPermission:'google_youtube:automatic'},{id:'owner',role:'owner'}),error=>error.code==='WRITE_UNSUPPORTED');
  assert.equal(JSON.stringify(state),before);
});

test('failed sync and failed status refresh restore controls instead of leaving Starting sync',async t=>{
  const f=await fixture(t);await f.connect();
  const dom=new JSDOM(await fs.readFile(new URL('../../index.html',import.meta.url),'utf8'),{url:'https://runvara.example.test',runScripts:'outside-only'});t.after(()=>dom.window.close());
  const {window}=dom, document=window.document;
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  window.eval(await fs.readFile(new URL('../../presentation.js',import.meta.url),'utf8'));
  window.eval(await fs.readFile(new URL('../../connections-ui.js',import.meta.url),'utf8'));
  const messages=[];
  window.RunvaraConnections.init({request:async()=>{throw Object.assign(new Error('Authentication required'),{code:'AUTH_REQUIRED',status:401});},escapeHtml:value=>String(value??''),date:String,notify:message=>messages.push(message),reload:async()=>{},setView:()=>{}});
  window.RunvaraConnections.render({user:{role:'owner'},connectionCentre:[await f.channel()],connectionWrites:[]});
  window.RunvaraConnections.open('shopify');document.querySelector('[data-connection-action="sync-selected"]').click();
  for(let i=0;i<30&&!messages.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.match(messages[0],/Runvara session has expired/);
  assert.doesNotMatch(document.getElementById('connection-progress').textContent,/Starting sync/);
  assert.equal(document.querySelector('[data-connection-action="test"]').disabled,false);
  assert.equal(document.getElementById('connection-dialog').hasAttribute('aria-busy'),false);
  window.RunvaraConnections.endSession();assert.equal(document.getElementById('connection-dialog').open,false);
});

test('provider rate limits offer retry recovery without incorrectly asking for credentials',async()=>{
  const service=new IntegrationService({CREDENTIALS_KEY:KEY},{fetchImpl:async()=>json({},429)});
  service.fetch=async()=>json({},429);
  await assert.rejects(service.connectorGet('google_youtube','/channels',{accessToken:'test'}),error=>error.code==='CONNECTION_RATE_LIMITED');
  const state=seedWorkspaceState();state.integrationStatus.google_youtube={status:'degraded',lastError:'CONNECTION_RATE_LIMITED'};
  state.connections=[{provider:'google_youtube',encryptedCredentials:encryptCredentials({accessToken:'test'},KEY)}];
  const channel=connectionCentre(state,service).find(item=>item.id==='google_youtube');
  assert.equal(channel.recovery.action,'sync');assert.match(channel.recovery.message,/limiting requests/);
});

test('onboarding persists per workspace and cannot bypass readiness or permission consent', async t => {
  const f=await fixture(t);
  let result=await f.request('/api/onboarding',{method:'POST',body:{revision:0,platforms:['shopify']}});
  assert.equal(result.status,200);assert.equal(result.body.complete,false);
  assert.equal((await f.request('/api/onboarding',{tenant:'beta'})).body.journey.platforms.length,0);
  assert.equal((await f.request('/api/onboarding',{method:'POST',body:{revision:1,finish:true}})).status,409);
  await f.connect();await f.request('/api/connections/shopify/test',{method:'POST',body:{}});
  await f.request('/api/connections/shopify/sync',{method:'POST',body:{areas:['products']}});
  result=await f.request('/api/onboarding',{method:'POST',body:{revision:1,reviewPermissions:'shopify'}});
  assert.equal(result.status,200);assert.equal(result.body.complete,true);
  assert.equal((await f.channel()).settings.permissionMode,'read_only');
  result=await f.request('/api/onboarding',{method:'POST',body:{revision:2,finish:true}});
  assert.equal(result.status,200);assert.ok(result.body.completedAt);
  const state=await f.server.packsmart.store.get('alpha');
  state.connectionSettings.shopify.revision++;await f.server.packsmart.store.save('alpha',state);
  assert.equal((await f.request('/api/onboarding')).body.journey.complete,false);
});

test('Meta recovers only app-verified granular Page targets and never publishes tokens', async () => {
  const service=new IntegrationService({META_CLIENT_ID:'app',META_CLIENT_SECRET:'secret'},{fetchImpl:async()=>{throw Error('unexpected');}});
  const calls=[];
  service.metaList=async path=>path==='/me/accounts'?[{id:'100',name:'First',access_token:'page-private'}]:[];
  service.metaRequest=async(path,token)=>{
    calls.push([path,token]);
    if(path==='/debug_token')return {data:{is_valid:true,app_id:'app',granular_scopes:[{scope:'pages_show_list',target_ids:['100','200']},{scope:'other',target_ids:['999']} ]}};
    if(path==='/200')return {id:'200',name:'Recovered',access_token:'other-private',instagram_business_account:{id:'300',username:'business'}};
    if(path==='/100')return {id:'100'};
    throw Error('Unexpected target');
  };
  const result=await service.metaAssets({accessToken:'user-private'},['pages_show_list','instagram_basic']);
  assert.deepEqual(result.pages.map(p=>p.id),['100','200']);assert.equal(result.pages[1].instagram.id,'300');
  assert.ok(!JSON.stringify({pages:result.pages,discovery:result.discovery}).includes('private'));
  assert.ok(!calls.some(([path])=>path==='/999'));assert.ok(calls.some(([path,token])=>path==='/100'&&token==='page-private'));
  service.metaRequest=async()=>({data:{is_valid:true,app_id:'different-app',granular_scopes:[{scope:'pages_show_list',target_ids:['999']}]}});
  assert.deepEqual((await service.metaAssets({accessToken:'user-private'},['pages_show_list'])).pages.map(p=>p.id),['100']);
});

test('Shopify tag actions require approval even in automatic mode and remain tenant bound', async t=>{
  const f=await fixture(t);await f.connect();await f.request('/api/connections/shopify/test',{method:'POST',body:{}});
  const channel=await f.channel();await f.request('/api/connections/shopify/settings',{method:'POST',body:{revision:channel.settings.revision,permissionMode:'automatic',confirmPermission:'shopify:automatic'}});
  for(const operation of ['product_tags_add','product_tags_remove']){
    const result=await f.request('/api/connections/shopify/writes',{method:'POST',body:{operation,productId:'gid://shopify/Product/1',tags:'Reviewed, Internal',requestId:`test-${operation}-0001`}});
    assert.equal(result.status,200);const write=result.body.write;assert.equal(write.requiresApproval,true);
    const route=`/api/connection-writes/${write.id}/execute`;
    assert.equal((await f.request(route,{method:'POST',body:{}})).status,409);
    assert.equal((await f.request(route,{tenant:'beta',method:'POST',body:{}})).status,404);
    await f.request(`/api/approvals/${write.approvalId}/decision`,{method:'POST',body:{decision:'approved',revision:1}});
    assert.equal((await f.request(route,{method:'POST',body:{}})).body.write.status,'completed');
    await f.request(route,{method:'POST',body:{}});
  }
  assert.equal(f.calls.filter(call=>call.query.includes('RunvaraProductTags')).length,2);
});

test('connection polling never overlaps slow status requests',async t=>{
  const f=await fixture(t);const channel=await f.channel();
  const dom=new JSDOM(await fs.readFile(new URL('../../index.html',import.meta.url),'utf8'),{url:'https://runvara.example.test',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
  const {window}=dom;window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  let poll,resolve,calls=0;window.setInterval=callback=>{poll=callback;return 1;};window.clearInterval=()=>{};
  const pending=new Promise(done=>resolve=done);
  window.eval(await fs.readFile(new URL('../../presentation.js',import.meta.url),'utf8'));
  window.eval(await fs.readFile(new URL('../../connections-ui.js',import.meta.url),'utf8'));
  window.RunvaraConnections.init({request:()=>{calls++;return pending;},reload:async()=>{},notify:()=>{},setView:()=>{},date:String,escapeHtml:String});
  window.RunvaraConnections.render({user:{role:'owner'},connectionCentre:[channel],connectionWrites:[]});window.RunvaraConnections.open('shopify');
  poll();poll();poll();assert.equal(calls,1);
  resolve({channels:[channel],writes:[],autopilotEnabled:false});await new Promise(done=>setImmediate(done));
  window.RunvaraConnections.endSession();
});

test('eBay eligibility recovery explains provider restriction without reconnect advice',()=>{
  const recovery = recoveryFor('ebay', {status:'degraded'}, {readDiagnostics:{marketing:{httpStatus:409,errorIds:['35077'],stage:'ads'}}});
  assert.match(recovery.message, /not currently eligible/);
  assert.match(recovery.message, /Order imports can continue/);
  assert.equal(recovery.action, 'sync');
});


test('reconnection verifies identity, retries selected reads once, preserves failures and never executes a write',async t=>{
  const f=await fixture(t);await f.connect();
  const channel=await f.channel();
  assert.equal((await f.request('/api/connections/shopify/settings',{method:'POST',body:{revision:channel.settings.revision,areas:['products'],autoSync:true,frequencyMinutes:30}})).status,200);
  async function reconnect(){
    const start=await f.request('/api/integrations/shopify/oauth/start',{method:'POST',body:{storeDomain:'alpha.myshopify.com'}});
    const state=new URL(start.body.authorizationUrl).searchParams.get('state'),cookie=start.headers.get('set-cookie').split(';')[0];
    const url=new URL('/api/integrations/shopify/oauth/callback',f.base);url.search=new URLSearchParams({code:'reconnect-code',shop:'alpha.myshopify.com',state,timestamp:String(Math.floor(Date.now()/1000))}).toString();
    const message=[...url.searchParams.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join('&');
    url.searchParams.set('hmac',crypto.createHmac('sha256',f.env.SHOPIFY_OAUTH_CLIENT_SECRET).update(message).digest('hex'));
    const route=url.pathname+url.search;
    assert.equal((await f.request(route,{cookie})).status,303);
    const count=f.calls.length;
    assert.equal((await f.request(route,{cookie})).status,400);
    assert.equal(f.calls.length,count,'replayed callback never retries provider requests');
  }
  await reconnect();
  let state=await f.server.packsmart.store.get('alpha');
  assert.equal(state.products[0].title,'Live product');
  assert.equal(state.orders[0].id,'alpha-historical');
  assert.equal(f.calls.filter(call=>call.query.includes('Products')).length,1);
  assert.ok(state.audit.some(item=>item.type==='connection_reconnect_read_sync'));
  assert.deepEqual((await f.channel()).settings.areas,['products']);
  assert.equal((await f.channel()).settings.permissionMode,'read_only');
  const preserved=JSON.stringify(state.products);
  f.flags.readUnavailable=true;await reconnect();
  state=await f.server.packsmart.store.get('alpha');
  assert.equal(JSON.stringify(state.products),preserved,'failed retry retains last good import');
  assert.equal((await f.channel()).history[0].status,'failed');
  assert.ok(!f.calls.some(call=>call.query.includes('mutation')));
  assert.equal((await f.server.packsmart.store.get('beta')).products[0].title,'Before');
  assert.ok(!JSON.stringify((await f.channel())).includes('private failure'));
  state.integrationStatus.shopify.lastError='SHOPIFY_PERMISSION_REQUIRED';
  assert.equal(connectionDue(state,'shopify',new Date(Date.now()+86400000)),false,'permission loss waits for owner repair');
});
