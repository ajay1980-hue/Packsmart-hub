// Responsive browser fixture uses the release HTML, CSS and UI module unchanged.
// Run with: node tests/render-connection-preview.mjs /absolute/output.html
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { publicConnectionWrite } from '../lib/action-display.mjs';
import { intelligentConnections } from '../lib/connection-intelligence.mjs';
import { onboardingJourney } from '../lib/onboarding.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

export function connectionPreviewFixture({ compatibility = false } = {}) {
const state = seedWorkspaceState({}, { workspaceId: 'visual-fixture', name: 'Runvara layout preview', email: 'preview@example.test', passwordHash: 'fixture' });
state.connections = [{id:'visual-shopify',provider:'shopify',encryptedCredentials:'fixture-not-a-credential',status:'connected',metadata:{shopDomain:'example.myshopify.com'}},{id:'visual-ebay',provider:'ebay',encryptedCredentials:'fixture-not-a-credential',status:'connected',metadata:{account:'Example seller'}}];
state.integrationStatus = { shopify:{status:'connected',lastSyncAt:'2026-09-21T10:00:00Z'},ebay:{status:'connected',lastSyncAt:'2026-09-21T09:30:00Z'} };
state.ebay = {source:'ebay-oauth-readonly',coverage:{fullCatalogueAvailable:false}};
state.products = Array.from({length:4},(_,index)=>({id:`gid://shopify/Product/${index+1}`,provider:'shopify',title:`Example product ${index+1}`,variants:[{id:'v'+index}]}));
state.connectionSyncs = [{id:'fixture-sync',provider:'shopify',areas:['products','variants','inventory','prices','orders'],status:'completed',startedAt:'2026-09-21T10:00:00Z',completedAt:'2026-09-21T10:00:03Z'}];
const service = new IntegrationService({});
state.onboardingJourney={platforms:['shopify','tiktok_shop'],permissionReviews:{shopify:0}};
state.connectionFirstSync={shopify:{status:'partial',identityVerifiedAt:'2026-09-21T10:00:00Z',startedAt:'2026-09-21T10:00:00Z',completedAt:'2026-09-21T10:00:03Z',areas:{products:'completed',variants:'completed',inventory:'completed',orders:'failed'},failures:{orders:{code:'UPSTREAM_REQUEST_FAILED'}},validation:{ok:true,counts:{products:4,variants:4,orders:0}}}};
if (compatibility) {
  state.connectionFirstSync = {};
  state.connectionSettings = {
    shopify: { areas: ['products'], autoSync: false, permissionMode: 'approval_gated', revision: 1 },
    ebay: { areas: ['orders'], autoSync: false, permissionMode: 'read_only', revision: 1 }
  };
  state.connections[0].metadata.grantedScopes = ['read_products', 'write_products'];
  state.connectionDoctor = { ebay: { pendingReadAttempts: [{ id: 'retained-future-read', privateFuture: 'private-fixture-canary' }] } };
  state.integrationStatus.ebay.retryAt = '2099-01-01T00:00:00.000Z';
  state.connectionSyncs.unshift({ id: 'fixture-held-read', provider: 'ebay', areas: ['orders'], automatic: true, status: 'deferred', startedAt: '2026-10-01T10:00:00Z', completedAt: '2026-10-01T10:00:01Z', errorCode: null, deferredReason: 'READ_COMPATIBILITY_DEFERRED' });
  state.connectionWrites = [
    { id: 'write_future', provider: 'ebay', status: 'ready', input: { operation: 'future_listing_update', privateFuture: 'private-fixture-canary' } },
    { id: 'write_legacy', provider: 'shopify', status: 'ready', approvalId: 'approval_legacy', requiresApproval: true, input: { operation: 'product_content', productId: 'gid://shopify/Product/1', title: 'Exact reviewed title', description: 'Keep this exact description.\nSecond line retained.' }, privateFuture: 'private-fixture-canary' }
  ];
}
const payload = {workspace:{id:state.workspace.id,name:state.workspace.name},launchAdmin:false,user:{id:'fixture-owner',role:'owner'},products:state.products,onboarding:{journey:onboardingJourney(state)},autopilot:{enabled:true},connectionWrites:(state.connectionWrites || []).map(publicConnectionWrite),connectionCentre:intelligentConnections(state,service,{now:new Date('2026-10-01T11:00:00Z')})};
return { state, service, payload };
}

