// Explicit pinned-baseline qualification, outside the portable *.test.mjs suite.
// RUNVARA_D32_SOURCE_DIR must contain the exact public Git object named below.
// Run with Node 22: node --test tests/quiet-startup-process-d32.mjs
import test from 'node:test';
import { extractD32, qualifyCutover, evidence } from './quiet-startup-process-harness.mjs';

test('exact public d32 writer overlaps quiet candidate, exits, then identical candidate starts normal without replay', { timeout: 60000 }, async t => {
  const baseline = await extractD32(t, process.env.RUNVARA_D32_SOURCE_DIR);
  await evidence('d32-candidate-cutover', await qualifyCutover(t, baseline));
});
