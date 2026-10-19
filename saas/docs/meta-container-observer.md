# Local container-status observer transport

This increment exercises the existing Facebook Login Graph transport shape with
an explicitly supplied mock. Default and production server composition remain
closed. It resolves no publication outcome and grants no resend authority.

The owner-only `/api/connection-writes/:writeId/meta-container-status` GET returns
a fresh selection bound to the protected synthetic publish receipt, exact
container, current connection/account/Page/Instagram identity, settings revision,
grants and owner session. POST requires CSRF, that selection and a request ID.
No HTTP input or environment flag can create the private mock capability.
There is no customer UI button, background polling, URL input or media-ID search.

The existing Meta adapter constructs one version-pinned `graph.facebook.com`
GET for the receipt's numeric container with `fields=id,status_code`. Redirects
are refused. The complete request/body has a five-second maximum and a 4 KiB
streamed response ceiling. Duplicate keys, unexpected fields, unknown statuses,
contradictory identity and malformed bodies fail closed. Raw provider text,
tokens, proofs and URLs are excluded from retained errors. The only credentials
used by this mock composition are fixed synthetic test strings; no credential
resolver or live transport issuer is connected.

Admission reuses the existing FileStore and OS transaction lock. A dedicated
`integrationStatus.meta.containerObserver` record coordinates all cooperating
current processes using that file: one held attempt per account, two globally,
at least 60 seconds between attempts for an account, at most five attempts for
a container within a fixed five-minute window. Bounds are 32 retained attempts
per workspace and 128 across the file. Neither a new request ID nor a replacement
process resets debt. Ordinary saves preserve the ledger and cannot create one.
The observer does not use connection-sync history, change sync success times,
enqueue jobs, create approvals or touch publication writes.

Reservations are saved before sending. Repeated request IDs only return their
retained state; they never reissue a GET. Uncertain reservation/settlement commits
remain unknown. A timeout, rate limit or access denial retains a review hold;
it does not automatically expire or trust abort as proof that transport stopped.
An operator recovery operation is deliberately not implemented. Fresh authority
and source checks run after awaited work and before private output is returned.

All returned observations explicitly say `transportMocked:true`,
`providerReadPerformed:false`, `executedExternally:false`,
`outcome:unresolved_do_not_resend`, and `resultId:null`. PUBLISHED is only a mocked
container status. The existing synthetic receipt/observation SQL contracts and
their provenance validators remain unchanged.

The local lock is not a fleet fence against older binaries, direct JSON writers,
administrators or another state file. Process-death locks and exhausted ledger
capacity require explicit review; no automatic cleanup or lock stealing occurs.
The local ledger is not production-protected immutable provider evidence.

## Remaining implementation and acceptance gates

- Production-authorized receipt/admission and immutable observation contracts,
  atomic shared admission/settlement in the existing database, and an approved
  credential-bound live transport issuer still need implementation and review.
- Production operator recovery for held/exhausted observations and a customer UI
  need a separately reviewed design; no automatic recovery is supplied here.
- Native database, hosted migrations/persistence, live permissions/account
  ownership, delivered asset bytes and compatible fleet/rollback acceptance are
  not established by these mocked tests. No database/schema change was made.
- Actual product costs and exact live target/asset approval remain user inputs.
  Never infer missing costs or substitute these tests for real provider evidence.

Official documentation consulted on 18 October 2026:
[IG Container](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-container.md/)
describes the exact status read and supported states;
[Content Publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing.md/)
recommends spacing checks by a minute and limiting the checking period.
The application limits above are conservative local policy, not a claim about
available provider quota or granted permissions.

The prior JPEG browser comparison remains qualified: the exploratory maximum
difference of three failed at four for eleven isolated blue-channel pixels.
Exact encoded bytes and the pinned decoder hash remain bound; browser/provider
pixel equality is not claimed and no threshold was changed.
