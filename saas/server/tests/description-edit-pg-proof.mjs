// Imported only after the existing harness proves a newly created, empty,
// disposable PostgreSQL 17 database on loopback. Never a production fallback.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { paragraphCases, descriptionFixture, descriptionInput, descriptionTimestampCases } from './description-edit-fixture.mjs';
import { contentPilotFixture } from './content-pilot-test-fixture.mjs';
import { contentInputPreimage } from '../lib/content-write-identity.mjs';
import { runContentReceiptDispatcherPgTests } from './content-execution-receipt-pg-dispatch.mjs';

export async function runDescriptionEditPgProof({ admin, withService }) {
  const old = await contentPilotFixture(); await old.run();
  const legacy = old.receiptCommits[1].receipt.source;
  const original = (await admin.query('SELECT public.runvara_outcome_action_input_text($1) input, public.runvara_outcome_action_request_digest($1,$2,$3) request, public.runvara_outcome_action_identity_digest($4) identity',
    [legacy.input, legacy.context.account, legacy.context.apiVersion, legacy])).rows[0];
  const rowsBefore = (await admin.query('SELECT workspace_id,attempt_id,receipt FROM public.runvara_content_receipts ORDER BY workspace_id,attempt_id')).rows;
  await admin.query(await readFile(new URL('../supabase/prepared/description-edit-contract.sql', import.meta.url), 'utf8'));
  assert.deepEqual((await admin.query('SELECT workspace_id,attempt_id,receipt FROM public.runvara_content_receipts ORDER BY workspace_id,attempt_id')).rows, rowsBefore);
  const after = (await admin.query('SELECT public.runvara_outcome_action_input_text($1) input, public.runvara_outcome_action_request_digest($1,$2,$3) request, public.runvara_outcome_action_identity_digest($4) identity',
    [legacy.input, legacy.context.account, legacy.context.apiVersion, legacy])).rows[0];
  assert.deepEqual(after, original, 'Historical preimages are byte-for-byte unchanged');
  for (const row of paragraphCases) {
    const query = () => admin.query('SELECT public.runvara_description_replace($1,$2,$3) result', [row.html, row.paragraph, row.text]);
    if (row.expected) assert.equal((await query()).rows[0].result, row.expected, row.name);
    else await assert.rejects(query, { code: 'P0O01' }, row.name);
  }
  for (const [baselineUpdatedAt, valid] of descriptionTimestampCases) {
    const input = { ...descriptionInput(), baselineUpdatedAt };
    const query = () => admin.query('SELECT public.runvara_description_validate_input($1::jsonb)', [input]);
    if (valid) await query(); else await assert.rejects(query, { code: 'P0O01' }, baselineUpdatedAt);
  }
  const f = await descriptionFixture(); await f.run();
  for (const fixture of [old, f]) {
    const descriptor = fixture.receiptCommits[1], source = descriptor.receipt.source, c = source.context;
    const values = (await admin.query('SELECT public.runvara_outcome_action_input_text($1) input, public.runvara_outcome_action_request_digest($1,$2,$3) request, public.runvara_outcome_action_identity_digest($4) identity, public.runvara_outcome_validate_source_action($4,$5) source, public.runvara_content_make_receipt($6,$4) receipt',
      [source.input, c.account, c.apiVersion, source, c.workspaceId, descriptor.admission])).rows[0];
    assert.equal(values.input, JSON.stringify(contentInputPreimage(source.input)));
    assert.equal(values.request, fixture.expected.requestDigest); assert.equal(values.identity, fixture.expected.identity);
    assert.deepEqual(values.source, source); assert.deepEqual(values.receipt, descriptor.receipt);
  }
  await assert.rejects(() => admin.query('SELECT public.runvara_content_make_receipt($1,$2)', [old.receiptCommits[1].admission, f.receiptCommits[1].receipt.source]), { code: 'P0R01' });
  for (const role of ['public','anon','authenticated','service_role']) {
    const permissions = role === 'public'
      ? (await admin.query("SELECT p.proname, EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') allowed FROM pg_proc p WHERE p.proname LIKE 'runvara_description_%'")).rows
      : (await admin.query("SELECT p.proname,has_function_privilege($1,p.oid,'EXECUTE') allowed FROM pg_proc p WHERE p.proname LIKE 'runvara_description_%'", [role])).rows;
    assert.equal(permissions.length, 3); assert.ok(permissions.every(row => row.allowed === false));
  }
  await runContentReceiptDispatcherPgTests({ admin, withService, families: ['description'] });
  console.log('DESCRIPTION_EDIT_PG_PROOF=' + JSON.stringify({ paragraphCases: paragraphCases.length, timestampCases: descriptionTimestampCases.length, legacyBytesPreserved: true,
    versions: ['v1','v3'], descriptionDispatcherModes: 12, providerTraffic: 'synthetic', productionConnections: 0 }));
}
