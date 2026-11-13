// Synthetic local browser acceptance. Outbound browser routes are blocked.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {fixture} from './parcel2go-live-integrated-fixture.mjs';
import {createParcel2GoLiveOwnerRoute,PARCEL2GO_LIVE_OFFLINE_PATH as PATH} from '../lib/parcel2go-live-owner-route.mjs';
const f=await fixture(),ui=await readFile(new URL('../../parcel2go-live-review-ui.js',import.meta.url),'utf8');let handler,origin,browser;
const server=createServer(async(req,res)=>{try{if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><meta charset="utf-8"><title>Runvara offline review</title><main id="review"></main><script src="/ui.js"></script><script>window.ready=(async()=>{const response=await fetch('+JSON.stringify(PATH)+');window.fixtureDescriptor=await response.json();window.review=RunvaraOfflineQuoteReview.create({csrf:'+JSON.stringify(f.session.csrf)+',request:async(p,o)=>{const r=await fetch(p,o);if(!r.ok)throw Error();return r.json();}});window.review.mount(document.getElementById("review"),fixtureDescriptor);})();</script>');return;}if(req.url==='/ui.js'){res.setHeader('content-type','text/javascript');res.end(ui);return;}const chunks=[];let bytes=0;for await(const part of req){bytes+=part.length;if(bytes>2048){res.writeHead(413);res.end();return;}chunks.push(part);}const request=new Request(origin+req.url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});const response=await handler.handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end('Fixture unavailable');}});
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 handler=createParcel2GoLiveOwnerRoute({mode:'offline-owner-route/v1',origin,config:f.config,input:f.args.input,now:f.config.now,authenticate:async()=>({session:f.session,state:structuredClone(f.fake.states.get('packsmart-solutions'))})});
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium'});const page=await browser.newPage();
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin);await page.evaluate(()=>window.ready);assert.equal(f.network.length,0);
 assert.match(await page.locator('#review').innerText(),/Synthetic fixture only/);
 assert.equal(await page.locator('#offline-quote-run').isDisabled(),true);
 await page.locator('#offline-quote-confirm').check();await page.locator('#offline-quote-run').click();
 await page.waitForFunction(()=>document.querySelector('#offline-quote-status').textContent.includes('receipt saved'));
 assert.equal(f.network.length,2);assert.match(await page.locator('#offline-quote-prices').innerText(),/GBP 12.66/);assert.equal(await page.locator('#offline-quote-run').isDisabled(),true);
 await page.screenshot({path:new URL('../../../offline-review-browser-20261112.png',import.meta.url).pathname,fullPage:true});
 await page.reload();await page.evaluate(()=>window.ready);assert.equal(await page.locator('#offline-quote-run').isDisabled(),true);assert.equal(f.network.length,2);assert.equal(await page.locator('#offline-quote-prices').innerText(),'');
 await page.evaluate(()=>{window.review.clear();window.simCalls=0;window.expiring=RunvaraOfflineQuoteReview.create({csrf:'synthetic',request:async()=>{window.simCalls++;}});window.expiring.mount(document.getElementById('review'),{...fixtureDescriptor,requestId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',remainingMs:15,canSubmit:true,outcome:'not_started'});});
 await page.waitForTimeout(50);assert.equal(await page.locator('#offline-quote-run').isDisabled(),true);assert.equal(await page.evaluate(()=>simCalls),0);
 await page.evaluate(()=>{window.expiring.clear();window.originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error('disabled storage');};window.blocked=RunvaraOfflineQuoteReview.create({csrf:'synthetic',request:async()=>{window.simCalls++;}});window.blocked.mount(document.getElementById('review'),{...fixtureDescriptor,requestId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',remainingMs:10000,canSubmit:true,outcome:'not_started'});});
 await page.locator('#offline-quote-confirm').check();await page.locator('#offline-quote-run').click();assert.match(await page.locator('#offline-quote-status').innerText(),/Nothing sent/);assert.equal(await page.evaluate(()=>simCalls),0);
 console.log(JSON.stringify({browser:'system Chromium',checks:['GET has no provider effects','explicit confirmation','one mocked token/quote pair','synthetic prices clearly labelled','no replay after reload','prices not persisted','expiry closes control','storage failure refuses submission'],result:'passed',realProviderCalls:0}));
}finally{handler?.close();await browser?.close();await new Promise(resolve=>server.close(resolve));}
