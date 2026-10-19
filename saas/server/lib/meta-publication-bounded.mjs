// Shared bounded wire reader for the inactive single-image composition.
// No fetch default, retry, raw provider error retention or credential access.
export async function metaBoundedBytes(submit, {maxBytes, mediaType, timeoutMs = 5000} = {}) {
  if (typeof submit !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 5000000
    || !['application/json', 'image/jpeg'].includes(mediaType) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw Error('META_DELIVERY_INVALID');
  const controller = new AbortController(), end = performance.now() + timeoutMs;
  let reader, body, timer;
  const fail = () => Object.assign(new Error('META_DELIVERY_RESPONSE_UNKNOWN'), {code: 'META_DELIVERY_RESPONSE_UNKNOWN'});
  const cancel = () => {try {(reader ? reader.cancel() : body?.cancel())?.catch(() => {});} catch {}};
  const time = () => {if (controller.signal.aborted || performance.now() >= end) {cancel(); throw fail();}};
  const pending = (async () => {
    const response = await submit(controller.signal, time); body = response?.body; time();
    if (response?.status !== 200 || response.redirected || response.headers?.get('content-encoding')
      || !new RegExp('^' + mediaType + '(?:\\s*;|$)', 'i').test(response.headers?.get('content-type') || '')) throw fail();
    const size = response.headers.get('content-length');
    if (size !== null && (!/^\d{1,8}$/.test(size) || Number(size) > maxBytes)) throw fail();
    reader = body?.getReader(); if (!reader) throw fail();
    const chunks = []; let total = 0, count = 0;
    for (;;) {time(); const {done, value} = await reader.read(); time(); if (done) break;
      if (!(value instanceof Uint8Array) || !value.byteLength || ++count > maxBytes) throw fail();
      total += value.byteLength; if (total > maxBytes) throw fail(); chunks.push(Buffer.from(value));}
    if (size !== null && total !== Number(size)) throw fail();
    return Buffer.concat(chunks, total);
  })();
  const deadline = new Promise((_, reject) => {timer = setTimeout(() => {controller.abort(); cancel(); reject(fail());}, timeoutMs);});
  try {return await Promise.race([pending, deadline]);} catch {throw fail();} finally {clearTimeout(timer); cancel();}
}
// Reject duplicate keys at every level before JSON.parse. Strictly bounded
// nesting and tokens also cover escaped property names and hostile fake bodies.
export function metaStrictJson(bytes) {
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  let p = 0, tokens = 0;
  const bad = () => {throw Object.assign(new Error('META_DELIVERY_JSON_INVALID'), {code: 'META_DELIVERY_JSON_INVALID'});};
  const ws = () => {while (/[ \t\r\n]/.test(text[p] || 'x')) p++;};
  const string = () => {
    const match = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(text.slice(p));
    if (!match) bad(); p += match[0].length; const value = JSON.parse(match[0]); if (!value.isWellFormed() || value.includes('\0')) bad(); return value;
  };
  const value = (depth = 0) => {
    if (depth > 24 || ++tokens > 50000) bad(); ws();
    if (text[p] === '"') {string(); return;}
    if (text[p] === '{') {p++; ws(); if (text[p] === '}') {p++; return;} const keys = new Set();
      for (;;) {ws(); const key = string(); if (keys.has(key)) bad(); keys.add(key); ws(); if (text[p++] !== ':') bad(); value(depth + 1); ws();
        const end = text[p++]; if (end === '}') return; if (end !== ',') bad();}}
    if (text[p] === '[') {p++; ws(); if (text[p] === ']') {p++; return;}
      for (;;) {value(depth + 1); ws(); const end = text[p++]; if (end === ']') return; if (end !== ',') bad();}}
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(p));
    if (!match) bad(); p += match[0].length;
  };
  value(); ws(); if (p !== text.length) bad(); return JSON.parse(text);
}
