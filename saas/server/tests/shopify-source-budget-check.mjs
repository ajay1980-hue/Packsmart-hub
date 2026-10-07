// Synthetic source-capture budgets. Every provider/database response is local;
// this script never accesses a live account or production service.
import assert from 'node:assert/strict';
import { IntegrationService } from '../lib/integrations.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
const WS='shopify-source-budget', AT='2026-10-07T10:00:00.000Z';
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const money=amount=>({shopMoney:{amount,currencyCode:'GBP'}});
const raw=Array.from({length:500},(_,i)=>({id:`gid://shopify/Order/${10000000000000+i}`,name:`#${i}`,createdAt:AT,updatedAt:AT,cancelledAt:null,displayFinancialStatus:'PAID',displayFulfillmentStatus:'FULFILLED',
  totalPriceSet:money('100.25'),currentTotalPriceSet:money('100.25'),currentTotalTaxSet:money('16.71'),currentTotalDiscountsSet:money('1.00'),currentShippingPriceSet:money('3.49'),paymentGatewayNames:['shopify_payments'],
  lineItems:{nodes:Array.from({length:4},(_,j)=>({id:`gid://shopify/LineItem/${10000000000000+i*100+j}`,name:'Synthetic packaging line',sku:`SKU-${j}`,quantity:1,originalTotalSet:money('25.0625'),discountedTotalSet:money('24.8125')})),pageInfo:{hasNextPage:false}}}));
// Exact pre-cutover layout, solely for comparing stored representations.
const legacy=raw.map(row=>({id:row.id,externalId:row.id,provider:'shopify',name:row.name,createdAt:AT,updatedAt:AT,cancelledAt:null,financialStatus:'PAID',fulfillmentStatus:'FULFILLED',customerEmailHash:null,statusPageUrl:null,
  total:100.25,currentTotal:100.25,currency:'GBP',refunds:0,tax:16.71,currentTax:16.71,discounts:1,shippingCharged:3.49,paymentGatewayNames:['shopify_payments'],paymentFees:null,channelFees:null,advertisingCost:null,actualShippingCost:null,otherVariableCosts:null,
  lineItems:row.lineItems.nodes.map(line=>({id:line.id,name:line.name,sku:line.sku,quantity:1,gross:25.0625,net:24.8125}))}));
const db=fakeSupabase(), storeEnv={SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-fixture-key'}, store=createStore(storeEnv,{fetchImpl:db.fetchImpl});
const state=seedWorkspaceState({}, {workspaceId:WS});state.orders=legacy;
await store.save(WS,state);
function requestBudget(start){const calls=db.calls.slice(start),groups={};for(const call of calls){const key=call.method+' '+call.url.pathname.split('/').pop();groups[key]??={requests:0,bodyBytes:0};groups[key].requests++;groups[key].bodyBytes+=call.body?Buffer.byteLength(call.body):0;}return{requests:calls.length,bodyBytes:calls.reduce((sum,call)=>sum+(call.body?Buffer.byteLength(call.body):0),0),groups};}
let start=db.calls.length;await store.save(WS,state);const baselineWarm=requestBudget(start),beforeBytes=bytes(state);
let providerRequests=0;
const service=new IntegrationService({SHOPIFY_ENV_WORKSPACE_ID:WS,SHOPIFY_STORE_DOMAIN:'fixture.myshopify.com',SHOPIFY_ADMIN_API_VERSION:'2026-07',SHOPIFY_ADMIN_ACCESS_TOKEN:'synthetic-token'}, {fetchImpl:async(_url,options)=>{
  providerRequests++;const body=JSON.parse(options.body);assert.match(body.query,/query PacksmartOpsOrders/);assert.doesNotMatch(body.query,/\bmutation\b|ConnectionIdentity/);
  const offset=body.variables.after?Number(body.variables.after):0,nodes=raw.slice(offset,offset+50),next=offset+nodes.length;
  return Response.json({data:{orders:{nodes,pageInfo:{hasNextPage:next<raw.length,endCursor:next<raw.length?String(next):null}}}},{headers:{'X-Shopify-API-Version':'2026-07'}});
}});
await service.syncShopify(state,{areas:['orders']});const afterBytes=bytes(state),map=state.channelData.shopify.orderReads;
start=db.calls.length;await store.save(WS,state);const firstCapture=requestBudget(start);
assert.equal(providerRequests,10);assert.equal(state.orders.length,500);assert.equal(state.orders[0].total,'100.25');
assert.equal(firstCapture.groups['POST order_financials']?.requests,1);assert.equal(firstCapture.groups['POST orders'],undefined);
assert.ok(!Object.keys(firstCapture.groups).some(key=>key.includes('runvara_history')));
await service.syncShopify(state,{areas:['orders']});start=db.calls.length;await store.save(WS,state);const repeatedCapture=requestBudget(start);
assert.equal(repeatedCapture.groups['POST order_financials'],undefined);assert.equal(repeatedCapture.groups['POST orders'],undefined);
const cold=createStore(storeEnv,{fetchImpl:db.fetchImpl});start=db.calls.length;await cold.save(WS,state);const coldCapture=requestBudget(start);
console.log(JSON.stringify({fixture:{orders:500,lines:2000},sourceRequestsPerRead:10,beforeSnapshotBytes:beforeBytes,afterSnapshotBytes:afterBytes,addedSnapshotBytes:afterBytes-beforeBytes,
  manifestMapBytes:bytes(map),referenceBytes:state.orders.reduce((sum,order)=>sum+bytes({sourceReadRef:order.sourceReadRef})-1,0),baselineWarm,firstCapture,repeatedCapture,coldCapture},null,2));
