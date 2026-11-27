// CI-only adapter. The sealed browser fixture is imported unchanged afterward.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from '/app/saas/server/node_modules/playwright/index.mjs';
const original=chromium.launch.bind(chromium);
const forbidden=argument=>/^--(?:no-sandbox|disable-setuid-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox|single-process)(?:=|$)/.test(argument);
let launches=0;
Object.defineProperty(chromium,'launch',{configurable:false,writable:false,value:async(options={})=>{
  assert.equal(++launches,1,'one reviewed browser launch only');
  assert.ok(options.chromiumSandbox===undefined||options.chromiumSandbox===true,'sandbox opt-out refused');
  assert.equal(options.ignoreDefaultArgs,undefined,'default-argument override refused');
  assert.ok(!(options.args||[]).some(forbidden),'sandbox-disabling argument refused');
  const browser=await original({...options,args:[...(options.args||[]),'--enable-automation'],chromiumSandbox:true});
  try{
    const cdp=await browser.newBrowserCDPSession();
    const result=await cdp.send('Browser.getBrowserCommandLine');await cdp.detach();
    assert.ok(Array.isArray(result.arguments)&&result.arguments.length>0,'browser command-line proof unavailable');
    assert.ok(!result.arguments.some(forbidden),'launched browser disabled sandbox');
    await fs.writeFile('/evidence/chromium-sandbox.json',JSON.stringify({launches,chromiumSandbox:true,commandLineVerified:true,disablingSwitches:0,fallback:false},null,2),{flag:'wx'});
    return browser;
  }catch(error){await browser.close();throw error;}
}});
for(const name of ['launchPersistentContext','launchServer','connect','connectOverCDP'])Object.defineProperty(chromium,name,{configurable:false,writable:false,value:()=>{throw Error('Unreviewed browser launch/connection refused');}});
