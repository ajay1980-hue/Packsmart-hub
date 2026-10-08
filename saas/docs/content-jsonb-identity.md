# Shopify content JSONB identity compatibility

This repair covers current Shopify `product_content` requests from three producers: manual requests without a policy proposal, manual requests with the v1 policy proposal, and objective content requests with the v2 proposal. PostgreSQL JSONB may reorder object keys; the previous raw `JSON.stringify` comparisons could therefore reject an unchanged stored request. Local PostgreSQL 17.6 casts reproduce that storage effect. This evidence does not establish a production incident or a live Supabase deployment.

## Two separate comparison contracts

`server/lib/content-write-identity.mjs` reconstructs the current producers' existing durable preimages. It does not change any digest version, persisted record, provider request or SQL serializer. The input order stays `productId`, `operation`, `title`, `description`. The claim outer order and every known nested proposal, policy entry, v2 source, approval payload and consent order are reconstructed exactly as the current producer emits them. Policy array order remains significant. Authority retains its existing outer order, credential hash and intentional granted-scope sorting.

`contentWriteSnapshot` is a separate temporary comparison. It captures immutable text, sorts object keys only, and preserves all fields, null versus absence, scalar values and types, and array order and length. Finite fractional/exponent numbers remain allowed; negative zero remains distinguishable from zero. Unknown ordinary fields outside the signed layouts remain in the full snapshot. The implementation never uses an evidence/display DTO as authorization data.

Snapshots reject getters, non-enumerable or symbol fields, functions, undefined, bigint, nonfinite numbers, custom prototypes, proxies, cycles, sparse arrays and decorated arrays. Descriptor/prototype checks run without invoking getters or `toJSON`. Malformed JSON cannot obtain a legacy fallback.

## Selection and legacy behavior

Before the first await for a retained request, the dispatcher pins either the supported producer family or the existing legacy comparison path. Eligibility requires exact known signed input/proposal/policy/source/payload/consent layouts, ordinary scalar authority fields, opaque string credentials and dense string scope arrays. Existing semantic owner/session/scope/approval/policy/source validators still run independently; recognizing a layout grants no authority.

Unknown signed JSON fields, including matching workspace or tenant fields in the signed input/payload, remain on the original path for the entire request. Unknown authority layouts also remain legacy. They are never dropped, re-signed, permuted, or retried under another comparison contract. A supported request that changes after an await rejects; it cannot switch to legacy. Meta, Shopify tags and internal notes retain the original path. Missing approval or connection data in exact retained history does not become a new execution eligibility gate.

## Caller coverage

| Caller | Comparison |
| --- | --- |
| Saved input checks during execution and retained local checks | Exact supported producer input bytes, otherwise original digest |
| Admission, retained claim checks and both narrow workspace rereads | Exact supported claim preimage, otherwise original identity |
| Initial/local/ACK/narrow authority and supplied precommit authority | Existing checks with exact supported consent/payload preimages |
| Objective history source await | Full immutable temporary write snapshot |
| Objective preparation source reread, private beforeCommit and save ACK | Full immutable temporary write/approval snapshots captured before the source await |
| Execution source/credential preparation awaits | Supported full write/approval snapshots captured before awaits, retaining membership and uniqueness checks |
| Claim save, phase save, final save, private beforeCommit and ACK | Full write and approval snapshots; existing revision, workspace, membership and CAS checks retained |
| Both narrow workspace rereads | Full write and supported approval snapshots plus durable identity and authority |
| Submitted v2 decision and claim | Full temporary snapshots; only the three pre-existing approval completion fields are omitted from decision comparison |
| Admissions, credential digest and explicit config binding | Existing bytes, ordered admissions and semantic checks unchanged |
| Provider request body and phase request digest | Existing exact bytes unchanged |

Supported manual saves now pass the existing synchronous `beforeCommit` guard. This closes a concrete boundary where an altered supplied save snapshot (approval, credentials, scopes, owner or admissions) could otherwise persist before the ACK comparison detected it. Both stores invoke this guard immediately before constructing the serialized commit. The guard checks the retained state and supplied snapshot against immutable captures, including authority before submission and ordered admissions. A private upgraded snapshot legitimately has a new revision; the old live revision must remain unchanged until commit, and the existing store CAS/ACK contract verifies the resulting revision.

Manual saves do not request a new full-workspace clone. Objective v2 retains its existing `ownedSnapshot: true`. The change adds no store reads, saves or provider requests. Temporary comparisons serialize selected rows, decisions and claims; layout selection additionally validates the selected connection and settings.

## Bounds and status behavior

Each strict snapshot is bounded to 2,097,152 UTF-8 bytes, matching the existing primary workspace ceiling rather than imposing an evidence DTO limit. Recursion is bounded to depth 32, the dispatcher's existing recursive scope bound. The traversal limit is 1,048,577 JSON nodes, derived from the minimum serialized bytes per child, so it does not exclude otherwise accepted JSON under the byte ceiling. Limits apply during traversal and string emission. Descriptors are read individually and small output tokens are batched, avoiding a complete descriptor map or millions of retained output fragments for a wide array. The store's existing 32 KiB narrow-context response limit and stricter input/proposal/source/history validators continue to apply independently.

Existing completed requests still return before provider, claim or authority work. Executing, failed, uncertain and rejected requests remain unreplayable. Existing claim fingerprints and workspace must match; phase claims are never removed or reset. Processing and concurrent replicas retain the existing phase/CAS behavior. Known result, lost final acknowledgement and final CAS conflict behavior remains unchanged.

After v2 submission, source/job loss, owner deactivation or policy expiry cannot erase a known result by causing a fresh eligibility check. Exact request, approval decision, submitted claim, admissions, final result snapshots and CAS still protect persistence. This existing v2 exception is not expanded to manual writes.

## Verification and limits

`content-write-identity.test.mjs` covers complete preimage text, known input bytes, all three consent states, legacy pinning, full JSON distinctions, immutable capture, malformed values, descriptor safety and bounds. `content-jsonb-dispatch.test.mjs` exercises supported producer flows, synthetic reordered acknowledgements/private save snapshots, real value changes, replay fences, concurrency, post-submission changes and unchanged legacy behavior. `run-content-jsonb-postgres.sh` is the separately opted-in disposable PostgreSQL fixture; it exercises actual JSONB storage roundtrips and reports no live provider or Supabase calls.

Primary Supabase save acknowledgements remain workspace acknowledgements; reordered returned-state tests are explicitly synthetic boundary variations. Existing manual v1 reviewed-source JS/SQL bytes remain unchanged. Objective-v2 publication evidence remains separate and unsupported by v1 evidence. There is no migration, claim reset, backfill, historical arbitrary-key-order guarantee, provider activity or release authorization in this repair.

Rollback here means returning to the immediately preceding compatible prepared executor at `951f2b7`, which retains unknown-envelope rejection and the required v2 readers and guards. That rollback needs no reverse migration and preserves supported existing fingerprints, claims and histories, while restoring the old ordering failures for new attempts. Current main at `d32da62` predates the required guard and is not a safe rollback target for v2 records. No rollback authorizes replay of failed or uncertain writes.
