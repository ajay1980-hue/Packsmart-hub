import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(pathToFileURL(process.argv[2] || '/tmp/runvara-mobile-preview.html').href);
 const frame=page.frameLocator('#preview');
 for(const width of [320,390,768,1200]){
  await page.setViewportSize({width:Math.max(width+40,600),height:1000});
  await page.locator(`[data-width="${width}"]`).click();
  await frame.locator('#connection-journey').waitFor();
  if(await frame.locator('#connection-journey > details').getAttribute('open')===null) await frame.locator('#connection-journey > details > summary').click();
  const layout=await frame.locator('body').evaluate(el=>({scroll:el.ownerDocument.documentElement.scrollWidth,width:el.ownerDocument.documentElement.clientWidth}));
  if(layout.scroll>layout.width+1)throw new Error(`Page overflows at ${width}: ${JSON.stringify(layout)}`);
  await frame.locator('[data-channel-card="tiktok_shop"] .connection-title').click();
  const dialog=await frame.locator('#connection-dialog').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,viewport:el.ownerDocument.documentElement.clientWidth}));
  if(dialog.scroll>dialog.width+1||dialog.left<0||dialog.right>dialog.viewport+1)throw new Error(`Dialog overflows at ${width}: ${JSON.stringify(dialog)}`);
  await frame.locator('#connection-close').click();
  console.log(JSON.stringify({viewport:width,page:layout,dialog}));
  if(width===390){await frame.locator('body').evaluate(el=>el.getBoundingClientRect().width);await page.locator('#preview').screenshot({path:'/tmp/runvara-onboarding-mobile.png'});}
 }
 if(errors.length)throw new Error(errors.join('\n'));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
