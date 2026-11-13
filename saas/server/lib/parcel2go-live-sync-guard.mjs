// Trusted revocation hooks use a synchronous void-or-throw contract.
// A promise must never be mistaken for successful admission or left unhandled.
export function assertParcel2GoSynchronousCurrent(callback){
 const result=callback();
 if(result!==undefined){
  Promise.resolve(result).catch(()=>{});
  throw new Error('Parcel2Go current-state assertion must return synchronously without a value.');
 }
}
