import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { revenueSignals } from '../lib/operations.mjs';
const context = vm.createContext({window:{},Intl,Date});
vm.runInContext(await fs.readFile(new URL('../../presentation.js',import.meta.url),'utf8'),context);
const ui=context.window.RunvaraUI;

test('revenue signals preserve refunds, unknown values and exact comparison boundaries',()=>{
  const now=new Date('2026-09-24T12:00:00Z');
  const order=(date,value,other={})=>({createdAt:date,financialStatus:'PAID',currentTotal:value,...other});
  const signals=revenueSignals([
    order('2026-09-24T10:00:00Z',100),
    order('2026-09-24T11:00:00Z',null,{total:40,refunds:10}),
    order('2026-09-23T11:00:00Z',null),
    order('2026-09-22T11:00:00Z',-5),
    order('2026-09-24T13:00:00Z',999),
    order('2026-09-24T11:00:00Z',999,{cancelledAt:'2026-09-24'}),
    order('2026-09-24T11:00:00Z',999,{financialStatus:'PENDING'}),
    order('2026-08-25T12:00:00Z',20),
    order('2026-08-25T11:59:59Z',10),
  ],now);
  assert.equal(signals.daily.length,30);
  assert.equal(signals.daily.at(-1).revenue,130);
  assert.equal(signals.daily.at(-2).revenue,null);
  assert.equal(signals.daily.at(-2).knownOrders,0);
  assert.equal(signals.daily.at(-3).revenue,-5);
  assert.equal(signals.daily.at(-4).revenue,0);
  assert.equal(signals.comparisons[30].current.revenue,null);
  assert.equal(signals.comparisons[30].current.knownRevenue,145);
  assert.equal(signals.comparisons[30].previous.revenue,10);
  assert.equal(signals.comparisons[30].change,null);
  const comparison=revenueSignals([order('2026-09-24',100),order('2026-09-11',50)],now);
  assert.equal(comparison.comparisons[7].change,100);
  assert.equal(revenueSignals([],now).comparisons[7].change,null);
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
