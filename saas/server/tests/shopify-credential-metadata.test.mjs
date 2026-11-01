import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyShopifyCredential as classify, SHOPIFY_DIAGNOSTIC_PATH as PATH, shopifyCredentialDiagnostic } from '../lib/shopify-credential-metadata.mjs';
import { createStartupPolicy } from '../lib/startup-mode.mjs';
import { fixture, catalogueState, ID, DOMAIN } from './shopify-catalogue-import-fixture.mjs';
import { SECRET } from './maintenance-login-fixture.mjs';
import { encryptCredentials, createSessionToken } from '../lib/security.mjs';

const now=Date.parse('2026-11-01T12:00:00.000Z');
const direct={storeDomain:DOMAIN,accessToken:'synthetic-token-only'};
const oauth={...direct,mode:'oauth',expiresAt:null,refreshToken:null,refreshTokenExpiresAt:null,scopes:['read_products']};
const enabled={RUNVARA_QUIET_SHOPIFY_CATALOGUE:'disabled/v1',RUNVARA_QUIET_SHOPIFY_DIAGNOSTIC:'enabled/v1'};
for(const [name,value,type,expiry,compatible] of [
 ['absent',undefined,'unknown','unknown',false],['empty',{},'missing','unknown',false],
 ['direct',direct,'direct_access_token','non_expiring_metadata',true],
 ['recognized OAuth null',oauth,'oauth','non_expiring_metadata',true],
 ['null alone',{...direct,expiresAt:null},'direct_access_token','unknown',false],
 ['OAuth without shape',{...direct,mode:'oauth',expiresAt:null},'oauth','unknown',false],
 ['unknown mode',{...oauth,mode:'unrecognized-secret-marker'},'unknown','unknown',false],
 ['unrecognized online shape',{...oauth,associated_user:{id:'synthetic-user'}},'unknown','unknown',false],
 ['provider lifetime instead of stored expiry',{...direct,expires_in:3600},'unknown','unknown',false],
 ['zero expiry',{...direct,expiresAt:0},'direct_access_token','malformed',false],
 ['future',{...direct,expiresAt:now+120000},'direct_access_token','future',true],
 ['expired',{...direct,expiresAt:now-1},'direct_access_token','expired',false],
 ['expiring',{...direct,expiresAt:now+60000},'direct_access_token','expiring',false],
 ['ISO string',{...direct,expiresAt:new Date(now+120000).toISOString()},'direct_access_token','malformed',false],
 ['numeric string',{...direct,expiresAt:String(now+120000)},'direct_access_token','malformed',false],
 ['NaN',{...direct,expiresAt:NaN},'direct_access_token','malformed',false],
 ['infinity',{...direct,expiresAt:Infinity},'direct_access_token','malformed',false],
 ['out of range',{...direct,expiresAt:8640000000000001},'direct_access_token','malformed',false],
 ['refresh contradiction',{...oauth,refreshToken:'synthetic-refresh-only'},'oauth','unknown',false],
 ['refresh expiry contradiction',{...oauth,refreshTokenExpiresAt:now+120000},'oauth','unknown',false],
 ['mixed grants',{...direct,clientId:'synthetic-client',clientSecret:'synthetic-secret'},'unknown','unknown',false],
 ['client credentials',{clientId:'synthetic-client',clientSecret:'synthetic-secret'},'client_credentials','unknown',false],
 ['OAuth future',{...oauth,expiresAt:now+120000,refreshToken:'synthetic-refresh-only',refreshTokenExpiresAt:now+240000},'oauth','future',true],
 ['OAuth missing expiry',Object.fromEntries(Object.entries(oauth).filter(([k])=>k!=='expiresAt')),'oauth','unknown',false],
]) test('metadata: '+name,()=>{
 const before=structuredClone(value);const r=classify(value,now);assert.equal(r.credentialType,type);assert.equal(r.expiryState,expiry);assert.equal(r.metadataCompatible,compatible);
 assert.equal(r.providerUsability,'unverified');assert.deepEqual(value,before);assert.doesNotMatch(JSON.stringify(r),/synthetic|unrecognized-secret-marker/);
});

