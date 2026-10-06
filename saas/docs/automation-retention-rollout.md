# Quota-safe automation evidence retention

Completed automation payloads are compacted only during an existing workspace save. The scheduler still sees every run needed for its UTC-day or configured local-day quota and cooldown checks. Active runs, latest-per-rule records, the newest 25 completed records, current-quota failures/blocked records and malformed/ambiguous records remain intact. Well-formed older terminal errors outside quota/latest protection move to immutable archives, preserving the previous age-eviction behavior rather than retaining them forever. Retained active objects keep their identity so a scheduler claim can still be updated after the pre-execution save.

A retained completed run is compacted only when its exact serialized stub is smaller than its full payload. Small records stay full and cause no early archive writes. Eligible old completed payloads are copied to immutable, content-addressed versions in the existing tenant-scoped runvara_history automationRuns collection. Only exact acknowledged archives can become compact stubs or leave the hot snapshot. A successful revision-guarded primary commit makes the staged representation authoritative. Archive failures and state conflicts do not discard caller-visible full records. Differing same-ID versions cannot overwrite one another; repeated saves and eventual stub eviction never archive the stub over its full payload.

Stubs retain scheduling fields, original evidenceCount and an exact version/digest reference. An empty evidence array is not invented proof of work. Replacing a full payload with a stub preserves its value count. Normal age eviction still changes retained-record totals; these are explicitly retained-record counts, not all-time financial outcomes. Durable cross-archive commercial outcome aggregation remains a separate original-blueprint stage.

## Data and request budget

- No new cleanup timer, scheduler tick, provider request, archive read or save is introduced.
- Initial compaction writes historical payloads earlier. Archive batches are capped at 200 rows and 1 MiB actual serialized request body. A larger single row is isolated only up to 2 MiB; larger records remain full with an explicit pending reason. Admission also bounds PostgreSQL JSONB read expansion (including decimal exponent expansion and whitespace) and the final API response envelope, so an accepted archive remains retrievable under the read cap.
- Insert/ignore-duplicates versions and persisted references make unchanged subsequent saves issue no new automation archive requests.
- Ordinary saves do not hydrate archives. The existing primary CAS and reporting behavior remain in place.
- A single explicit evidence click performs compact identity authentication and one exact tenant/collection/version lookup. Storage response streaming and re-serialized payloads are capped at 2 MiB. The endpoint allows at most ten reads per user/workspace per minute; browser requests coalesce and cache only in the current snapshot/session.

The synthetic 250-run store fixture shrank hot state from 1,325,425 to 269,176 bytes (79.7%). All 250 quota rows and value counts remained; 225 full payloads became stubs. First compaction wrote two immutable archive requests totaling 1,235,927 bytes. An unchanged save wrote zero archive requests/bytes; fixture save request count fell from nine to three. These results describe that fixture, not production bandwidth, database billing or guaranteed savings. Actual savings depend on the tenant's payload composition.

## Evidence access and safety

The existing Automations view gains a collapsed recent-check history using its already-loaded, bounded records. Full active/recent evidence stays readable. Archived evidence is loaded only on request, with explicit unavailable/retry states. The server reconstructs tenant/table/collection scope and verifies run identity plus the canonical full-payload SHA-256; browser-provided scope overrides are rejected. Evidence rendering is capped at 100 items per record with an explicit omitted count and bounded, type-checked text. Stored text is escaped, late responses cannot cross sessions/snapshots, and archive hashes are not displayed as product content.

No database schema, RLS, grants, credentials or external business actions change. All archive versions remain recoverable through the exact-reference reader. Records too large or malformed to archive safely remain full; this change must not claim universal hot-state size guarantees.

## Verification and rollback

`AUTOMATION_RETENTION_ENABLED` defaults to enabled when unset. The server reads it when constructing the Supabase store, so applying `AUTOMATION_RETENTION_ENABLED=false` requires a restart/redeploy of the same stub-aware code. Store diagnostics expose the effective boolean as `automationRetentionEnabled`. Disabled mode skips automation planning, archival and compaction/eviction; existing full records and stubs remain intact. Removing the flag or setting it to `true` resumes planning on subsequent existing saves. No production setting was changed while adding this safeguard.

Required regressions cover quota/cooldown equality, UTC/local midnight and DST, active claim→save→finish→save identity, archive failure, CAS conflict, differing same-ID versions, unchanged-save/restart behavior, stub eviction, tenant/run/digest rejection, payload/response size boundaries, zero extra reads/provider calls, and explicit UI lifecycle/cache controls. Full security/tenant, responsive browser, PostgreSQL and container gates precede release.

Set the server-only AUTOMATION_RETENTION_ENABLED=false flag to stop new automation compaction while retaining stub-aware counts/readers and immutable archive handling. This does not rehydrate records or change other retention behavior. A blind binary revert could miscount evidence or write stubs into legacy archive keys. Do not automatically rehydrate all records: the resulting snapshot may exceed the existing 2 MiB hard limit. Any restoration must be bounded, tenant-scoped and revision-guarded, with archived versions preserved.
