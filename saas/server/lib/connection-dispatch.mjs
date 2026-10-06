// Server-created, per-execution capabilities. A JSON flag cannot authorize a
// mutation, and a transport cannot repeat a phase after an ambiguous send.
const capabilities = new WeakMap();
const denied = () => Object.assign(new Error('A verified connection-write dispatch claim is required.'),
  { code: 'WRITE_DISPATCH_REQUIRED', status: 409, definitive: true });

export function createConnectionDispatch(check) {
  if (typeof check !== 'function') throw denied();
  const capability = Object.freeze({});
  capabilities.set(capability, { check, phases: new Set(), sent: 0 });
  return capability;
}

export function connectionDispatchCount(capability) {
  return capabilities.get(capability)?.sent || 0;
}

export async function dispatchConnectionMutation(capability, request, submit) {
  const entry = capabilities.get(capability);
  if (!entry || typeof submit !== 'function' || !request || typeof request.phase !== 'string'
    || entry.phases.has(request.phase)) throw denied();
  entry.phases.add(request.phase); // Fence siblings before any asynchronous check.
  const prepared = Object.freeze({ ...request });
  await entry.check(prepared);
  entry.sent++;
  return submit();
}
