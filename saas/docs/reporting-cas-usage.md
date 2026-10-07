# Reporting status write volume

## Observed problem

The earlier one-hour outbound bandwidth reduction did not persist. A bounded Render metrics read on 7 October 2026 returned the following mature hourly observations for the existing `packsmart-ops` service. Values are the API's reported `mb` unit, without an additional unit conversion.

| UTC measurement window | Reported MB |
| --- | ---: |
| 6 October 23:00–7 October 00:00 | 48.750996 |
| 7 October 00:00–01:00 | 48.742996 |
| 7 October 01:00–02:00 | 49.563470 |
| 7 October 02:00–03:00 | 50.302560 |
| 7 October 03:00–04:00 | 51.006720 |
| 7 October 04:00–05:00 | 51.722977 |

The six-hour total is 300.089719 MB, averaging 50.014953 MB/hour. This is 29.78% above the earlier 23-hour baseline of 38.538550 MB/hour. These are observations, not causal savings estimates or billing projections. Render labels bandwidth points with the end of the preceding hourly interval and publishes them with a delay: [service metrics](https://render.com/docs/service-metrics#outbound-bandwidth).

Main and the latest Render live deployment were rechecked at 07:01 UTC on 7 October. Both still pointed to `3ebc1c75370b6a8b843da3829bc1b7af59f0a867`, deployed at 22:24:06 UTC on 6 October. No later deployment appeared in the latest-deploy result. This establishes control-plane deployment stability; it does not establish functional application health.

## Confirmed amplification path

A bounded aggregate over the existing Packsmart workspace's retained automation records found 42 rule runs and 10 distinct claim timestamps in each of the five complete 00:00–05:00 UTC hours. Production source saves a normal scheduler batch's claim and completion separately. Each Supabase save submits the entire workspace twice: once for authoritative business state and once to record the normalized reporting refresh result.

Consequently, these normal batches imply approximately 40 full snapshot submissions per hour before additional connection work, mirrors, archives, retries or public traffic. This is inferred from retained batches and code, not a measured transport request count.

At 06:57 UTC the current snapshot's PostgreSQL JSONB text representation was 1,441,225 bytes. Multiplying this current representation by 40 yields 57.649 decimal MB/hour, illustrating the scale. PostgreSQL JSONB text includes formatting and is not the historical compact JSON request body; this calculation must not be presented as exact wire traffic or an attribution of all Render bandwidth.

The bounded HTTP metrics query returned only three timestamp buckets, totaling 12 requests in the returned series. Missing buckets are not proof of zero traffic. A filtered application-log query returned no matching persistence-integrity, mirror-failure, scheduler-failure, reporting-deferred or startup events for 23:00–05:00 UTC. Neither result substitutes for functional verification.

## Prepared repair and limits

The repair targets only the reporting-status follow-up. The authoritative claim/completion write remains a full-state compare-and-save. A small, bounded server-only database function can update reporting diagnostics and the revision conditionally, preserving durable failure visibility without resending the business dataset.

This reduces application request-body volume for that follow-up. It does not eliminate the database update, guarantee physical storage/WAL reduction, change scheduler frequency, establish provider costs, or guarantee a particular reduction in total Render bandwidth.

In the synthetic 1.4 MB fixture, an existing-workspace save sends a 1,405,167-byte primary body plus a 364-byte reporting body. A real scheduler claim/completion test sends two primary bodies totaling 2,813,843 bytes and two reporting bodies totaling 728 bytes. These are exact test request bodies, excluding HTTP framing; they are not production network measurements. The request bound is 16 KiB and reporting acknowledgement/revision reads are bounded to 4 KiB.

The function must run with caller privileges, retain the exact workspace and expected-revision predicate, reject malformed or excessive input, and change only reporting diagnostics, revision and the row timestamp. It must not accept arbitrary paths or arbitrary business state. Public and customer roles must remain denied. Existing server SELECT/UPDATE privileges were verified read-only; a new narrowly scoped function EXECUTE grant requires specific owner approval before application.

The concrete function is `public.runvara_commit_reporting_status(text,text,text,jsonb,timestamptz)`. It uses `SECURITY INVOKER` and an empty search path. Only the existing `service_role` receives EXECUTE; PUBLIC, anon and authenticated are explicitly denied. No table grant or RLS policy changes. Missing migration, denied execution, invalid legacy diagnostic timestamps or unconfirmed reporting writes remain visibly deferred; there is no full-snapshot fallback. Failed reporting confirmation invalidates scheduler and mirror cache trust.

## Release gates

Local verification on Node 22.23.3 passed 576 Node tests and 73 real PostgreSQL 17.6 tests, with zero skipped, plus syntax and SaaS guards. Database tests use separate physical sessions for competing revisions, check denied roles and unchanged table grants/RLS, and preserve unrelated business bytes. Node tests cover bounded request/response bodies, malformed revision acknowledgements, lost acknowledgements, cancellation and uncertain response-body deferral, no full-state fallback, and no writes on reads. Independent review found no remaining blocking defect after the malformed revision-response case was fixed.

The local Supabase CLI security advisor could not connect to the disposable no-TLS fixture because it insisted on TLS despite the local connection setting. This check is not claimed as passed. Explicit catalog, role, RLS and invoker tests passed; production catalog/advisor verification remains a release step after an approved migration. No live migration was used to work around the local advisor limitation.

Preparation is based directly on current production main, independently of the eight held feature PRs. No production schema change or release has occurred for this repair. The existing live functional verification gate remains blocked by the cloud browser permission-check failure. The owner approval already granted for outcome-history PR #74 does not cover this separate function grant.

Before release: complete the Node, PostgreSQL concurrency/tenant/role and CI checks; review exact request-size evidence; obtain the specific function approval; clear functional health; apply the reviewed migration; verify the resulting catalog/grants; deploy the exact green revision to the existing service; verify fresh production health. A subsequent mature-hour comparison is needed before reporting an observed improvement.

Rollback should restore the prior application revision first. Retaining an unused narrowly scoped function avoids destructive recovery; revoking or removing its access is a separate reviewed database action. Business state, approvals, audit and tenant data must remain intact.


## Held-feature integration rehearsal

The separate implementation was also replayed locally onto the recovery of PR74–81. Its shared CAS helper preserves strict primary-health handling and uses trusted activity contexts for primary writes, reporting writes and compact revision reads. Reporting retries have separate fixed activity keys. Only primary full snapshots update hot-state samples; the small RPC body is request-volume evidence, never saved-workspace size or storage growth.

The combined Node22 suite passed 1,088 tests and the fresh disposable PostgreSQL17.6 reporting gate passed all 73 cases; syntax, SaaS guards and independent conflict review passed. The standalone PR82 CI result does not cover this combined tree. See [business-os-acceptance.md](business-os-acceptance.md) for source, compatibility decisions and remaining approval/health/CI gates.
