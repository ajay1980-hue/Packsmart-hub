import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { revenueSignals } from '../lib/operations.mjs';
const context = vm.createContext({window:{},Intl,Date});
vm.runInContext(await fs.readFile(new URL('../../presentation.js',import.meta.url),'utf8'),context);
const ui=context.window.RunvaraUI;

test('revenue signals reference shared recorded evidence without scalar comparisons or rescanning',()=>{
  const trap = new Proxy({}, { get() { throw new Error('Series must reuse existing period evidence'); } });
  const signals = revenueSignals(trap);
  assert.deepEqual(signals.daily, []);
  assert.equal(signals.periodRef, 'last30d');
  assert.equal(signals.status, 'source_period_unverified');
  assert.deepEqual(signals.comparisons[30], { current: null, previous: null, change: null });
  assert.deepEqual(signals.comparisons[7], { current: null, previous: null, change: null });
});

test('incident projection links only evidenced single causes, keeps every record and never mutates state',()=>{
  const record=(id,kind,reference,extra={})=>({id,kind,reference,present:true,status:'open',...extra});
  const data={connectionCentre:[{id:'meta',name:'Facebook & Instagram',recovery:{action:'reconnect'},history:[{errorCode:'META_PERMISSION_REQUIRED'}]},{id:'shopify'}],
    exceptions:[record('meta-root','integration','meta'),record('shop-root','integration','shopify'),record('dependent','automation','channelSync',{evidence:[{type:'automation_run',id:'r1'}]}),record('ambiguous','automation','channelSync',{evidence:[{type:'automation_run',id:'r2'}]}),record('stock-1','stock','SKU1'),record('stock-2','stock','SKU2')],
    automationRuns:[{id:'r1',evidence:[{type:'integration_read',id:'meta',detail:'META_PERMISSION_REQUIRED'},{type:'integration_read',id:'shopify',detail:'connected'}]},{id:'r2',evidence:[{type:'integration_read',id:'meta',detail:'failed'},{type:'integration_read',id:'shopify',detail:'failed'}]}]};
  const before=JSON.stringify(data), groups=ui.incidents(data);
  assert.equal(groups.length,4);
  assert.deepEqual(Array.from(groups.find(item=>item.key==='meta-root').items,item=>item.id),['meta-root','dependent']);
  assert.equal(groups.find(item=>item.key==='ambiguous').items.length,1);
  assert.equal(groups.find(item=>item.key==='stock-1').cohort,true);
  assert.equal(new Set(groups.flatMap(item=>Array.from(item.items,row=>row.id))).size,6);
  assert.equal(ui.incidentTitle(groups[0]),'Facebook & Instagram needs permission');
  assert.equal(JSON.stringify(data),before);
  assert.equal(ui.incidents(data,false).length,6);
});

test('shared presentation escapes source content and distinguishes coverage, permission and actual work evidence',()=>{
  assert.equal(ui.issueCopy('COVERAGE_UNAVAILABLE'),'Full marketplace coverage is not available');
  assert.match(ui.issueCopy('META_PERMISSION_REQUIRED','Facebook & Instagram'),/needs permission/);
  assert.equal(ui.workState({status:'COMPLETED',evidence:[]}).text,'Outcome not verified');
  assert.equal(ui.workState({status:'COMPLETED',evidence:[{type:'read'}]}).text,'Completed');
  assert.ok(!ui.badge('<img src=x onerror=alert(1)>','bad').includes('<img'));
  assert.ok(!ui.logo('<script>alert(1)</script>').includes('<script'));
  const channel={configured:true,settings:{autoSync:true},recovery:{action:'reconnect'}};
  assert.equal(ui.schedule(channel,{autopilot:{enabled:true}}),'Access needs review');
  assert.equal(ui.schedule(channel,{autopilot:{enabled:false}}),'Automatic sync paused');
});
