// Forked only by the local simulated restart tests. No ambient environment copy.
import assert from 'node:assert/strict';
import { installSimulationRuntimeGuard, probeSimulationRuntimeGuard } from './simulation-runtime-guard.mjs';

const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
if (!process.send) throw new Error('SIMULATION_WORKER_REQUIRES_IPC');
process.once('message', async options => {
  let fixture, result, submissions = 0;
  const guard = installSimulationRuntimeGuard(options);
  try {
    if (options.action === 'probe') result = { probes: await probeSimulationRuntimeGuard() };
    else {
      const { openSyntheticAttempt, observeSyntheticAttempt } = await import('../scripts/simulation-attempt.mjs');
      const { createDescriptionSimulation, descriptionSimulationBinding } = await import('../scripts/simulate-description-pilot.mjs');
      const attempt = await openSyntheticAttempt(options.attemptId, descriptionSimulationBinding());
      observeSyntheticAttempt(attempt, async phase => {
        if (phase === 'simulated_submission') submissions++;
        await send({ type: 'checkpoint', phase, submissions, guard: guard.snapshot() });
        if (options.stopAt === phase) await new Promise(() => {});
      });
      fixture = await createDescriptionSimulation({ attempt, fault: options.fault || 'none' });
      await send({ type: 'bound', address: fixture.lifecycle().address, attempt: fixture.attemptDetails, guard: guard.snapshot() });
      const proposal = await fixture.request('/api/connections/shopify/writes', fixture.body);
      assert.equal(proposal.status, 200);
      const write = proposal.body.write;
      const approval = await fixture.request(`/api/approvals/${write.approvalId}/decision`, { decision: 'approved', revision: 1 });
      assert.equal(approval.status, 200);
      const go = options.waitForGo ? new Promise(resolve => process.once('message', message => { assert.equal(message.action, 'go'); resolve(); })) : null;
      await send({ type: 'ready', submissions, attempt: fixture.attemptDetails, guard: guard.snapshot() });
      if (go) await go;
      const execution = await fixture.request(`/api/connection-writes/${write.id}/execute`, {});
      result = { httpStatus: execution.status, writeStatus: execution.body.write?.status,
        code: execution.body.code || execution.body.write?.errorCode, provider: { ...fixture.provider.counts },
        finalizations: fixture.storage.calls.finalize, attempt: fixture.attemptDetails };
    }
  } catch (error) { result = { error: error.code || error.name }; }
  finally {
    try { if (fixture) await fixture.close(); }
    catch (error) { result = { ...result, cleanupError: error.code || error.name }; process.exitCode = 1; }
    await send({ type: 'result', simulated: true, ...result, submissions, guard: guard.snapshot(), lifecycle: fixture?.lifecycle() });
    process.disconnect();
  }
});
