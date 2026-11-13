// Server auth adapter; no save/provider/credential access.
import {tokenFromRequest,verifySessionToken} from './security.mjs';
import {assertQuietOwnerWorkspace} from './quiet-owner-workspace.mjs';
export function createCredentialOwnerAuth({enabled=false,store,sessionSecret,now=Date.now}={}){
 const fail=()=>{throw Error('Private owner authentication unavailable');};
 if(enabled&&(store?.provider!=='supabase'||typeof store.get!=='function'||typeof sessionSecret!=='string'||sessionSecret.length<32))fail();
 return async request=>{
  if(!enabled||request.signal?.aborted)fail();
  const token=tokenFromRequest({headers:request.headers??{}},{secure:true,allowBearer:false});
  const before=now();if(!Number.isSafeInteger(before))fail();
  const session=verifySessionToken(token,sessionSecret,Math.floor(before/1000));
  if(session?.role!=='owner'||session.workspaceId!=='packsmart-solutions'||!Number.isSafeInteger(session.sessionVersion)||session.sessionVersion<1||!Number.isSafeInteger(session.exp)||session.exp*1000<=before)fail();
  const state=await store.get(session.workspaceId,{exactSnapshot:true}),after=now();
  if(!Number.isSafeInteger(after)||after<before||request.signal?.aborted||session.exp*1000<=after)fail();
  const auth={session,state};assertQuietOwnerWorkspace(auth,{inspectEvidence:false});
  const user=state.users.find(u=>u.id===session.sub);if(user.active!==true||user.sessionVersion!==session.sessionVersion)fail();
  // Transport proof is returned only after actual cookie signature + fresh owner checks.
  return Object.freeze({method:'signed-cookie',role:'owner',csrf:session.csrf,session,state});
 };
}