export async function renderConnectionPreview(options = {}) {
const { payload } = connectionPreviewFixture(options);
const html = await fs.readFile(new URL('../../index.html',import.meta.url),'utf8');
const favicon = (await fs.readFile(new URL('../../favicon.svg',import.meta.url))).toString('base64');
const css = await fs.readFile(new URL('../../styles.css',import.meta.url),'utf8');
const js = await fs.readFile(new URL('../../presentation.js',import.meta.url),'utf8') + '\n' + await fs.readFile(new URL('../../connections-ui.js',import.meta.url),'utf8');
const setup = `const fixture=${JSON.stringify(payload).replaceAll('<','\\u003c')};
window.fixtureRequests=[];window.fixtureViews=[];
document.getElementById('loading-screen').classList.add('hidden');document.getElementById('login-screen').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
document.querySelectorAll('.view').forEach(el=>el.classList.toggle('active',el.id==='view-channels'));
document.getElementById('page-title').textContent='Connection Centre';document.getElementById('advanced-channel-connections').classList.add('hidden');
const escapeHtml=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
RunvaraConnections.init({escapeHtml,date:value=>new Date(value).toLocaleString('en-GB',{timeZone:'UTC'}),notify:message=>{document.getElementById('global-success').textContent=message;document.getElementById('global-success').classList.remove('hidden');},setView:view=>window.fixtureViews.push(view),reload:async()=>{},request:async(url,options={})=>{window.fixtureRequests.push({url,method:options.method||'GET',body:options.body});if(url==='/api/connection-centre')return {channels:fixture.connectionCentre,writes:fixture.connectionWrites,autopilotEnabled:true};throw new Error('Unexpected synthetic fixture request: '+url);}});RunvaraConnections.render(fixture);`;
const frame = html.replaceAll(/(?:src|href)="\/favicon\.svg[^"]*"/g, match=>match.slice(0,match.indexOf('=')+1)+'"data:image/svg+xml;base64,'+favicon+'"').replace(/<link[^>]+href="\/styles.css[^>]+>/,'<style>'+css+'</style>').replace(/<script src="[^"\n]+"><\/script>/g,'')
  .replace('</body>','<script>'+js.replaceAll('</script','<\\/script')+'</script><script>'+setup+'</script></body>');
return frame;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const frame = await renderConnectionPreview({compatibility:process.argv.includes('--compatibility')});
const output = process.argv[2]; if(!output)throw new Error('An absolute output path is required.');
await fs.writeFile(output, `<!doctype html><html><head><meta charset="utf-8"><title>Runvara responsive verification</title><style>body{margin:0;background:#eee;color:#111;font:14px system-ui}header{padding:12px;display:flex;gap:12px;align-items:center}button{padding:10px}iframe{display:block;margin:0 auto;border:0;height:900px;background:#08080a;width:390px;max-width:100%}</style></head><body><header><b>Visual QA fixture — no production data</b><button data-width="320">320px</button><button data-width="390">390px mobile</button><button data-width="768">768px tablet</button><button data-width="1200">1200px desktop</button><span id="size">390px</span></header><iframe id="preview" title="Runvara preview"></iframe><script>const frame=document.getElementById('preview');frame.srcdoc=${JSON.stringify(frame).replaceAll('<','\\u003c')};document.querySelectorAll('[data-width]').forEach(button=>button.onclick=()=>{frame.style.width=button.dataset.width+'px';document.getElementById('size').textContent=button.dataset.width+'px';});</script></body></html>`);
console.log(output);

}
