// Local synthetic attempts only. Not a credential store or production issuer.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';

export const SIMULATION_ATTEMPT_ROOT = fileURLToPath(new URL('../../../../.local-simulation-attempts/', import.meta.url));
const handles = new WeakMap();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const unavailable = () => fail('SIMULATION_ATTEMPT_STATE_UNAVAILABLE');
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) || {}, 'value'));
const normalized = value => path.resolve(value).toLowerCase();

function checkedBinding(value) {
  const fixed = { mode: 'simulated', workspaceId: 'runvara-description-simulation', connectionId: 'simulation-shopify',
    account: 'runvara-description-simulation.myshopify.com', productId: 'gid://shopify/Product/900000000001',
    operation: 'product_content', requestedBy: 'simulation-owner', settingsRevision: 1, apiVersion: '2026-07' };
  if (!exact(value, [...Object.keys(fixed), 'inputDigest']) || Object.entries(fixed).some(([key, expected]) => value[key] !== expected)
    || !/^[a-f0-9]{64}$/.test(value.inputDigest)) throw fail('SIMULATION_ATTEMPT_BINDING_MISMATCH');
  return Object.freeze({ ...fixed, inputDigest: value.inputDigest });
}
function directory(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw unavailable();
  return path.join(SIMULATION_ATTEMPT_ROOT, `attempt-${id}`);
}
async function checkedDirectory(id) {
  const dir = directory(id);
  for (const candidate of [SIMULATION_ATTEMPT_ROOT, dir]) {
    const info = await fs.lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink() || normalized(await fs.realpath(candidate)) !== normalized(candidate)) throw unavailable();
  }
  return dir;
}
async function readManifest(id, expectedBinding) {
  try {
    const dir = await checkedDirectory(id), filename = path.join(dir, 'manifest.json');
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw unavailable();
    const handle = await fs.open(filename, 'r');
    let value;
    try { value = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
    if (!exact(value, ['schema', 'simulated', 'attemptId', 'requestId', 'createdAt', 'binding', 'digest'])) throw unavailable();
    const { digest: recorded, ...body } = value;
    if (body.schema !== 'runvara-simulated-attempt/v1' || body.simulated !== true || body.attemptId !== id
      || body.requestId !== `simulation_${id}` || !Number.isFinite(Date.parse(body.createdAt)) || recorded !== digest(body)
      || digest(checkedBinding(body.binding)) !== digest(checkedBinding(expectedBinding))) throw fail('SIMULATION_ATTEMPT_BINDING_MISMATCH');
    return value;
  } catch (error) {
    if (error.code === 'SIMULATION_ATTEMPT_BINDING_MISMATCH') throw error;
    throw unavailable();
  }
}
async function refuseExistingMarker(id) {
  try { await fs.lstat(path.join(await checkedDirectory(id), 'consumed.json')); }
  catch (error) { if (error.code === 'ENOENT') return; throw unavailable(); }
  // Any existing entry is closed, including partial, malformed or unreadable files.
  throw fail('SIMULATION_ATTEMPT_CONSUMED');
}

export async function createSyntheticAttempt(binding) {
  binding = checkedBinding(binding);
  const id = randomBytes(16).toString('hex');
  try {
    await fs.mkdir(SIMULATION_ATTEMPT_ROOT, { recursive: true });
    const root = await fs.lstat(SIMULATION_ATTEMPT_ROOT);
    if (!root.isDirectory() || root.isSymbolicLink() || normalized(await fs.realpath(SIMULATION_ATTEMPT_ROOT)) !== normalized(SIMULATION_ATTEMPT_ROOT)) throw unavailable();
    await fs.mkdir(directory(id)); // Never reuse or replace an existing identity.
    const body = { schema: 'runvara-simulated-attempt/v1', simulated: true, attemptId: id,
      requestId: `simulation_${id}`, createdAt: new Date().toISOString(), binding };
    const handle = await fs.open(path.join(directory(id), 'manifest.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ ...body, digest: digest(body) }) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    return await openSyntheticAttempt(id, binding);
  } catch (error) { if (error.code?.startsWith('SIMULATION_')) throw error; throw unavailable(); }
}

export async function openSyntheticAttempt(id, binding) {
  binding = checkedBinding(binding);
  const manifest = await readManifest(id, binding);
  await refuseExistingMarker(id);
  const handle = Object.freeze(Object.create(null));
  handles.set(handle, { manifest, binding, checkpoint: null });
  return handle;
}
export function syntheticAttemptDetails(handle) {
  const entry = handles.get(handle);
  if (!entry) throw unavailable();
  return Object.freeze({ simulated: true, attemptId: entry.manifest.attemptId, requestId: entry.manifest.requestId,
    directory: directory(entry.manifest.attemptId), manifestDigest: entry.manifest.digest });
}
export function assertSyntheticAttemptBinding(handle, binding) {
  const entry = handles.get(handle);
  if (!entry || digest(entry.binding) !== digest(checkedBinding(binding))) throw fail('SIMULATION_ATTEMPT_BINDING_MISMATCH');
}
// Trusted, test-only IPC checkpoints; never exposed through HTTP or config.
export function observeSyntheticAttempt(handle, callback) {
  const entry = handles.get(handle);
  if (!entry || typeof callback !== 'function' || entry.checkpoint) throw unavailable();
  entry.checkpoint = callback;
}
export async function syntheticAttemptCheckpoint(handle, phase) {
  const entry = handles.get(handle);
  if (!entry) throw unavailable();
  await entry.checkpoint?.(phase);
}
export async function consumeSyntheticAttempt(handle, binding) {
  assertSyntheticAttemptBinding(handle, binding);
  const entry = handles.get(handle), id = entry.manifest.attemptId;
  const manifest = await readManifest(id, entry.binding);
  if (manifest.digest !== entry.manifest.digest) throw fail('SIMULATION_ATTEMPT_BINDING_MISMATCH');
  let file;
  try {
    // Exclusive creation is the cross-process claim. No check-then-write race.
    file = await fs.open(path.join(await checkedDirectory(id), 'consumed.json'), 'wx', 0o600);
    await syntheticAttemptCheckpoint(handle, 'marker_created');
    await file.writeFile(JSON.stringify({ schema: 'runvara-simulated-consumed/v1', simulated: true,
      attemptId: id, requestId: manifest.requestId, manifestDigest: manifest.digest,
      state: 'consumed', consumedAt: new Date().toISOString() }) + '\n');
    await syntheticAttemptCheckpoint(handle, 'marker_written');
    await file.sync();
    await syntheticAttemptCheckpoint(handle, 'marker_flushed');
  } catch (error) {
    if (error.code === 'EEXIST') throw fail('SIMULATION_ATTEMPT_CONSUMED');
    throw unavailable();
  } finally { if (file) await file.close(); }
  // Manifest replacement during the claim cannot authorize a send either.
  if ((await readManifest(id, entry.binding)).digest !== manifest.digest) throw fail('SIMULATION_ATTEMPT_BINDING_MISMATCH');
  // No deletion, reset, auto-repair or retry is provided. File sync is not a
  // claim about power loss, disk caches, directory durability or tampering.
}
