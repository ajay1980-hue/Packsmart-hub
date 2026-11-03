import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { assertQuietOwnerWorkspace } from './quiet-owner-workspace.mjs';
import { inspectShopifyCataloguePage } from './shopify-catalogue-read.mjs';
import { addAudit } from './events.mjs';
import { decryptCredentials } from './security.mjs';
import { classifyShopifyCredential } from './shopify-credential-metadata.mjs';
import { CATALOGUE_SHOP_ID, CATALOGUE_COMPONENT_QUERY, CATALOGUE_EVIDENCE_LIMITS, inspectCatalogueSourceFields, captureCatalogueVariantEvidence, validateCatalogueEvidenceContext } from './shopify-catalogue-evidence.mjs';

export const CATALOGUE_PATH = '/api/owner/shopify-catalogue';
export const CATALOGUE_LIMITS = Object.freeze({pages:20,productsPerPage:10,variantsPerProduct:50,products:200,variants:1000,pageBytes:524288,totalBytes:2097152,windowMs:600000});
const WORKSPACE = 'packsmart-solutions', DOMAIN = 'wavtzm-vy.myshopify.com', VERSION = '2026-07';
const SCHEMA = 'runvara-shopify-catalogue-import/v1';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const permits = new WeakMap();
export const catalogueError = (code, status=409) => Object.assign(new Error('Catalogue import stopped: '+code+'. Reconcile this request before any new attempt.'), {code:'SHOPIFY_CATALOGUE_'+code,status});

export function createCataloguePolicy(env) {
  const flag = env.RUNVARA_QUIET_SHOPIFY_CATALOGUE === undefined ? 'disabled/v1' : env.RUNVARA_QUIET_SHOPIFY_CATALOGUE;
  if (!['disabled/v1','enabled/v1'].includes(flag)) throw catalogueError('CONFIG_INVALID',503);
  if (flag === 'disabled/v1') return null;
  const requestId=env.RUNVARA_SHOPIFY_CATALOGUE_REQUEST_ID, expiresAt=env.RUNVARA_SHOPIFY_CATALOGUE_EXPIRES_AT;
  const until=Date.parse(expiresAt), startedAt=Date.now(), startedMono=performance.now();
  if (env.RUNVARA_STARTUP_MODE !== 'quiet' || env.RUNVARA_QUIET_OWNER_WORKSPACE !== 'enabled/v1'
    || !uuid(requestId) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt || '')
    || !Number.isFinite(until) || !Number.isFinite(startedAt) || !Number.isFinite(startedMono)
    || until > startedAt+CATALOGUE_LIMITS.windowMs) throw catalogueError('CONFIG_INVALID',503);
  // Restart keeps the absolute deadline; within this process neither clock reversal
  // nor a stalled wall clock can extend the initial remaining monotonic budget.
  const remainingMs=until-startedAt;
  let closed=remainingMs<=0, lastWall=startedAt, lastMono=startedMono;
  const active=()=>{
    if(closed) return false;
    const wall=Date.now(), mono=performance.now();
    if(!Number.isFinite(wall) || !Number.isFinite(mono) || wall<lastWall || mono<lastMono
      || wall>=until || mono-startedMono>=remainingMs) closed=true;
    lastWall=wall; lastMono=mono;
    return !closed;
  };
  return Object.freeze({requestId,expiresAt,workspaceId:WORKSPACE,domain:DOMAIN,apiVersion:VERSION,
    available:active, assertActive:()=>{if(!active()) throw catalogueError('EXPIRED');}});
}

