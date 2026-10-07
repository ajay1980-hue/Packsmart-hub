import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken, sessionCookie } from '../lib/security.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const SECRET = 'static-cache-tests-only-session-secret-over-thirty-two-characters';
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' https://cdn.shopify.com data:; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
const SECURITY_HEADERS = {
  'x-content-type-options':'nosniff', 'x-frame-options':'DENY', 'referrer-policy':'same-origin',
  'permissions-policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy':'same-origin', 'cross-origin-resource-policy':'same-origin',
  'strict-transport-security':'max-age=31536000; includeSubDomains'
};
const ASSETS = [
  ['/', 'index.html', 'text/html; charset=utf-8', 'no-cache'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8', 'no-cache'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8', 'no-cache'],
  ['/presentation.js', 'presentation.js', 'text/javascript; charset=utf-8', 'no-cache'],
  ['/control-ui.js', 'control-ui.js', 'text/javascript; charset=utf-8', 'no-cache'],
  ['/connections-ui.js', 'connections-ui.js', 'text/javascript; charset=utf-8', 'no-cache'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8', 'public, max-age=300'],
  ['/favicon.svg', 'favicon.svg', 'image/svg+xml', 'public, max-age=300']
];
const assetUrl = filename => new URL(`../../${filename}`, import.meta.url);
const contentTag = bytes => `"sha256-${crypto.createHash('sha256').update(bytes).digest('hex')}"`;

async function fixture(t) {
  const states = new Map(), cookies = {}, calls = [];
  for (const workspaceId of ['alpha','beta']) {
    const state = seedWorkspaceState({}, { workspaceId, email:`${workspaceId}@example.test`, passwordHash:'fixture' });
    state.users[0].passwordChangeRequired = false;
    state.connections = [{ id:`${workspaceId}-connection`, provider:'shopify', status:'connected' }];
    states.set(workspaceId, state);
    cookies[workspaceId] = sessionCookie(createSessionToken({
      userId:state.users[0].id, workspaceId, email:state.users[0].email,
      role:state.users[0].role, sessionVersion:state.users[0].sessionVersion
    }, SECRET)).split(';')[0];
  }
  const store = { provider:'file', get:async workspaceId => { calls.push(workspaceId); return states.get(workspaceId); } };
  const server = createPacksmartServer({ NODE_ENV:'test', APP_PUBLIC_URL:'https://cache.example.test', SESSION_SECRET:SECRET }, {
    store, integrations:{}, aiProvider:{}, schedulerEnabled:false, agentOpsEnabled:false,
    fetchImpl:async () => { assert.fail('static revalidation must not call a provider'); }
  });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = (pathname, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    // Raw loopback HTTP avoids a client cache hiding actual status/body bytes.
    const req = http.request({ host:'127.0.0.1', port:server.address().port, path:pathname, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, body:Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
  return { request, calls, cookies };
}

function assertProtected(response) {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) assert.equal(response.headers[header], value, header);
  assert.ok(response.headers['x-request-id']);
}

function assertUncached(response) {
  assert.notEqual(response.status, 304);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.headers['last-modified'], undefined);
  assertProtected(response);
}

test('allowlisted assets support conditional GET/HEAD without changing cache policy, MIME or security headers', async t => {
  const { request, calls } = await fixture(t);
  let firstLoadBytes = 0, revalidatedBytes = 0;
  for (const [pathname, filename, contentType, cacheControl] of ASSETS) {
    const original = await fs.readFile(assetUrl(filename));
    const first = await request(pathname);
    assert.equal(first.status, 200, pathname);
    assert.deepEqual(first.body, original);
    assert.equal(first.headers.etag, contentTag(original));
    for (const method of ['GET','HEAD']) {
      const unchanged = await request(pathname, { method, headers:{ 'If-None-Match':first.headers.etag } });
      assert.equal(unchanged.status, 304, `${method} ${pathname}`);
      assert.equal(unchanged.body.length, 0);
      assert.equal(unchanged.headers.etag, first.headers.etag);
      assert.ok(unchanged.headers.date, '304 retains a Date header');
      assert.equal(unchanged.headers['transfer-encoding'], undefined);
      for (const response of [first, unchanged]) {
        assert.equal(response.headers['content-type'], contentType);
        assert.equal(response.headers['cache-control'], cacheControl);
        assert.equal(response.headers['content-security-policy'], CSP);
        assert.equal(response.headers['set-cookie'], undefined);
        assertProtected(response);
      }
      if (method === 'GET' && pathname !== '/index.html') revalidatedBytes += unchanged.body.length;
    }
    const head = await request(pathname, { method:'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers.etag, first.headers.etag);
    if (pathname !== '/index.html') firstLoadBytes += first.body.length;
    t.diagnostic(`${pathname}: initial body ${first.body.length} bytes; matching revalidation body 0 bytes`);
  }
  assert.equal(revalidatedBytes, 0);
  assert.deepEqual(calls, [], 'static requests never read tenant state');
  t.diagnostic(`Seven unique public assets: ${firstLoadBytes} initial body bytes; ${revalidatedBytes} revalidated body bytes. Local HTTP body measurement only.`);
});

test('If-None-Match accepts weak/list/wildcard validators and ignores nonmatching or malformed fields', async t => {
  const { request, calls } = await fixture(t);
  const first = await request('/app.js?v=unchanged');
  const etag = first.headers.etag;
  for (const value of [etag, `W/${etag}`, `"old", W/${etag}, "other"`, `"comma,inside", ${etag}`, `"obs-\u00a0\u00ff-text", ${etag}`,
    ` , ,\tW/${etag}, , `, '*', ' * ']) {
    for (const method of ['GET','HEAD']) {
      const response = await request('/app.js?v=another-version', { method, headers:{ 'If-None-Match':value } });
      assert.equal(response.status, 304, `${method}: ${value}`);
      assert.equal(response.body.length, 0);
      assert.equal(response.headers.etag, etag);
    }
  }
  for (const value of ['', '"old"', 'W/"old"', '"old", W/"other"', etag.slice(1, -1),
    `w/${etag}`, `W/ ${etag}`, `*, ${etag}`, `${etag}, *`, `${etag} trailing`, `"unfinished, ${etag}`,
    `"with space", ${etag}`, `${etag} ${etag}`, `\u00a0${etag}`, `${etag}\u00a0`, `\u00a0*`, `*\u00a0`,
    `\u0085${etag}`, `${etag}\u0085`, `"old",\u00a0${etag}`, `"obs-\u00a0\u00ff-text"`]) {
    for (const method of ['GET','HEAD']) {
      const response = await request('/app.js', { method, headers:{ 'If-None-Match':value } });
      assert.equal(response.status, 200, `${method}: ${value}`);
      assert.deepEqual(response.body, method === 'HEAD' ? Buffer.alloc(0) : first.body);
      assert.equal(response.headers.etag, etag);
    }
  }
  const head = await request('/app.js', { method:'HEAD', headers:{ 'If-None-Match':'"old"' } });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers.etag, etag);
  assert.deepEqual(calls, []);
});

test('same-length content changes invalidate the validator, and missing assets never return a stale 304', async t => {
  const { request } = await fixture(t);
  const target = path.resolve(fileURLToPath(assetUrl('favicon.svg')));
  const originalRead = fs.readFile;
  let bytes = Buffer.from('<svg>A</svg>'), reads = 0, missing = false;
  t.mock.method(fs, 'readFile', async (filename, ...options) => {
    if (filename instanceof URL && path.resolve(fileURLToPath(filename)) === target) {
      reads++;
      if (missing) throw Object.assign(new Error('missing asset'), { code:'ENOENT' });
      return Buffer.from(bytes);
    }
    return originalRead(filename, ...options);
  });
  const first = await request('/favicon.svg');
  assert.equal(first.headers.etag, contentTag(bytes));
  bytes = Buffer.from('<svg>B</svg>');
  const changed = await request('/favicon.svg', { headers:{ 'If-None-Match':first.headers.etag } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.length, first.body.length, 'length alone cannot detect this change');
  assert.deepEqual(changed.body, bytes);
  assert.notEqual(changed.headers.etag, first.headers.etag);
  assert.equal(changed.headers.etag, contentTag(bytes));
  const unchanged = await request('/favicon.svg', { headers:{ 'If-None-Match':`W/${changed.headers.etag}` } });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.body.length, 0);
  missing = true;
  for (const value of [changed.headers.etag, '*']) {
    const absent = await request('/favicon.svg', { headers:{ 'If-None-Match':value } });
    assert.equal(absent.status, 404);
    assertUncached(absent);
  }
  assert.equal(reads, 5, 'each response re-reads the current asset instead of caching bytes or metadata');
});

test('unknown paths and unsupported methods keep existing 404/no-store behavior', async t => {
  const { request, calls } = await fixture(t);
  for (const pathname of ['/missing.js','/saas/app.js','/server/server.mjs','/.env','/favicon.svg/extra']) {
    for (const method of ['GET','HEAD']) {
      const response = await request(pathname, { method, headers:{ 'If-None-Match':'*' } });
      assert.equal(response.status, 404, `${method} ${pathname}`);
      assertUncached(response);
      if (method === 'HEAD') assert.equal(response.body.length, 0);
    }
  }
  for (const method of ['POST','PUT','PATCH','DELETE','OPTIONS']) {
    const response = await request('/app.js', { method, headers:{ 'If-None-Match':'*' } });
    assert.equal(response.status, 404, method);
    assertUncached(response);
  }
  assert.deepEqual(calls, []);
});

test('API, authenticated tenant data and OAuth callbacks never gain validators or become cacheable', async t => {
  const { request, cookies } = await fixture(t);
  const asset = await request('/app.js');
  for (const validator of ['*', asset.headers.etag]) {
    const headers = { 'If-None-Match':validator };
    const publicApi = await request('/api/auth/signup-options', { headers });
    assert.equal(publicApi.status, 200);
    assertUncached(publicApi);
    for (const pathname of ['/api/auth/session','/api/connections','/api/app.js']) {
      const anonymous = await request(pathname, { headers });
      assert.equal(anonymous.status, 401);
      assertUncached(anonymous);
    }
    for (const workspaceId of ['alpha','beta']) {
      const authenticatedHeaders = { ...headers, Cookie:cookies[workspaceId] };
      const session = await request('/api/auth/session', { headers:authenticatedHeaders });
      assert.equal(session.status, 200);
      assert.equal(JSON.parse(session.body).workspace.id, workspaceId);
      assertUncached(session);
      const business = await request('/api/connections?workspaceId=another-tenant', { headers:authenticatedHeaders });
      assert.equal(business.status, 200);
      assert.equal(JSON.parse(business.body).connections[0].id, `${workspaceId}-connection`);
      assertUncached(business);
    }
    for (const pathname of ['/api/integrations/shopify/oauth/callback','/api/integrations/ebay/oauth/callback',
      '/api/marketing/providers/canva/oauth/callback']) {
      const callback = await request(pathname, { headers });
      assert.equal(callback.status, 400);
      assertUncached(callback);
    }
  }
});
