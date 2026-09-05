const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'saas', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'saas', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'saas', 'server', 'server.mjs'), 'utf8');
const operations = fs.readFileSync(path.join(root, 'saas', 'server', 'lib', 'operations.mjs'), 'utf8');
const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'ebay-manager', 'shopify-products.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(html.includes('Approval Centre'), 'Approval Centre must remain visible');
assert(html.includes('Contribution = selling price minus landed, packing, delivery and channel costs.'), 'Contribution caveat must remain visible');
assert(js.includes("request('/api/bootstrap')"), 'Browser must load the authenticated server workspace');
assert(!js.includes('../ebay-manager/shopify-products.json'), 'Browser must not fetch the repository catalogue directly');
assert(!server.includes("'/ebay-manager/shopify-products.json'"), 'Server must not publicly expose the fallback snapshot');
assert(server.includes('executedExternally: false'), 'Approval decisions must not execute external actions');
assert(server.includes('assertCsrf(req, auth.session, publicUrl)'), 'State-changing API routes must enforce CSRF protection');
assert(operations.includes('supplier_order'), 'Supplier orders must remain approval-gated');
assert(operations.includes('advertising_spend'), 'Advertising spend must remain approval-gated');
assert(operations.includes('refund'), 'Refunds must remain approval-gated');
assert(operations.includes('major_price_change'), 'Major price changes must remain approval-gated');
assert(operations.includes('paid_service_purchase'), 'Paid services must remain approval-gated');
assert(operations.includes('risky_marketplace_action'), 'Risky marketplace actions must remain approval-gated');
assert(operations.includes('Facebook & Instagram Shops'), 'Meta social commerce must be present');
assert(operations.includes('TikTok Shop'), 'TikTok Shop must be present');
assert(operations.includes('Pinterest Shopping'), 'Pinterest Shopping must be present');
assert(operations.includes('Google & YouTube Shopping'), 'Google and YouTube Shopping must be present');
assert(operations.includes('WhatsApp Business'), 'WhatsApp Business must be present');
assert(!/(shpat_|sk_live_|service_role\s*[:=]\s*['\"]eyJ)/.test(js), 'Browser JavaScript must not contain private service credentials');
assert(Array.isArray(catalogue.products) && catalogue.products.length > 0, 'Packsmart Shopify snapshot must contain products');
assert(catalogue.products.every(product => Array.isArray(product.variants)), 'Every product must expose a variants array');

const referencedIds = [...js.matchAll(/\$\('#([^']+)'\)/g)].map(match => match[1]);
const missingIds = [...new Set(referencedIds)].filter(id => !html.includes(`id="${id}"`));
assert(missingIds.length === 0, `Browser code references missing DOM IDs: ${missingIds.join(', ')}`);

console.log(`SaaS guard checks passed for ${catalogue.products.length} Packsmart products.`);