export const CATALOGUE_QUERY = `query RunvaraOwnerCatalogue($first: Int!, $after: String) {
  shop { id myshopifyDomain currencyCode }
  products(first: $first, after: $after, sortKey: ID) {
    nodes { id title handle status productType description updatedAt onlineStoreUrl totalInventory
      featuredMedia { preview { image { url } } }
      variants(first: 50) { pageInfo { hasNextPage }
        nodes { id title sku price inventoryQuantity availableForSale requiresComponents updatedAt selectedOptions { name value } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const integer = value => value === null || Number.isSafeInteger(value);
function mapProduct(raw, shop, at) {
  inspectCatalogueSourceFields(raw,at);
  if (!['ACTIVE','DRAFT','ARCHIVED','UNLISTED'].includes(raw.status) || typeof raw.title !== 'string' || typeof raw.productType !== 'string'
    || typeof raw.handle !== 'string' || typeof raw.description !== 'string' || !Number.isFinite(Date.parse(raw.updatedAt)) || !integer(raw.totalInventory)) throw catalogueError('PRODUCT_INVALID',502);
  const source={system:'shopify',accountId:shop.id,domain:shop.myshopifyDomain,apiVersion:VERSION,capturedAt:at,currencySource:'Shop.currencyCode'};
  const type=raw.productType.trim().toLowerCase();
  // Explicit source types are evidence; SKU prefixes are only review hints.
  const component=['component','raw material','internal component'].includes(type);
  const variants=raw.variants.nodes.map(v=>{
    if (typeof v.title!=='string' || (v.sku!==null && typeof v.sku!=='string') || typeof v.price!=='string' || !/^\d+(\.\d{1,6})?$/.test(v.price)
      || !Number.isFinite(Number(v.price)) || Number(v.price)>Number.MAX_SAFE_INTEGER || !integer(v.inventoryQuantity)
      || typeof v.availableForSale!=='boolean' || typeof v.requiresComponents!=='boolean') throw catalogueError('VARIANT_INVALID',502);
    return {id:v.id,externalId:v.id,title:v.title,sku:v.sku,price:Number(v.price),priceDecimal:v.price,currency:shop.currencyCode,
      inventory:v.inventoryQuantity,available:v.availableForSale,requiresComponents:v.requiresComponents,updatedAt:v.updatedAt,selectedOptions:structuredClone(v.selectedOptions),
      stock:{available:v.inventoryQuantity,onHand:null,committed:null,incoming:null,unit:'Shopify sellable variant units',aggregateEligible:false},
      source:{...source,objectType:'ProductVariant',recordId:v.id},raw:structuredClone(v)};
  });
  const hint=variants.some(v=>/^(RAW|PACK)[-_]/i.test(v.sku));
  const classification=component ? 'component' : variants.some(v=>v.requiresComponents) ? 'bundle' : hint ? 'internal_review' : 'unclassified';
  return {id:raw.id,externalId:raw.id,provider:'shopify',title:raw.title,handle:raw.handle,status:raw.status.toLowerCase(),productType:raw.productType,
    description:raw.description,image:raw.featuredMedia?.preview?.image?.url || null,inventory:raw.totalInventory,updatedAt:raw.updatedAt,onlineStoreUrl:raw.onlineStoreUrl,
    currency:shop.currencyCode,source:{...source,objectType:'Product',recordId:raw.id},raw:structuredClone(raw),variants,
    catalogueClassification:{kind:classification,basis:component?'source_product_type':classification==='bundle'?'source_requires_components':hint?'sku_hint_unverified':'unknown',retailVerified:false},
    stock:{available:raw.totalInventory,onHand:null,committed:null,incoming:null,aggregateEligible:false},catalogueObserved:true};
}

async function boundedJson(response) {
  const reader=response.body?.getReader(); if(!reader) throw catalogueError('RESPONSE_INVALID',502);
  let size=0; const chunks=[];
  try { while(true) { const {done,value}=await reader.read(); if(done) break; size+=value.byteLength;
    if(size>CATALOGUE_LIMITS.pageBytes) throw catalogueError('RESPONSE_LIMIT',502); chunks.push(Buffer.from(value)); }
  } catch(error) { await reader.cancel().catch(()=>{}); throw error; }
  let payload; try { payload=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw catalogueError('RESPONSE_INVALID',502); }
  if (!response.ok || !payload || Array.isArray(payload) || (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length))) throw catalogueError('PROVIDER_READ_FAILED',502);
  if(response.headers.get('x-shopify-api-version')!==VERSION) throw catalogueError('VERSION_CHANGED',502);
  return {payload,size};
}

export async function readBoundedCatalogue({config,fetchImpl,assertCurrent,context}) {
  if(config.domain!==DOMAIN || config.apiVersion!==VERSION || !config.accessToken) throw catalogueError('SOURCE_INVALID');
  validateCatalogueEvidenceContext(context,new Date().toISOString());
  const products=[], pages=[], seenProductIds=new Set(),seenVariantIds=new Set(),seenCursors=new Set();
  let after=null,shop=null,totalBytes=0;
  for(let page=0;page<CATALOGUE_LIMITS.pages;page++) {
    await assertCurrent();
    const response=await fetchImpl(`https://${DOMAIN}/admin/api/${VERSION}/graphql.json`,{method:'POST',redirect:'error',
      headers:{'Content-Type':'application/json','X-Shopify-Access-Token':config.accessToken},
      body:JSON.stringify({query:CATALOGUE_QUERY,variables:{first:CATALOGUE_LIMITS.productsPerPage,after}}),signal:AbortSignal.timeout(20000)});
    const {payload,size}=await boundedJson(response); totalBytes+=size;
    if(totalBytes>CATALOGUE_LIMITS.totalBytes) throw catalogueError('RESPONSE_LIMIT',502);
    const data=payload.data, current=data?.shop;
    if(!current || current.id!==CATALOGUE_SHOP_ID || current.myshopifyDomain!==DOMAIN || !/^[A-Z]{3}$/.test(current.currencyCode)
      || shop && !isDeepStrictEqual(current,shop)) throw catalogueError('ACCOUNT_OR_CURRENCY_CHANGED',502);
    shop=structuredClone(current);
    const inspected=inspectShopifyCataloguePage(data,{workspaceId:WORKSPACE,after,seenProductIds,seenVariantIds,seenCursors});
    if(inspected.nodes.length>CATALOGUE_LIMITS.productsPerPage || inspected.nodes.some(p=>p.variants.nodes.length>CATALOGUE_LIMITS.variantsPerProduct)) throw catalogueError('COVERAGE_LIMIT',502);
    inspected.productIds.forEach(id=>seenProductIds.add(id)); inspected.variantIds.forEach(id=>seenVariantIds.add(id));
    if(seenProductIds.size>CATALOGUE_LIMITS.products || seenVariantIds.size>CATALOGUE_LIMITS.variants) throw catalogueError('COVERAGE_LIMIT',502);
    const at=new Date().toISOString();
    products.push(...inspected.nodes.map(raw=>mapProduct(raw,shop,at)));
    pages.push({kind:'catalogue',capturedAt:at,sha256:digest(data),bytes:size,products:inspected.nodes.length});
    await assertCurrent();
    if(!inspected.hasNextPage) {
      const pairs=products.flatMap(product=>product.variants.map(variant=>({product,variant})));
      const batch=CATALOGUE_EVIDENCE_LIMITS.variantsPerBatch;
      // Component batches share the EXISTING 20-response/2MiB budget. No
      // continuation/retry or partial completeness claim on nested truncation.
      if(pages.length+Math.ceil(pairs.length/batch)>CATALOGUE_LIMITS.pages)throw catalogueError('COVERAGE_LIMIT',502);
      const relationIds=new Set();
      for(let start=0;start<pairs.length;start+=batch){
        await assertCurrent();const selected=pairs.slice(start,start+batch),ids=selected.map(x=>x.variant.id);
        const reply=await fetchImpl(`https://${DOMAIN}/admin/api/${VERSION}/graphql.json`,{method:'POST',redirect:'error',
          headers:{'Content-Type':'application/json','X-Shopify-Access-Token':config.accessToken},
          body:JSON.stringify({query:CATALOGUE_COMPONENT_QUERY,variables:{ids}}),signal:AbortSignal.timeout(20000)});
        const part=await boundedJson(reply);totalBytes+=part.size;
        if(totalBytes>CATALOGUE_LIMITS.totalBytes)throw catalogueError('RESPONSE_LIMIT',502);
        const d=part.payload.data,rows=d?.nodes;
        if(!isDeepStrictEqual(d?.shop,shop)||!Array.isArray(rows)||rows.length!==ids.length)throw catalogueError('EVIDENCE_INVALID',502);
        const capturedAt=new Date().toISOString(),byId=new Map();
        for(const row of rows){if(!row||!ids.includes(row.id)||byId.has(row.id))throw catalogueError('EVIDENCE_INVALID',502);byId.set(row.id,row);}
        for(const {product,variant} of selected){
          const evidence=captureCatalogueVariantEvidence(product,variant,byId.get(variant.id),{context,shop,capturedAt});
          for(const entry of evidence.components.entries){if(relationIds.has(entry.relationId))throw catalogueError('EVIDENCE_INVALID',502);relationIds.add(entry.relationId);}
          variant.catalogueEvidence=evidence;
        }
        pages.push({kind:'components',capturedAt,sha256:digest(d),bytes:part.size,variants:rows.length});
        await assertCurrent();
      }
      return {products,shop,pages,totalBytes,completedAt:pages.at(-1).capturedAt,snapshotConsistency:'unverified'};
    }
    after=inspected.nextCursor; seenCursors.add(after);
  }
  throw catalogueError('COVERAGE_LIMIT',502);
}

