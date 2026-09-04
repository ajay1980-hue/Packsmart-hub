const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'saas', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'saas', 'app.js'), 'utf8');
const catalogue = JSON.parse(fs.readFileSync(path.join(root, 'ebay-manager', 'shopify-products.json'), 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(html.includes('Approval Centre'), 'Approval Centre must remain visible');
assert(html.includes('Contribution is shown before channel/payment fees and tax.'), 'Contribution caveat must remain visible');
assert(js.includes("../ebay-manager/shopify-products.json"), 'Pilot must read the existing Packsmart catalogue snapshot');
assert(js.includes('Spend money'), 'Spending must remain approval-gated');
assert(js.includes('Place supplier orders'), 'Supplier orders must remain approval-gated');
assert(js.includes('Issue refunds'), 'Refunds must remain approval-gated');
assert(js.includes('Major price changes'), 'Major price changes must remain approval-gated');
assert(js.includes('Risk-sensitive live actions'), 'Risk-sensitive live actions must remain approval-gated');
assert(js.includes('OAuth remains server-side'), 'Browser must not imply eBay credentials are exposed');
assert(Array.isArray(catalogue.products) && catalogue.products.length > 0, 'Packsmart Shopify snapshot must contain products');
assert(catalogue.products.every(product => Array.isArray(product.variants)), 'Every product must expose a variants array');

console.log(`SaaS guard checks passed for ${catalogue.products.length} Packsmart products.`);
