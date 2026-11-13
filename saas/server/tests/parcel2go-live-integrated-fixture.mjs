import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fixture as base,KEY,CLIENT,SECRET_VALUE,TOKEN,quoteBody} from './parcel2go-sandbox-fixture.mjs';
import {createParcel2GoLiveAdmission as runner,createParcel2GoLiveCredentialAdmission as admit} from '../lib/parcel2go-live-admission.mjs';
import {prepareParcel2GoLiveQuotePlan} from '../lib/parcel2go-live-quote-plan.mjs';
import {parcel2GoCanonicalHash} from '../lib/parcel2go-live-canonical.mjs';
const W='packsmart-solutions';
export async function fixture(handler,intercept){
 const f=base({intercept}),t=f.getTime(),binding={workspaceId:W,connectionId:'fixture-live',accountId:'fixture-account',environment:'live'};let mono=0;
 const common={expectedSessionFingerprint:parcel2GoCanonicalHash(f.session),store:f.store,trustedBinding:binding,expectedClientId:CLIENT,termsReference:'fixture-terms',key:KEY,expiresAt:new Date(t+300000).toISOString(),now:()=>f.getTime(),monotonic:()=>mono,assertCurrent:()=>{}};
 await admit({...common,mode:'offline-credential-admission/v1',requestId:randomUUID(),expectedRevision:f.state._revision}).run({session:f.session,csrf:f.session.csrf,credentials:{clientId:CLIENT,clientSecret:SECRET_VALUE}});f.calls.length=0;
 const input={operation:'quote',account:{workspaceId:W,accountId:binding.accountId,environment:'live',currency:'GBP',collectionVatStatus:'NotRegistered',deliveryVatStatus:'Individual',verifiedAt:new Date(t).toISOString()},parcel:{evidenceId:'fixture-parcel',provenance:'owner_authorised_estimate',observedAt:new Date(t).toISOString(),weightGrams:'5000',lengthMm:'450',widthMm:'300',heightMm:'250',declaredValueDecimal:'15.15'},route:{collectionCountry:'GBR',deliveryCountry:'GBR',collectionPostcode:'SW1A 1AA',deliveryPostcode:'M1 1AE'}};
 const network=[];const mockRequest=(url,options,cb)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{network.push({url:String(url),options,body});queueMicrotask(()=>{const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'application/json'};res.complete=true;
 let data=url.pathname.endsWith('/token')?{access_token:TOKEN,token_type:'Bearer',scope:'public-api',expires_in:3600}:quoteBody();if(handler)data=handler(data,url,f);cb(res);if(!res.destroyed)res.end(typeof data==='string'?data:JSON.stringify(data));});};return req;};
 const receipt=f.fake.states.get(W).parcel2goLiveQuoteRuns.at(-1);
 const config={...common,credentialAdmissionRequestId:receipt.requestId,expectedCredentialReceiptHash:parcel2GoCanonicalHash(receipt),mode:'offline-integrated/v1',mockRequest,requestId:randomUUID(),expectedRevision:f.fake.states.get(W)._revision,inputFingerprint:prepareParcel2GoLiveQuotePlan(input,t).fingerprint};
 const args={session:f.session,csrf:f.session.csrf,input};const make=extra=>runner({...config,...extra}),r=make();return {...f,network,args,config,make,run:()=>r.run(args),setMono:v=>mono=v};
}