function validateActor(state,session) {
  assertQuietOwnerWorkspace({state,session});
  if(!Number.isFinite(session.exp) || session.exp*1000<=Date.now()) throw catalogueError('SESSION_EXPIRED',401);
  if(!uuid(state._revision)) throw catalogueError('REVISION_INVALID');
}
function sourceBinding(state,integrations,env) {
  const rows=state.connections?.filter(c=>c.provider==='shopify') || [];
  const c=rows[0];
  if(rows.length!==1 || !c?.id || !c.encryptedCredentials || state.connectionSettings?.shopify?.disconnected
    || c.metadata?.shopDomain!==DOMAIN) throw catalogueError('SOURCE_INVALID');
  const credentials=decryptCredentials(c.encryptedCredentials,env.CREDENTIALS_KEY);
  const metadata=classifyShopifyCredential(credentials);
  if(!metadata.metadataCompatible) throw catalogueError(metadata.code);
  const config=integrations.shopifyConfig(state);
  if(config.connection?.id!==c.id || config.domain!==DOMAIN || config.apiVersion!==VERSION || !config.accessToken) throw catalogueError('SOURCE_CONFIG_MISMATCH');
  return {config,binding:{connectionId:c.id,domain:DOMAIN,apiVersion:VERSION,credentialDigest:digest(c.encryptedCredentials),settingsDigest:digest(state.connectionSettings?.shopify || {})}};
}
function ledger(state) {
  const rows=state.shopifyCatalogueImports ?? [];
  if(!Array.isArray(rows) || rows.length>20 || new Set(rows.map(r=>r.requestId)).size!==rows.length || rows.some(r=>r.schema!==SCHEMA || !uuid(r.requestId))) throw catalogueError('LEDGER_INVALID');
  return rows;
}
function publicRun(run) {
  if(!run) return null;
  return {requestId:run.requestId,status:run.status,startedAt:run.startedAt,completedAt:run.completedAt || null,code:run.code || null,
    productCount:run.productCount ?? null,variantCount:run.variantCount ?? null,currency:run.currency || null,sourceAccountId:run.sourceAccountId || null,
    sourceDomain:DOMAIN,sourceCapturedAt:run.sourceCapturedAt || null,snapshotConsistency:'unverified'};
}
export function catalogueStatus(state,policy) {
  const run=policy ? ledger(state).find(r=>r.requestId===policy.requestId) : ledger(state).at(-1);
  return {schema:SCHEMA,requestId:policy?.requestId || null,expiresAt:policy?.expiresAt || null,enabled:Boolean(policy?.available()),canRun:Boolean(policy?.available() && !run),
    expectedRevision:policy?.available() && !run ? state._revision : null,run:publicRun(run),limits:CATALOGUE_LIMITS,domain:DOMAIN,apiVersion:VERSION};
}

