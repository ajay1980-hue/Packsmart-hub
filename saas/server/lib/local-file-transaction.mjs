import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// All current FileStore writers and local draft commits share this OS-visible
// lock. A crashed writer leaves a closed lock, requiring explicit local recovery.
// Never steal a lock based on age or PID: another process may still own it.
export async function localFileTransaction(file, callback) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lock = file + '.transaction-lock';
  let handle, lastAcquisitionError;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { handle = await fs.open(lock, 'wx', 0o600); break; }
    catch (error) {
      // Windows may temporarily deny this exact exclusive open during lock
      // turnover. Retry acquisition only, within the same finite budget.
      // No callback, write or release operation is ever retried here.
      if (error.code !== 'EEXIST' && !(process.platform === 'win32' && error.code === 'EPERM')) throw error;
      lastAcquisitionError = error;
      await delay(10);
    }
  }
  if (!handle && lastAcquisitionError?.code === 'EPERM') throw lastAcquisitionError;
  if (!handle) throw Object.assign(new Error('Local state is busy or needs lock recovery'), { code: 'LOCAL_STATE_LOCKED', status: 503 });
  try { return await callback(); }
  finally { await handle.close(); await fs.unlink(lock); }
}
