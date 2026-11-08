// Stable Swagger v1 capture 2026-11-08; intentionally conservative subset.
// No URLs from caller/provider, HTML, service guarantees or purchase actions.
import { prepareParcel2GoQuote } from './parcel2go-quote-foundation.mjs';
import { metaStrictJson } from './meta-publication-bounded.mjs';
const fail = () => { throw Object.assign(new Error('Parcel2Go quote evidence invalid.'), {code:'PARCEL2GO_QUOTE_INVALID'}); };
const decimal = n => `${Math.floor(n / 100)}.${String(n % 100).padStart(2,'0')}`;
function pence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value,-0)
    || !/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/.test(String(value))) fail();
  const [whole,fraction=''] = String(value).split('.');
  return Number(whole)*100+Number(fraction.padEnd(2,'0'));
}
// grams to kg and millimetres to cm, exactly two decimal places, no rounding.
function convert(value, divisor) {
  const [whole,fraction=''] = value.split('.');
  const milli = BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0'));
  const denominator = BigInt(divisor)*10n;
  if (milli % denominator !== 0n) fail();
  return Number(milli / denominator)/100;
}
export function parcel2GoQuoteRequest(input, binding, now, tax) {
  if(!tax||tax.accountCurrency!=='GBP'||!['Individual','NotRegistered','Registered'].includes(tax.collectionVatStatus)
    ||!['Individual','NotRegistered','Registered'].includes(tax.deliveryVatStatus))fail();
  const prepared=prepareParcel2GoQuote(input,binding,now,{syntheticOnly:tax.mode==='sandbox-quote/v1'}), p=prepared.parcel;
  return {prepared, body:{CollectionAddress:{Country:'GBR',VatStatus:tax.collectionVatStatus},DeliveryAddress:{Country:'GBR',VatStatus:tax.deliveryVatStatus},Parcels:[{
    Weight:convert(p.weightGrams,1000),Length:convert(p.lengthMm,10),Width:convert(p.widthMm,10),Height:convert(p.heightMm,10),
    Value:Number(p.declaredValueDecimal)}]}};
}
export function parcel2GoQuoteResponse(bytes, {observedAt, requestId,responseSource='fixture'}) {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength>262144||!['fixture','sandbox-http'].includes(responseSource)) fail();
    // Duplicate keys (including escaped aliases), malformed UTF-8 and depth fail.
    metaStrictJson(bytes);
    // Node 22 source-aware reviver preserves the original numeric spelling.
    // Reject lossy decimal/exponent money before a rounded Number can pass.
    const root=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes),(key,value,context)=>{
      if(['TotalPrice','TotalPriceExVat','TotalVat'].includes(key)
        &&(typeof value!=='number'||!/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,2})?$/.test(context?.source||'')))fail();
      return value;
    });
    if (!root || !Array.isArray(root.Quotes) || root.Quotes.length>50
      || typeof observedAt!=='string' || new Date(observedAt).toISOString()!==observedAt) fail();
    const seen=new Set();
    const quotes=root.Quotes.map(q=>{
      const code=q?.Service?.Slug;
      if(typeof code!=='string'||!/^[a-z0-9][a-z0-9-]{0,79}$/.test(code)||seen.has(code)||q.CurrencyCode!=='GBP')fail();
      seen.add(code);
      const total=pence(q.TotalPrice),net=pence(q.TotalPriceExVat),vat=pence(q.TotalVat);
      if(net+vat!==total)fail();
      return Object.freeze({serviceCode:code,totalDecimal:decimal(total),netDecimal:decimal(net),vatDecimal:decimal(vat),currency:q.CurrencyCode,
        currencySource:'Quote.CurrencyCode',amountSource:'Quote.TotalPrice',tax:'included',quoteExpiresAt:null,
        priceGuaranteed:false,deliveryGuaranteed:false,purchaseAllowed:false});
    });
    return Object.freeze({schema:'runvara-parcel2go-sandbox-quote/v1',requestId,observedAt,quotes:Object.freeze(quotes),
      synthetic:responseSource==='fixture',responseSource,syntheticParcel:responseSource==='sandbox-http',accountVerified:false,liveReady:false,quoteValidity:'unknown',purchaseAllowed:false});
  } catch {fail();}
}