function issuePermit(before,after) {
  const allowed=new Set(['products','shopifyCatalogueImports','audit']);
  for(const key of new Set([...Object.keys(before),...Object.keys(after)])) if(!allowed.has(key) && !isDeepStrictEqual(before[key],after[key])) throw catalogueError('UNRELATED_CHANGE');
  const permit=Object.freeze({}); permits.set(permit,{workspaceId:before.workspace.id,revision:before._revision,sha256:digest(after)}); return permit;
}
export function assertCatalogueImportPermit(permit,workspaceId,state) {
  const expected=permits.get(permit);
  if(!expected || workspaceId!==expected.workspaceId || state._revision!==expected.revision || digest(state)!==expected.sha256) throw catalogueError('PERSISTENCE_PERMIT_INVALID');
  permits.delete(permit);
}

export function createCatalogueImporter({store,integrations,env,policy,fetchImpl}) {
  const unknown=new Set();
  const scope=state=>`${state.workspace.id}:${policy?.requestId}`;
  async function save(before,after,assertActive) {
    const permit=issuePermit(before,after);
    try { return await store.save(before.workspace.id,after,{ownedSnapshot:true,catalogueImportPermit:permit,beforeCommit:assertActive}); }
    catch { unknown.add(scope(before)); throw catalogueError('COMMIT_UNCERTAIN',503); }
  }
  async function run(auth,body,assertOpen=()=>{}) {
    if(!policy || store.provider!=='supabase') throw catalogueError('DISABLED',503);
    if(!body || Array.isArray(body) || Object.keys(body).length!==2 || body.requestId!==policy.requestId || body.expectedRevision!==auth.state._revision) throw catalogueError('INPUT_STALE');
    const assertActive=()=>{policy.assertActive();assertOpen();if(auth.session.exp*1000<=Date.now())throw catalogueError('SESSION_EXPIRED',401);};
    assertActive(); validateActor(auth.state,auth.session);
    const old=ledger(auth.state), existing=old.find(r=>r.requestId===policy.requestId);
    if(existing) return {...catalogueStatus(auth.state,policy),replayed:false};
    if(unknown.has(scope(auth.state))) throw catalogueError('COMMIT_UNCERTAIN',503);
    if(old.length>=20) throw catalogueError('LEDGER_FULL');
    const {config,binding}=sourceBinding(auth.state,integrations,env);
    const before=structuredClone(auth.state), admitted=structuredClone(before);
    const record={schema:SCHEMA,requestId:policy.requestId,status:'reserved',actorId:auth.session.sub,sessionVersion:auth.session.sessionVersion,
      binding,startedAt:new Date().toISOString(),expiresAt:policy.expiresAt};
    admitted.shopifyCatalogueImports=[...old,record];
    addAudit(admitted,{type:'shopify_catalogue_reserved',actor:auth.session.sub,detail:{requestId:policy.requestId,domain:DOMAIN,limits:CATALOGUE_LIMITS}});
    let current=await save(before,admitted,assertActive);
    const reservationRevision=current._revision;
    const fresh=async()=>{
      assertActive(); const next=await store.get(WORKSPACE,{exactSnapshot:true}); validateActor(next,auth.session);
      if(next._revision!==reservationRevision || !isDeepStrictEqual(sourceBinding(next,integrations,env).binding,binding)
        || !isDeepStrictEqual(ledger(next).find(r=>r.requestId===policy.requestId),record)) throw catalogueError('SOURCE_OR_STATE_CHANGED');
      assertActive(); return next;
    };
    let stage;
    try { stage=await readBoundedCatalogue({config,fetchImpl,assertCurrent:fresh,context:{workspaceId:WORKSPACE,connectionId:binding.connectionId,revision:reservationRevision}}); current=await fresh(); }
    catch(error) { // The durable reservation remains spent. No retry or failure-write loop.
      throw catalogueError(error.code?.replace(/^SHOPIFY_CATALOGUE_/, '') || 'READ_FAILED',error.status || 502);
    }
    const next=structuredClone(current), incoming=new Map(stage.products.map(p=>[p.id,p]));
    const seen=new Set();
    next.products=(current.products || []).map(p=>{
      if(p.provider!=='shopify') return p;
      if(seen.has(p.id)) throw catalogueError('SAVED_IDENTITY_CONFLICT'); seen.add(p.id);
      if(p.source?.accountId && p.source.accountId!==stage.shop.id || p.source?.domain && p.source.domain!==DOMAIN) throw catalogueError('SAVED_ACCOUNT_CONFLICT');
      const replacement=incoming.get(p.id); incoming.delete(p.id);
      return replacement ? {...p,...replacement} : {...p,catalogueObserved:false};
    });
    next.products.push(...incoming.values());
    const completed={...record,status:'imported',sourceRevision:reservationRevision,completedAt:new Date().toISOString(),sourceCapturedAt:stage.completedAt,sourceAccountId:stage.shop.id,currency:stage.shop.currencyCode,
      productCount:stage.products.length,variantCount:stage.products.reduce((n,p)=>n+p.variants.length,0),pages:stage.pages,bytes:stage.totalBytes,payloadDigest:digest(stage.products)};
    next.shopifyCatalogueImports=ledger(next).map(r=>r.requestId===record.requestId?completed:r);
    addAudit(next,{type:'shopify_catalogue_imported',actor:auth.session.sub,detail:{requestId:record.requestId,sourceAccountId:stage.shop.id,currency:stage.shop.currencyCode,productCount:completed.productCount,payloadDigest:completed.payloadDigest}});
    validateActor(next,auth.session);
    const saved=await save(current,next,assertActive);
    return {...catalogueStatus(saved,policy),replayed:false};
  }
  return {run,status:catalogueStatus};
}
