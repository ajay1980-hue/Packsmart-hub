// Trusted platform policy projection. No evidence issuer, provider or activation.
const id = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const hash = /^[a-f0-9]{64}$/;
const limitKeys = ['maxRequests','maxInputTokens','maxOutputTokens','maxTotalTokens','maxCostMicros'];
const keys = ['version','grantId','currency','scope','historicalExposure','evidenceHash','expiresAt',
  'legacyDispatchStoppedAt','credentialDigest','organizationId','projectId','limits','accountingStartAt'];
const integer = x => Number.isSafeInteger(x) && x >= 0;
function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).length === names.length && names.every(name => {
    const d = Object.getOwnPropertyDescriptor(value,name); return d?.enumerable && Object.hasOwn(d,'value');
  });
}
export function futureAllowancePolicy(governance, now) {
  try {
    if (!Object.hasOwn(governance, 'futureAllowance')) return { allowed:true, policy:null };
    const a = governance.futureAllowance;
    if (!exact(a,keys) || a.version!==1 || a.currency!=='USD' || a.scope!=='additional_after_cutover'
      || !['grantId','organizationId','projectId'].every(k=>typeof a[k]==='string' && id.test(a[k]))
      || !['evidenceHash','credentialDigest'].every(k=>typeof a[k]==='string' && hash.test(a[k]))
      || !exact(a.historicalExposure,['status','costMicros','reconciled'])
      || a.historicalExposure.status!=='unknown' || a.historicalExposure.costMicros!==null || a.historicalExposure.reconciled!==false
      || !exact(a.limits,limitKeys) || !limitKeys.every(k=>integer(a.limits[k]))
      || !['accountingStartAt','legacyDispatchStoppedAt','expiresAt'].every(k=>integer(a[k]) && a[k]<=8640000000000000)
      || a.legacyDispatchStoppedAt>a.accountingStartAt || a.accountingStartAt>now || a.expiresAt<=now
      || governance.accountingStartAt!==a.accountingStartAt
      || !integer(governance.configuredAt) || governance.configuredAt<a.accountingStartAt || governance.configuredAt>now
      || governance.providers?.openai?.adapters?.['openai-responses']?.atomicUsageCutoverAt!==a.legacyDispatchStoppedAt) {
      return { allowed:false, reason:'AI_FUTURE_ALLOWANCE_UNVERIFIED' };
    }
    return { allowed:true, policy:structuredClone(a) };
  } catch { return { allowed:false, reason:'AI_FUTURE_ALLOWANCE_UNVERIFIED' }; }
}
export const futureAllowanceEffects = () => ({ accountingScope:'additional_after_cutover',
  historicalExposure:{status:'unknown',costMicros:null,reconciled:false} });
