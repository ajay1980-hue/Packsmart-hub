import crypto from 'node:crypto';
import { calculateOrderProfit, orderRevenue, settledOrder } from './profit.mjs';

const DAY = 86400000;
const clean = (value, max = 240) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const rounded = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
const nowIso = now => (now instanceof Date ? now : new Date(now || Date.now())).toISOString();

function safeDate(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function customerKey(order) {
  const hash = clean(order?.customerEmailHash, 128);
  if (hash) return 'shopify:' + hash;
  const providerCustomerId = clean(order?.customerId || order?.buyerId || order?.buyerUsername, 160);
  if (providerCustomerId) return clean(order?.provider || 'channel', 40) + ':' + providerCustomerId;
  return null;
}

function orderSourceEvidence(order) {
  const touches = [];
  const add = (kind, value, confidence = 'confirmed') => {
    const cleanValue = clean(value, 200);
    if (cleanValue) touches.push({ kind, value: cleanValue, confidence });
  };
  const attr = order?.attribution && typeof order.attribution === 'object' ? order.attribution : {};
  add('utm_source', attr.utmSource || order.utmSource);
  add('utm_medium', attr.utmMedium || order.utmMedium);
  add('utm_campaign', attr.utmCampaign || order.utmCampaign);
  add('referrer', attr.referrer || order.referrer);
  add('landing_page', attr.landingPage || order.landingPage);
  add('source', attr.source || order.sourceName || order.source);
  add('campaign', attr.campaign || order.campaignName);
  if (order.provider) add('sales_channel', order.provider, 'confirmed');
  return touches;
}

function dominant(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a,b) => b[1] - a[1])[0]?.[0] || null;
}

export function ensureRevenueEngine(state) {
  const current = state.revenueEngine && typeof state.revenueEngine === 'object' ? state.revenueEngine : {};
  state.revenueEngine = {
    intentEvents: Array.isArray(current.intentEvents) ? current.intentEvents : [],
    leads: Array.isArray(current.leads) ? current.leads : [],
    quotes: Array.isArray(current.quotes) ? current.quotes : [],
    experiments: Array.isArray(current.experiments) ? current.experiments : [],
    referrals: Array.isArray(current.referrals) ? current.referrals : [],
    loyaltyRules: Array.isArray(current.loyaltyRules) ? current.loyaltyRules : [],
    attributionTouches: Array.isArray(current.attributionTouches) ? current.attributionTouches : [],
    updatedAt: current.updatedAt || null
  };
  return state.revenueEngine;
}

