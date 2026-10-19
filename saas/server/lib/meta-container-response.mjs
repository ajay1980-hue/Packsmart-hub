export const META_CONTAINER_STATUSES = Object.freeze(['IN_PROGRESS','FINISHED','PUBLISHED','ERROR','EXPIRED']);
export const metaContainerError = (reason, status=409) => Object.assign(new Error('META_CONTAINER_OBSERVER_'+reason), {code:'META_CONTAINER_OBSERVER_'+reason,status});
// Deliberately narrow response grammar: duplicate/contradictory keys, extra
// objects, free-form provider errors and guessed media IDs are never accepted.
export function parseMetaContainerResponse(text, containerId) {
  const match = /^[ \t\r\n]*\{[ \t\r\n]*(?:"id"[ \t\r\n]*:[ \t\r\n]*"(\d{1,32})"[ \t\r\n]*,[ \t\r\n]*"status_code"[ \t\r\n]*:[ \t\r\n]*"([A-Z_]+)"|"status_code"[ \t\r\n]*:[ \t\r\n]*"([A-Z_]+)"[ \t\r\n]*,[ \t\r\n]*"id"[ \t\r\n]*:[ \t\r\n]*"(\d{1,32})")[ \t\r\n]*\}[ \t\r\n]*$/.exec(text);
  const id=match?.[1]??match?.[4],status=match?.[2]??match?.[3];
  if (id!==containerId || !META_CONTAINER_STATUSES.includes(status)) throw metaContainerError('RESPONSE_INVALID',503);
  return {id,status_code:status};
}
export async function boundedMetaContainerResponse(submit, containerId, timeoutMs=5000) {
  const controller=new AbortController();let timer,reader,body;
  const expiresAt=performance.now()+timeoutMs;
  const cancel=()=>{try {const result=reader?reader.cancel():body?.cancel();if(result?.catch)result.catch(()=>{});}catch{}};
  const assertTime=()=>{if(controller.signal.aborted||performance.now()>=expiresAt){cancel();throw metaContainerError('TIMEOUT',503);}};
  const pending=(async()=>{
    const response=await submit(controller.signal);
    body=response.body;
    // submit may ignore abort and settle after the outer deadline/finally.
    // Never consume such a late response; explicitly cancel its new body.
    assertTime();
    if (response.status!==200 || response.redirected) {
      try {response.body?.cancel()?.catch(()=>{});}catch{}
      throw metaContainerError(response.status===429?'RATE_LIMITED':[401,403].includes(response.status)?'ACCESS_DENIED':'RESPONSE_INVALID',503);
    }
    const declared=response.headers?.get('content-length');
    if (declared!==null && declared!==undefined && (!/^\d{1,8}$/.test(declared)||Number(declared)>4096)) throw metaContainerError('RESPONSE_LIMIT',503);
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type')||'') || !response.body?.getReader) throw metaContainerError('RESPONSE_INVALID',503);
    reader=response.body.getReader();const chunks=[];let total=0,count=0;
    while(true){assertTime();const {done,value}=await reader.read();assertTime();if(done)break;
      if(!(value instanceof Uint8Array)||!value.byteLength||++count>4096)throw metaContainerError('RESPONSE_INVALID',503);total+=value.byteLength;
      if(total>4096)throw metaContainerError('RESPONSE_LIMIT',503);chunks.push(Buffer.from(value));}
    const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,total));
    assertTime();
    return parseMetaContainerResponse(text,containerId);
  })();
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();cancel();reject(metaContainerError('TIMEOUT',503));},timeoutMs);});
  try {return await Promise.race([pending,deadline]);}
  catch(error){
    const known=['RESPONSE_INVALID','RESPONSE_LIMIT','RATE_LIMITED','ACCESS_DENIED','TIMEOUT'];
    const reason=known.find(item=>error?.code==='META_CONTAINER_OBSERVER_'+item)||'RESPONSE_UNKNOWN';
    throw metaContainerError(reason,503);
  } finally {clearTimeout(timer);cancel();}
}
