const closures = new WeakMap();
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeCode = value => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : null;
function localSummary(value) {
  // These are process-local observations, never tenant IDs or durable receipts.
  return { scheduler: { errors: count(value.scheduler?.errors), lastError: safeCode(value.scheduler?.lastError) },
    agentOps: { retainedClaims: count(value.agentOps?.retainedClaims), errors: count(value.agentOps?.errors), lastError: safeCode(value.agentOps?.lastError) } };
}

// A settled drain proves only local tasks have settled. A deadline proves
// neither task completion nor process termination; the caller owns exit.
export function closePacksmartServer(server, { timeoutMs = 10000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (closures.has(server)) return closures.get(server);
  const deadline = Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 120000 ? timeoutMs : 10000;
  let finish;
  const promise = new Promise(resolve => { finish = resolve; });
  closures.set(server, promise);
  let resolved = false, closed = false, drained = false, closeFailed = false, drainFailed = false, localWork = null;
  const complete = timedOut => {
    if (resolved || (!timedOut && !(closed && drained) && !closeFailed && !drainFailed)) return;
    resolved = true;
    clearTimer(timer);
    finish(Object.freeze({ settled: closed && drained && !closeFailed && !drainFailed,
      timedOut, closed, drained, closeFailed, drainFailed, localWork }));
  };
  // Keep this timer referenced: without it an unresolved Promise cannot keep
  // an otherwise idle process alive until its truthful timeout is reported.
  const timer = setTimer(() => complete(true), deadline);
  try {
    // Close admission and polling before waiting for existing HTTP sockets.
    Promise.resolve(server.packsmart.drain()).then(result => {
      if (result?.settled !== true) drainFailed = true;
      else { drained = true; localWork = localSummary(result); }
      complete(false);
    }, () => { drainFailed = true; complete(false); });
  } catch { drainFailed = true; }
  try {
    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') closeFailed = true;
      else closed = true;
      complete(false);
    });
  } catch (error) {
    if (error?.code === 'ERR_SERVER_NOT_RUNNING') closed = true;
    else closeFailed = true;
  }
  complete(false);
  return promise;
}