export function deriveCustomerIntelligence(state, { now = new Date() } = {}) {
  const economics = state.economics || {};
  const groups = new Map();
  for (const order of state.orders || []) {
    if (order.cancelledAt || !settledOrder(order)) continue;
    const key = customerKey(order);
    if (!key) continue;
    const at = safeDate(order.createdAt);
    if (!at) continue;
    const profit = calculateOrderProfit(order, economics);
    const revenue = orderRevenue(order).netRevenue || 0;
    const row = groups.get(key) || { id: key, orders: [], channels: new Set(), products: new Map(), revenue: 0, contribution: 0, contributionCoveredRevenue: 0, completeProfitOrders: 0, firstPurchaseAt: at, lastPurchaseAt: at };
    row.orders.push(order);
    row.channels.add(order.provider || 'unknown');
    row.revenue += revenue;
    row.firstPurchaseAt = Math.min(row.firstPurchaseAt, at);
    row.lastPurchaseAt = Math.max(row.lastPurchaseAt, at);
    if (profit.complete) {
      row.contribution += Number(profit.contribution || 0);
      row.contributionCoveredRevenue += Number(profit.netRevenue || 0);
      row.completeProfitOrders += 1;
    }
    for (const line of order.lineItems || []) {
      const sku = clean(line.sku || line.name, 160);
      if (!sku) continue;
      const item = row.products.get(sku) || { sku, name: clean(line.name || sku, 180), quantity: 0, revenue: 0 };
      item.quantity += Number(line.quantity || 0);
      item.revenue += Number(line.net ?? line.gross ?? 0) || 0;
      row.products.set(sku, item);
    }
    groups.set(key, row);
  }

  const customers = [...groups.values()].map(row => {
    row.orders.sort((a,b) => safeDate(a.createdAt) - safeDate(b.createdAt));
    const intervals = [];
    for (let i=1;i<row.orders.length;i++) intervals.push((safeDate(row.orders[i].createdAt) - safeDate(row.orders[i-1].createdAt)) / DAY);
    const averageReorderDays = intervals.length ? intervals.reduce((a,b)=>a+b,0)/intervals.length : null;
    const daysSinceLastOrder = Math.max(0, (now.getTime() - row.lastPurchaseAt) / DAY);
    const expectedNextOrderAt = averageReorderDays ? new Date(row.lastPurchaseAt + averageReorderDays * DAY).toISOString() : null;
    const favourite = [...row.products.values()].sort((a,b)=>b.quantity-a.quantity || b.revenue-a.revenue)[0] || null;
    const windowValue = days => row.orders.filter(order => now.getTime() - safeDate(order.createdAt) <= days * DAY).reduce((sum, order) => sum + (orderRevenue(order).netRevenue || 0), 0);
    const repeat = row.orders.length > 1;
    const due = repeat && averageReorderDays && daysSinceLastOrder >= averageReorderDays * .9;
    const dormant = daysSinceLastOrder >= Math.max(60, (averageReorderDays || 45) * 1.75);
    const churnRisk = repeat && daysSinceLastOrder >= Math.max(45, (averageReorderDays || 30) * 1.35);
    const segment = dormant ? 'dormant' : churnRisk ? 'churn-risk' : due ? 'reorder-due' : row.orders.length >= 3 ? 'loyal' : repeat ? 'repeat' : 'new';
    return {
      id: row.id,
      privacyLabel: 'Customer ' + row.id.split(':').pop().slice(0,8).toUpperCase(),
      orderCount: row.orders.length,
      revenue: rounded(row.revenue),
      contribution: row.completeProfitOrders ? rounded(row.contribution) : null,
      profitCoverage: row.orders.length ? Math.round(row.completeProfitOrders / row.orders.length * 100) : 0,
      averageOrderValue: rounded(row.revenue / row.orders.length),
      firstPurchaseAt: new Date(row.firstPurchaseAt).toISOString(),
      lastPurchaseAt: new Date(row.lastPurchaseAt).toISOString(),
      daysSinceLastOrder: rounded(daysSinceLastOrder, 1),
      averageReorderDays: rounded(averageReorderDays, 1),
      expectedNextOrderAt,
      ltv30: rounded(windowValue(30)), ltv60: rounded(windowValue(60)), ltv90: rounded(windowValue(90)), ltv365: rounded(windowValue(365)),
      favouriteProduct: favourite,
      channels: [...row.channels],
      segment,
      signals: { repeat, reorderDue: Boolean(due), dormant, churnRisk }
    };
  }).sort((a,b) => b.revenue - a.revenue);

  const repeatCustomers = customers.filter(c=>c.orderCount>1).length;
  const totalRevenue = customers.reduce((sum,c)=>sum+c.revenue,0);
  const contributionKnown = customers.filter(c=>c.contribution!==null);
  const recommendations = [];
  for (const customer of customers) {
    if (customer.signals.reorderDue) recommendations.push({ type:'reorder', customerId:customer.id, title:customer.privacyLabel + ' is near its usual reorder window', evidence:`${customer.orderCount} orders; average reorder ${customer.averageReorderDays} days; last order ${customer.daysSinceLastOrder} days ago.`, action:'Prepare a reorder reminder or account follow-up.', approvalRequired:true });
    if (customer.signals.churnRisk) recommendations.push({ type:'retention', customerId:customer.id, title:customer.privacyLabel + ' shows retention risk', evidence:`Last order ${customer.daysSinceLastOrder} days ago versus an average ${customer.averageReorderDays || 'unknown'}-day repeat cycle.`, action:'Review a win-back message using margin-safe incentives only.', approvalRequired:true });
  }

  return {
    summary: {
      customers: customers.length,
      repeatCustomers,
      repeatRate: customers.length ? rounded(repeatCustomers / customers.length * 100, 1) : 0,
      totalRevenue: rounded(totalRevenue),
      knownContribution: contributionKnown.length ? rounded(contributionKnown.reduce((s,c)=>s+c.contribution,0)) : null,
      reorderDue: customers.filter(c=>c.signals.reorderDue).length,
      churnRisk: customers.filter(c=>c.signals.churnRisk).length,
      dormant: customers.filter(c=>c.signals.dormant).length
    },
    customers,
    recommendations: recommendations.slice(0,100),
    coverage: {
      identity: 'privacy-preserving customer keys from connected order data',
      historicalWindow: 'limited to retained/imported order history; 365-day LTV is only complete when 365 days of orders are retained',
      namesAndEmailsExposed: false
    }
  };
}

