// Responsive browser fixture uses the release HTML, CSS and UI module unchanged.
// Run with: node tests/render-connection-preview.mjs /absolute/output.html
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { connectionCentre } from '../lib/connection-centre.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const state = seedWorkspaceState({}, { workspaceId: 'visual-fixture', name: 'Runvara layout preview', email: 'preview@example.test', passwordHash: 'fixture' });
state.connections = [{id:'visual-shopify',provider:'shopify',encryptedCredentials:'fixture-not-a-credential',status:'connected',metadata:{shopDomain:'example.myshopify.com'}},{id:'visual-ebay',provider:'ebay',encryptedCredentials:'fixture-not-a-credential',status:'connected',metadata:{account:'Example seller'}}];
state.integrationStatus = { shopify:{status:'connected',lastSyncAt:'2026-09-21T10:00:00Z'},ebay:{status:'connected',lastSyncAt:'2026-09-21T09:30:00Z'} };
state.ebay = {source:'ebay-oauth-readonly',coverage:{fullCatalogueAvailable:false}};
state.products = Array.from({length:4},(_,index)=>({id:`gid://shopify/Product/${index+1}`,provider:'shopify',title:`Example product ${index+1}`,variants:[{id:'v'+index}]}));
state.connectionSyncs = [{id:'fixture-sync',provider:'shopify',areas:['products','variants','inventory','prices','orders'],status:'completed',startedAt:'2026-09-21T10:00:00Z',completedAt:'2026-09-21T10:00:03Z'}];
const service = new IntegrationService({});
const payload = {user:state.users[0],products:state.products,autopilot:{enabled:true},connectionWrites:[],connectionCentre:connectionCentre(state,service)};
const html = await fs.readFile(new URL('../../index.html',import.meta.url),'utf8');
const css = await fs.readFile(new URL('../../styles.css',import.meta.url),'utf8');
const js = await fs.readFile(new URL('../../presentation.js',import.meta.url),'utf8') + '\n' + await fs.readFile(new URL('../../connections-ui.js',import.meta.url),'utf8');
const setup = `const fixture=${JSON.stringify(payload)};
document.getElementById('login-screen').classList.add('hidden');document.getElementById('app-shell').classList.remove('hidden');
document.querySelectorAll('.view').forEach(el=>el.classList.toggle('active',el.id==='view-channels'));
document.getElementById('page-title').textContent='Connection Centre';
const escapeHtml=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
RunvaraConnections.init({escapeHtml,date:value=>new Date(value).toLocaleString('en-GB'),notify:message=>{document.getElementById('global-success').textContent=message;document.getElementById('global-success').classList.remove('hidden');},setView:()=>{},reload:async()=>{},request:async()=>({channels:fixture.connectionCentre,writes:[],autopilotEnabled:true})});RunvaraConnections.render(fixture);`;
const frame = html.replace(/<link[^>]+href="\/styles.css[^>]+>/,'<style>'+css+'</style>').replace(/<script src="[^"\n]+"><\/script>/g,'')
  .replace('</body>','<script>'+js.replaceAll('</script','<\\/script')+'</script><script>'+setup+'</script></body>');
const output = process.argv[2]; if(!output)throw new Error('An absolute output path is required.');
await fs.writeFile(output, `<!doctype html><html><head><meta charset="utf-8"><title>Runvara responsive verification</title><style>body{margin:0;background:#eee;color:#111;font:14px system-ui}header{padding:12px;display:flex;gap:12px;align-items:center}button{padding:10px}iframe{display:block;margin:0 auto;border:0;height:900px;background:#08080a;width:390px;max-width:100%}</style></head><body><header><b>Visual QA fixture — no production data</b><button data-width="320">320px</button><button data-width="390">390px mobile</button><button data-width="768">768px tablet</button><button data-width="1200">1200px desktop</button><span id="size">390px</span></header><iframe id="preview" title="Runvara preview"></iframe><script>const frame=document.getElementById('preview');frame.srcdoc=${JSON.stringify(frame).replaceAll('<','\\u003c')};document.querySelectorAll('[data-width]').forEach(button=>button.onclick=()=>{frame.style.width=button.dataset.width+'px';document.getElementById('size').textContent=button.dataset.width+'px';});</script></body></html>`);
console.log(output);
