import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {maintenanceFixture,ownerState} from '/app/saas/server/tests/maintenance-login-fixture.mjs';
const outputs='/evidence';await fs.mkdir(outputs,{recursive:true});
assert.equal(process.versions.node,'22.23.5');
assert.equal(process.execPath,'/opt/runvara-node22/bin/node');
assert.equal(process.platform,'linux');assert.equal(process.arch,'x64');
const glibc=process.report.getReport().header.glibcVersionRuntime;
assert.match(glibc||'',/^\d+\.\d+$/,'expected glibc Node runtime');
await fs.writeFile(`${outputs}/node-runtime.json`,JSON.stringify({version:process.versions.node,executable:process.execPath,platform:process.platform,arch:process.arch,glibc},null,2));
const pkg=JSON.parse(await fs.readFile('/app/saas/server/node_modules/playwright/package.json','utf8'));
assert.equal(pkg.version,'1.62.1');
async function run(args,name,timeout=180000,extra={}){
  const log=await fs.open(`${outputs}/${name}.log`,'wx');
  const child=spawn(process.execPath,args,{cwd:'/app',env:{PATH:process.env.PATH,HOME:'/tmp',TMPDIR:'/tmp',PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH||'/ms-playwright',...extra},stdio:['ignore',log.fd,log.fd]});
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);await log.close();
  assert.ok(!timedOut,`${name} exceeded its deadline`);assert.equal(code,0,`${name} failed`);
}
await run(['.github/ci/renewal/network-check.mjs'],'network-boundary',10000);
await run(['.github/ci/renewal/validate-inputs.mjs','/app','source-only'],'source-identity',10000);
for(const [i,file] of ['saas/server/lib/shopify-renewal-runtime-permit.mjs','saas/server/lib/shopify-renewal-runtime.mjs','saas/shopify-runtime-renewal-ui.js'].entries())await run(['--check',file],`syntax-${i}`,10000);
const records=[];
for(const flag of [undefined,'disabled/v1']){
  let providerCalls=0;
  const state=ownerState('packsmart-solutions'),before=createHash('sha256').update(JSON.stringify(state)).digest('hex');
  const f=await maintenanceFixture({states:[state],env:{RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',...(flag===undefined?{}:{RUNVARA_OWNER_SHOPIFY_RUNTIME_RENEWAL:flag})},providerFetch:async()=>{providerCalls++;throw Error('Provider use forbidden');}});
  try{
    const health=await f.request('/api/health');assert.equal(health.status,200);assert.equal(health.payload.startupMode,'quiet');assert.equal(health.payload.ownerShopifyRuntimeRenewal,false);assert.equal(health.payload.productionReady,false);
    assert.equal(health.payload.checks.persistence,true);assert.equal(health.payload.checks.authentication,true);assert.equal(health.payload.checks.credentialEncryption,true);
    const reads=f.calls.length;
    for(const [method,action] of [['GET','review'],['GET','status'],['POST','approve'],['POST','run'],['POST','close']]){
      const r=await f.request(`/api/owner/shopify-runtime-renewal/${action}`,{method,...(method==='POST'?{body:{}}:{})});assert.equal(r.status,503);assert.equal(r.payload.code,'STARTUP_QUIET_MODE');
    }
    assert.equal(f.calls.length,reads,'disabled request reached persistence');
    assert.equal(providerCalls,0);assert.equal(f.server.packsmart.scheduler.status.lastTickAt,null);assert.equal(f.server.packsmart.agentOps.status.lastTickAt,null);
    assert.equal(createHash('sha256').update(JSON.stringify(f.fake.states.get('packsmart-solutions'))).digest('hex'),before,'fixture state changed');
    records.push({flag:flag??'absent',healthStatus:200,positiveHealthUsesInjectedSyntheticPersistence:true,providerCalls,deniedRequests:5,workerTicks:false,stateUnchanged:true});
  }finally{await f.close();assert.equal(f.server.listening,false);}
}
await fs.writeFile(`${outputs}/disabled-module-result.json`,JSON.stringify(records,null,2));
await run(['--import','./.github/ci/renewal/chromium-sandbox-preload.mjs','saas/server/tests/shopify-runtime-owner-browser-check.mjs'],'owner-browser',180000,{RUNTIME_OWNER_BROWSER_EVIDENCE:'/evidence/owner-browser'});
await run(['.github/ci/renewal/network-check.mjs'],'network-boundary-after',10000);
await run(['.github/ci/renewal/validate-inputs.mjs','/app','source-only'],'source-identity-after',10000);
await fs.writeFile(`${outputs}/complete.json`,JSON.stringify({passed:true,productSourceUnchanged:true,providerCompatibilityClaim:false,browserVersion:pkg.version,node:process.version},null,2));