export function deriveAttribution(state) {
  const orders = (state.orders || []).filter(order => !order.cancelledAt && settledOrder(order));
  const rows = orders.map(order => {
    const touches = [...orderSourceEvidence(order), ...(state.revenueEngine?.attributionTouches || []).filter(t => t.orderId === order.id)];
    const sourceTouch = touches.find(t=>t.kind==='utm_source') || touches.find(t=>t.kind==='source') || null;
    const channel = clean(order.provider || 'unknown', 80);
    const revenue = orderRevenue(order).netRevenue || 0;
    const profit = calculateOrderProfit(order, state.economics || {});
    return { orderId: order.id, channel, source: sourceTouch?.value || null, touches, revenue: rounded(revenue), contribution: profit.complete ? rounded(profit.contribution) : null, confidence: sourceTouch ? 'confirmed-source' : 'channel-only' };
  });
  const sourced = rows.filter(r=>r.source);
  const bySource = new Map();
  for (const row of sourced) {
    const item=bySource.get(row.source)||{source:row.source,orders:0,revenue:0,contribution:0,profitCoveredOrders:0};
    item.orders++; item.revenue+=row.revenue;
    if(row.contribution!==null){item.contribution+=row.contribution;item.profitCoveredOrders++;}
    bySource.set(row.source,item);
  }
  return {
    orders: rows,
    bySource: [...bySource.values()].map(x=>({...x,revenue:rounded(x.revenue),contribution:x.profitCoveredOrders?rounded(x.contribution):null})).sort((a,b)=>b.revenue-a.revenue),
    coverage: {
      orders: rows.length,
      sourceAttributedOrders: sourced.length,
      sourceCoveragePercent: rows.length ? Math.round(sourced.length / rows.length * 100) : 0,
      note: 'Runvara never infers traffic source from a sales channel. First/last/assisted attribution expands only when real UTM, referrer, analytics or campaign evidence is connected.'
    }
  };
}

export function deriveBasketIntelligence(state) {
  const pairCounts = new Map(), skuStats = new Map();
  for (const order of state.orders || []) {
    if (order.cancelledAt || !settledOrder(order)) continue;
    const unique = [...new Set((order.lineItems || []).map(line=>clean(line.sku || line.name,160)).filter(Boolean))];
    for (const sku of unique) skuStats.set(sku,(skuStats.get(sku)||0)+1);
    for(let i=0;i<unique.length;i++) for(let j=i+1;j<unique.length;j++) {
      const key=[unique[i],unique[j]].sort().join('||');
      pairCounts.set(key,(pairCounts.get(key)||0)+1);
    }
  }
  const pairs=[...pairCounts.entries()].map(([key,count])=>{
    const [a,b]=key.split('||'); const base=Math.min(skuStats.get(a)||1,skuStats.get(b)||1);
    return {a,b,ordersTogether:count,affinity:rounded(count/base*100,1)};
  }).sort((a,b)=>b.ordersTogether-a.ordersTogether || b.affinity-a.affinity);
  return { pairs:pairs.slice(0,50), recommendations:pairs.filter(p=>p.ordersTogether>=2).slice(0,20).map(p=>({type:'cross-sell',title:`${p.a} + ${p.b}`,evidence:`Bought together in ${p.ordersTogether} retained orders; ${p.affinity}% affinity against the less-frequent item.`,approvalRequired:true})) };
}

