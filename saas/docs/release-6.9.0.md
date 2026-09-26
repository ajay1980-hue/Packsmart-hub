# Runvara 6.9.0 — connection onboarding and safe recovery

Continues production `96f582c41e108ff71896d44b4602e2702772a5b7` on the existing
`packsmart-ops` service. No new service, database, provider credential or OAuth implementation.

## Customer experience

- Six-channel guided setup, optional business preferences, channel skipping,
  read-only recommended defaults, persisted progress and dashboard completion.
- Every successful existing OAuth callback verifies the account and persists a
  first-read job before redirecting. The browser can poll real read stages while
  the same workspace lock protects imports. Interrupted work resumes after its lease.
- Shopify catalogue reads remain grouped; orders/customers have separate first-read
  outcomes. Existing provider adapters and merge rules preserve history. Partial
  results retain successful imports and identify failed areas for retry.
- Central readiness and connection health projections use implemented capabilities,
  actual expiry, scope, sync, scheduler and persistence evidence. Unsupported or
  unmeasured signals are explicit; no numerical health score.
- Customer-only copy for pending providers. Operator readiness is protected by the
  existing platform-owner guard, not just a workspace-owner role.

## Recovery and safeguards

- Auto-Doctor runs inside the existing scheduler/workspace lock, independently of
  the general marketing/business autopilot switch. It renews supported expiring
  credentials and retries interrupted/transient reads with durable exponential
  backoff, Retry-After handling and a five-attempt ceiling.
- Newly connected channels use independent read schedules. Existing settings are
  retained. Disconnected/paused reads, revoked access, account mismatch, scope
  changes and restricted features do not trigger automatic reauthorisation.
- eBay advertising eligibility remains a provider restriction; commerce reads can
  continue without repeatedly requesting restricted advertising data.
- No doctor operation can publish, change stock/prices, spend, delete records or
  execute an approval. OAuth state, browser binding, identity checks, encrypted
  credentials and existing write approval gates remain in place.
- Events use the existing audit_events archive-before-trim path. Per-provider
  current state is bounded by the connector registry. Sync history is archived
  before trimming by the existing persistence layer.

## Database

No migration required. Reuses existing `saas_workspace_state`, `audit_events`
and `runvara_history`. Production read-only verification confirmed RLS enabled,
no anon/authenticated SELECT and service-role access for all three tables.

## Verification

The release workflow retains full syntax, Phase 1, Phase 2, production Docker
build and container health checks. Adds browser layout checks at 320, 390, 768
and 1200 pixels and an uploaded mobile screenshot. Added security, first-sync,
recovery, retry/lease, encrypted rotation, tenant and archive tests.

Local baseline: 121 passing tests. Implementation validation: 134 passing tests,
no skipped tests; Phase 1 safety guards pass. Two pre-existing OAuth tests now
wait for the authorised background read to finish before checking callback replay
and audit evidence; their security assertions are unchanged.

## External restrictions and honest limits

- TikTok Partner/Developer approval and approved app configuration remain external
  blockers. Existing TikTok OAuth code is preserved and becomes available through
  the existing readiness check when approved credentials are enabled.
- Google/YouTube reads channels; Pinterest reads boards/Pins. This release does
  not add unimplemented advertising, feed or publishing capabilities.
- Webhook health is explicitly not monitored; backlog is represented by actual
  active read leases, not a fabricated provider queue length.
- The under-ten-minute journey is a product target, not a measured promise for
  every provider, account size or provider approval state.
- Real provider consent and signed-in production UI verification require an
  authenticated owner browser session. Mocked OAuth tests do not imply live consent.
