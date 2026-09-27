import crypto from 'node:crypto';
import { AI_MODEL_CATALOG, estimateAiCostUsd, normalizeAiUsage } from './ai-economics.mjs';

const truthy = value => ['1','true','yes','on'].includes(String(value||'').toLowerCase());
const safeText = (value,max=1000) => String(value??'').trim().slice(0,max);

function outputText(response) {
  if (typeof response?.output_text === 'string') return response.output_text.trim();
  return (response?.output || []).flatMap(item => item?.content || [])
    .filter(item => item?.type === 'output_text' && typeof item.text === 'string')
    .map(item => item.text.trim()).filter(Boolean).join('\n').trim();
}

function approximateInputTokens(text) {
  return Math.ceil(String(text||'').length / 3.5);
}

export function createAiProvider({ env=process.env, store, fetchImpl=fetch }={}) {
  const apiKey=String(env.OPENAI_API_KEY||'').trim();
  const enabled=truthy(env.RUNVARA_OPENAI_ENABLED) && apiKey.length >= 20;
  const endpoint=String(env.OPENAI_API_BASE_URL||'https://api.openai.com/v1').replace(/\/$/,'');
  const maxOutputTokens=Math.max(64,Math.min(2000,Number(env.RUNVARA_AI_MAX_OUTPUT_TOKENS)||500));

  async function monthlyUsage(workspaceId, now=new Date()) {
    const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString();
    const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString();
    return store.aiUsageSummary(workspaceId,start,end);
  }

  async function enhanceCommander({workspaceId,jobId,route,command,run,state}) {
    if (!enabled || route?.provider !== 'openai' || !AI_MODEL_CATALOG[route.model]) {
      return { used:false, reason:enabled?'ROUTE_NOT_SUPPORTED':'PROVIDER_NOT_CONFIGURED', route };
    }
    const deterministic = {
      summary:safeText(run?.summary,5000),
      priorities:(run?.priorities||[]).slice(0,8),
      urgentRisks:(run?.urgentRisks||[]).slice(0,8).map(item=>({code:item.code,severity:item.severity,affected:item.affected||null})),
      workStatus:run?.workStatus||'COMPLETED'
    };
    const input = [
      'User request: '+safeText(command,1000),
      'Verified deterministic Runvara findings:',
      JSON.stringify(deterministic),
      'Write a concise operator brief using only these findings. Do not invent metrics, actions, external results, or approvals. Do not claim an action was executed. Keep the final brief under 180 words.'
    ].join('\n');

    const economics=state?.aiEconomics||{};
    const usage=await monthlyUsage(workspaceId);
    const currentCost=Number(usage.totals?.estimatedCostUsd||0);
    const monthlyLimit=economics.monthlyCostLimitUsd === null || economics.monthlyCostLimitUsd === undefined ? null : Number(economics.monthlyCostLimitUsd);
    const approxInput=approximateInputTokens(input);
    const worstCase=estimateAiCostUsd(route.model,{inputTokens:approxInput,outputTokens:maxOutputTokens});
    if (monthlyLimit !== null && currentCost + worstCase > monthlyLimit) {
      return { used:false, reason:'AI_MONTHLY_COST_LIMIT', route, currentCostUsd:currentCost, estimatedWorstCaseUsd:worstCase };
    }

    const safetyIdentifier=crypto.createHash('sha256').update(String(workspaceId)).digest('hex').slice(0,32);
    let response;
    try {
      response=await fetchImpl(endpoint+'/responses',{
        method:'POST',
        headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},
        body:JSON.stringify({
          model:route.model,
          instructions:'You are Runvara Operator Brief. Summarise only supplied verified findings. You are read-only and must never claim to perform external actions.',
          input,
          max_output_tokens:maxOutputTokens,
          reasoning:{effort:route.tier==='quality'?'medium':'low'},
          store:false,
          safety_identifier:safetyIdentifier,
          prompt_cache_key:'runvara-operator-brief-v1'
        }),
        signal:AbortSignal.timeout(45000)
      });
    } catch(cause) {
      throw Object.assign(new Error('AI provider request failed'),{code:'AI_PROVIDER_FAILED',cause});
    }
    if(!response.ok) {
      throw Object.assign(new Error('AI provider request failed'),{code:'AI_PROVIDER_FAILED',upstreamStatus:response.status});
    }
    const body=await response.json();
    const measured=normalizeAiUsage({
      workspaceId,jobId,taskType:'agent_command',provider:'openai',model:route.model,
      inputTokens:body.usage?.input_tokens||0,
      cachedInputTokens:body.usage?.input_tokens_details?.cached_tokens||0,
      cacheWriteTokens:body.usage?.input_tokens_details?.cache_write_tokens||0,
      outputTokens:body.usage?.output_tokens||0,
      requestId:body.id||null,
      occurredAt:new Date().toISOString()
    });
    await store.recordAiUsage(workspaceId,measured);
    return {
      used:true, route, summary:safeText(outputText(body),2500),
      usage:{inputTokens:measured.inputTokens,cachedInputTokens:measured.cachedInputTokens,cacheWriteTokens:measured.cacheWriteTokens,outputTokens:measured.outputTokens,estimatedCostUsd:measured.estimatedCostUsd},
      requestId:body.id||null
    };
  }

  return { enabled, enhanceCommander, monthlyUsage };
}
