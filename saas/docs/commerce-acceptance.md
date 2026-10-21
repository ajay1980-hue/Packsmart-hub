# Commerce completion and activation scope

Continue the existing Packsmart-hub application, packsmart-ops service and its
existing production database. The local pilot-readiness worktree contains newer
unpublished work; GitHub main is not its source of truth. Exact candidate and
test hashes live in the task workspace evidence directories.

| Area | Implemented local scope | Remaining activation evidence |
| --- | --- | --- |
| Product eligibility | Campaign/product freshness, known stock, exact SKU-first or variant-ID cost rows, margin and allowance gates | Fresh provider-backed inventory and verified input costs; missing costs remain a refusal |
| Instagram proposal | Exact caption, account, Page, destination, completed export and owner approval; duplicate and daily-limit controls | Current provider permissions/ownership and exact live-operation approval |
| Asset integrity | Bounded owned PNG bytes, complete decoding of the admitted PNG subset, pixel digest and export context bound through local approval and simulation receipt | Provider format acceptance, immutable remote delivery and ownership |
| Persistence | Existing workspace CAS plus an opt-in, separately protected synthetic Meta event chain; exact lost-ACK lookup and overwrite guards | Hosted CAS/PostgREST, grants and protected-storage acceptance; prepared SQL remains unapplied live |
| Uncertain outcomes | Read-only exact-container simulation observation from protected history, without resending or guessing a media ID | Real provider observation and restart-safe reconciliation evidence; PUBLISHED alone cannot recover the media ID |
| Fleet | Quiet/normal process cutover harness with pinned public predecessor and exact runtime-byte attestation | Actual hosted rollout, draining, termination and rollback acceptance; no synthetic records in old live fleets |
| Shopify description pilot | Existing description/receipt/outcome machinery and prepared forward SQL | Hosted protected storage, reader-first rollout and non-atomic provider baseline/write race acceptance; SQL remains unapplied live |
| Launch follow-up | Existing application and database retained | Packing slips/labels are deferred until after shop launch. Grok remains optional and internal-only. |

Windows runtime attestation canonicalizes repository-relative paths to `/` and
sorts those paths before hashing. The pinned predecessor commit/tree/blob checks,
full runtime comparison and all process-effect assertions remain intact.

Native PostgreSQL tests use a disposable loopback-only cluster and synthetic
tenants, roles and provider responses. A native database result is evidence of
actual local SQL/JSONB transactions, not hosted Supabase or real Meta acceptance.
The Meta database bridge uses real primary reads and conditional writes while
PostgREST projections, reporting mirrors and provider transport are synthetic.
Legacy embedded Meta receipts remain mutable workspace evidence. The separate
`runvara-synthetic-meta-receipts/v1` contract protects the whole synthetic chain:
claim, container admission, observed container, publish admission and terminal
observation. Its prepared SQL starts inactive; only trusted local composition
selects it. Generic writes cannot downgrade or replace admitted records, even
when capture is paused. An ambiguous database reply permits one exact proof
lookup, with no mutation retry. No synthetic evidence is a provider attestation.

The local PNG v2 contract admits only 8-bit, noninterlaced grayscale/RGB with
optional alpha and IHDR/IDAT/IEND chunks. It bounds encoded input and decompressed
scanlines, validates CRC/zlib/filter data, and binds decoded pixel identity.
Historical v1 evidence remains explicitly undecoded. Unsupported image variants
are refused. See the [PNG specification](https://www.w3.org/TR/png-3/).

Reconciliation preserves current owner/session authorization and exact protected
identity without renewing pre-send eligibility. Product, cost or date changes
cannot erase a retained outcome. The network-free observer is process-local:
after restart, absent observation remains unknown. A documented container
`PUBLISHED` status is not a media ID; see [Meta's container API](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-container.md/).
Real provider transport, hosted observations and durable provider recovery remain
unaccepted. There is no public reconciliation or protection activation route.

Production preparation and posting stay closed. No HTTP flag, environment switch
or JSON snapshot can issue simulation authority. Credential/account changes,
hosted migrations, provider calls, live posting, deployment or spend require their
specific approval and a concrete reviewed activation plan. Prior local test
counts apply only to their recorded file hashes.
