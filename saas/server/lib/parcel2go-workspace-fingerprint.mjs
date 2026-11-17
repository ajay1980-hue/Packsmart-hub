// Private, ephemeral persistence-permit identity. Operation/approval/credential
// fingerprints keep their separate, smaller canonical contract unchanged.
import {createHash} from 'node:crypto';
import {types} from 'node:util';

// The exact snapshot reader accepts 2.2MB, 50,000 value tokens and depth24.
// Its [{state: ...}] envelope consumes two token/depth levels. The store's
// separate final-write limit (<2MiB), capacity checks and CAS still apply.
export const PARCEL2GO_WORKSPACE_LIMITS=Object.freeze({bytes:2200000,nodes:49998,depth:22});
const fail=()=>{throw Object.assign(new Error('Parcel2Go workspace fingerprint unavailable.'),{code:'PARCEL2GO_WORKSPACE_FINGERPRINT_INVALID'});};
function numericReadBytes(value,encoded){
 const [mantissa,exponent]=encoded.split('e');if(exponent===undefined)return encoded.length;
 const negative=value<0,unsigned=negative?mantissa.slice(1):mantissa,digits=unsigned.replace('.','');
 const point=(unsigned.includes('.')?unsigned.indexOf('.'):unsigned.length)+Number(exponent);
 return (point<=0?2-point+digits.length:point>=digits.length?point:digits.length+1)+Number(negative);
}
export function parcel2GoWorkspaceFingerprint(state){
 // Conservative JSONB read size: comma/colon spaces, expanded exponents,
 // [{"state": ...}] envelope and optional terminating CRLF (15 bytes).
 const digest=createHash('sha256').update('parcel2go-workspace-persistence/v1\0'),ancestors=new Set();let readBytes=15,nodes=0;
 const emit=(text,extra=0)=>{readBytes+=Buffer.byteLength(text,'utf8')+extra;if(readBytes>PARCEL2GO_WORKSPACE_LIMITS.bytes)fail();digest.update(text,'utf8');};
 const string=value=>{if(value.length>PARCEL2GO_WORKSPACE_LIMITS.bytes||!value.isWellFormed()||value.includes('\0'))fail();return JSON.stringify(value);};
 function visit(value,depth){
  if(++nodes>PARCEL2GO_WORKSPACE_LIMITS.nodes||depth>PARCEL2GO_WORKSPACE_LIMITS.depth)fail();
  if(value===null||typeof value==='boolean'){emit(JSON.stringify(value));return;}
  if(typeof value==='string'){emit(string(value));return;}
  if(typeof value==='number'){if(!Number.isFinite(value)||Object.is(value,-0))fail();const encoded=JSON.stringify(value);emit(encoded,numericReadBytes(value,encoded)-encoded.length);return;}
  if(typeof value!=='object'||types.isProxy(value)||ancestors.has(value))fail();
  const array=Array.isArray(value),proto=Object.getPrototypeOf(value);
  if(array?proto!==Array.prototype:proto!==Object.prototype&&proto!==null)fail();
  if(array&&value.length>PARCEL2GO_WORKSPACE_LIMITS.nodes-nodes)fail();
  const keys=Reflect.ownKeys(value).filter(key=>!(array&&key==='length'));
  if(keys.length>PARCEL2GO_WORKSPACE_LIMITS.nodes-nodes||array&&keys.length!==value.length)fail();
  for(const key of keys){
   if(typeof key!=='string'||key==='__proto__')fail();
   const d=Object.getOwnPropertyDescriptor(value,key);
   if(!d.enumerable||!Object.hasOwn(d,'value')||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))fail();
  }
  ancestors.add(value);emit(array?'[':'{');
  if(!array)keys.sort();
  for(let i=0;i<keys.length;i++){
   if(i)emit(',',1);const key=keys[i];if(!array){emit(string(key));emit(':',1);}
   visit(Object.getOwnPropertyDescriptor(value,key).value,depth+1);
  }
  emit(array?']':'}');ancestors.delete(value);
 }
 if(state===null||typeof state!=='object'||types.isProxy(state)||Array.isArray(state))fail();
 visit(state,0);return digest.digest('hex');
}
