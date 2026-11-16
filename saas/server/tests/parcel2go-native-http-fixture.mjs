import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TOKEN, quoteBody } from './parcel2go-sandbox-fixture.mjs';

// Never permit a test to fall through to a provider or persistence socket.
export function nativeHttpFixture(t, responseFor = () => ({})) {
  const calls = [];
  t.mock.method(net.Socket.prototype, 'connect', () => assert.fail('Socket creation forbidden'));
  t.mock.method(globalThis, 'fetch', () => assert.fail('Uninjected fetch forbidden'));
  t.mock.method(https, 'request', (url, options, callback) => {
    const call = { url: String(url), options, body: null, destroyed: false };
    calls.push(call);
    const request = new EventEmitter();
    request.destroy = () => { call.destroyed = true; };
    request.end = body => {
      call.body = body;
      queueMicrotask(() => {
        const operation = url.pathname.endsWith('/token') ? 'token' : 'quote';
        const spec = responseFor(operation) || {};
        if (spec.reset) { request.emit('error', new Error('Synthetic response lost')); return; }
        const data = spec.body ?? (operation === 'token'
          ? { access_token: TOKEN, token_type: 'Bearer', scope: 'public-api', expires_in: 3600 }
          : quoteBody());
        const bytes = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
        const response = new PassThrough();
        response.statusCode = spec.status ?? 200;
        response.headers = { 'content-type': 'application/json', 'content-length': String(bytes.length) };
        response.complete = true;
        callback(response);
        if (!response.destroyed) {
          const split = Math.floor(bytes.length / 2);
          response.write(bytes.subarray(0, split)); response.end(bytes.subarray(split));
        }
      });
    };
    return request;
  });
  return calls;
}