export function deriveIntentRecovery(state, { now = new Date() } = {}) {
  const events = ensureRevenueEngine(state).intentEvents;
  const sessions = new Map();
  for (const event of events) {
    const key=clean(event.sessionId||event.customerId,160); if(!key) continue;
    const row=sessions.get(key)||{id:key,events:[],lastAt:null,checkoutValue:null,customerId:event.customerId||null};
    row.events.push(event); const at=safeDate(event.createdAt); if(at && (!row.lastAt||at>row.lastAt)) row.lastAt=at;
    if(event.type==='checkout_started' && Number.isFinite(Number(event.value))) row.checkoutValue=Number(event.value);
    sessions.set(key,row);
  }
  const recoveries=[];
  for(const row of sessions.values()){
    const types=new Set(row.events.map(e=>e.type)); const age=row.lastAt?(now.getTime()-row.lastAt)/DAY:null;
    if(types.has('checkout_started')&&!types.has('order_completed')&&age!==null&&age>=.04&&age<=14) recoveries.push({sessionId:row.id,customerId:row.customerId,value:rounded(row.checkoutValue),ageDays:rounded(age,1),stage:'checkout-abandoned',recommendedAction:row.checkoutValue>=250?'sales-follow-up':'margin-safe-reminder',approvalRequired:true});
    else if(types.has('add_to_cart')&&!types.has('checkout_started')&&!types.has('order_completed')&&age!==null&&age<=7) recoveries.push({sessionId:row.id,customerId:row.customerId,value:null,ageDays:rounded(age,1),stage:'cart-abandoned',recommendedAction:'product-reminder',approvalRequired:true});
  }
  return {events:events.length,recoveries:recoveries.sort((a,b)=>(b.value||0)-(a.value||0)).slice(0,100)};
}

export function deriveSalesPipeline(state, { now = new Date() } = {}) {
  const engine=ensureRevenueEngine(state);
  const quotes=engine.quotes.map(q=>{
    const value=(q.lines||[]).reduce((s,l)=>s+(Number(l.quantity)||0)*(Number(l.unitPrice)||0),0);
    const expectedContribution=(q.lines||[]).every(l=>Number.isFinite(Number(l.unitContribution))) ? (q.lines||[]).reduce((s,l)=>s+(Number(l.quantity)||0)*Number(l.unitContribution),0) : null;
    const overdue=q.followUpAt&&safeDate(q.followUpAt)<now.getTime()&&!['won','lost','expired'].includes(q.status);
    return {...q,value:rounded(value),expectedContribution:rounded(expectedContribution),overdue};
  });
  const open=quotes.filter(q=>!['won','lost','expired'].includes(q.status));
  return {
    leads:engine.leads,
    quotes,
    summary:{
      leads:engine.leads.length,
      openQuotes:open.length,
      openPipeline:rounded(open.reduce((s,q)=>s+q.value,0)),
      overdueFollowUps:open.filter(q=>q.overdue).length,
      won:quotes.filter(q=>q.status==='won').length,
      lost:quotes.filter(q=>q.status==='lost').length,
      conversionPercent:quotes.filter(q=>['won','lost'].includes(q.status)).length ? rounded(quotes.filter(q=>q.status==='won').length/quotes.filter(q=>['won','lost'].includes(q.status)).length*100,1) : null
    }
  };
}

export function deriveAdvertisingIntelligence(state) {
  const rows=(state.advertisingCosts||[]).map(item=>{
    const spend=Number(item.spend)||0, revenue=Number.isFinite(Number(item.attributableRevenue))?Number(item.attributableRevenue):null;
    return {...item,roas:revenue!==null&&spend>0?rounded(revenue/spend,2):null};
  });
  const spend=rows.reduce((s,r)=>s+(Number(r.spend)||0),0);
  const attributed=rows.filter(r=>r.attributableRevenue!==null&&r.attributableRevenue!==undefined);
  const revenue=attributed.reduce((s,r)=>s+Number(r.attributableRevenue||0),0);
  return {summary:{spend:rounded(spend),attributedRevenue:attributed.length?rounded(revenue):null,roas:attributed.length&&spend>0?rounded(revenue/spend,2):null,attributionCoverage:rows.length?Math.round(attributed.length/rows.length*100):0},rows};
}

