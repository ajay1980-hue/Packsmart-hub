// Pure offline utility. No routes, credentials, storage or provider transport.
// Reconstructed 2026-11-12; does not inherit historical candidate test claims.
import { createHash } from 'node:crypto';
const fail = () => { throw Object.assign(new Error('Parcel2Go evidence is not canonical JSON.'), { code: 'PARCEL2GO_LIVE_CANONICAL_INVALID' }); };
export function canonicalParcel2GoJson(value) {
  const ancestors = new Set(); let nodes = 0;
  function visit(x, depth) {
    if (++nodes > 5000 || depth > 20) fail();
    if (x === null || typeof x === 'boolean' || typeof x === 'string') return JSON.stringify(x);
    if (typeof x === 'number') { if (!Number.isFinite(x) || Object.is(x, -0)) fail(); return JSON.stringify(x); }
    if (typeof x !== 'object' || ancestors.has(x)) fail();
    const array = Array.isArray(x), proto = Object.getPrototypeOf(x);
    if (!array && proto !== Object.prototype && proto !== null) fail();
    if (array && proto !== Array.prototype) fail();
    ancestors.add(x);
    const keys = Reflect.ownKeys(x).filter(k => !(array && k === 'length'));
    if (array && keys.length !== x.length) fail();
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(x, k);
      if (typeof k !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value') || k === '__proto__') fail();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= x.length)) fail();
    }
    const result = array
      ? '[' + keys.map(k => visit(Object.getOwnPropertyDescriptor(x, k).value, depth + 1)).join(',') + ']'
      : '{' + keys.sort().map(k => JSON.stringify(k) + ':' + visit(Object.getOwnPropertyDescriptor(x, k).value, depth + 1)).join(',') + '}';
    ancestors.delete(x);
    if (Buffer.byteLength(result, 'utf8') > 65536) fail();
    return result;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(result, 'utf8') > 65536) fail();
  return result;
}
export function parcel2GoCanonicalFingerprint(value) {
  return createHash('sha256').update(canonicalParcel2GoJson(value)).digest('hex');
}
// Retained candidate interface names. This reconstruction intentionally keeps
// tighter limits until full workspace projection requirements are reviewed.
export const parcel2GoCanonicalJson = canonicalParcel2GoJson;
export const parcel2GoCanonicalHash = parcel2GoCanonicalFingerprint;
