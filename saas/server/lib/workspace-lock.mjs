// Existing server serialization extracted without behavioral change. Caller retains map for drain.
export function createWorkspaceLock(locks = new Map()) {
  return async function withWorkspaceLock(workspaceId, callback) {
    const previous = locks.get(workspaceId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    locks.set(workspaceId, queued);
    await previous;
    try { return await callback(); }
    finally {
      release();
      if (locks.get(workspaceId) === queued) locks.delete(workspaceId);
    }
  };
}
