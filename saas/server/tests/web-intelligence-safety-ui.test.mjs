import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { addWebIntelligenceTarget, webIntelligenceSnapshot } from '../lib/web-intelligence.mjs';

const app = await fs.readFile(new URL('../../app.js', import.meta.url), 'utf8');
const start = app.indexOf('  function renderMarketRadar() {');
const end = app.indexOf('  const automationHistory =', start);
assert.ok(start >= 0 && end > start, 'Market Radar renderer must remain inspectable');
const render = new Function('state', '$', 'escapeHtml', 'date', 'statusLabel', 'statusClass', app.slice(start, end) + '\nrenderMarketRadar();');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

test('Market Radar shows configured-but-paused readiness and preserves saved target/evidence visibility', () => {
  const state = { workspace: { id: 'web-ui' } }, target = addWebIntelligenceTarget(state, { url: 'https://example.test/prices', name: 'Existing public source' });
  state.webIntelligence.findings.push({ id: 'old', type: 'price_change', title: 'Saved observation', detail: 'Existing evidence remains available', detectedAt: '2026-10-01T00:00:00.000Z', sourceUrl: target.url });
  const ids = ['radar-provider-chip','radar-change-count','radar-target-count','radar-price-count','radar-competitor-count','radar-supplier-count','radar-last-run','radar-target-list','radar-finding-list'];
  for (const configured of [false, true]) {
    const dom = new JSDOM(ids.map(id => `<div id="${id}"></div>`).join(''));
    const doc = dom.window.document;
    const snapshot = webIntelligenceSnapshot(state, configured ? { FIRECRAWL_API_KEY: 'synthetic' } : {});
    render({ data: { webIntelligence: snapshot } }, selector => doc.querySelector(selector), escape, String, String, () => 'neutral');
    assert.match(doc.querySelector('#radar-provider-chip').textContent, /paid scans paused/i);
    assert.doesNotMatch(doc.querySelector('#radar-provider-chip').textContent, /Runvara ready|live scans available/i);
    assert.equal(doc.querySelector('#radar-provider-chip .tag').classList.contains('warn'), true);
    assert.match(doc.querySelector('#radar-target-list').textContent, /Existing public source/);
    assert.match(doc.querySelector('#radar-finding-list').textContent, /Saved observation/);
    assert.equal(doc.querySelector('#radar-finding-list a').getAttribute('href'), target.url);
    dom.window.close();
  }
  assert.doesNotMatch(app, /showMessage\('Web intelligence scan completed\.'/);
  assert.match(app, /No new scans ran\. Saved targets and findings remain available\./);
});
