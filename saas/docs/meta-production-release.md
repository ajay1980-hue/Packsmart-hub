# Bounded production pilot release

This is a release procedure for the existing app and database, not an activation
authorization or a claim of general commerce readiness. The exact commit, source
patch, SQL hash and validation receipt belong in the local release handover.
Do not rebuild from main, promote simulation records, merge obsolete pilot PRs,
create another service, or install the synthetic fixture schemas.

## Limits the operator must accept

The production publishing routes and recovery UI are owner-only. Admins, members
and viewers cannot use them. There is no member recovery workflow in this pilot.
Capacity is finite: 16 proposals/assets per workspace and 128 globally; retained
records are immutable and there is no purge, refill or uncertain-hold release.
An acceptance proposal consumes real capacity. Unknown outcomes must remain held.
These are explicit pilot limits, not a complete commercial operating model.

The process gate is global and read at startup. Both database controls must be
active to create or approve a proposal; rejection/revocation remains available
while closed. There is no tenant-specific activation
switch, upload-only endpoint, or provider-only preflight endpoint. `/execute`
can create a container and publish in the same call; never use it for a supposedly
read-only check. Saved request reads do not contact Meta or grant resend authority.

## Order of operations

1. Reconfirm the release commit, upstream revision, one existing Render service,
   all running executors and current database catalog. Keep auto-deploy off until
   the approved manual release. Establish authenticated owner and non-owner
   sessions without exporting cookies or inspecting credential values.
2. Establish a recoverable database backup and a usable prior Render artifact
   before approving hosted changes. Record the backup timestamp/restore point,
   scope, secure retention location, operator and tested restore procedure. A
   successful local PostgreSQL test is not backup evidence. A Free Supabase plan
   does not establish automatic backups or PITR. If export/restore is needed,
   obtain specific approval for its sensitive-data handling and any cost before
   running it. Verify artifact availability and the actual rollback operation;
   a live deployment ID alone does not establish rollback eligibility.
3. With explicit release approval, first set and verify
   `RUNVARA_META_PUBLICATION=disabled/v1` by merging that single setting,
   preserving all others. Publish only the reviewed local commit through the
   existing repository's normal review process and manually deploy that exact
   revision to `packsmart-ops`. Verify the deployed revision and
   all workers. Run health, existing commerce and closed-gate checks. Do not call
   publish or treat a closed-gate failure as permission to activate.
4. With explicit database approval, install only the reviewed
   `saas/server/supabase/prepared/meta-production-v1.sql` on the existing database.
   It is one non-idempotent transaction; do not blindly retry an uncertain result.
   Its controls initially remain `prepared`. Verify the catalog before retrying.
   The new guards touch `saas_workspace_state`: allow a controlled maintenance
   window and observe lock contention and existing writer compatibility. Do not
   apply `schema.sql` or the native test harness to the hosted database.
5. Closed checks can prove default rejection, grants and startup compatibility.
   They cannot prove hosted proposal creation or approval, which require active
   gates. Approve a separate, tightly scoped activation window for **proposal
   acceptance only**, naming an existing tenant/campaign/owner, one exact JPEG,
   caption/destination, expiry and record limit. During that window enable the
   process and both controls; verify actual PostgREST shapes, exact review,
   approval/revocation, same-origin asset bytes, denial paths and restart evidence.
   Do not call `/execute`. Global activation technically enables eligible owners,
   so first establish operational exclusivity for all other owners/executors.
   If that cannot be established, the current implementation cannot provide an
   isolated tenant activation window; stop and resolve the scope first.
6. Pause both database controls, disable the process gate and verify the closed
   state at the end of that window. Retain every proposal, asset, audit entry and
   receipt. Separately select and approve a real canary only after hosted, asset,
   fleet and rollback gates pass. Bind one post to the exact image hash/length,
   caption, source, owner, tenant, Page/Instagram IDs, time and zero additional
   spend. Container creation is a provider mutation. Approval in the app and the
   publish action remain separate; required provider confirmations also remain.

## Pause and rollback

The following is an operation template requiring hosted approval, not a startup
migration. The SQL runs through an approved operator connection to the existing
project; no credential value belongs in this document or command output.

```sql
BEGIN;
UPDATE public.runvara_meta_prod_ledger_control_v1 SET mode = 'paused' WHERE id;
UPDATE public.runvara_meta_prod_asset_control_v1 SET mode = 'paused' WHERE id;
COMMIT;
```

Verify exactly one row in each control. For a separately approved activation
window, use the identical transaction with `active` instead of `paused`.
Set the process gate to `disabled/v1` and restart through the approved service
operation. Pausing prevents new admissions; it cannot cancel an already admitted
provider call. Drain executors and retain late outcomes before considering an
application rollback. Never delete protected rows/triggers, reset an unknown
hold, release retained identity debt, or return production work to an older
publishing queue. A predecessor may reject protected workspace writes; that
availability impact must be accepted and verified before rollback. Keep the
contract installed while reverting app code; database restoration is a separate,
approved disaster-recovery action, not routine rollback.

Render rollback can reuse the target deployment's environment, instance count
and start command. Verify that target's non-secret publication-gate behavior and
executor inventory before selecting it; the current service setting alone does
not establish its behavior. Keep database controls paused, then verify the
deployed revision, closed state and retained evidence again after rollback.
See [Render's rollback behavior](https://render.com/docs/rollbacks).

Local regressions and native disposable PostgreSQL evidence do not establish
hosted PostgREST, real provider, public asset rendering or fleet acceptance.
Missing product costs stay blocked. Packing slips and labels remain deferred
until shop launch. Grok remains optional and internal-only.
