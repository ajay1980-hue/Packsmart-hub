import test from 'node:test';import assert from 'node:assert/strict';
import {PACKSMART_BUNDLE_POLICY as pinned,canonicalBundleRoster,verifyBundleMembership,createBundleRosterValidator,validatePacksmartBundleRoster,SUPPORT_BUNDLE_CONTEXT_SELECT,supportBundleContextFromState} from '../lib/support-bundle-policy.mjs';
import {createBundleSupportProjection,supportBundleProductProjection,supportProductReply,productOnlySupportReply} from '../lib/support-product-facts.mjs';
import {syntheticBundleFixture,addSyntheticUnmapped} from './support-bundle-fixtures.mjs';
const evaluate=f=>createBundleRosterValidator(f.policy)(f.products,f.context,{now:f.now});
test('production policy remains pinned; synthetic full roster is not the audited original',()=>{
  assert.equal(pinned.digest,'a7f34c219e4b88923457d8911893d9f05d0818b2a609ce15d44294c3464f36da');assert.equal(pinned.canonicalBytes,21911);assert.equal(Object.keys(pinned.parents).length,15);assert.equal(Object.keys(pinned.outers).length,5);
  const f=syntheticBundleFixture();assert.equal(verifyBundleMembership(f.rows),false);assert.equal(validatePacksmartBundleRoster(f.products,f.context,{now:f.now}),null);
  assert.equal(supportBundleProductProjection(f.context.workspaceId,f.products,f.sku,{now:f.now,context:f.context}),null);
  assert.throws(()=>{pinned.parents['x']={};},TypeError);
});
test('canonicalization is compact UTF8, ASCII full-GID ordered and independent of input/component order',()=>{
  const rows=[['gid://shopify/Product/2','gid://shopify/ProductVariant/2',25,[['gid://shopify/ProductVariant/3',25],['gid://shopify/ProductVariant/10',1]]],['gid://shopify/Product/10','gid://shopify/ProductVariant/10',25,[['gid://shopify/ProductVariant/11',25]]]];
  const c=canonicalBundleRoster(rows);assert.equal(c.canonical,JSON.stringify([rows[1],[...rows[0].slice(0,3),[rows[0][3][1],rows[0][3][0]]]]));
  assert.equal(c.bytes,Buffer.byteLength(c.canonical));assert.equal(c.canonical.includes('\n'),false);assert.deepEqual(canonicalBundleRoster([...rows].reverse()),c);
  const f=syntheticBundleFixture();assert.equal(verifyBundleMembership(f.rows,f.policy),true);assert.equal(evaluate(f).length,150);
});
test('fresh synthetic complete roster yields bounded facts, never original provider prices or stock promises',()=>{
  const f=syntheticBundleFixture(),before=structuredClone(f),project=createBundleSupportProjection(f.policy);
  const facts=project(f.context.workspaceId,f.products,f.sku,{context:f.context,now:f.now}),reply=supportProductReply(facts,{now:f.now});
  assert.equal(facts.packQuantity,25);assert.equal(facts.priceDecimal,'12.3400');assert.match(reply.reply,/GBP 12\.3400/);assert.match(reply.reply,/25 items per sellable pack/);assert.equal(reply.needsOrderDetails,false);
  assert.doesNotMatch(JSON.stringify(facts),/999999|raw|components|relation|connection|revision|policyDigest|order|customer/i);assert.match(reply.reply,/not a live stock check/);assert.deepEqual(f,before);
  assert.equal(supportProductReply({...facts},{now:f.now}),null);
});
test('grey250 consumption251 and BP100 primary100 plus exact outer1 do not change sold quantity',()=>{
  const f=syntheticBundleFixture(),r=evaluate(f);assert.equal(r.find(x=>x.sku==='SYNTH-0-250').packQuantity,250);assert.equal(r.find(x=>x.sku==='SYNTH-10-100').packQuantity,100);
  assert.deepEqual(f.rows.find(x=>x[1]===r.find(x=>x.sku==='SYNTH-0-250').variantId)[3].map(x=>x[1]),[251]);
});
test('126 unmapped variants remain excluded even if marked Retail; duplicate SKU blocks selection',()=>{
  const f=addSyntheticUnmapped(syntheticBundleFixture()),project=createBundleSupportProjection(f.policy);assert.equal(evaluate(f).length,150);
  assert.equal(project(f.context.workspaceId,f.products,'UNMAPPED-0',{context:f.context,now:f.now}),null);
  f.products.at(-1).variants[0].sku=f.sku;assert.equal(project(f.context.workspaceId,f.products,f.sku,{context:f.context,now:f.now}),null);
});
for(const [name,change] of [
  ['wrong tenant',f=>f.context.workspaceId='foreign'],['wrong account',f=>f.context.sourceAccountId='gid://shopify/Shop/1'],['wrong domain',f=>f.context.domain='other.myshopify.com'],
  ['wrong connection',f=>f.context.connectionId='other'],['missing snapshot revision',f=>delete f.context.revision],['newer receipt revision',f=>f.context.sourceRevision=f.context.revision],
  ['missing receipt',f=>f.context.status=null],['pending receipt',f=>f.context.status='reserved'],['stale context',f=>f.now+=86400001],['future context',f=>f.now-=100000],
  ['wrong capture window',f=>f.context.startedAt=f.context.sourceCapturedAt],['changed receipt counts',f=>f.context.variantCount++],['wrong currency',f=>f.context.currency='EUR'],
  ['missing parent',f=>f.products.pop()],['extra policy variant',f=>{const v=structuredClone(f.products[0].variants[0]);v.id='gid://shopify/ProductVariant/999999';f.products[0].variants.push(v);}],
  ['missing variant',f=>f.products[0].variants.pop()],['duplicate variant',f=>f.products[0].variants[1].id=f.products[0].variants[0].id],['duplicate parent',f=>f.products.push(f.products[0])],
  ['requiresComponents false',f=>f.products[0].variants[0].requiresComponents=false],['archived parent',f=>f.products[0].status='archived'],['unpublished',f=>f.products[0].onlineStoreUrl=null],
  ['unknown current source',f=>f.products[0].catalogueObserved=false],['source connection conflict',f=>f.products[0].source.connectionId='other'],['source tenant conflict',f=>f.products[0].variants[0].source.tenantId='other'],
  ['nested tenant alias',f=>f.products[0].tenant={id:'foreign'}],['connection alias',f=>f.products[0].variants[0].connection_id='foreign'],
  ['raw currency drift',f=>f.products[0].variants[0].currency='USD'],['price drift',f=>f.products[0].variants[0].priceDecimal='99.00'],
  ['missing option',f=>f.products[0].variants[0].selectedOptions=[]],['duplicate option',f=>f.products[0].variants[0].selectedOptions.push(f.products[0].variants[0].selectedOptions[0])],
  ['incomplete product pagination',f=>f.products[0].raw.variants.pageInfo.hasNextPage=true],['incomplete components',f=>f.products[0].variants[0].catalogueEvidence.raw.productVariantComponents.pageInfo.hasNextPage=true],
  ['component ID tampering',f=>f.products[0].variants[0].catalogueEvidence.components.entries[0].componentVariantId='gid://shopify/ProductVariant/99'],
  ['component quantity tampering',f=>f.products[0].variants[0].catalogueEvidence.components.entries[0].consumedQuantity--],
  ['duplicate relation',f=>f.products[0].variants[1].catalogueEvidence.raw.productVariantComponents.nodes[0].id=f.products[0].variants[0].catalogueEvidence.raw.productVariantComponents.nodes[0].id],
  ['invalid relation',f=>f.products[0].variants[0].catalogueEvidence.raw.productVariantComponents.nodes[0].id='bad relation'],
  ['stale individual capture',f=>f.products[0].variants[0].source.capturedAt='2020-01-01T00:00:00.000Z'],
  ['newer individual capture',f=>f.products[0].variants[0].catalogueEvidence.capturedAt=new Date(f.now+1).toISOString()],
])test('bundle projection fails closed: '+name,()=>{const f=syntheticBundleFixture();change(f);assert.equal(evaluate(f),null);});
for(const [name,change] of [
  ['missing row',f=>f.rows.pop()],['extra row',f=>f.rows.push(f.rows[0])],['changed sold quantity',f=>f.rows[0][2]=50],['grey subtraction',f=>f.rows[0][3][0][1]--],
  ['outer ID',f=>f.rows.find(x=>x[3].length===2)[3][1][0]='gid://shopify/ProductVariant/99'],['outer quantity',f=>f.rows.find(x=>x[3].length===2)[3][1][1]=2],
  ['extra component',f=>f.rows[0][3].push(['gid://shopify/ProductVariant/99',1])],['new variant replaces old',f=>f.rows[0][1]='gid://shopify/ProductVariant/99']
])test('membership anchor rejects '+name,()=>{const f=syntheticBundleFixture();change(f);assert.equal(verifyBundleMembership(f.rows,f.policy),false);});
test('policy dependency is cloned and immutable after factory construction',()=>{
  const f=syntheticBundleFixture(),validate=createBundleRosterValidator(f.policy);f.policy.digest='0'.repeat(64);assert.equal(validate(f.products,f.context,{now:f.now}).length,150);
});
test('primary and outer policy-ID tampering cannot preserve the verified roster',()=>{
  for(const kind of ['primary','outer','family','digest','bytes']){
    const f=syntheticBundleFixture();if(kind==='primary')f.policy.parents[f.rows[0][0]].primary='gid://shopify/ProductVariant/99';
    if(kind==='outer')f.policy.outers[Object.keys(f.policy.outers)[0]]='gid://shopify/ProductVariant/99';
    if(kind==='family')f.policy.parents[f.rows[0][0]].family='ep';if(kind==='digest')f.policy.digest='0'.repeat(64);if(kind==='bytes')f.policy.canonicalBytes++;
    assert.equal(evaluate(f),null,kind);
  }
});
test('safe context projection excludes credentials, bindings hashes, orders and customers',()=>{
  const f=syntheticBundleFixture(),r={...f.context,binding:{connectionId:f.context.connectionId,domain:f.context.domain,credentialDigest:'PRIVATE'},sourceRevision:f.context.sourceRevision};
  const ctx=supportBundleContextFromState({workspace:{id:f.context.workspaceId},_revision:f.context.revision,shopifyCatalogueImports:[r],connections:[{encryptedCredentials:'PRIVATE'}]});
  assert.equal(ctx.connectionId,f.context.connectionId);assert.doesNotMatch(JSON.stringify(ctx),/PRIVATE|credential|encrypted|binding/i);assert.doesNotMatch(SUPPORT_BUNDLE_CONTEXT_SELECT,/credential|encrypted|orders|customers/i);
  assert.match(SUPPORT_BUNDLE_CONTEXT_SELECT,/shopifyCatalogueImports->-1/);assert.match(productOnlySupportReply(null).reply,/does not look up orders/);
});
