// Public display DTOs only. No store capability, provider request or live data.
export const recoveryRoute = '/api/connections/shopify/order-recovery';
export const originalStartedAt = '2026-10-01T10:00:00.000Z';
export const lastCapturedAt = '2026-10-01T10:03:00.000Z';
export const recoveryWindow = () => ({ requestedLowerBound:'2026-07-03T00:00:00.000Z', requestedUpperBound:originalStartedAt, sortKey:'UPDATED_AT', reverse:false });
export const recoveryObservation = () => ({ originalStartedAt,lastCapturedAt,continued:true,snapshotConsistency:'unverified',window:recoveryWindow() });
export function recoveryPreview(workspaceId, { status='failed', reason=null, available=true, action=true, selection='synthetic-one-use-selection-0001' }={}) {
  return { schema:'runvara-order-recovery-preview/v1',workspaceId,available,selection:action?selection:null,expiresAt:action?new Date(Date.now()+300000).toISOString():null,
    originalStartedAt:available?originalStartedAt:null,window:available?recoveryWindow():null,
    stage:status===null?null:{status,pageCount:3,orderCount:120,...recoveryObservation()},
    canStart:available && action && status===null,canResume:available && action && ['reading','failed','complete'].includes(status),reason };
}
export function recoveryResult(workspaceId, status='committed', code=null) {
  return {schema:'runvara-order-recovery-result/v1',workspaceId,status,originalStartedAt,lastCapturedAt,continued:true,snapshotConsistency:'unverified',code};
}
export function recoveryChannel({available=true,observation=false}={}) {
  return {id:'shopify',name:'Shopify',identity:'synthetic-recovery.myshopify.com',configured:true,status:'connected',oauthReady:true,
    areas:['products','orders','customers'],writes:['product_content','internal_note'],settings:{revision:7,permissionMode:'read_only',areas:['products','orders'],autoSync:false,frequencyMinutes:60},
    counts:{products:0,orders:2},history:[],grantedScopes:['read_products','read_orders'],writeAccessGranted:false,refreshSupported:true,
    health:{status:'Healthy',message:'Synthetic connection'},orderRecovery:{available},...(observation?{orderRecoveryObservation:recoveryObservation()}:{})};
}
