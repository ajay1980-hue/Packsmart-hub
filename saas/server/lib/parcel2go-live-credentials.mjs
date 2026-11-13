// Server-only pure envelope helpers. Never stored or exposed by these functions.
// Only the existing credential codec is used; no new encryption software.
import {encryptCredentials,decryptCredentials} from './security.mjs';
import {assertQuietOwnerWorkspace} from './quiet-owner-workspace.mjs';
import {parcel2GoCanonicalJson} from './parcel2go-live-canonical.mjs';
const SCHEMA='runvara-parcel2go-live-credentials/v1';
const fail=()=>{throw Object.assign(new Error('Parcel2Go live credential binding refused.'),{code:'PARCEL2GO_LIVE_CREDENTIALS_INVALID'});};
const exact=(x,keys)=>{if(!x||Array.isArray(x)||Object.keys(x).sort().join('|')!==keys.split(' ').sort().join('|'))fail();};
const clone=x=>{try{return JSON.parse(parcel2GoCanonicalJson(x));}catch{fail();}};
const secret=x=>typeof x==='string'&&/^[^\x00-\x20\x7f]{8,4096}$/.test(x);
function binding(value){const b=clone(value);exact(b,'workspaceId connectionId accountId environment');if(b.workspaceId!=='packsmart-solutions'||b.environment!=='live'||![b.accountId,b.connectionId].every(x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(x)))fail();return b;}
function owner(auth,now){
 if(!Number.isSafeInteger(now)||now<0)fail();
 // Do not traverse unrelated business state or decrypt before this check.
 const state=auth?.state;if(!state||![Object.prototype,null].includes(Object.getPrototypeOf(state)))fail();
 const selected={};for(const k of ['workspace','users','workspaceId','workspace_id','tenantId','tenant_id','tenant']){const d=Object.getOwnPropertyDescriptor(state,k);if(d){if(!Object.hasOwn(d,'value'))fail();selected[k]=d.value;}}
 const projection=clone({session:auth?.session,state:selected});
 const s=projection.session,u=projection.state.users;
 if(!Array.isArray(u)||typeof s.sub!=='string'||!Number.isSafeInteger(s.sessionVersion)||s.sessionVersion<1||!Number.isSafeInteger(s.exp)||s.exp*1000<=now||u.filter(x=>x.id===s.sub&&x.active===true&&x.sessionVersion===s.sessionVersion).length!==1)fail();
 try{assertQuietOwnerWorkspace(projection,{inspectEvidence:false});}catch{fail();}
}
function value(input){const v=clone(input);exact(v,'clientId clientSecret');if(!secret(v.clientId)||!secret(v.clientSecret))fail();return v;}
const keyCheck=key=>{if(typeof key!=='string'||key.length<32||key.length>4096)fail();};
export function sealParcel2GoLiveCredentials({auth,trustedBinding,value:credentials,key,now=Date.now()}={}){
 owner(auth,now);keyCheck(key);const b=binding(trustedBinding),v=value(credentials);
 const encryptedCredentials=encryptCredentials({schema:SCHEMA,binding:b,credentials:v},key);
 return Object.freeze({schema:SCHEMA,binding:Object.freeze(b),encryptedCredentials});
}
export function openParcel2GoLiveCredentials({auth,trustedBinding,envelope,key,expectedClientId,now=Date.now()}={}){
 owner(auth,now);keyCheck(key);if(!secret(expectedClientId))fail();const b=binding(trustedBinding),e=clone(envelope);
 exact(e,'schema binding encryptedCredentials');
 if(e.schema!==SCHEMA||parcel2GoCanonicalJson(binding(e.binding))!==parcel2GoCanonicalJson(b)||typeof e.encryptedCredentials!=='string'||e.encryptedCredentials.length>32768)fail();
 let data;try{data=clone(decryptCredentials(e.encryptedCredentials,key));}catch{fail();}
 exact(data,'schema binding credentials');if(data.schema!==SCHEMA||parcel2GoCanonicalJson(binding(data.binding))!==parcel2GoCanonicalJson(b))fail();
 const v=value(data.credentials);if(v.clientId!==expectedClientId)fail();return v;
}
