# Local single-image publication composition

This is an inactive, fixture-only implementation. It uses the existing app,
workspace state, exact campaign/source and approval rules, Meta request
serializer, JPEG decoder and protected publication ledger. It adds no route,
credential reader, live environment switch, migration or second service.

## Durable bytes and approval

`meta-publication-delivery.mjs` snapshots the exact strictly decoded 1080 × 1080
baseline JPEG (maximum 2 MiB). The prepared asset table retains those bytes and
an immutable descriptor binding workspace, actor/session, campaign, selection,
source revision, reference digest, image hash, delivery origin, token digest and
expiry. The original token is not stored; a trusted caller must retain it to
reconstruct the same fixture URL. No renewal, redirect, arbitrary fetch or
replacement is provided. Fixture origins must end in `.invalid`.

The inactive byte handler reauthorizes the original owner/session and checks
expiry and control mode through the database RPC. It returns exact bytes with
private/no-store, no-referrer and nosniff headers. Local byte verification calls
that handler directly and hashes its output. It does not establish public
reachability, CDN behavior or provider retrieval.

Preparing a composition saves a pending approval with exact bytes, caption,
destination, selection, source and delivery descriptor. Approval remains a
separate decision. Existing cost and stock checks apply; no costs are invented.
The legacy `connectionWrites` queue does not receive this new proposal.

## Execution order and retained uncertainty

1. Revalidate owner/session, source, exact approval, asset and financial inputs;
   reserve the existing protected ledger identity and shared daily allowance.
2. Admit at most one container submission, verify the retained bytes, and check
   current provider identity, granted scopes, Page/Instagram binding and quota
   using injected bounded responses. Recheck the exact workspace snapshot before
   each request. The serializer is shared with the existing Meta adapter; this
   fixture forces the hostname to `graph.runvara.invalid` and uses synthetic
   authentication values.
3. Retain the container result, then admit a bounded read of that exact container.
   Publication requires the latest exact `FINISHED` result. Readiness is valid
   for less than 60 seconds from the database admission time; late settlement
   cannot extend it. `IN_PROGRESS` can be checked by a subsequent explicit call
   after cadence permits. There is no polling loop. `PUBLISHED` does not prove
   which publication occurred and cannot authorize publication.
4. Admit at most one publication submission, repeat the fresh gates and persist
   the exact result. Owner revocation closes disclosure and further admission;
   an already admitted exact result can still be retained.

Unknown commit acknowledgements perform only an exact retained lookup. Replayed
or recovered admissions cannot dispatch. An ambiguous GET/POST leaves its hold
in place across restarts. There is no automatic retry, timeout lease release,
cleanup reset or token renewal. Readiness has no operator release shortcut;
unresolved work stays closed for separately authorized review.

The new readiness table shares the existing ledger control lock, global two and
account one active slots, account 60-second cadence, five lifetime read attempts
per proposal and five-minute read horizon. A trigger makes older ledger
admissions count readiness holds and debt too. Immutable rows and revocations
cover direct table/helper privileges and truncation. The database owner remains
outside this threat boundary.

## Prepared contracts and acceptance limits

`meta-publication-delivery-v1.sql` and `meta-publication-readiness-v1.sql` depend on
the accepted ledger and its earlier prepared contracts. They are not installed
by application startup or included as live migrations. The provenance is always
`native_fixture_no_provider_action/v1`; provider delivery/read/publish claims
remain false, including after native persistence and restart tests.

Native tests create disposable empty PostgreSQL databases, use actual RPCs and
conditional JSONB writes, and destroy them afterwards. Historical capacity and
time fixtures are explicitly owner-seeded; they are not elapsed-time or real
provider evidence. Hosted PostgREST roles, actual API format/permissions/quota,
public asset bytes, the deployed fleet and authenticated UI still need separate
acceptance. A production issuer, route and live provenance contract require a
reviewed activation change; changing a fixture flag is not a release procedure.

See the workspace evidence directory `commerce-meta-delivery-20261019` for the
frozen candidate, baseline, patch, validation map and consolidated approval plan.
Provider format references: [Meta content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing.md/)
and [media_publish](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media_publish.md/).
