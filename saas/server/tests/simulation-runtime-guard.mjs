// Test-only observation/denial of common JS I/O APIs. Not an OS sandbox/audit.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const attemptRoot = fileURLToPath(new URL('../../../../.local-simulation-attempts/', import.meta.url));
const normalize = value => path.resolve(value).toLowerCase();
const within = (candidate, root) => candidate === normalize(root) || candidate.startsWith(normalize(root) + path.sep);
const credentialName = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials(?:\..*)?|tokens?\.json|id_rsa|id_ed25519|cookies(?:\..*)?)$/i;
const credentialDirectory = /^(?:\.aws|\.ssh|\.codex|browserprofiles)$/i;

export function installSimulationRuntimeGuard({ attemptId, ioFault = 'none' } = {}) {
  const counters = { loopbackRequests: 0, loopbackConnections: 0, loopbackListens: 0, numericLookups: 0,
    sourceReads: 0, attemptReads: 0, attemptWrites: 0, injectedFaults: 0 };
  const denied = [], allowedPorts = new Set();
  const deny = operation => {
    denied.push(operation);
    throw Object.assign(new Error('SIMULATION_GUARD_DENIED'), { code: 'SIMULATION_GUARD_DENIED', operation });
  };
  const markerPath = typeof attemptId === 'string' && /^[a-f0-9]{32}$/.test(attemptId)
    ? normalize(path.join(attemptRoot, `attempt-${attemptId}`, 'consumed.json')) : null;
  const manifestPath = markerPath && normalize(path.join(path.dirname(markerPath), 'manifest.json'));
  const injected = code => { counters.injectedFaults++; throw Object.assign(new Error('SIMULATED_IO_FAULT'), { code }); };
  const filePath = value => {
    if (value instanceof URL) value = fileURLToPath(value);
    if (typeof value !== 'string') return deny('file:non-path');
    return normalize(value);
  };
  const checkFile = (value, write = false) => {
    const candidate = filePath(value), segments = candidate.split(/[\\/]/);
    if (credentialName.test(segments.at(-1)) || segments.some(segment => credentialDirectory.test(segment))) return deny('file:credential-name');
    if (within(candidate, attemptRoot)) counters[write ? 'attemptWrites' : 'attemptReads']++;
    else if (!write && within(candidate, repoRoot)) counters.sourceReads++;
    else return deny(write ? 'file:write-outside-attempts' : 'file:read-outside-source');
    return candidate;
  };
  const writeFlags = flags => typeof flags === 'number'
    ? Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
    : /[wa+]/.test(flags || 'r');
  for (const key of ['readFile', 'readFileSync', 'createReadStream']) {
    const original = fs[key]; fs[key] = function (filename, ...args) { checkFile(filename); return original.call(this, filename, ...args); };
  }
  for (const key of ['open', 'openSync']) {
    const original = fs[key]; fs[key] = function (filename, flags, ...args) { checkFile(filename, writeFlags(flags)); return original.call(this, filename, flags, ...args); };
  }
  const readFile = fsp.readFile;
  fsp.readFile = async function (filename, ...args) { checkFile(filename); return readFile.call(this, filename, ...args); };
  const open = fsp.open;
  fsp.open = async function (filename, flags, ...args) {
    const candidate = checkFile(filename, writeFlags(flags));
    if (ioFault === 'unreadable_manifest' && candidate === manifestPath) injected('EACCES');
    const handle = await open.call(this, filename, flags, ...args);
    if (ioFault === 'sync_failure' && candidate === markerPath) handle.sync = async () => injected('EIO');
    return handle;
  };
  const lstat = fsp.lstat;
  fsp.lstat = async function (filename, ...args) {
    if (ioFault === 'unreadable_marker' && filePath(filename) === markerPath) injected('EACCES');
    return lstat.call(this, filename, ...args);
  };
  for (const target of [fs, fsp]) for (const key of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream']) {
    if (typeof target[key] !== 'function') continue;
    const original = target[key]; target[key] = function (filename, ...args) { checkFile(filename, true); return original.call(this, filename, ...args); };
  }

  function connectionOptions(args) {
    while (Array.isArray(args[0])) args = args[0];
    if (args[0] && typeof args[0] === 'object') return args[0];
    return { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
  }
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const options = connectionOptions(args);
    if (options.path || (options.hostname || options.host) !== '127.0.0.1' || !allowedPorts.has(Number(options.port))) return deny('net:destination');
    counters.loopbackConnections++; return connect.apply(this, args);
  };
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const options = connectionOptions(args);
    if (options.path || options.host !== '127.0.0.1' || Number(options.port) !== 0) return deny('net:listen');
    counters.loopbackListens++;
    this.once('listening', () => {
      const address = this.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.family !== 'IPv4') return deny('net:bound-address');
      allowedPorts.add(address.port);
      this.once('close', () => allowedPorts.delete(address.port));
    });
    return listen.apply(this, args);
  };
  for (const key of ['request', 'get']) {
    const original = http[key]; http[key] = function (input, ...args) {
      const options = typeof input === 'string' || input instanceof URL ? new URL(input) : input;
      if (!options || (options.hostname || options.host) !== '127.0.0.1' || !allowedPorts.has(Number(options.port))
        || (options.protocol && options.protocol !== 'http:') || options.socketPath) return deny('http:destination');
      counters.loopbackRequests++; return original.call(this, input, ...args);
    };
    https[key] = () => deny('https:request');
  }
  globalThis.fetch = async () => deny('fetch:request');
  tls.connect = () => deny('tls:connect');
  http2.connect = () => deny('http2:connect');
  dgram.createSocket = () => deny('udp:create');
  for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const key of Object.getOwnPropertyNames(target)) if (/^(lookup|resolve|reverse)/.test(key) && typeof target[key] === 'function') {
      // Node's listener calls lookup even for a literal IP. Resolve that single
      // numeric address locally; never delegate to DNS or the system resolver.
      if (key === 'lookup' && (target === dns || target === dns.promises)) {
        target[key] = (hostname, options, callback) => {
          if (hostname !== '127.0.0.1') return deny('dns:query');
          counters.numericLookups++;
          const result = { address: '127.0.0.1', family: 4 };
          if (target === dns.promises) return Promise.resolve(options?.all ? [result] : result);
          const done = typeof options === 'function' ? options : callback;
          process.nextTick(() => options?.all ? done(null, [result]) : done(null, result.address, result.family));
        };
        continue;
      }
      target[key] = () => deny('dns:query');
    }
  }
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = () => deny('child:spawn');
  syncBuiltinESMExports();
  return { snapshot: () => ({ ...counters, denied: [...denied], activeAllowedPorts: [...allowedPorts] }) };
}

