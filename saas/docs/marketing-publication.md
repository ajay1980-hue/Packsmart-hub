# Exact Meta campaign preparation and local simulation

This increment prepares one Instagram image publication from an existing
campaign. It reuses connection writes, owner approvals, conditional workspace
saves, dispatch phase claims, audit records and the existing Instagram operation.
Production preparation and publishing remain disabled. There is no new queue, service, database,
grant, credential reader, environment switch or HTTP simulation issuer.

## API contract

All routes require the current workspace owner. POST also requires CSRF, but
production preparation is refused on every store, including Supabase and servers
with the legacy governed-producer stage enabled. Responses are no-store.
The tests explicitly use a local durability harness. Quiet startup
refuses these routes before storage access.

- `GET /api/marketing/campaigns/:id/publication/meta/preview` requires exactly
  `pageId`, `creativeRequestId`, and `assetUrl`, each once.
- `POST /api/marketing/campaigns/:id/publication/meta` accepts exactly
  `requestId`, `sourceRevision`, `target`, `caption`, and `asset`. Use the exact
  preview values plus a stable 16–100 character request ID. No authority override
  or caller-provided receipt is accepted. This route currently returns
  `META_PUBLICATION_PREPARATION_CLOSED` before creating any write, approval or
  audit record. It has no simulation-capability issuer.
- `GET /api/marketing/campaigns/:id/publication/meta/requests/:requestId` reads
  the exact saved request and its receipt. It neither writes nor dispatches.

The preview binds the retained account/connection, Page and Instagram account,
connection-settings revision, required scope metadata, full campaign copy,
selected caption, current product/variant, stock, source cost row, marketing
settings, and one completed Canva social-post export. The asset binding includes
its request/job identity, completion evidence, selected exact URL and reference
digest. Both write identity and the separate owner approval bind this proposal.
The public approval projection includes exact caption, destination and asset.
The cost binding uses the same SKU-first, variant-ID fallback as the financial
checks, preserving exact source amounts even when display rounding is unchanged.

Local preparation requires a private capability bound to the exact workspace,
owner session, campaign and request body. It is issued only by trusted local
simulation composition, never by HTTP or environment configuration. This creation
fence is necessary because predecessor executors do not recognize the new
publication marker and can execute such records. Simulated records must remain
in isolated local fixtures; they are not safe to import into an older live fleet.
Production creation requires separately reviewed compatible-fleet activation.

A reference digest does **not** verify remote image bytes, MIME type, licensing,
current provider ownership or immutable URL delivery. The DTO explicitly says
`bytesVerified: false`. None of those checks is silently treated as passed.
The completed export is reused; this path never creates paid creative work or
changes creative allowance gates. Costs remain recorded evidence; source invoice
verification and order profit are not established by the marketing margin check.

## Local image snapshots and database identity

Trusted local simulation composition may additionally call
`createMetaPublicationLocalAsset` with copied image bytes. It returns an opaque
in-process capability, not JSON authority. A maximum 8 MiB PNG subset is checked
for signature, IHDR dimensions/format, chunk lengths and CRCs, IDAT presence and
terminal IEND. Only noninterlaced 8-bit grayscale/RGB/grayscale-alpha/RGBA and
IHDR/IDAT/IEND chunks are accepted. This does **not** decompress or render the
image, certify provider format support, fetch the URL, verify ownership, or
establish that Meta receives those bytes. Shared buffers and proxies are refused;
intrinsic typed-array metadata prevents accessor overrides and sliced views are
copied exactly.

The descriptor binds SHA-256, byte length, dimensions, declared MIME and the
exact workspace/campaign/request/job/completion/URL/reference context. The source
fingerprint, owner approval, simulated phase observations and receipt bind that
same descriptor. Changed bytes under an unchanged URL require a new proposal;
wrong, copied or missing capabilities cannot execute a byte-bound proposal.
Persisted metadata alone never restores a capability after restart. Trusted local
composition must supply and validate the same bytes and context again.

