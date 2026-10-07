// Synthetic payload comparison only; starts a local server and never calls providers.
// Optional argument selects another local checkout for the same fixture.
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
const root = process.argv[2] || fileURLToPath(new URL('../../../', import.meta.url));
const load = file => import(pathToFileURL(path.join(root, 'saas/server', file)));
const { seedWorkspaceState } = await load('lib/store.mjs');
const { createPacksmartServer } = await load('server.mjs');
const { createSessionToken } = await load('lib/security.mjs');
const { runCommander } = await load('lib/agents.mjs');
const { deriveOperations, buildDailyBrief } = await load('lib/operations.mjs');
const { deriveBusinessState } = await load('lib/business-state.mjs');
const { revenueEngineSnapshot } = await load('lib/revenue-engine.mjs');
const elapsed = start => Math.round((performance.now() - start) * 100) / 100;
const sizes = value => Buffer.byteLength(JSON.stringify(value));
const providers = ['shopify','ebay','meta','tiktok_shop','pinterest','google_youtube','whatsapp_business','amazon'];
const statuses = ['PAID','PARTIALLY_REFUNDED','REFUNDED','AUTHORIZED','PARTIALLY_PAID','PENDING','EXPIRED','VOIDED','UNPAID','UNKNOWN'];
for (const config of [{ name:'packsmart_sized_synthetic', orders:500, variants:100, providers:2, worst:false }, { name:'bounded_worst_case_synthetic', orders:2000, variants:2000, providers:8, worst:true }]) {
  const state = seedWorkspaceState({}, { workspaceId:'payload-measure-fixture' });
  state.users[0].passwordChangeRequired = false;
  const now = new Date();
  const cost = { landed:2, packing:0, handling:0, delivery:0, paymentFee:0, channelFee:0, advertising:0, otherVariable:0 };
  state.products = Array.from({length:config.variants},(_,i)=>({id:`product-${i}`,provider:providers[i%config.providers],title:'Synthetic recorded packaging product',status:'active',image:'https://example.invalid/image.jpg',description:'Synthetic fixture',variants:[{id:`variant-${i}`,sku:`SKU-${i}`,price:10,inventory:50}]}));
  state.economics = Object.fromEntries(state.products.map((p,i)=>[`SKU-${i}`,cost]));
  state.orders = Array.from({length:config.orders},(_,i)=>({id:`order-${i}`,provider:providers[i%config.providers],currency:config.worst?String.fromCharCode(65+Math.floor(i/8)%26)+'AA':i%2?'USD':'GBP',createdAt:new Date(now.getTime()-1000-(i%29)*86400000).toISOString(),financialStatus:config.worst?statuses[Math.floor(i/208)%10]:'PAID',fulfillmentStatus:'FULFILLED',total:config.worst?'999999999999999999999999.999999':100,currentTotal:config.worst?'999999999999999999999999.999999':100,tax:0,currentTax:0,refunds:0,discounts:0,shippingCharged:0,customerEmailHash:`synthetic-${i%100}`,lineItems:Array.from({length:4},(_,j)=>({id:`line-${i}-${j}`,sku:`SKU-${(i+j)%config.variants}`,quantity:1,net:25}))}));
  let start = performance.now();
  const operations = deriveOperations(state, { now }); const operationsMs = elapsed(start);
  start = performance.now(); deriveBusinessState(state, { now, operations }); const businessStateMs = elapsed(start);
  start = performance.now(); buildDailyBrief(state, { now, operations }); const briefMs = elapsed(start);
  start = performance.now(); revenueEngineSnapshot(state); const revenueSnapshotMs = elapsed(start);
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-payload-'));
  const secret='payload-measure-fixture-secret-more-than-thirty-two';
  const server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,SAAS_STATE_FILE:path.join(dir,'state.json'),SHOPIFY_PUBLIC_SYNC_ENABLED:'false'},{schedulerEnabled:false,agentOpsEnabled:false});
  await server.packsmart.store.save(state.workspace.id,state);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const token=createSessionToken({userId:state.users[0].id,workspaceId:state.workspace.id,email:state.users[0].email,role:'owner',sessionVersion:1},secret);
  start = performance.now();
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/bootstrap`,{headers:{Cookie:`packsmart_session=${token}`}});
  if(response.status!==200)throw new Error(await response.text());
  const raw=await response.text(),payload=JSON.parse(raw); const localBootstrapRequestMs = elapsed(start);
  start = performance.now();
  const run=await runCommander(state,'Review revenue and profit',{now});
  const commandMs = elapsed(start);
  console.log(JSON.stringify({root,localNode:process.version,operationsMs,businessStateMs,briefMs,revenueSnapshotMs,commandMs,localBootstrapRequestMs,scenario:config.name,orders:config.orders,variants:config.variants,bootstrapBytes:Buffer.byteLength(raw),businessStateBytes:sizes(payload.hypergrowth.businessState),dashboardBytes:sizes(payload.dashboard),briefBytes:sizes(payload.brief),commandBytes:sizes(run),commandSummaryBytes:Buffer.byteLength(run.summary),periodEvidenceBytes:sizes(payload.dashboard.last30d.importedOrderEvidence ?? null)}));
  await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});
}
