import test from 'node:test';
import { qualifyCutover, evidence } from './quiet-startup-process-harness.mjs';

test('real same-artifact processes: normal drains admitted work, quiet stays inert, and cold normal preserves retained attempts', { timeout: 60000 }, async t => {
  await evidence('same-artifact-cutover', await qualifyCutover(t));
});
