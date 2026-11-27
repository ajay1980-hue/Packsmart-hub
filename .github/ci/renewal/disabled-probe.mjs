import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createSessionToken} from '/app/saas/server/lib/security.mjs';
const deadline=Date.now()+30000;
assert.equal(Number(process.versions.node.split('.')[0]),22);
let response,health;
while(Date.now()<deadline){
  try{response=await fetch('http://127.0.0.1:8787/api/health',{signal:AbortSignal.timeout(1000)});health=await response.json();break;}catch{await delay(100);}
}
assert.ok(health,'bounded startup did not produce health');
assert.equal(response.status,503,'filesystem production fixture must not claim production readiness');
assert.equal(health.startupMode,'quiet');assert.equal(health.ownerShopifyRuntimeRenewal,false);
assert.equal(health.quietOwnerWorkspace,true);assert.equal(health.quietOwnerLogin,true);
assert.equal(health.productionReady,false);assert.equal(health.agentOps.running,false);assert.equal(health.agentOps.lastTickAt,null);
assert.equal(health.checks.authentication,true);assert.equal(health.checks.credentialEncryption,true);
for(const key of ['quietOwnerProductReadiness','quietShopifyCatalogue','quietShopifyDiagnostic','quietShopifyTokenExchange','quietParcel2GoCredentialEntry','quietParcel2GoSandboxQuote','quietCommercePreview','quietPublicSupport','quietSupportProducts','quietProductOnlySupport'])assert.equal(health[key],false,key);
assert.equal(health.quietApprovalPilot.open,false);assert.equal(health.quietCreativePilot.open,false);
const token=createSessionToken({userId:'fixture-owner',workspaceId:'packsmart-solutions',email:'owner@example.test',role:'owner',sessionVersion:1},process.env.SESSION_SECRET);
let denied=0;
for(const cookie of ['',`__Host-packsmart_session=${token}`])for(const [method,action] of [['GET','review'],['GET','status'],['POST','approve'],['POST','run'],['POST','close']]){
  const r=await fetch(`http://127.0.0.1:8787/api/owner/shopify-runtime-renewal/${action}`,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(1000)});
  assert.equal(r.status,503);assert.equal((await r.json()).code,'STARTUP_QUIET_MODE');denied++;
}
console.log(JSON.stringify({unmodifiedEntrypoint:true,node:process.version,mode:health.startupMode,renewal:health.ownerShopifyRuntimeRenewal,healthStatus:response.status,deliberatelyMissingProductionPersistence:true,deniedRequests:denied,agentRunning:health.agentOps.running,lastTickAt:health.agentOps.lastTickAt}));
