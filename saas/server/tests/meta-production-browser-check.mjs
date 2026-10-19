// Real-browser layout qualification of the existing production-review UI.
// Only synthetic read DTOs are intercepted. Every browser mutation and external
// network request is refused; this cannot qualify hosted/provider execution.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
import {createPacksmartServer} from '../server.mjs';
import {createSessionToken} from '../lib/security.mjs';
import {publicationFixture} from './marketing-publication-fixture.mjs';
import {jpegFixture} from './marketing-local-jpeg-fixture.mjs';

assert.ok(process.env.RUNVARA_BROWSER_EVIDENCE_DIR, 'Set a fresh browser evidence directory');
const output=path.resolve(process.env.RUNVARA_BROWSER_EVIDENCE_DIR);
await fs.mkdir(output); // Do not replace an earlier run.
const cleanups=[],f=await publicationFixture({after:fn=>cleanups.push(fn)}),bytes=jpegFixture();
const secret='synthetic-browser-session-no-production-credential';
const imageHash=createHash('sha256').update(bytes).digest('hex');
const caption='Synthetic customer review. Keep this exact caption visible.\n'+
  'https://example.test/'+ 'review-caption-'.repeat(18)+'\nSecond line: <b>literal caption text</b>.';
const requestId='production-browser-reference-0001';
const saved={campaignId:f.campaignId,requestId,status:'pending',enabled:true,expiresAt:Date.now()+3600000,
  consent:{postCount:1,caption,imageSha256:imageHash,byteLength:bytes.length,sourceRevision:'a'.repeat(64),
    target:{pageId:'202123456789012345',instagramId:'303123456789012345',account:'101123456789012345'}},
  retained:{phase:'not_started',canContinue:true}};
let providerCalls=0,browser,server,reviewBaseline;
const report={schema:'runvara-production-dialog-browser/v1',syntheticOnly:true,hostedAcceptance:false,
  cases:[],pageErrors:[],unexpectedNetwork:[],refusedMutations:[],calls:[],screenshots:[],failures:[]};