export function deriveGrowthPlan(state, { targetProfit = null } = {}) {
  const customers=deriveCustomerIntelligence(state), baskets=deriveBasketIntelligence(state), attribution=deriveAttribution(state), intent=deriveIntentRecovery(state), pipeline=deriveSalesPipeline(state);
  const opportunities=[];
  if(customers.summary.reorderDue) opportunities.push({kind:'retention',title:`Follow up ${customers.summary.reorderDue} customers near a reorder window`,evidence:`${customers.summary.reorderDue} customer records have repeat history and are at or beyond 90% of their observed reorder interval.`,estimatedImpact:null,confidence:'medium',risk:'Customer contact requires appropriate consent and review.',approvalRequired:true});
  if(intent.recoveries.length) opportunities.push({kind:'conversion',title:`Review ${intent.recoveries.length} recoverable buying-intent sessions`,evidence:'Recorded cart/checkout events have no matching completion event in the configured recovery window.',estimatedImpact:null,confidence:'medium',risk:'Do not send discounts below margin floor; outbound contact remains approval-controlled.',approvalRequired:true});
  if(baskets.recommendations.length) opportunities.push({kind:'aov',title:'Test evidence-backed cross-sell bundles',evidence:baskets.recommendations[0].evidence,estimatedImpact:null,confidence:'medium',risk:'Association does not prove uplift; use controlled experiments.',approvalRequired:true});
  if(pipeline.summary.overdueFollowUps) opportunities.push({kind:'b2b',title:`Resolve ${pipeline.summary.overdueFollowUps} overdue B2B follow-ups`,evidence:`Open pipeline value is £${Number(pipeline.summary.openPipeline||0).toFixed(2)}.`,estimatedImpact:null,confidence:'high',risk:'Quote terms and customer-facing messages need owner review.',approvalRequired:true});
  if(attribution.coverage.sourceCoveragePercent<80) opportunities.push({kind:'attribution',title:'Increase source attribution coverage',evidence:`${attribution.coverage.sourceCoveragePercent}% of retained settled orders currently have confirmed traffic-source evidence.`,estimatedImpact:null,confidence:'high',risk:'Do not optimise spend from channel-only attribution.',approvalRequired:false});
  return {targetProfit: Number.isFinite(Number(targetProfit))?Number(targetProfit):null, opportunities, generatedAt:nowIso(), note:'Estimated impact remains null where Runvara lacks defensible uplift evidence. The plan prioritises measurable actions without inventing financial certainty.'};
}


export function createOpportunityExperiment(state, opportunity, body = {}, actor = 'system') {
  if (!opportunity?.id) throw Object.assign(new Error('Opportunity is required'), { status:400, code:'VALIDATION_FAILED' });
  const experiment = createExperiment(state, {
    kind: body.kind || opportunity.kind,
    title: body.title || ('Test: ' + opportunity.title),
    hypothesis: body.hypothesis || opportunity.recommendedNextStep || opportunity.title,
    opportunityId: opportunity.id,
    metric: body.metric || 'incremental_contribution',
    baseline: body.baseline,
    target: body.target
  }, actor);
  opportunity.experimentId = experiment.id;
  opportunity.experimentStatus = 'draft';
  opportunity.updatedAt = nowIso();
  return experiment;
}

export function createExperiment(state, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state), now=nowIso();
  const kind=clean(body.kind || body.type,80).toLowerCase();
  const title=clean(body.title,180);
  if(!kind || !title) throw Object.assign(new Error('Experiment kind and title are required'),{status:400,code:'VALIDATION_FAILED'});
  const experiment={
    id:'experiment_'+crypto.randomUUID(),
    kind,
    title,
    hypothesis:clean(body.hypothesis,600),
    status:'draft',
    opportunityId:clean(body.opportunityId,180)||null,
    approvalId:clean(body.approvalId,180)||null,
    metric:clean(body.metric || 'incremental_contribution',120),
    baseline:body.baseline && typeof body.baseline==='object' ? body.baseline : null,
    target:body.target && typeof body.target==='object' ? body.target : null,
    impact:null,
    createdAt:now,
    updatedAt:now,
    createdBy:actor,
    externalWrites:false
  };
  engine.experiments.unshift(experiment);
  engine.updatedAt=now;
  return experiment;
}

