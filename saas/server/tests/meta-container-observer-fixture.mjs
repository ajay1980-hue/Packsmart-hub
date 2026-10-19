import {observationFixture} from './meta-publication-observation-fixture.mjs';
import {createMetaContainerObserverMock,previewMetaContainerObserver,runMetaContainerObserver} from '../lib/meta-container-observer.mjs';
import {randomUUID} from 'node:crypto';
export async function containerObserverFixture(t,options={}) {
  const f=await observationFixture(t,options),calls=[];let time=Date.now();
  const controls={respond:null};
  const fetchImpl=async(address,settings)=>{calls.push({address,settings});return controls.respond?controls.respond(address,settings):
    new Response(JSON.stringify({id:f.anchor.containerId,status_code:'PUBLISHED'}),{headers:{'Content-Type':'application/json'}});};
  const capability=createMetaContainerObserverMock({store:f.store,receiptStore:f.observationStore,fetchImpl,environment:'test',now:()=>time,timeoutMs:options.timeoutMs??1000});
  const preview=()=>previewMetaContainerObserver(capability,f.writeId,f.session);
  const run=async(input,cap=capability)=>runMetaContainerObserver(cap,f.writeId,f.session,input??{requestId:randomUUID(),selection:(await preview()).selection});
  return {...f,calls,controls,fetchImpl,capability,preview,run,advance:ms=>{time+=ms;},now:()=>time,
    input:async()=>({requestId:randomUUID(),selection:(await preview()).selection})};
}
