import crypto from 'node:crypto';
import {supportProductSku,supportProductReply} from './support-product-facts.mjs';

const clean=(value,max=300)=>String(value??'').trim().slice(0,max);
const hashEmail=value=>{const normalized=clean(value,254).toLowerCase();return normalized?crypto.createHash('sha256').update(normalized).digest('hex'):null;};
export const PUBLIC_SUPPORT_WORKSPACE = 'packsmart-solutions';
export const SUPPORT_READ_MAX_BYTES = 2097152;
export const SUPPORT_MAX_ORDERS = 5000;
export const SUPPORT_ORIGINS = Object.freeze(['https://packsmartsolutions.com', 'https://www.packsmartsolutions.com', 'https://packsmartsolutionscom.myshopify.com']);
export const supportUnavailable = () => Object.assign(new Error('Saved support information is unavailable'), { status:503, code:'SUPPORT_UNAVAILABLE' });

export function validateSupportInput(body){
  if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(new Error('Invalid support request'),{status:400,code:'SUPPORT_INPUT_INVALID'});
  const result={};
  for(const [key,max] of [['message',1200],['orderNumber',80],['email',254]]){
    if(body[key]!==undefined&&(typeof body[key]!=='string'||body[key].length>max))throw Object.assign(new Error('Invalid support request'),{status:400,code:'SUPPORT_INPUT_INVALID'});
    result[key]=clean(body[key],max);
  }
  return result;
}

export function supportNeedsOrders(input){
  return classifySupportIntent(input.message)==='order_status'&&Boolean(normalizeOrderRef(input.orderNumber)&&hashEmail(input.email));
}

export function supportProductRequest(input){
  return classifySupportIntent(input.message)==='product'?supportProductSku(input.message):null;
}

// Only these saved fields leave the trusted store reader. No hydration or writes.
export function supportOrderProjection(orders){
  if(!Array.isArray(orders)||orders.length>SUPPORT_MAX_ORDERS||Buffer.byteLength(JSON.stringify(orders))>SUPPORT_READ_MAX_BYTES)throw supportUnavailable();
  const limits={provider:32,name:80,orderNumber:80,number:80,id:200,customerEmailHash:64,
    fulfillmentStatus:80,fulfilmentStatus:80,displayFulfillmentStatus:80,financialStatus:80,displayFinancialStatus:80,statusPageUrl:2048};
  return orders.map(order=>{
    if(!order||typeof order!=='object'||Array.isArray(order))throw supportUnavailable();
    if(order.provider!=='shopify')return null;
    const result={};
    for(const [key,max] of Object.entries(limits)){
      let value=order[key];
      if(value===undefined||value===null)continue;
      if(['id','orderNumber','number'].includes(key)&&Number.isSafeInteger(value)&&value>=0)value=String(value);
      if(typeof value!=='string'||value.length>max)throw supportUnavailable();
      result[key]=value;
    }
    return result;
  }).filter(Boolean);
}

function safeTrackingUrl(value){
  try{
    if(typeof value!=='string'||value.length>2048||/[\s<>]/.test(value))return null;
    const url=new URL(value);
    return SUPPORT_ORIGINS.includes(url.origin)&&!url.username&&!url.password?url.href:null;
  }catch{return null;}
}