export async function probeSimulationRuntimeGuard() {
  // Nonexistent synthetic names only. Every operation must throw before I/O.
  const fakeEnv = path.join(repoRoot, '.env.synthetic-guard-sentinel');
  const fakeCredentials = path.join(repoRoot, '.aws', 'credentials');
  const probes = {
    fetch: () => fetch('https://simulation-denied.invalid'),
    http: () => http.request('http://simulation-denied.invalid'),
    https: () => https.request('https://simulation-denied.invalid'),
    http2: () => http2.connect('https://simulation-denied.invalid'),
    net: () => net.createConnection({ host: '192.0.2.1', port: 443 }),
    tls: () => tls.connect({ host: 'simulation-denied.invalid', port: 443 }),
    listen: () => net.createServer().listen(0, '0.0.0.0'),
    dns: () => dns.lookup('simulation-denied.invalid', () => {}),
    dnsPromise: () => dns.promises.resolve4('simulation-denied.invalid'),
    dnsResolver: () => new dns.Resolver().resolve4('simulation-denied.invalid', () => {}),
    udp: () => dgram.createSocket('udp4'),
    readSync: () => fs.readFileSync(fakeEnv),
    readCallback: () => fs.readFile(fakeEnv, () => {}),
    readPromise: () => fsp.readFile(fakeEnv),
    readStream: () => fs.createReadStream(fakeEnv),
    openSync: () => fs.openSync(fakeCredentials, 'r'),
    openCallback: () => fs.open(fakeCredentials, 'r', () => {}),
    openPromise: () => fsp.open(fakeCredentials, 'r'),
    subprocess: () => childProcess.spawn(process.execPath, ['--version'])
  };
  const results = {};
  for (const [name, probe] of Object.entries(probes)) {
    try { await probe(); results[name] = 'NOT_BLOCKED'; }
    catch (error) { results[name] = error.code; }
  }
  return results;
}
