import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { seededRequest } from './content-execution-receipt-pg-dispatch.mjs';

export async function runDescriptionProcessPgProof({ admin, connectionString }) {
  const dataDirectory = (await admin.query("SELECT current_setting('data_directory') data")).rows[0].data;
  const active = new Set(), summaries = [];
  const seed = async () => {
    const workspaceId = 'description-process-' + randomUUID(), fixture = await seededRequest('description', workspaceId);
    await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [workspaceId]);
    await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [workspaceId, fixture.state]);
    return { workspaceId, session: fixture.session };
  };
  const launch = (fixture, pauseAt = []) => {
    const env = Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','PATH','NODE_PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    env.OUTCOME_ALLOW_DISPOSABLE_TEST_DB = '1';
    const child = fork(new URL('./description-edit-pg-worker.mjs', import.meta.url), [], { env, windowsHide: true, stdio: ['ignore','pipe','pipe','ipc'] });
    active.add(child); const events = []; let diagnostics = '', ended = false;
    child.stdout.on('data', b => { diagnostics += b; }); child.stderr.on('data', b => { diagnostics += b; });
    const closed = new Promise(resolve => child.once('close', (code, signal) => { ended = true; active.delete(child); resolve({ code, signal }); }));
    child.on('message', message => events.push(message));
    const waitFor = predicate => new Promise((resolve, reject) => {
      const existing = events.find(predicate); if (existing) return resolve(existing);
      const timer = setTimeout(() => { clean(); reject(Error('Synthetic worker timed out: ' + diagnostics.slice(-1000))); }, 20000);
      const onMessage = message => { if (message.kind === 'fatal') { clean(); reject(Error(JSON.stringify(message))); } else if (predicate(message)) { clean(); resolve(message); } };
      const onClose = () => { clean(); reject(Error('Worker ended before expected event: ' + diagnostics.slice(-1000))); };
      const clean = () => { clearTimeout(timer); child.off('message', onMessage); child.off('close', onClose); };
      child.on('message', onMessage); child.once('close', onClose);
      if (ended) onClose();
    });
    child.send({ kind: 'start', connectionString, dataDirectory, ...fixture, pauseAt });
    return { child, events, closed, waitFor, resume: point => child.send({ kind: 'continue', point }) };
  };
  const rows = async workspaceId => (await admin.query(`SELECT
    (SELECT count(*)::int FROM public.runvara_content_admissions WHERE workspace_id=$1) admissions,
    (SELECT count(*)::int FROM public.runvara_content_receipts WHERE workspace_id=$1) receipts,
    (SELECT state#>>'{connectionWrites,0,status}' FROM public.saas_workspace_state WHERE workspace_id=$1) status`, [workspaceId])).rows[0];
  const mutations = worker => worker.events.filter(e => e.point === 'provider-confirmed').length;
  try {
    const f = await seed(), one = launch(f, ['ready']), two = launch(f, ['ready']);
    await Promise.all([one.waitFor(e => e.point === 'ready'), two.waitFor(e => e.point === 'ready')]);
    assert.notEqual(one.child.pid, two.child.pid); one.resume('ready'); two.resume('ready');
    const results = await Promise.all([one.waitFor(e => e.kind === 'result'), two.waitFor(e => e.kind === 'result')]);
    await Promise.all([one.closed, two.closed]);
    assert.equal(results.filter(r => r.status === 'completed').length, 1);
    assert.equal(results.filter(r => r.errorCode === 'STATE_CONFLICT').length, 1);
    assert.equal(mutations(one) + mutations(two), 1);
    assert.deepEqual(await rows(f.workspaceId), { admissions: 1, receipts: 1, status: 'completed' });
    summaries.push({ scenario: 'concurrent-processes', processes: 2, completed: 1, conflicts: 1, providerMutations: 1 });
    for (const crashPoint of ['initial-committed','reserve-before-commit','reserve-uncommitted','reserve-committed','provider-confirmed','finalize-before-commit','finalize-uncommitted','finalize-committed']) {
      const fixture = await seed(), first = launch(fixture, [crashPoint]);
      await first.waitFor(e => e.point === crashPoint);
      assert.equal(first.child.kill('SIGKILL'), true); await first.closed;
      const committed = crashPoint === 'finalize-committed';
      const admitted = !['initial-committed','reserve-before-commit','reserve-uncommitted'].includes(crashPoint);
      const sent = ['provider-confirmed','finalize-before-commit','finalize-uncommitted','finalize-committed'].includes(crashPoint);
      const expected = { admissions: admitted ? 1 : 0, receipts: committed ? 1 : 0, status: committed ? 'completed' : 'executing' };
      assert.deepEqual(await rows(fixture.workspaceId), expected);
      const restart = launch(fixture), result = await restart.waitFor(e => e.kind === 'result'); await restart.closed;
      if (committed) assert.equal(result.status, 'completed'); else assert.equal(result.errorCode, 'WRITE_ALREADY_ATTEMPTED');
      assert.equal(mutations(first), sent ? 1 : 0); assert.equal(mutations(restart), 0);
      assert.deepEqual(await rows(fixture.workspaceId), expected);
      summaries.push({ scenario: crashPoint, actualProcessTermination: true, restarted: true, providerMutations: sent ? 1 : 0, replayMutations: 0, ...expected });
    }
  } finally {
    await Promise.all([...active].map(child => new Promise(resolve => { child.once('close', resolve); child.kill('SIGKILL'); })));
  }
  console.log('DESCRIPTION_PROCESS_PG_PROOF=' + JSON.stringify(summaries));
}
