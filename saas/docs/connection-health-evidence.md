# Saved connection health evidence

Connection health is a read-only projection of the workspace's saved state. Opening it does not test authorization, contact a provider, refresh a token, schedule work, or change connection recovery. Existing status labels and action names remain compatible with the Connection Centre.

## Read freshness

`dataFreshness` retains its `current`, `stale`, and `not_measured` vocabulary. It describes the age of recorded successful reads for the selected, implemented connector areas, not complete provider coverage or current authorization.

- Automatic mode requires `autoSync: true`, no disconnect tombstone, and an existing supported frequency of 15, 30, 60, 180, 360, or 1440 minutes. The warning window remains `max(2 * frequencyMinutes, 60)` minutes. An age equal to the window is current; an age greater than it is stale.
- Each selected area uses only `integrationStatus[provider].areaSuccessAt[area]`. All selected areas must have valid, nonfuture evidence within the window to report current. Any measured stale area makes the overall result stale; otherwise missing evidence leaves the result unmeasured. An empty selection never reports current.
- Manual or disconnected mode reports unmeasured freshness without a scheduled window, even when a saved success is recent. Saved timestamps remain visible as history. Manual-mode health messages do not promise automatic read recovery, and `nextRetryAt` is null in the projection.
- `freshnessEvidence` identifies the source, mode, window, bounded selected-area evidence, and each timestamp's validity. `all_recorded` means all selected areas have a valid historical timestamp; it does not mean those reads are recent or complete.
- Aggregate `lastSuccessfulSyncAt`, completed run history, first-sync completion, and adapter `lastSyncAt` remain historical summaries. None can substitute for per-area evidence. A products-only completion cannot make orders current.

The sole `areaSuccessAt` writer is `finishConnectionSync` in `connection-centre.mjs`. It stamps only `run.areas` when the run returns without an error, a `lastError`, or a degraded result. Partial and failed runs do not advance these timestamps. `monitoredSync` in `scheduler.mjs` merges previous integration state before calling that writer, preserving evidence for unselected areas even when an adapter replaces its status object. First-sync groups use this same monitored path; their final summary alone does not establish area freshness. Successful subsets of a partial grouped read may therefore remain unmeasured or retain older evidence. This projection does not infer missing success timestamps or alter any writer.

## Authorization and expiry

`lastCheckedAt` is written after successful identity verification by the OAuth callback in `server.mjs` and by `testConnection` in `connector-oauth.mjs`. It is a historical successful check, with no existing authorization TTL. Health exposes its validated timestamp in `lastConnectionTestAt` and `authenticationEvidence`, but never promotes it to current verified authorization. Explicit saved authorization failures, missing reported scopes, or expired saved access remain attention conditions ahead of unrelated read failures or exhausted read-retry messages. Health uses the same active eBay OAuth/Manager record selected by the Connection Centre; an inactive record's errors cannot replace that record's evidence. The doctor's existing record selection and recovery behavior are unchanged. `authenticationEvidence.currentAccess` stays `not_measured`.

`connectionAccessExpiry` already reads the saved encrypted credential expiry locally and returns an ISO timestamp or null. Health only consumes that existing projection; it adds no credential access. `accessExpiry` distinguishes unknown, expired, expiring within 24 hours, and not expiring within that window. An expiry equal to the current time is expired; exactly 24 hours remaining is not expiring. A future expiry is evidence of the saved expiry date, not proof of currently usable access or successful future renewal. Missing or malformed expiry remains unknown.

Historical read/check timestamps in health fields must be valid ISO date-times with an explicit timezone and must not be in the future. Missing, malformed, impossible-date, and future values produce null health timestamps and explicit evidence states instead of leaking the raw value or implying success. Legacy channel history fields are unchanged. Future values are valid for expiry and saved retry targets. Existing persistence and scheduler health fields keep their separate meanings.

## Verification and release boundary

Focused tests cover manual mode, warning boundaries, selected-area omissions, products-only completion, partial/failed completion, invalid and future timestamps, historical authentication, explicit failure precedence, expiry boundaries, tenant isolation, bounded output, and absence of state mutation, provider requests, and timers. The existing connection-doctor test now requires per-area evidence before expecting Healthy. Full server tests, syntax checks, and the existing SaaS guard remain release gates.

Local validation on 2026-10-07 passed all 575 server tests, `npm --prefix saas/server run check`, `node saas/tests/saas-guard.test.cjs`, and `git diff --check`. Independent review also passed the 27 evidence/doctor tests with no remaining blocking findings. Docker is unavailable in this executor, so the container build was not run.

This change adds no schema, network path, polling loop, recovery behavior, credential change, or production operation. Existing records without area evidence intentionally display uncertainty until a successful existing sync records that evidence. A green local suite does not establish live provider access or production health.