export function recordExperimentMeasurement(state, experimentId, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state);
  const experiment=engine.experiments.find(item=>item.id===experimentId);
  if(!experiment) throw Object.assign(new Error('Experiment not found'),{status:404,code:'EXPERIMENT_NOT_FOUND'});
  if(!['draft','running','completed','measured'].includes(String(experiment.status||'').toLowerCase())) throw Object.assign(new Error('Experiment cannot be measured in its current state'),{status:409,code:'EXPERIMENT_STATE_INVALID'});
  const method=clean(body.method,160);
  if(!method) throw Object.assign(new Error('Measurement method is required'),{status:400,code:'VALIDATION_FAILED'});
  const numbers=['incrementalRevenue','incrementalContribution','contributionProtected','costAvoided','minutesSaved'];
  const impact={verified:false,status:'measured',method,measuredAt:nowIso(),recordedBy:actor};
  let hasMetric=false;
  for(const field of numbers) {
    if(body[field]===null || body[field]===undefined || body[field]==='') continue;
    const value=Number(body[field]);
    if(!Number.isFinite(value)) throw Object.assign(new Error('Measurement values must be numeric'),{status:400,code:'VALIDATION_FAILED'});
    impact[field]=rounded(value);
    hasMetric=true;
  }
  if(!hasMetric) throw Object.assign(new Error('At least one measured impact value is required'),{status:400,code:'VALIDATION_FAILED'});
  experiment.impact=impact;
  experiment.status='measured';
  experiment.updatedAt=impact.measuredAt;
  engine.updatedAt=impact.measuredAt;
  return experiment;
}

function experimentDecisionPosture(impact = {}) {
  const contribution = ['incrementalContribution','contributionProtected','costAvoided']
    .reduce((sum, field) => sum + (Number.isFinite(Number(impact[field])) ? Number(impact[field]) : 0), 0);
  if (contribution > 0) return { status:'ready-for-owner-review', verifiedContributionValue:rounded(contribution), reason:'Verified realised contribution evidence is positive.' };
  if (contribution < 0) return { status:'deprioritise', verifiedContributionValue:rounded(contribution), reason:'Verified realised contribution evidence is negative.' };
  return { status:'needs-more-evidence', verifiedContributionValue:0, reason:'No positive verified contribution evidence has been established.' };
}

export function verifyExperimentMeasurement(state, experimentId, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state);
  const experiment=engine.experiments.find(item=>item.id===experimentId);
  if(!experiment) throw Object.assign(new Error('Experiment not found'),{status:404,code:'EXPERIMENT_NOT_FOUND'});
  if(!experiment.impact || String(experiment.status).toLowerCase()!=='measured') throw Object.assign(new Error('Experiment must have a measured result before verification'),{status:409,code:'EXPERIMENT_NOT_MEASURED'});
  const note=clean(body.note,500);
  if(!note) throw Object.assign(new Error('Verification note is required'),{status:400,code:'VALIDATION_FAILED'});
  const now=nowIso();
  experiment.impact={...experiment.impact,verified:true,status:'verified',verifiedAt:now,verifiedBy:actor,verificationNote:note};
  experiment.status='completed';
  experiment.completedAt=now;
  experiment.updatedAt=now;
  const posture=experimentDecisionPosture(experiment.impact);
  experiment.decisionPosture=posture;
  if (experiment.opportunityId) {
    const opportunity=(state.opportunities || []).find(item=>item.id===experiment.opportunityId);
    if (opportunity) {
      opportunity.experimentId=experiment.id;
      opportunity.experimentStatus='completed';
      opportunity.evidenceDecision=posture.status;
      opportunity.verifiedContributionValue=posture.verifiedContributionValue;
      opportunity.evidenceDecisionReason=posture.reason;
      opportunity.evidenceUpdatedAt=now;
    }
  }
  engine.updatedAt=now;
  return experiment;
}