Only allowlisted descriptor fields appear in approval displays. No bytes, base64,
local filename, or buffer enters workspace state or audit output. `bytesVerified`
and `providerDeliveryVerified` remain false, and `decoded` is false. Reference-only
simulations remain supported without claiming local byte verification.

New proposals explicitly bind
`dispatchIdentitySchema: runvara-meta-publication-canonical-dispatch/v1`.
Only those proposals canonicalize object-key order for dispatch identity and
authority, preserving every field, value and array position across JSONB storage.
The input digest reconstructs the original fixed producer key order. Legacy
dispatch claims retain their original hashing contract; no existing claim or
receipt is rewritten, reset or upgraded. Unknown dispatch contracts are refused.
This does not remove the production creation fence or make synthetic records
safe to import into older live executors.

## Admission and duplicate rules

Preparation rechecks all seven marketing eligibility conditions, requires a known
integer inventory count, refuses changed draft product details, and checks the
existing selected connection, scopes and permission mode. Draft-only marketing
mode and disabled channels refuse preparation. Every prepared request reserves
one slot under the existing daily organic limit. Uncertainty or failure does not
silently free a slot or permit another request for the same logical publication.

The logical identity is workspace + campaign + connection/account + Page +
Instagram target. A new request ID cannot bypass an existing request for that
identity, even after copy changes. Retrying an identical request returns its
retained history without another approval or save. Different intent under a used
request ID conflicts. Legacy campaign-only approval payloads confer no authority.

Execution requires an opaque capability bound to one saved write and a fixed
network-free simulation adapter. The ordinary HTTP execution route has no such
capability and refuses the marked request before credential preparation, storage
mutation or transport. JSON flags, a copied capability or another adapter cannot
open it. The simulation cannot accept an external transport callback.

Before each unsent phase, execution checks the exact approval, current actor and
session, source fingerprint, authority and full-workspace revision. Conditional
saves and their exact acknowledgements persist admission before transport. Source
and approval guards run immediately before serialization as well. The final
revision check attests the full source even when the store returns a narrow
authority projection.

## Interruption and reconciliation

The existing Instagram operation has separate container and publication claims:

1. A container claim is saved before synthetic container creation. An unknown
   container result is unresolved and cannot be sent again.
2. A known saved container may remain `processing`. A later explicit simulation
   can observe readiness and perform only the still-unsent publication phase.
   Current eligibility is checked again; stale content or low stock stops it.
3. The final publication claim is saved and acknowledged before submission.
   Losing the result leaves an unresolved request, never an automatic retry.
4. A valid numeric publication ID produces a simulation receipt in the same
   terminal conditional save. A later eligibility change cannot erase an already
   observed result; immutable write, approval-decision and claim checks remain.
5. A lost final save acknowledgement is resolved by reading the exact retained
   receipt. If that save never committed, history remains unresolved. This path
   cannot manufacture provider evidence or recover an unknown result from user
   assertions. It never republishes during reconciliation.

Receipt digests bind workspace, write/request, publication proposal, claim,
approval decision, container and result. These are mutable application records
under the existing workspace CAS, **not independently protected ledger receipts**.
All simulation results say `simulated: true` and `executedExternally: false`;
approval/work history also avoids claiming a real post.
Confirmation also requires the container identity to agree in the receipt,
retained provider state and container-phase result. Missing or conflicting
identities are rejected; reconciliation never repairs them by resending.

## Remaining activation work

Live publication needs a separately reviewed immutable asset/content contract,
fresh Meta account/asset/scope checks, a protected Meta receipt/storage contract,
native database concurrency and fleet rollout acceptance, provider-specific
read-only reconciliation, and explicit approval of the exact live operation.
The Shopify protected receipt schema is not reused as Meta authority. No migration
or hosted acceptance is included here. The existing advertising, cost, stock,
approval, tenant and creative allowance controls must remain in force.

The current endpoints expose preview/history and a closed preparation route; this increment does not
add an end-to-end customer publishing UI or activate a real publisher.
