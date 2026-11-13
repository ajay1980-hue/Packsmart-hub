// Pure fixed-schema mapper. Internal bounds are not verified carrier limits.
import {prepareParcel2GoLiveQuotePlan} from './parcel2go-live-quote-plan.mjs';
const fail=()=>{throw Object.assign(new Error('Parcel2Go quote units cannot be represented exactly.'),{code:'PARCEL2GO_LIVE_WIRE_INVALID'});};
function units(value,divisor){const [whole,fraction='']=value.split('.');const milli=BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));const denominator=BigInt(divisor)*10n;if(milli%denominator!==0n)fail();const result=Number(milli/denominator)/100;if(result<0.01||result>1000)fail();return result;}
export function parcel2GoLiveWireBody(input,now=Date.now()){
 const plan=prepareParcel2GoLiveQuotePlan(input,now),{account:a,route:r,parcel:p}=plan;
 const address=(country,postcode,vat)=>({Country:country,VatStatus:vat,Postcode:postcode});
 const body={CollectionAddress:address(r.collectionCountry,r.collectionPostcode,a.collectionVatStatus),DeliveryAddress:address(r.deliveryCountry,r.deliveryPostcode,a.deliveryVatStatus),Parcels:[{Weight:units(p.weightGrams,1000),Length:units(p.lengthMm,10),Width:units(p.widthMm,10),Height:units(p.heightMm,10),Value:Number(p.declaredValueDecimal)}]};
 return Object.freeze({plan,body:JSON.stringify(body)});
}
