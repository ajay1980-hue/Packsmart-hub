// Entirely in-process HTTP/DOM acceptance fixture. No listener or real sockets.
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {JSDOM} from 'jsdom';
import {nativeHttpFixture} from './parcel2go-native-http-fixture.mjs';
import {fixture} from './parcel2go-live-integrated-fixture.mjs';
import {KEY} from './parcel2go-sandbox-fixture.mjs';
import {createSessionToken} from '../lib/security.mjs';
import {createCredentialOwnerAuth} from '../lib/parcel2go-credential-owner-auth.mjs';
import {createParcel2GoOwnerQuoteSurface,PARCEL2GO_OWNER_QUOTE_PAGE,PARCEL2GO_OWNER_QUOTE_SCRIPT} from '../lib/parcel2go-owner-quote-surface.mjs';
import {PARCEL2GO_RECORDED_REVIEW_PATH} from '../lib/parcel2go-recorded-owner-review.mjs';
export const ORIGIN='https://synthetic-owner-surface.example.test';
export const flush=async check=>{for(let i=0;i<150;i++){if(check())return;await new Promise(r=>setImmediate(r));}assert.fail('Synthetic UI did not settle');};
export async function surfaceFixture(t,responseFor=()=>({})){
 t.mock.method(Date,'now',()=>Date.parse('2026-11-16T12:00:00.000Z'));
 let c;const network=nativeHttpFixture(t,operation=>responseFor(operation,c)),f=await fixture(),workspaceId=f.config.trustedBinding.workspaceId;
 const state=await f.store.get(workspaceId,{exactSnapshot:true}),user=state.users[0];
 const token=createSessionToken({workspaceId,userId:user.id,email:user.email,role:'owner',csrf:f.session.csrf},KEY);
 const options={mode:'unmounted-owner-quote-surface/v1',store:f.store,sessionSecret:KEY,origin:ORIGIN,
  withWorkspaceLock:async(id,fn)=>{assert.equal(id,workspaceId);return fn();},admission:{...f.config,mode:'disabled/v1',mockRequest:undefined},
  requestId:f.config.requestId,expiresAt:f.config.expiresAt,now:f.getTime,monotonic:f.config.monotonic};
 const authenticate=createCredentialOwnerAuth({enabled:true,store:f.store,sessionSecret:KEY,now:f.getTime});
 c={f,network,workspaceId,state,options,requests:[],transform:null};
 c.api=PARCEL2GO_RECORDED_REVIEW_PATH+'?requestId='+options.requestId;c.page=PARCEL2GO_OWNER_QUOTE_PAGE+'?requestId='+options.requestId;c.script=PARCEL2GO_OWNER_QUOTE_SCRIPT;
 c.make=(extra={})=>{const surface=createParcel2GoOwnerQuoteSurface({...options,...extra});t.after(()=>surface.close());return surface;};c.surface=c.make();
 c.send=async(path,opts={},surface=c.surface)=>{
  const headers={cookie:`__Host-packsmart_session=${token}`,...Object.fromEntries(new Headers(opts.headers))};if(opts.method==='POST'&&headers.origin===undefined)headers.origin=ORIGIN;
  c.requests.push({path,opts});
  if(path==='/api/auth/session'){const a=await authenticate({headers,signal:opts.signal});return Response.json({csrf:a.session.csrf});}
  const req=opts.stream??Readable.from(opts.body===undefined?[]:[Buffer.from(opts.body)]);Object.assign(req,{url:path,method:opts.method??'GET',headers,aborted:false});
  let reads=0;const read=req.read.bind(req);req.read=(...args)=>{reads++;return read(...args);};
  const res=new EventEmitter();Object.assign(res,{destroyed:false,writableEnded:false});let status,body,responseHeaders;
  res.writeHead=(s,h)=>{status=s;responseHeaders=h;};res.end=b=>{body=b;res.writableEnded=true;};
  const cancel=()=>{req.aborted=true;req.emit('aborted');res.destroyed=true;res.emit('close');};
  opts.signal?.addEventListener('abort',cancel,{once:true});if(opts.signal?.aborted)cancel();
  try{await surface.handle(req,res);c.last={req,res,reads};if(body===undefined)throw Error('Synthetic request disconnected');
   const response=new Response(body,{status,headers:responseHeaders});return c.transform?await c.transform(path,opts,response):response;
  }finally{opts.signal?.removeEventListener('abort',cancel);req.destroy();}
 };
 c.boot=async({storage,surface=c.surface}={})=>{
  const page=await c.send(c.page,{},surface);assert.equal(page.status,200);
  const dom=new JSDOM(await page.text(),{url:ORIGIN+c.page,runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;
  w.structuredClone=structuredClone;w.fetch=(path,opts)=>c.send(path,opts,surface);if(storage)Object.defineProperty(w,'sessionStorage',{value:storage});
  const script=await c.send(c.script,{},surface);assert.equal(script.status,200);w.eval(await script.text());
  const root=w.document.querySelector('main'),ui={w,root,dom};c.ui=ui;return ui;
 };
 c.fill=ui=>{const values={collectionPostcode:'SW1A 1AA',deliveryPostcode:'M1 1AE',collectionVatStatus:'NotRegistered',deliveryVatStatus:'Individual',currency:'GBP',basis:'estimate',weightGrams:'5000',lengthMm:'450',widthMm:'300',heightMm:'250',declaredValueDecimal:'15.15'};
  for(const [name,value] of Object.entries(values))ui.root.querySelector(`[name="${name}"]`).value=value;
  ui.root.querySelector('[name="acknowledgedUnverified"]').checked=true;ui.root.querySelector('form').dispatchEvent(new ui.w.Event('input'));
 };
 c.click=(ui,text)=>{const button=[...ui.root.querySelectorAll('button')].find(x=>x.textContent===text);assert.ok(button,'Missing button '+text);button.click();};
 c.check=(ui,name)=>{const input=ui.root.querySelector(`[name="${name}"]`);assert.ok(input);input.checked=true;input.dispatchEvent(new ui.w.Event('change'));};
 c.prepare=async ui=>{await flush(()=>!!ui.root.querySelector('form'));c.fill(ui);c.click(ui,'Prepare exact review');await flush(()=>!!ui.root.querySelector('[name="reviewed"]'));};
 c.approve=async ui=>{await c.prepare(ui);c.check(ui,'reviewed');c.click(ui,'Approve exact review');await flush(()=>!!ui.root.querySelector('[name="sendConfirmed"]'));};
 f.calls.length=0;return c;
}