export function normalizeOrderRef(value){
  return clean(value,80).replace(/^order\s*/i,'').replace(/^#/,'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,48);
}

export function classifySupportIntent(message){
  const value=clean(message,1200).toLowerCase();
  if(!value)return 'empty';
  if(/change.*address|cancel.*order|complaint|damaged|missing|wrong item|chargeback/.test(value))return 'escalate';
  if(/where.*order|track.*order|order.*track|delivery.*order|has.*shipped|dispatch/.test(value))return 'order_status';
  if(/return|refund|send.*back/.test(value))return 'returns';
  if(/deliver|shipping|postage|courier|how long/.test(value))return 'delivery';
  if(/stock|available|availability|sold out|in stock/.test(value))return 'stock';
  if(/vat|invoice|receipt|business account|trade/.test(value))return 'business';
  if(/pack size|quantity|how many|size|dimensions|\bsku\b|\bprice\b/.test(value))return 'product';
  return 'general';
}

function orderRefs(order){
  return [order?.name,order?.orderNumber,order?.number,order?.id]
    .map(normalizeOrderRef).filter(Boolean);
}

function orderStatus(order){
  const aliases=['fulfillmentStatus','fulfilmentStatus','displayFulfillmentStatus'];
  const statuses=[];
  for(const key of aliases){
    const raw=order?.[key];
    if(raw===undefined||raw===null||raw==='')continue;
    if(typeof raw!=='string'||raw.length>80)return 'not yet confirmed';
    const value=raw.trim().toLowerCase().replace(/[\s-]+/g,'_');
    if(!value)continue;
    // Compare every provided alias by exact status semantics, never financial state.
    const status=value==='delivered'?'delivered'
      :['fulfilled','shipped','in_transit'].includes(value)?'dispatched'
      :['partial','partially_fulfilled','partially_shipped','partially_dispatched'].includes(value)?'partially dispatched'
      :['cancelled','canceled'].includes(value)?'cancelled'
      :['unfulfilled','unshipped'].includes(value)?'not yet dispatched':null;
    if(!status)return 'not yet confirmed';
    statuses.push(status);
  }
  return statuses.length&&new Set(statuses).size===1?statuses[0]:'not yet confirmed';
}

export function findCustomerOrder(orders,{orderNumber,email}={}){
  const ref=normalizeOrderRef(orderNumber);
  const emailHash=hashEmail(email);
  if(!ref||!emailHash)return null;
  const matches=(Array.isArray(orders)?orders:[]).filter(order=>
    order?.provider==='shopify' &&
    orderRefs(order).some(candidate=>candidate.toLowerCase()===ref.toLowerCase()) &&
    order.customerEmailHash===emailHash
  );
  return matches.length===1?matches[0]:null;
}

export function buildSupportReply(state,input={}){
  const message=clean(input.message,1200);
  const intent=classifySupportIntent(message);
  const orderNumber=normalizeOrderRef(input.orderNumber);
  const email=clean(input.email,254).toLowerCase();

  if(intent==='empty')return {intent,reply:'Hi! How can I help with your Packsmart order or packaging today?',needsHuman:false,needsOrderDetails:false};
  if(intent==='order_status'){
    if(!orderNumber||!email)return {intent,reply:'Enter your order number and checkout email to check the saved order status. Do not send payment details or passwords.',needsHuman:false,needsOrderDetails:true};
    const order=findCustomerOrder(state?.orders,{orderNumber,email});
    if(!order)return {intent,reply:"I couldn't safely match that order number and email. Please contact Packsmart through the store's contact page. This chat has not sent a message to the team.",needsHuman:true,needsOrderDetails:false};
    const status=orderStatus(order);
    let reply=`The saved status for order ${normalizeOrderRef(order.name||orderNumber)} is **${status}**. This is not a live carrier check and may have changed.`;
    const uncertain=status==='not yet confirmed';
    if(uncertain)reply+=" Contact Packsmart through the store's contact page to confirm. This chat has not sent a message to the team.";
    const tracking=safeTrackingUrl(order.statusPageUrl);
    if(tracking)reply+=` For updates, open your store order-status page: ${tracking}`;
    return {intent,reply,needsHuman:uncertain,needsOrderDetails:false,matchedOrder:true,source:'saved_order'};
  }
  if(intent==='delivery')return {intent,reply:'Delivery options and timings are shown at checkout and vary by parcel size and destination. For an existing order, I can check its saved status using your order number and checkout email.',needsHuman:false,needsOrderDetails:false};
  if(intent==='returns')return {intent,reply:"For a return or refund, contact Packsmart through the store's contact page with your order number and reason. This chat does not submit return or refund requests.",needsHuman:true,needsOrderDetails:false};
  if(intent==='stock')return {intent,reply:'Check the product page for current availability and pack options. This chat does not perform a live stock check.',needsHuman:false,needsOrderDetails:false};
  if(intent==='business')return {intent,reply:"For a VAT invoice, repeat order or larger quantity, contact Packsmart through the store's contact page. This chat has not sent a message to the team.",needsHuman:true,needsOrderDetails:false};
  if(intent==='product'){
    const sku=supportProductRequest(input),facts=state?.supportProductFacts;
    const grounded=sku&&facts?.sku===sku?supportProductReply(facts):null;
    return grounded||{intent,reply:'I cannot verify product facts from the available saved evidence. Check the product page or contact Packsmart for pack quantities, dimensions and current price. For an exact catalogue check, use SKU: followed by the exact SKU. This chat has not sent a message to the team.',needsHuman:true,needsOrderDetails:false};
  }
  if(intent==='escalate')return {intent,reply:"This chat cannot change an order, payment or address. Please contact Packsmart through the store's contact page. No message has been sent to the team.",needsHuman:true,needsOrderDetails:false};
  return {intent,reply:"I can explain delivery and returns or check saved order status. For a human response, contact Packsmart through the store's contact page; this chat does not send messages to the team.",needsHuman:false,needsOrderDetails:false};
}
