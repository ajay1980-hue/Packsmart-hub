// Only fixed DTOs reach the non-hidden artifact directory. Never copy raw logs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const id=process.env.RUNVARA_QUALIFICATION_ID;assert.match(id||'',/^[0-9]+-[0-9]+$/);
const raw=path.resolve('.runvara-qualification',id,'evidence');
const output=path.resolve('runvara-ci-evidence',id);assert.ok(!fs.existsSync(output),'artifact destination already exists');
fs.mkdirSync(path.join(output,'reports'),{recursive:true});
const missing=[],invalid=[],written=[];
const integer=(value,max=100000)=>{assert.ok(Number.isSafeInteger(value)&&value>=0&&value<=max);return value;};
const hash=value=>{assert.match(value,/^[a-f0-9]{64}$/);return value;};
const commit=value=>{assert.match(value,/^[a-f0-9]{40}$/);return value;};
const read=name=>{
  const file=path.join(raw,name);if(!fs.existsSync(file)){missing.push(name);throw Error('missing');}
  const root=fs.realpathSync(raw),resolved=fs.realpathSync(file);
  assert.ok(resolved.startsWith(root+path.sep),'evidence path escapes its owned directory');
  const stat=fs.lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=262144,'invalid evidence file');
  return fs.readFileSync(file,'utf8');
};
const json=name=>JSON.parse(read(name));
const lines=name=>read(name).trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
const emit=(name,fn)=>{
  try{const dto=fn(),file=path.join(output,'reports',name+'.json');fs.writeFileSync(file,JSON.stringify(dto,null,2)+'\n',{flag:'wx'});written.push({file:'reports/'+name+'.json',sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});}
  catch{invalid.push(name);}
};
emit('reviewed-source',()=>{
  const x=json('reviewed-source.json');assert.equal(x.repository,'ajay1980-hue/Packsmart-hub');assert.equal(x.event,'ready_for_review');assert.equal(x.runAttempt,1);assert.equal(x.globalOnceGuaranteed,false);
  return {repository:x.repository,pr:integer(x.pr),base:commit(x.base),head:commit(x.head),merge:commit(x.merge),event:x.event,runAttempt:1,globalOnceGuaranteed:false};
});
emit('builder-binding',()=>{
  const x=json('builder-binding.json');assert.equal(x.otherRecipeBytesUnchanged,true);assert.equal(x.specificIgnorePrecedencePreserved,true);assert.equal(x.renderRuntimeIdentityClaim,false);assert.match(x.resolvedFrom,/^node@sha256:[a-f0-9]{64}$/);
  return {sourceCommit:commit(x.sourceCommit),originalRecipeSha256:hash(x.originalRecipeSha256),resolvedRecipeSha256:hash(x.resolvedRecipeSha256),resolvedFrom:x.resolvedFrom,rootIgnoreSha256:hash(x.rootIgnoreSha256),dockerfileSpecificIgnoreSha256:x.dockerfileSpecificIgnoreSha256===null?null:hash(x.dockerfileSpecificIgnoreSha256),otherRecipeBytesUnchanged:true,specificIgnorePrecedencePreserved:true,renderRuntimeIdentityClaim:false};
});
emit('images',()=>{const rows=lines('image-identities.jsonl');assert.equal(rows.length,5);return rows.map(x=>{assert.match(x.id,/^sha256:[a-f0-9]{64}$/);assert.equal(x.os,'linux');assert.equal(x.architecture,'amd64');return {id:x.id,os:x.os,architecture:x.architecture};});});
emit('containers',()=>{const rows=lines('container-boundaries.jsonl');assert.equal(rows.length,3);return rows.map(x=>{assert.match(x.id,/^[a-f0-9]{64}$/);assert.equal(x.network,'none');assert.equal(x.privileged,false);assert.ok(x.capDrop.includes('ALL')&&x.securityOpt.some(v=>v==='no-new-privileges'||v==='no-new-privileges:true'));return {id:x.id,network:'none',privileged:false,capabilitiesDropped:true,noNewPrivileges:true};});});
for(const flag of ['absent','disabled']){
  emit(flag+'-startup',()=>{const x=json(flag+'-result.json');assert.equal(x.unmodifiedEntrypoint,true);assert.equal(x.mode,'quiet');assert.equal(x.renewal,false);assert.equal(x.healthStatus,503);assert.equal(x.deliberatelyMissingProductionPersistence,true);assert.equal(x.deniedRequests,10);assert.equal(x.agentRunning,false);assert.equal(x.lastTickAt,null);assert.match(x.node,/^v22\.[0-9]+\.[0-9]+$/);return {unmodifiedEntrypoint:true,node:x.node,mode:'quiet',renewal:false,healthStatus:503,deliberatelyMissingProductionPersistence:true,deniedRequests:10,agentRunning:false,lastTickAt:null};});
  emit(flag+'-shutdown',()=>{const x=json(flag+'-shutdown.json');assert.equal(x.stopped,true);assert.equal(x.exitCode,0);assert.equal(x.shutdownSettled,true);return {stopped:true,exitCode:0,shutdownSettled:true};});
}
emit('network',()=>{const names=['absent-network.log','disabled-network.log','network-boundary.log','network-boundary-after.log'];return names.map(name=>{const rows=lines(name);assert.equal(rows.length,1);assert.equal(rows[0].networkBoundaryVerified,true);assert.equal(rows[0].child,false);return {check:name,networkBoundaryVerified:true,independentChildChecked:true};});});
emit('source',()=>{const names=['absent-source.log','disabled-source.log','source-identity.log','source-identity-after.log'];const expected=JSON.parse(fs.readFileSync('.github/ci/renewal/source-manifest.json','utf8')).length;return names.map(name=>{const x=lines(name);assert.equal(x.length,1);assert.equal(x[0].sourceFilesVerified,expected);assert.equal(x[0].sourceOnly,true);return {check:name,sourceFilesVerified:expected};});});
emit('node-runtime',()=>{const x=json('node-runtime.json');assert.equal(x.version,'22.23.5');assert.equal(x.executable,'/opt/runvara-node22/bin/node');assert.equal(x.platform,'linux');assert.equal(x.arch,'x64');assert.match(x.glibc,/^\d+\.\d+$/);return {version:x.version,executable:x.executable,platform:x.platform,arch:x.arch,glibc:x.glibc};});
emit('sandbox',()=>{const x=json('chromium-sandbox.json');assert.equal(x.launches,1);assert.equal(x.chromiumSandbox,true);assert.equal(x.commandLineVerified,true);assert.equal(x.disablingSwitches,0);assert.equal(x.fallback,false);return {launches:1,chromiumSandbox:true,commandLineVerified:true,disablingSwitches:0,fallback:false};});
emit('disabled-modules',()=>{const rows=json('disabled-module-result.json');assert.equal(rows.length,2);return rows.map((x,i)=>{assert.equal(x.flag,i===0?'absent':'disabled/v1');assert.equal(x.healthStatus,200);assert.equal(x.positiveHealthUsesInjectedSyntheticPersistence,true);assert.equal(x.providerCalls,0);assert.equal(x.deniedRequests,5);assert.equal(x.workerTicks,false);assert.equal(x.stateUnchanged,true);return {flag:x.flag,healthStatus:200,positiveHealthUsesInjectedSyntheticPersistence:true,providerCalls:0,deniedRequests:5,workerTicks:false,stateUnchanged:true};});});
emit('browser',()=>{const x=json('owner-browser/result.json');assert.equal(x.checks,344);assert.equal(x.external,0);assert.deepEqual(x.errors,[]);assert.equal(x.scenarios.length,21);return {checks:344,external:0,errors:0,scenarios:21};});
emit('completion',()=>{for(const name of ['syntax-0.log','syntax-1.log','syntax-2.log'])assert.equal(read(name).trim(),'');const x=json('complete.json');assert.equal(x.passed,true);assert.equal(x.productSourceUnchanged,true);assert.equal(x.providerCompatibilityClaim,false);assert.equal(x.browserVersion,'1.62.1');assert.equal(x.node,'v22.23.5');return {passed:true,productSourceUnchanged:true,providerCompatibilityClaim:false,browserVersion:x.browserVersion,node:x.node,syntaxChecks:3};});
emit('cleanup',()=>{const x=json('cleanup.json');assert.equal(x.cleanupExit,0);assert.ok(!x.uncertain&&!x.notNeeded);assert.equal(x.sharedBaseImagesPreserved,true);return {cleanupExit:0,sharedBaseImagesPreserved:true};});
const jobStatus=process.env.QUALIFICATION_JOB_STATUS;assert.ok(['success','failure','cancelled'].includes(jobStatus));
const passed=jobStatus==='success'&&missing.length===0&&invalid.length===0&&written.length===16;
fs.writeFileSync(path.join(output,'qualification-summary.json'),JSON.stringify({passed,jobStatus,missing,invalid,reports:written},null,2)+'\n',{flag:'wx'});
assert.ok(passed,'Required qualification evidence missing or invalid; sanitized failure summary preserved');