test('invalid token values and clock fail closed',()=>{
 for(const accessToken of ['short','has whitespace inside',{},42])assert.equal(classify({...oauth,accessToken},now).metadataCompatible,false);
 assert.equal(classify(oauth,NaN).metadataCompatible,false);
});
test('diagnostic requires exact default-off quiet owner switch',()=>{
 assert.equal(createStartupPolicy({},[]).quietShopifyDiagnostic,false);
 for(const value of [null,true,'enabled/v1 ', 'true']) assert.throws(()=>createStartupPolicy({RUNVARA_QUIET_SHOPIFY_DIAGNOSTIC:value},[]));
 assert.throws(()=>createStartupPolicy({RUNVARA_QUIET_SHOPIFY_DIAGNOSTIC:'enabled/v1'},[]));
 const p=createStartupPolicy({RUNVARA_STARTUP_MODE:'quiet',RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',...enabled},[]);
 assert.equal(p.allowsRequest('GET',PATH),true);for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS'])assert.equal(p.allowsRequest(method,PATH),false);
 assert.equal(p.allowsRequest('POST','/api/integrations/sync'),false);assert.equal(p.catalogue,null);
});
test('default-off rejects before workspace reads',async t=>{
 const f=await fixture(t,{env:{RUNVARA_QUIET_SHOPIFY_CATALOGUE:'disabled/v1'}});const before=f.calls.length;
 assert.equal((await f.request(PATH,{cookie:f.cookie})).status,503);assert.equal(f.calls.length,before);assert.equal(f.reads.length,0);
});
test('diagnostic is explicit, no-store, exact snapshot and sanitized; no business or credential mutation',async t=>{
 const f=await fixture(t,{env:enabled});const before=structuredClone(f.fake.states.get(ID));
 const boot=await f.request('/api/bootstrap',{cookie:f.cookie});assert.equal(boot.payload.shopifyCredentialDiagnosticAvailable,true);assert.equal(boot.payload.catalogueImport.enabled,false);
 const r=await f.request(PATH,{cookie:f.cookie});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 assert.deepEqual(Object.keys(r.payload).sort(),['schema','credentialPresent','bindingMatches','configMatches','tokenPresent','credentialType','expiryState','expiresAt','metadataCompatible','providerUsability','code'].sort());
 assert.equal(r.payload.metadataCompatible,true);assert.equal(r.payload.configMatches,true);assert.equal(r.payload.providerUsability,'unverified');
 assert.doesNotMatch(JSON.stringify(r.payload),/synthetic|accessToken|refreshToken|encrypted|Digest|fingerprint/);
 assert.deepEqual(f.fake.states.get(ID),before);assert.equal(f.reads.length,0);assert.equal(f.calls.some(c=>c.method!=='GET'),false);
 assert.equal(f.server.packsmart.scheduler.status.lastTickAt,null);assert.equal(f.server.packsmart.agentOps.status.lastTickAt,null);
});
for(const kind of ['anonymous','admin','viewer','inactive','revoked','password','tenant','cross-record','expired','expired-cookie','different-tenant-cookie','duplicate-owner']) test('diagnostic rejects '+kind,async t=>{
 const f=await fixture(t,{env:enabled});const s=f.fake.states.get(ID),user=s.users[0];
 if(['admin','viewer'].includes(kind))user.role=kind;
 if(kind==='inactive')user.active=false;if(kind==='revoked')user.sessionVersion++;
 if(kind==='password')user.passwordChangeRequired=true;if(kind==='tenant')s.workspace.id='beta';if(kind==='cross-record')s.products.push({workspaceId:'beta'});
 if(kind==='duplicate-owner')s.users.push(structuredClone(user));
 let cookie=kind==='anonymous'?undefined:f.cookie;
 if(kind==='expired-cookie')cookie='__Host-packsmart_session='+createSessionToken({userId:user.id,workspaceId:ID,email:'synthetic@example.test',role:'owner'},SECRET,-1);
 if(kind==='different-tenant-cookie')cookie='__Host-packsmart_session='+createSessionToken({userId:'beta-owner',workspaceId:'beta',email:'synthetic@example.test',role:'owner'},SECRET);
 if(kind==='expired') {
  assert.throws(()=>shopifyCredentialDiagnostic({state:s,session:{...f.session,exp:1}}, {shopifyConfig:()=>assert.fail('must not inspect credentials')},f.config),{code:'SHOPIFY_DIAGNOSTIC_SESSION_EXPIRED'});
 } else assert.ok([401,403].includes((await f.request(PATH,{cookie})).status));
 assert.equal(f.reads.length,0);assert.equal(f.calls.some(c=>c.method==='PATCH'),false);
});
test('query, method and adjacent routes cannot broaden diagnostic',async t=>{
 const f=await fixture(t,{env:enabled});
 assert.equal((await f.request(PATH+'?workspaceId=beta',{cookie:f.cookie})).status,400);
 for(const method of ['POST','PUT','DELETE','PATCH','HEAD','OPTIONS'])assert.equal((await f.request(PATH,{cookie:f.cookie,method})).status,503);
 assert.equal((await f.request(PATH+'/renew',{cookie:f.cookie})).status,503);assert.equal(f.reads.length,0);assert.equal(f.calls.some(c=>c.method!=='GET'),false);
});
for(const kind of ['absent','unreadable','domain','duplicate','disconnected','config','unknown','stored-domain','known-expired','malformed-expiry']) test('diagnostic redacts '+kind,async t=>{
 const s=catalogueState();
 if(kind==='absent')delete s.connections[0].encryptedCredentials;
 if(kind==='unreadable')s.connections[0].encryptedCredentials='malformed-secret-do-not-log';
 if(kind==='domain')s.connections[0].metadata.shopDomain='other.myshopify.com';
 if(kind==='duplicate')s.connections.push(structuredClone(s.connections[0]));
 if(kind==='disconnected')s.connectionSettings.shopify.disconnected=true;
 if(kind==='unknown')s.connections[0].encryptedCredentials=encryptCredentials({...direct,mode:'secret-marker-unknown',expiresAt:null},SECRET);
 if(kind==='stored-domain')s.connections[0].encryptedCredentials=encryptCredentials({...direct,storeDomain:'other.myshopify.com'},SECRET);
 if(kind==='known-expired')s.connections[0].encryptedCredentials=encryptCredentials({...direct,expiresAt:now-1},SECRET);
 if(kind==='malformed-expiry')s.connections[0].encryptedCredentials=encryptCredentials({...direct,expiresAt:'secret-marker-expiry'},SECRET);
 const logs=[];const f=await fixture(t,{state:s,env:{...enabled,...(kind==='config'?{SHOPIFY_ADMIN_API_VERSION:'2099-01'}:{})}});t.mock.method(console,'error',(...args)=>logs.push(args));
 const before=structuredClone(f.fake.states.get(ID));const r=await f.request(PATH,{cookie:f.cookie});assert.equal(r.status,200);assert.equal(r.payload.metadataCompatible,false);
 assert.doesNotMatch(JSON.stringify(r.payload)+JSON.stringify(logs),/synthetic-token|secret-marker|malformed-secret|ciphertext|accessToken/);
 assert.deepEqual(f.fake.states.get(ID),before);assert.equal(f.reads.length,0);assert.equal(f.calls.some(c=>c.method!=='GET'),false);
});
test('recognized OAuth null metadata allows the existing bounded import without renewal or credential changes',async t=>{
 const s=catalogueState();s.connections[0].encryptedCredentials=encryptCredentials(oauth,SECRET);const f=await fixture(t,{state:s});const original=structuredClone(s.connections);
 const r=await f.submit();assert.equal(r.status,200,JSON.stringify(r.payload));assert.equal(r.payload.run.status,'imported');assert.equal(f.reads.length,1);assert.deepEqual(f.fake.states.get(ID).connections,original);
});
for(const [name,value] of [['null alone',{...direct,expiresAt:null}],['unknown mode',{...oauth,mode:'other'}],['malformed',{...direct,expiresAt:'tomorrow'}]]) test('import stops before claim/source for '+name,async t=>{
 const s=catalogueState();s.connections[0].encryptedCredentials=encryptCredentials(value,SECRET);const f=await fixture(t,{state:s});
 const r=await f.submit();assert.equal(r.status,409);assert.match(r.payload.code,/TOKEN_METADATA_(UNKNOWN|INVALID)$/);assert.equal(f.reads.length,0);assert.equal(f.calls.some(c=>c.method==='PATCH'),false);
});
