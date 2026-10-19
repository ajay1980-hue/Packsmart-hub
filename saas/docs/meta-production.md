# Protected Instagram production path

This implementation extends the existing Runvara app, database and service. It
does not activate publication. The existing synthetic contracts retain their
original names and immutable fixture provenance; no fixture record is promoted.

`meta-production.mjs` composes the current owner/session, normal Supabase store,
existing IntegrationService credential resolver and Meta serializer. New contracts
use `production-v1`, `server_meta_publication/production-v1` and `runvara_meta_prod_*`
objects. Installation of `supabase/prepared/meta-production-v1.sql` and activation
are separate consequential steps; this file is not imported by startup. Its two
controls start `prepared`. No hosted SQL has been applied as part of this work.

The process requires `RUNVARA_META_PUBLICATION=enabled/v1`, the exact existing
public origin `https://packsmart-ops.onrender.com`, the normal durable store, and
the existing credential-encryption key and Meta app secret. There is no test mode
that turns fixture evidence into production authority. No new credential is
requested, refresh or reconnect is performed, or fallback account is selected.
Tests inject network through IntegrationService's fetch boundary.

## Registered routes and owner actions

- `GET /api/meta-production/campaigns/:campaign/context` reads saved choices.
- `POST .../:campaign/proposals` retains an existing 1080×1080 baseline JPEG,
  at most 2 MiB, and creates a pending exact proposal after current campaign,
  product, variant cost, stock and connection checks.
- `GET .../:campaign/requests/:request` reads the exact proposal and retained
  outcome. It never contacts Meta or grants resend authority.
- `GET .../:campaign/requests/:request/image` returns exact retained image bytes
  only to a freshly authorized owner for review, including while execution is off.
- `POST .../:campaign/requests/:request/decision` requires exact consent binding
  caption, image SHA-256/length, source revision, connection/Page/Instagram and
  a one-post count. The generic approval and edit routes cannot substitute.
- `POST .../:campaign/requests/:request/execute` is a separate explicit action.
  It requires the same consent and fresh source/actor/approval checks. A retained
  uncertain mutation can never be resent. A later explicit action may perform a
  bounded readiness check and publish an already approved, acknowledged container.
- `GET /api/meta-publication-assets/production-v1/:digest/:token.jpg` returns the
  exact retained JPEG after SQL and server checks. The server derives a 256-bit
  bearer value with a domain-separated HMAC using the existing encryption key.
  Only its digest is retained. No arbitrary URL/path is fetched. Responses are
  no-store; expiry, actor/session/source changes and approval revocation close
  delivery. Application errors redact the bearer path.

All authenticated mutations retain existing cookie/CSRF and owner requirements.
The UI shows the exact retained bytes, caption, destination, source and expiry,
then requires separate approval and publish actions. It stores only the scoped
request reference in sessionStorage. Late responses after a session change are
discarded. Unknown outcomes offer an exact saved read, with no automatic resend.
Retained readiness uncertainty, terminal container results and exhausted attempts
close continuation. A `PUBLISHED` container without a retained publication ID
remains unresolved. Cooldown status includes the earliest next review time;
reading saved evidence never performs a provider check.

## Provider and database boundaries

The adapter uses the existing encrypted user connection, verifies `/me` and
permissions, then uses one bounded `/me/accounts` response to select the exact
Page/tasks/Instagram identity and its Page token. Tokens remain server-side and
are not part of retained events. It never follows provider pagination URLs.
The Page token is used for media creation/publication and container status.
Current quota is read explicitly; absent or invalid quota is a closed gate.
Fresh state and deadline checks run again after credential resolution and before
each fetch. Same-origin asset verification compares exact delivered bytes; it
does not claim Meta fetched or rendered the image.
Requests ask for identity encoding. If Node fetch has already decoded gzip,
deflate or Brotli, the production adapter removes only recognized wire encoding
metadata, preserving status, redirects and media type. The unchanged bounded
reader limits the decoded stream and elapsed time. Unknown encodings, oversized
decoded bodies, malformed lengths, redirects and error statuses remain closed.

Meta references: [Pages/tasks/tokens](https://developers.facebook.com/documentation/pages-api/manage-pages.md/),
[content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing.md/),
[publishing limit](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit.md/).

Production tables are RLS-enabled and inaccessible directly to anon,
authenticated and service_role. Only eight bounded definer RPCs are granted to
service_role. Helpers have no public grants. Immutable rows, full-state comparison,
shared locks and pending-approval predecessor fences prevent legacy writers from
rewriting protected identities. Admissions, permanent uncertain holds, exact
settlement and bounded readiness debt survive process restarts. Late results can
be retained after revocation without granting another operation.

The current finite contract retains at most 16 assets/proposals per workspace,
128 globally, and 24 ledger events per proposal. Shared active holds are capped
at two globally/one per account, with five lifetime readiness/read attempts,
60-second cadence and a five-minute horizon. There is no pruning, budget refill,
automatic polling, token renewal or hold-release endpoint in this increment.

Local injected-network and disposable PostgreSQL tests are not real-provider,
hosted PostgREST, deployed fleet/rollback, public asset retrieval or authenticated
production E2E acceptance. Those remain separate gates. No production settings,
schema, credential values or real posts were accessed or changed by local tests.
