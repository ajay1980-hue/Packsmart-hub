import { createStore,withLocalFileState } from '../lib/store.mjs';
const [file,workspaceId,mode]=process.argv.slice(2);
if(!process.send||!file||!workspaceId||!['hold','write'].includes(mode))throw Error('Use isolated local-state test runner');
const store=createStore({SAAS_STATE_FILE:file});
const timeout=setTimeout(()=>{process.exitCode=1;process.disconnect();},10000);
try {
  if(mode==='hold')await withLocalFileState(store,workspaceId,async()=>{
    process.send({event:'locked'});await new Promise(resolve=>process.once('message',message=>{if(message==='release')resolve();}));
  });
  else {const state=await store.get(workspaceId);state.users[0].disabled=true;process.send({event:'writing'});await store.save(workspaceId,state);}
  process.send({event:'done'});
} finally {clearTimeout(timeout);process.disconnect();}
