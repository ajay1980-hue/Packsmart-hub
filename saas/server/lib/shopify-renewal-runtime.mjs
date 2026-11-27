// Explicit owner approvals only. The server supplies its existing authenticated
// context and transport; no environment edits or credential inputs are accepted.
import {createShopifyTokenPolicy,createShopifyTokenExchange} from './shopify-token-exchange.mjs';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {tokenFromRequest,verifySessionToken} from './security.mjs';
import {metaStrictJson} from './meta-publication-bounded.mjs';
import {assertRuntimeRenewalOwner,assertRuntimeRenewalIdentity,assertRuntimeRenewalReviewable,assertRuntimeRenewalClaim,prepareRuntimeRenewalChange,reviewRuntimeRenewal,runtimeRenewalStatus,runtimeRenewalCompletion,runtimeRenewalDigest,runtimeRenewalError,RUNTIME_RENEWAL_LEDGER,RUNTIME_RENEWAL_WORKSPACE} from './shopify-renewal-runtime-permit.mjs';
export const SHOPIFY_RUNTIME_RENEWAL_PATH='/api/owner/shopify-runtime-renewal';
export const runtimeRenewalAction=(method,path)=>method==='GET'&&['review','status'].some(x=>path===SHOPIFY_RUNTIME_RENEWAL_PATH+'/'+x)
  ||method==='POST'&&['approve','run','close'].some(x=>path===SHOPIFY_RUNTIME_RENEWAL_PATH+'/'+x);