export function revenueEngineSnapshot(state) {
  ensureRevenueEngine(state);
  return {
    customers: deriveCustomerIntelligence(state),
    attribution: deriveAttribution(state),
    baskets: deriveBasketIntelligence(state),
    intent: deriveIntentRecovery(state),
    sales: deriveSalesPipeline(state),
    advertising: deriveAdvertisingIntelligence(state),
    loyalty: { referrals: state.revenueEngine.referrals, rules: state.revenueEngine.loyaltyRules },
    experiments: state.revenueEngine.experiments,
    growthPlan: deriveGrowthPlan(state)
  };
}

export function createLead(state, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state), now=nowIso();
  const lead={id:'lead_'+crypto.randomUUID(),company:clean(body.company,160),contact:clean(body.contact,160),source:clean(body.source,120),stage:['new','qualified','quote','won','lost'].includes(body.stage)?body.stage:'new',notes:clean(body.notes,1200),createdAt:now,updatedAt:now,createdBy:actor};
  if(!lead.company) throw Object.assign(new Error('Company is required'),{status:400,code:'VALIDATION_FAILED'});
  engine.leads.unshift(lead); engine.updatedAt=now; return lead;
}

export function createQuote(state, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state), now=nowIso();
  const lines=Array.isArray(body.lines)?body.lines.slice(0,100).map(line=>({sku:clean(line.sku,160),description:clean(line.description||line.sku,220),quantity:Math.max(0,Number(line.quantity)||0),unitPrice:Math.max(0,Number(line.unitPrice)||0),unitContribution:Number.isFinite(Number(line.unitContribution))?Number(line.unitContribution):null})).filter(line=>line.quantity>0):[];
  if(!lines.length) throw Object.assign(new Error('At least one quote line is required'),{status:400,code:'VALIDATION_FAILED'});
  const quote={id:'quote_'+crypto.randomUUID(),leadId:clean(body.leadId,160)||null,customerId:clean(body.customerId,200)||null,status:'draft',lines,expiresAt:body.expiresAt&&safeDate(body.expiresAt)?new Date(body.expiresAt).toISOString():null,followUpAt:body.followUpAt&&safeDate(body.followUpAt)?new Date(body.followUpAt).toISOString():null,notes:clean(body.notes,1200),createdAt:now,updatedAt:now,createdBy:actor,customerFacing:false};
  engine.quotes.unshift(quote); engine.updatedAt=now; return quote;
}

export function recordIntentEvent(state, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state);
  const type=clean(body.type,60);
  if(!['product_viewed','add_to_cart','checkout_started','order_completed'].includes(type)) throw Object.assign(new Error('Unsupported intent event'),{status:400,code:'VALIDATION_FAILED'});
  const event={id:'intent_'+crypto.randomUUID(),type,sessionId:clean(body.sessionId,160),customerId:clean(body.customerId,200)||null,sku:clean(body.sku,160)||null,value:Number.isFinite(Number(body.value))?Math.max(0,Number(body.value)):null,createdAt:body.createdAt&&safeDate(body.createdAt)?new Date(body.createdAt).toISOString():nowIso(),source:clean(body.source,100)||'recorded',recordedBy:actor};
  if(!event.sessionId) throw Object.assign(new Error('sessionId is required'),{status:400,code:'VALIDATION_FAILED'});
  engine.intentEvents.unshift(event); engine.intentEvents=engine.intentEvents.slice(0,10000); engine.updatedAt=nowIso(); return event;
}

export function recordAttributionTouch(state, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state);
  const kind=clean(body.kind,40), value=clean(body.value,200), orderId=clean(body.orderId,200);
  if(!['utm_source','utm_medium','utm_campaign','referrer','landing_page','source','campaign'].includes(kind)||!value||!orderId) throw Object.assign(new Error('orderId, supported kind and value are required'),{status:400,code:'VALIDATION_FAILED'});
  const touch={id:'touch_'+crypto.randomUUID(),orderId,kind,value,confidence:'confirmed',createdAt:nowIso(),recordedBy:actor};
  engine.attributionTouches.unshift(touch); engine.attributionTouches=engine.attributionTouches.slice(0,10000); engine.updatedAt=nowIso(); return touch;
}