const requireCheck=(condition,message)=>{if(!condition)report.failures.push(message);};
try {
  const before=await f.get();
  server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,APP_PUBLIC_URL:'http://127.0.0.1'},
    {store:f.store,schedulerEnabled:false,agentOpsEnabled:false,fetchImpl:async()=>{providerCalls++;throw Error('Provider transport forbidden');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.RUNVARA_BROWSER_EXECUTABLE?{executablePath:process.env.RUNVARA_BROWSER_EXECUTABLE}:{}),
    env:Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','COMSPEC'].flatMap(k=>process.env[k]?[[k,process.env[k]]]:[]))});
  report.browserVersion=browser.version();
  const cases=[...[320,390,1440].flatMap(width=>[100,200].map(textScale=>({width,textScale,mode:'pending'}))),
    ...[320,1440].flatMap(width=>[100,200].map(textScale=>({width,textScale,mode:'form'}))),
    {width:320,textScale:200,mode:'approved'},
    {width:320,textScale:200,mode:'closed'},{width:390,textScale:200,mode:'unresolved'}];
  for(const scenario of cases){
    const {width,textScale,mode}=scenario,label=`${mode}-${width}-${textScale}`;
    const context=await browser.newContext({viewport:{width,height:900}});
    try {
      const token=createSessionToken({...f.session,email:before.users[0].email,role:'owner'},secret);
      await context.addCookies([{name:'packsmart_session',value:token,url:base,httpOnly:true,sameSite:'Strict'}]);
      await context.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url());
        if(request.method()!=='GET'){report.refusedMutations.push({case:label,method:request.method(),path:url.pathname});return route.abort();}
        if(url.origin!==base){
          if(url.hostname==='example.test'&&request.resourceType()==='image')return route.fulfill({contentType:'image/jpeg',body:bytes});
          report.unexpectedNetwork.push({case:label,origin:url.origin,type:request.resourceType()});return route.abort();
        }
        if(!url.pathname.startsWith('/api/meta-production/'))return route.continue();
        report.calls.push({case:label,method:request.method(),path:url.pathname});
        const prefix='/api/meta-production/campaigns/'+encodeURIComponent(f.campaignId);
        if(url.pathname===prefix+'/context')return route.fulfill({json:{enabled:true,notice:'Synthetic local layout fixture',
          pages:[{pageId:saved.consent.target.pageId,instagramId:saved.consent.target.instagramId}],
          assets:[{creativeRequestId:'creative-browser-'+ 'identifier'.repeat(8),assetUrl:'https://example.test/'+ 'retained-image-'.repeat(15)+'.jpg'}]}});
        const row=structuredClone(saved);
        if(mode==='approved')row.status='approved';
        if(mode==='closed')row.enabled=false;
        if(mode==='unresolved'){row.status='approved';row.retained={phase:'publication_id_unresolved',canContinue:false,resultId:null};}
        if(url.pathname===prefix+'/requests/'+requestId)return route.fulfill({json:row});
        if(url.pathname===prefix+'/requests/'+requestId+'/image')return route.fulfill({json:{mediaType:'image/jpeg',sha256:imageHash,bytesBase64:bytes.toString('base64')}});
        throw Error('Unexpected production read: '+url.pathname);
      });
      const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.pageErrors.push({case:label,message:e.message}));
      await page.goto(base);await page.locator('#app-shell:not(.hidden)').waitFor();
      if(await page.locator('#mobile-menu').isVisible())await page.locator('#mobile-menu').click();
      await page.locator('#main-nav [data-view="marketing"]').click();
      const trigger=page.locator('[data-meta-production-open]').first();await trigger.waitFor();
      if(!reviewBaseline){
        reviewBaseline=await f.get();
        report.initialBootstrap={changedKeys:Object.keys(reviewBaseline).filter(k=>JSON.stringify(reviewBaseline[k])!==JSON.stringify(before[k])),
          qualification:'Existing initial bootstrap control/brief preparation in disposable synthetic state; snapshot precedes all dialog interactions.'};
        const allowed=new Set(['_revision','audit','controlSignature','dailyBriefs','exceptions','opportunities']);
        assert.ok(report.initialBootstrap.changedKeys.every(k=>allowed.has(k)),'Unexpected initial bootstrap change');
      }
      if(mode!=='form')await page.evaluate(({workspaceId,userId,campaign,reference})=>sessionStorage.setItem(
        'runvara-meta-production-reference:'+JSON.stringify([workspaceId,userId,campaign]),reference),
        {workspaceId:f.workspaceId,userId:f.session.userId,campaign:f.campaignId,reference:requestId});
      await trigger.click();const dialog=page.locator('#meta-production-dialog[open]');await dialog.waitFor();
      if(mode==='form')await dialog.locator('form').waitFor();
      else {await dialog.locator('img').waitFor();await dialog.locator('img').evaluate(img=>img.decode());}
      // Double the computed text sizes, including px-sized caption controls;
      // do not use a browser screenshot scale or shrink the viewport to mimic it.
      if(textScale===200)await dialog.evaluate(root=>{
        const rows=[root,...root.querySelectorAll('*')].map(node=>({node,size:parseFloat(getComputedStyle(node).fontSize),line:parseFloat(getComputedStyle(node).lineHeight)}));
        for(const {node,size,line} of rows){node.style.fontSize=size*2+'px';if(Number.isFinite(line))node.style.lineHeight=line*2+'px';}
      });
      const geometry=await dialog.evaluate(root=>{
        const r=root.getBoundingClientRect(),style=getComputedStyle(root),left=r.left+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft),
          right=r.right-parseFloat(style.borderRightWidth)-parseFloat(style.paddingRight),textOverflow=[],rangeOverflow=[];
        const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
        while(walker.nextNode()){
          if(!walker.currentNode.textContent.trim()||walker.currentNode.parentElement.closest('option'))continue;
          const range=document.createRange();range.selectNodeContents(walker.currentNode);
          const rects=[...range.getClientRects()].filter(x=>x.width>0&&x.height>0);
          if(rects.some(x=>x.left<left-1||x.right>right+1)){
            const outside=[];let offset=0;
            for(const character of walker.currentNode.textContent){
              range.setStart(walker.currentNode,offset);range.setEnd(walker.currentNode,offset+character.length);offset+=character.length;
              const glyphs=[...range.getClientRects()].filter(x=>x.width>0&&x.height>0);
              if(glyphs.some(x=>x.left<left-1||x.right>right+1))outside.push({character,whitespace:/\s/u.test(character)});
            }
            rangeOverflow.push({text:walker.currentNode.textContent.slice(0,100),outside});
            // pre-wrap may hang trailing spaces past its line box. Preserve
            // them in exact text, but require every visible glyph to fit.
            if(outside.some(item=>!item.whitespace))textOverflow.push(walker.currentNode.textContent.slice(0,100));
          }
        }
        const img=root.querySelector('img'),image=img?{width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height,
          left:img.getBoundingClientRect().left,right:img.getBoundingClientRect().right,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight}:null;
        return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,clientWidth:root.clientWidth,scrollWidth:root.scrollWidth,
          contentLeft:left,contentRight:right,textOverflow,rangeOverflow,image,focusInside:root.contains(document.activeElement)};
      });
      const row={...scenario,geometry,controls:[]};report.cases.push(row);
      requireCheck(geometry.left>=-1&&geometry.right<=width+1,label+': dialog exceeds viewport');
      requireCheck(geometry.scrollWidth<=geometry.clientWidth+1,label+': horizontal dialog overflow');
      requireCheck(geometry.textOverflow.length===0,label+': exact review text exceeds content width');
      requireCheck(geometry.focusInside,label+': modal did not receive focus');
      if(mode!=='form'){
        requireCheck(await dialog.locator('pre').textContent()===caption,label+': exact caption changed');
        requireCheck(geometry.image.naturalWidth===1080&&geometry.image.naturalHeight===1080,label+': retained image did not decode');
        requireCheck(geometry.image.width>0&&Math.abs(geometry.image.width-geometry.image.height)<=1&&geometry.image.left>=geometry.contentLeft-1&&geometry.image.right<=geometry.contentRight+1,label+': image clipped or distorted');
        requireCheck(await dialog.locator('pre').isVisible(),label+': exact caption hidden');
        requireCheck(await dialog.locator('section').textContent().then(s=>[imageHash,saved.consent.sourceRevision,...Object.values(saved.consent.target)].every(value=>s.includes(value))),label+': exact review identifiers absent');
      }
      await page.screenshot({path:path.join(output,label+'-top.png'),animations:'disabled'});report.screenshots.push(label+'-top.png');
      if(mode!=='form'){
        await dialog.getByText('Image SHA-256:',{exact:false}).scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(output,label+'-identity.png'),animations:'disabled'});report.screenshots.push(label+'-identity.png');
      }
      for(const control of await dialog.locator('button,input,select').all()){
        await control.scrollIntoViewIfNeeded();
        const box=await control.boundingBox();
        const item={tag:await control.evaluate(e=>e.tagName),text:(await control.textContent())?.slice(0,80),box};row.controls.push(item);
        requireCheck(Boolean(box)&&box.x>=-1&&box.x+box.width<=width+1&&box.y>=-1&&box.y+box.height<=900+1,label+': control cannot be reached within viewport');
        const visible=await control.evaluate(element=>{
          const r=element.getBoundingClientRect(),d=element.closest('dialog').getBoundingClientRect();
          const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          return {inside:r.left>=d.left&&r.right<=d.right&&r.top>=d.top&&r.bottom<=d.bottom,hit:hit===element||element.contains(hit)};
        });
        requireCheck(visible.inside&&visible.hit,label+': control is clipped or obscured in dialog scrollport');
      }
      if(mode==='closed')requireCheck(await dialog.getByRole('button',{name:'Approve this exact proposal',exact:true}).count()===0,label+': closed mode offered approval');
      if(mode==='approved')requireCheck(await dialog.getByRole('button',{name:'Publish this exact one post',exact:true}).count()===1,label+': approved action missing');
      if(mode==='pending'&&width===320&&textScale===100){
        const consent=dialog.locator('[data-meta-production-consent]');await consent.focus();
        await page.keyboard.press('Space');requireCheck(await consent.isChecked(),label+': consent inaccessible by keyboard');
        await page.keyboard.press('Space');requireCheck(!await consent.isChecked(),label+': consent could not be cleared');
      }
      if(mode==='unresolved'){
        requireCheck(await dialog.getByRole('button',{name:/Publish this exact|Check readiness and publish/}).count()===0,label+': unresolved state offered execution');
        await dialog.getByRole('button',{name:'Read saved outcome without contacting Meta',exact:true}).click();
        await dialog.getByText('Meta reported a published container',{exact:false}).waitFor();
      }
      await page.screenshot({path:path.join(output,label+'-controls.png'),animations:'disabled'});report.screenshots.push(label+'-controls.png');
      if(mode==='form'&&width===1440&&textScale===100)await dialog.getByRole('button',{name:'Close',exact:true}).click();
      else await page.keyboard.press('Escape');
      await page.locator('#meta-production-dialog').waitFor({state:'hidden'});
      requireCheck(await trigger.evaluate(e=>document.activeElement===e),label+': focus did not return to opener');
      requireCheck(await page.locator('#meta-production-dialog').textContent()==='',label+': dismissed dialog retained private content');
      assert.deepEqual(await f.get(),reviewBaseline,'Dialog journey changed post-bootstrap synthetic workspace state');
    } finally {await context.close();}
  }
  assert.deepEqual(await f.get(),reviewBaseline,'Read-only browser qualification changed post-bootstrap synthetic workspace state');
  report.workspaceUnchangedAfterBootstrap=true;
} catch(error){report.failures.push(error.stack||error.message);}
finally {
  await browser?.close();
  if(server){await server.packsmart.drain();if(server.listening)await new Promise(resolve=>server.close(resolve));}
  for(const cleanup of cleanups.reverse())await cleanup();
}
report.providerCalls=providerCalls;
requireCheck(providerCalls===0,'Provider transport was called');requireCheck(report.pageErrors.length===0,'Browser page errors occurred');
requireCheck(report.unexpectedNetwork.length===0,'Unexpected external request attempted');requireCheck(report.refusedMutations.length===0,'Browser mutation attempted');
report.passed=report.failures.length===0;report.finishedAt=new Date().toISOString();
await fs.writeFile(path.join(output,'browser-result.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,screenshots:report.screenshots.length,failures:report.failures.map(s=>s.slice(0,350)),providerCalls}));
process.exitCode=report.passed?0:1;