const fail=code=>{throw runtimeRenewalError(code);};
export function createShopifyRuntimeRenewal({env={},store,integrations,fetchImpl,withWorkspaceLock,now=Date.now,monotonic=()=>performance.now()}={}) {
  const flag=env.RUNVARA_OWNER_SHOPIFY_RUNTIME_RENEWAL??'disabled/v1';
  if(flag==='disabled/v1')return null;
  if(flag!=='enabled/v1'||env.RUNVARA_STARTUP_MODE!=='quiet'||env.RUNVARA_QUIET_OWNER_WORKSPACE!=='enabled/v1'||store?.provider!=='supabase'
    ||typeof fetchImpl!=='function'||typeof withWorkspaceLock!=='function'||typeof store.getIdentity!=='function'||typeof env.SESSION_SECRET!=='string'||env.SESSION_SECRET.length<32)fail('CONFIG_INVALID');
  for(const key of ['RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE','RUNVARA_QUIET_SHOPIFY_CATALOGUE','RUNVARA_QUIET_SHOPIFY_DIAGNOSTIC'])if(env[key]!==undefined&&env[key]!=='disabled/v1')fail('MIXED_CAPABILITIES');
  const authenticate=async request=>{
    const session=verifySessionToken(tokenFromRequest({headers:request.headers??{}},{secure:true,allowBearer:false}),env.SESSION_SECRET,Math.floor(now()/1000));
    if(request.signal?.aborted||session?.role!=='owner'||session.workspaceId!==RUNTIME_RENEWAL_WORKSPACE)fail('OWNER_REQUIRED');
    const auth=await fresh({session});if(request.signal?.aborted)fail('CANCELLED');return Object.freeze({...auth,method:'signed-cookie',role:'owner',csrf:session.csrf});
  };
  const sign=(auth,review)=>createHmac('sha256',env.SESSION_SECRET).update('runvara-runtime-review/v2\0'+runtimeRenewalDigest([auth.session,review,assertRuntimeRenewalReviewable(auth,time())])).digest('base64url');
  function verifyReview(auth,body){
    if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.challenge!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.challenge))fail('REVIEW_REQUIRED');
    const {challenge,...review}=body,expected=sign(auth,review);
    if(!timingSafeEqual(Buffer.from(challenge),Buffer.from(expected)))fail('REVIEW_REQUIRED');
    return review;
  }
  const acknowledged=new Map(),spent=new Set(),closed=new Set(),timers=new Map();let stopped=false,last=now(),lastMono=monotonic();
  function time() {
    const t=now(),m=monotonic();
    if(stopped||!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono){stopped=true;fail('CLOSED');}
    last=t;lastMono=m;return t;
  }
  function active(record) {
    const t=time(),m=monotonic(),expiry=Date.parse(record.expiresAt);
    if(!timers.has(record.id))timers.set(record.id,{t,m});
    const initial=timers.get(record.id);
    if(closed.has(record.id)||t<Date.parse(record.approvedAt)||t>=expiry||m-initial.m>=expiry-initial.t){closed.add(record.id);fail('EXPIRED_OR_CLOSED');}
  }
  async function persist(auth,kind,body,guard=()=>time()) {
    guard();const plan=prepareRuntimeRenewalChange(auth,kind,body,time());
    const check=()=>{guard();if(kind!=='close')active(plan.record);};check();
    try {
      const saved=await store.save(RUNTIME_RENEWAL_WORKSPACE,plan.state,{ownedSnapshot:true,shopifyRuntimeRenewalPermit:plan.permit,
        beforeEffects:check,beforeCommit:()=>{check();assertRuntimeRenewalOwner(auth,time());}});
      if(saved._revision!==plan.nextRevision)fail('COMMIT_UNKNOWN');
      return {saved,record:plan.record};
    } catch {closed.add(body.requestId);acknowledged.delete(body.requestId);fail('COMMIT_UNKNOWN');}
  }
  async function fresh(auth) {
    if(auth.session?.role!=='owner'||auth.session.workspaceId!==RUNTIME_RENEWAL_WORKSPACE)fail('OWNER_REQUIRED');
    const identity=await store.getIdentity(RUNTIME_RENEWAL_WORKSPACE);assertRuntimeRenewalIdentity({...auth,state:identity},time());
    const state=await store.get(RUNTIME_RENEWAL_WORKSPACE,{exactSnapshot:true});
    const next={...auth,state};assertRuntimeRenewalOwner(next,time());return next;
  }
  return Object.freeze({authenticate,
    close(){stopped=true;acknowledged.clear();},
    review(auth){time();const review=reviewRuntimeRenewal(auth,time());return Object.freeze({...review,challenge:sign(auth,review)});},
    status(auth){time();return {outcomes:runtimeRenewalStatus(auth,time()),expectedRevision:auth.state._revision,importAllowed:false,ordersAllowed:false};},
    ownerStatus(auth) {
      const t=time(),outcomes=runtimeRenewalStatus(auth,t),record=auth.state[RUNTIME_RENEWAL_LEDGER]?.at(-1),outcome=outcomes.at(-1);
      let canReview=false;try{assertRuntimeRenewalReviewable(auth,t);canReview=true;}catch{}
      let canRun=false;
      if(record&&record.ownerId===auth.session.sub&&record.status==='approved'&&!spent.has(record.id)&&acknowledged.get(record.id)===record.approvedRevision) {
        try {active(record);assertRuntimeRenewalClaim(auth,record,t);canRun=true;}catch{}
      }
      const canClose=Boolean(record&&record.ownerId===auth.session.sub&&record.status!=='closed');
      const state=outcome?.outcome==='stored'?'check_result':outcome?.outcome==='claimed_reconcile_no_replay'?'stopped':record?.status==='closed'?'stopped':record&&Date.parse(record.expiresAt)<=t?'expired':canReview||canRun?'ready':'stopped';
      const terminal=Boolean(record&&(outcome?.outcome==='stored'||record.status==='closed'&&outcome?.outcome==='closed'));
      return {schema:'runvara-shopify-runtime-owner/v2',enabled:true,state,expectedRevision:auth.state._revision,canReview,canRun,canClose,terminal,
        approval:record?{requestId:record.id,previousRequestId:record.previousRequestId,expiresAt:record.expiresAt,remainingMs:Math.max(0,Math.min(300000,Date.parse(record.expiresAt)-t))}:null,
        outcome:outcome?.outcome==='stored'?'stored':outcome?.outcome==='claimed_reconcile_no_replay'?'uncertain':record?.status==='closed'?'closed':record?'approved':'none'};
    },
    async approve(auth,body,{signal}={}) {
      return withWorkspaceLock(RUNTIME_RENEWAL_WORKSPACE,async()=>{
        auth=await fresh(auth);const review=verifyReview(auth,body);const {saved,record}=await persist(auth,'approve',review,()=>{time();if(signal?.aborted)fail('CANCELLED');});
        active(record);acknowledged.set(record.id,record.approvedRevision);
        return {requestId:record.id,expectedRevision:saved._revision,expiresAt:record.expiresAt,status:'approved',importAllowed:false,ordersAllowed:false};
      });
    },
    async run(auth,body,{signal}={}) {
      return withWorkspaceLock(RUNTIME_RENEWAL_WORKSPACE,async()=>{
        auth=await fresh(auth);const record=auth.state[RUNTIME_RENEWAL_LEDGER]?.find(r=>r.id===body?.requestId);
        if(!record||spent.has(record.id)||acknowledged.get(record.id)!==record.approvedRevision)fail('ACKNOWLEDGED_APPROVAL_REQUIRED');
        active(record);spent.add(record.id);acknowledged.delete(record.id);
        const guard=()=>{active(record);if(signal?.aborted)fail('CANCELLED');};
        const {saved}=await persist(auth,'claim',body,guard);
        const claimed=saved[RUNTIME_RENEWAL_LEDGER].find(r=>r.id===record.id);
        // Ack-local admission is intentionally lost at restart. An unused
        // durable approval must be explicitly closed/reviewed again; a claimed
        // operation remains spent across every process, including lost saves.
        const policy=createShopifyTokenPolicy({...env,RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE:'enabled/v1',
          RUNVARA_SHOPIFY_TOKEN_OPERATION:'renew_expired/v1',RUNVARA_SHOPIFY_TOKEN_PREVIOUS_REQUEST_ID:record.previousRequestId,
          RUNVARA_SHOPIFY_TOKEN_REQUEST_ID:record.id,RUNVARA_SHOPIFY_TOKEN_EXPIRES_AT:record.expiresAt});
        const exchange=createShopifyTokenExchange({store,integrations,env,policy,fetchImpl});
        auth=await fresh(auth);
        if(auth.state._revision!==claimed.claimRevision||auth.state[RUNTIME_RENEWAL_LEDGER].find(r=>r.id===record.id)?.status!=='claimed')fail('STATE_CHANGED');
        const result=await exchange.run(auth,{requestId:record.id,expectedRevision:claimed.claimRevision},guard);
        const verified=await fresh(auth),savedRecord=verified.state[RUNTIME_RENEWAL_LEDGER]?.find(x=>x.id===record.id);
        if(!savedRecord||runtimeRenewalCompletion(verified.state,savedRecord)!=='stored')fail('COMPLETION_UNCONFIRMED');
        return result;
      });
    },
    async revoke(auth,body) {
      // Do not wait for the issuer-held local lock. Primary CAS arbitrates a
      // competing close; a failed/unknown close is never retried automatically.
      // Validate the already authenticated snapshot, then latch stop before the
      // first asynchronous read. A lost/failed CAS remains stopped locally and
      // must be reconciled, never represented as confirmed durable closure.
      const plan=prepareRuntimeRenewalChange(auth,'close',body,time());
      closed.add(plan.record.id);acknowledged.delete(plan.record.id);
      auth=await fresh(auth);
      const {saved}=await persist(auth,'close',body);
      return {requestId:plan.record.id,status:'closed',expectedRevision:saved._revision,tokenRevoked:false};
    }
  });
}

