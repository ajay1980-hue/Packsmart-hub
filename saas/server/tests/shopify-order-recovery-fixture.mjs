// Synthetic transport fixture only. SQL security/atomicity is exercised by the
// disposable-PostgreSQL suite, not simulated by this helper.
import crypto from 'node:crypto';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { encryptCredentials } from '../lib/security.mjs';
import { connectionSettings } from '../lib/connection-centre.mjs';
import { createOrderRecoveryRunner } from '../lib/shopify-order-recovery-run.mjs';
import { ORDER_RECOVERY_CONTRACT } from '../lib/shopify-order-recovery-store.mjs';
import { createShopifyOrderRecoveryStage, resumeShopifyOrderRecoveryStage, appendShopifyOrderRecoveryPage, shopifyOrderRecoverySummary } from '../lib/shopify-order-recovery.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

export function rawRecoveryOrder(index=0, startedAt=new Date().toISOString()) {
  const money = amount => ({shopMoney:{amount,currencyCode:'GBP'}});
  return {id:`gid://shopify/Order/${index}`,name:`#${index}`,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:new Date(Date.parse(startedAt)-86400000+index).toISOString(),cancelledAt:null,
    displayFinancialStatus:'PAID',displayFulfillmentStatus:'FULFILLED',totalPriceSet:money('100.00'),currentTotalPriceSet:money('97.00'),currentTotalTaxSet:money('16.00'),currentTotalDiscountsSet:money('3.00'),currentShippingPriceSet:money('2.00'),
    lineItems:{nodes:[{id:`gid://shopify/LineItem/${index}`,name:'Fixture line',sku:`SKU${index}`,quantity:1,originalTotalSet:money('100.00'),discountedTotalSet:money('97.00')}],pageInfo:{hasNextPage:false}}};
}
export function recoveryFixture({count=51,enabled=true,workspaceId='recovery-fixture',fetchFault=null}={}) {
  const env = {NODE_ENV:'test',SESSION_SECRET:'synthetic-recovery-session-secret-over32chars',CREDENTIALS_KEY:'synthetic-recovery-credential-key-over32chars',
    SHOPIFY_ORDER_RECOVERY_CONTRACT:enabled ? ORDER_RECOVERY_CONTRACT : '',SUPABASE_URL:'https://recovery.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-role',SHOPIFY_ADMIN_API_VERSION:'2026-07'};
  const state = seedWorkspaceState({}, {workspaceId,email:'owner@recovery.test',passwordHash:'synthetic'});
  state.users[0].passwordChangeRequired=false; state.users[0].sessionVersion=1; state._revision=crypto.randomUUID(); state.orders=[];state.products=[];
  state.connectionSettings={shopify:{...connectionSettings(state,'shopify'),areas:['orders'],managedReadSchedule:true}};
  state.connections=[{id:'shopify-persisted',provider:'shopify',label:'Shopify',status:'connected',encryptedCredentials:encryptCredentials({mode:'oauth',storeDomain:'fixture.myshopify.com',accessToken:'synthetic-token',expiresAt:Date.now()+86400000},env.CREDENTIALS_KEY),metadata:{shopDomain:'fixture.myshopify.com',shopId:'fixture-shop',grantedScopes:['read_orders']},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}];
  const fake=fakeSupabase({initialStates:[state]}), stages=new Map(),acks=new Map(),calls=[];
  const controls={providerFailureAt:null,providerCalls:0,mode:'enforced',unknownKind:null,dropLookup:false,beforeContext:null,failFinalize:false};
  const metrics={};
  const observed=async (category,input,options,response)=>{
    const text=await response.clone().text(), row={category,requestBytes:Buffer.byteLength(options.body || ''),responseBytes:Buffer.byteLength(text)};
    calls.push({url:String(input),...row,body:options.body || ''});
    metrics[category] ||= {calls:0,requestBytes:0,responseBytes:0}; for (const key of ['requestBytes','responseBytes']) metrics[category][key]+=row[key]; metrics[category].calls++;
    return response;
  };
  const fetchImpl=async (input,options={})=>{
    const url=new URL(input), name=url.pathname.split('/').at(-1);
    if (!['fixture.myshopify.com','recovery.supabase.test'].includes(url.hostname)) throw new Error('Unexpected network destination in synthetic recovery fixture');
    if (url.hostname==='fixture.myshopify.com') {
      controls.providerCalls++;
      const body=JSON.parse(options.body);
      if (controls.providerFailureAt===controls.providerCalls) return observed('provider',input,options,Response.json({errors:[{message:'synthetic interruption'}]},{status:503}));
      const after=body.variables.after,offset=after===null?0:Number(after.slice(7)),nodes=Array.from({length:Math.min(50,Math.max(0,count-offset))},(_,i)=>rawRecoveryOrder(offset+i,state.connections[0].createdAt));
      const next=offset+nodes.length,hasNextPage=next<count;
      return observed('provider',input,options,Response.json({data:{orders:{nodes,pageInfo:{hasNextPage,endCursor:hasNextPage?`cursor:${next}`:null}}}},{headers:{'X-Shopify-API-Version':'2026-07'}}));
    }
    const category=name==='runvara_read_order_recovery'?(JSON.parse(JSON.parse(options.body).p_request).view==='context'?'authority':JSON.parse(JSON.parse(options.body).p_request).view):name==='runvara_lookup_order_recovery'?'lookup':/^runvara_(reserve|append|finalize)_order_recovery$/.test(name)?'stage_mutation':name==='runvara_commit_reporting_status'?'reporting':name==='saas_workspace_state'?(options.method==='PATCH'?'primary':url.searchParams.get('select')?.includes('actor:')?'authority':'state_read'):'mirror_archive';
    if (category==='authority') await controls.beforeContext?.(fake.states.get(workspaceId));
    if (name.endsWith('_order_recovery')) {
      const raw=JSON.parse(options.body).p_request,p=JSON.parse(raw),stage=stages.get(p.workspaceId);
      let result;
      if (name==='runvara_read_order_recovery' && p.view==='context') {
        const s=fake.states.get(workspaceId),i=p.context;
        result={schema:'shopify-order-recovery-context/v1',mode:controls.mode,workspace_id:workspaceId,revision:s._revision,workspace:s.workspace,actor:s.users[i.actorIndex]??null,connection:s.connections[i.connectionIndex]??null,run:s.connectionSyncs?.[i.runIndex]??null,settings:s.connectionSettings?.shopify??null,doctor:s.connectionDoctor?.shopify??null,status:s.integrationStatus?.shopify??null,firstSync:s.connectionFirstSync?.shopify??null,sourceGeneration:s.channelData?.shopify?.orderReads?.lastSuccess??null};
      }
      else if (name==='runvara_read_order_recovery') result={schema:'shopify-order-recovery-read/v1',mode:controls.mode,stage:stage?(p.view==='summary'?shopifyOrderRecoverySummary(stage):stage):null,quota:{unfinishedStages:stages.size,logicalBytes:4096+[...stages.values()].reduce((n,s)=>n+s.logicalBytes,0),maxStages:8,maxBytes:16777216}};
      else if (name==='runvara_lookup_order_recovery') result=controls.dropLookup?null:acks.get(`${p.stageId}:${p.kind}:${p.requestFingerprint}`)||null;
      else {
        if (fetchFault) { const response=await fetchFault({name,p,stage,fake,controls}); if(response)return observed(category,input,options,response); }
        if (p.kind==='finalize' && controls.failFinalize) return observed(category,input,options,Response.json({code:'P0Q04'},{status:409}));
        if (p.kind!=='append' && fake.states.get(p.workspaceId)._revision!==p.expectedRevision) return observed(category,input,options,Response.json({code:'P0Q04'},{status:409}));
        let next=p.kind==='reserve'?(stage?resumeShopifyOrderRecoveryStage(stage,p.admission):createShopifyOrderRecoveryStage({id:p.stageId,binding:p.binding,admission:p.admission})):p.kind==='append'?appendShopifyOrderRecoveryPage(stage,p.page):{...stage,revision:stage.revision+1,status:'committed'};
        if (p.kind==='finalize') stages.delete(p.workspaceId); else stages.set(p.workspaceId,next);
        if (p.kind!=='append') fake.states.set(p.workspaceId,structuredClone(p.state));
        result={schema:'shopify-order-recovery-ack/v1',kind:p.kind,workspaceId:p.workspaceId,stageId:p.stageId,requestFingerprint:`sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`,stageRevision:next.revision,
          expectedRevision:p.expectedRevision??null,nextRevision:p.nextRevision??null,logicalBytes:next.logicalBytes,status:next.status,replayed:false};
        acks.set(`${p.stageId}:${p.kind}:${result.requestFingerprint}`,{...result,replayed:true});
        if (controls.unknownKind===p.kind) { controls.unknownKind=null; await observed(category,input,options,Response.json(result)); throw new TypeError('synthetic lost reply'); }
      }
      return observed(category,input,options,Response.json(result));
    }
    return observed(category,input,options,await fake.fetchImpl(input,options));
  };
  const store=createStore(env,{fetchImpl}),integrations=new IntegrationService(env,{fetchImpl}),runner=createOrderRecoveryRunner({store,integrations,env});
  const actor={id:state.users[0].id,sessionVersion:1,sessionDigest:'a'.repeat(64),expiresAt:new Date(Date.now()+3600000).toISOString()};
  return {env,state,actor,store,integrations,runner,fake,stages,acks,calls,controls,metrics,fetchImpl,get:()=>store.get(workspaceId),clearMetrics:()=>{calls.length=0;for(const key of Object.keys(metrics))delete metrics[key];},snapshot:()=>structuredClone(fake.states.get(workspaceId))};
}
