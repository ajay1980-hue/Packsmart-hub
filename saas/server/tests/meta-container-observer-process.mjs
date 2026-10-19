import fs from 'node:fs/promises';
import {createStore} from '../lib/store.mjs';
import {readProtectedMetaReceipt,META_RECEIPT_CONTRACT} from '../lib/meta-publication-receipt.mjs';
import {createMetaContainerObserverMock,runMetaContainerObserver} from '../lib/meta-container-observer.mjs';
const f=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const store=createStore({SAAS_STATE_FILE:f.stateFile});
const receiptStore={readProtectedMetaPublication:(workspace,write,session)=>readProtectedMetaReceipt(async()=>({contract:META_RECEIPT_CONTRACT,workspaceId:workspace,writeId:write,events:f.events,simulated:true,executedExternally:false}),workspace,write,session)};
const capability=createMetaContainerObserverMock({store,receiptStore,environment:'test',now:()=>f.now,
 fetchImpl:async()=>{await fs.appendFile(f.calls,'mock GET\n');return new Response(JSON.stringify({id:f.containerId,status_code:'PUBLISHED'}),{headers:{'Content-Type':'application/json'}});}});
process.send('ready');await new Promise(resolve=>process.once('message',resolve));
try{const result=await runMetaContainerObserver(capability,f.writeId,f.session,f.input);process.send({result});}
catch(error){process.send({error:error.code});process.exitCode=1;}
process.disconnect();