// Bound the private production mutation body independently of the general HTTP
// server timeout. Duplicate JSON members and reserved keys fail closed.
export async function readRuntimeRenewalBody(req) {
  if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??''))fail('INPUT_INVALID');
  let timer,size=0;const chunks=[],iterator=req[Symbol.asyncIterator]();
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(runtimeRenewalError('BODY_TIMEOUT')),2000);});
  try {for(;;){const {done,value}=await Promise.race([iterator.next(),timeout]);if(done)break;size+=value.length;if(size>2048)fail('BODY_LIMIT');chunks.push(value);}return metaStrictJson(Buffer.concat(chunks));}
  finally{clearTimeout(timer);void iterator.return?.().catch(()=>{});}
}

export function createShopifyRuntimeRenewalRehearsal({controller,origin,mode='disabled/v1'}={}) {
  const reply=(status,body)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
  if(mode==='disabled/v1'||!controller)return {handle:async()=>reply(404,{error:'Unavailable'})};
  const url=new URL(origin);
  if(mode!=='offline-owner-http/v1'||url.origin!==origin||url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||!url.port)fail('REHEARSAL_ONLY');
  return Object.freeze({async handle(req) {
    try {
      const u=new URL(req.url),part=u.pathname.slice(SHOPIFY_RUNTIME_RENEWAL_PATH.length);
      if(u.origin!==origin||u.search||!u.pathname.startsWith(SHOPIFY_RUNTIME_RENEWAL_PATH)||!['/review','/status','/approve','/run','/close'].includes(part))return reply(404,{error:'Unavailable'});
      const read=['/review','/status'].includes(part);
      if(req.method!==(read?'GET':'POST'))return reply(405,{error:'Method refused'});
      const headers=Object.fromEntries(req.headers),auth=await controller.authenticate({headers,signal:req.signal});
      if(req.signal.aborted)fail('CANCELLED');
      if(headers['sec-fetch-site']&&!['same-origin','none'].includes(headers['sec-fetch-site']))return reply(403,{error:'Origin refused'});
      if(read)return reply(200,part==='/review'?controller.review(auth):controller.status(auth));
      if(headers.origin!==origin||headers['x-csrf-token']!==auth.session.csrf||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(headers['content-type']??''))return reply(403,{error:'Request refused'});
      const reader=req.body?.getReader();if(!reader)fail();let timer,bytes=0;const chunks=[];
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(runtimeRenewalError('BODY_TIMEOUT')),2000);});
      try{for(;;){const {done,value}=await Promise.race([reader.read(),timeout]);if(req.signal.aborted)fail('CANCELLED');if(done)break;bytes+=value.byteLength;if(bytes>2048)fail('BODY_LIMIT');chunks.push(Buffer.from(value));}}finally{clearTimeout(timer);reader.cancel().catch(()=>{});}
      const body=metaStrictJson(Buffer.concat(chunks));if(req.signal.aborted)fail('CANCELLED');
      const method=part==='/approve'?'approve':part==='/run'?'run':'revoke';
      // A disconnected run remains spent; do not automatically retry it.
      const out=await controller[method](auth,body,{signal:req.signal});if(req.signal.aborted)fail('CANCELLED');return reply(200,out);
    }catch{return reply(409,{error:'Outcome unconfirmed; reconcile without retry.'});}
  }});
}
