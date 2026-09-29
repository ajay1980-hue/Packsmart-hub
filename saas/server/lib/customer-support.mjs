import crypto from 'node:crypto';

const clean=(value,max=300)=>String(value??'').trim().slice(0,max);
const hashEmail=value=>{const normalized=clean(value,254).toLowerCase();return normalized?crypto.createHash('sha256').update(normalized).digest('hex'):null;};

export function normalizeOrderRef(value){
  return clean(value,80).replace(/^order\s*/i,'').replace(/^#/,'').replace(/[^A-Za-z0-9_-]/g,'').slice(0,48);
}

export function classifySupportIntent(message){
  const value=clean(message,1200).toLowerCase();
  if(!value)return 'empty';
  if(/where.*order|track.*order|order.*track|delivery.*order|has.*shipped|dispatch/.test(value))return 'order_status';
  if(/return|refund|send.*back/.test(value))return 'returns';
  if(/deliver|shipping|postage|courier|how long/.test(value))return 'delivery';
  if(/stock|available|availability|sold out|in stock/.test(value))return 'stock';
  if(/vat|invoice|receipt|business account|trade/.test(value))return 'business';
  if(/pack size|quantity|how many|size|dimensions/.test(value))return 'product';
  if(/change.*address|cancel.*order|complaint|damaged|missing|wrong item|chargeback/.test(value))return 'escalate';
  return 'general';
}

function orderRefs(order){
  return [order?.name,order?.orderNumber,order?.number,order?.id]
    .map(normalizeOrderRef).filter(Boolean);
}

function orderStatus(order){
  const fulfilment=clean(order?.fulfillmentStatus||order?.fulfilmentStatus||order?.displayFulfillmentStatus,80).toLowerCase();
  const financial=clean(order?.financialStatus||order?.displayFinancialStatus,80).toLowerCase();
  if(/delivered/.test(fulfilment))return 'delivered';
  if(/fulfilled|shipped|in_transit|in transit/.test(fulfilment))return 'dispatched';
  if(/partial/.test(fulfilment))return 'partially dispatched';
  if(/cancel/.test(fulfilment))return 'cancelled';
  if(/paid|authorized|authorised|pending/.test(financial))return 'being prepared';
  return fulfilment||'being processed';
}

export function findCustomerOrder(orders,{orderNumber,email}={}){
  const ref=normalizeOrderRef(orderNumber);
  const emailHash=hashEmail(email);
  if(!ref||!emailHash)return null;
  return (Array.isArray(orders)?orders:[]).find(order=>
    order?.provider==='shopify' &&
    orderRefs(order).some(candidate=>candidate.toLowerCase()===ref.toLowerCase()) &&
    order.customerEmailHash===emailHash
  )||null;
}

export function buildSupportReply(state,input={}){
  const message=clean(input.message,1200);
  const intent=classifySupportIntent(message);
  const orderNumber=normalizeOrderRef(input.orderNumber);
  const email=clean(input.email,254).toLowerCase();

  if(intent==='empty')return {intent,reply:'Hi! How can I help with your Packsmart order or packaging today?',needsHuman:false,needsOrderDetails:false};
  if(intent==='order_status'){
    if(!orderNumber||!email)return {intent,reply:'I can check that now. Please enter your order number and the email address used at checkout.',needsHuman:false,needsOrderDetails:true};
    const order=findCustomerOrder(state?.orders,{orderNumber,email});
    if(!order)return {intent,reply:"I couldn't safely match that order number and email. Please double-check both. If they're correct, I'll pass this to Packsmart for a human check.",needsHuman:true,needsOrderDetails:false};
    const status=orderStatus(order);
    let reply=`I've found order ${clean(order.name||orderNumber,80)}. Its current status is **${status}**.`;
    if(order.statusPageUrl&&/^https:\/\//i.test(order.statusPageUrl))reply+=` You can see the latest tracking and delivery updates here: ${order.statusPageUrl}`;
    else if(status==='being prepared')reply+=' Tracking will appear after the order is dispatched.';
    return {intent,reply,needsHuman:false,needsOrderDetails:false,matchedOrder:true};
  }
  if(intent==='delivery')return {intent,reply:'Delivery options and timings are shown at checkout and vary by parcel size and destination. If you already ordered, ask me to track your order and I can check it securely.',needsHuman:false,needsOrderDetails:false};
  if(intent==='returns')return {intent,reply:"I can help with a return or refund. Please send your order number and a short reason. Anything needing a decision will be passed to Packsmart rather than guessed.",needsHuman:true,needsOrderDetails:false};
  if(intent==='stock')return {intent,reply:'Tell me the product or pack size you need and I’ll help you find the right current option.',needsHuman:false,needsOrderDetails:false};
  if(intent==='business')return {intent,reply:'Packsmart supports business purchasing and VAT documentation. Tell me whether you need a VAT invoice, repeat order or larger quantity and I’ll guide you.',needsHuman:false,needsOrderDetails:false};
  if(intent==='product')return {intent,reply:'Tell me the product name plus the pack quantity or dimensions you need and I’ll help narrow it down.',needsHuman:false,needsOrderDetails:false};
  if(intent==='escalate')return {intent,reply:"I can help get this sorted, but I won't change an order, payment or address without a human check. Send your order number and a short summary and Packsmart will pick it up.",needsHuman:true,needsOrderDetails:false};
  return {intent,reply:"I can help with orders, delivery, returns, stock, VAT and pack sizes. Tell me what you need and I'll answer straight away or pass it to Packsmart if a human decision is needed.",needsHuman:false,needsOrderDetails:false};
}
