# Saved brief history and bounded workspace compaction

This change prepares a smaller representation of older retained daily briefs. It
does not delete history, increase the workspace size limits, change quota rows,
alter financial evidence, or install a database migration. New compaction is
disabled unless the process starts with the exact setting
`BRIEF_HISTORY_COMPACTION_CONTRACT=runvara-brief-history/v1`.
Absent, malformed and unknown values keep the producer closed. Readers remain
available with the producer closed.

## Eligibility and preservation

The existing 30-brief hot-history limit is unchanged. The newest retained brief
and every brief generated today in UTC remain full, preserving the existing
same-day source-signature cache. A candidate must have a unique retained ID, a
valid older timestamp, strict bounded JSON, no existing archive reference, and a
full serialized size of at most 64 KiB. Invalid, future, ambiguous, unsupported,
or non-saving candidates remain full. Existing legacy large-brief compaction is
a separate compatibility path.

At most two new candidates are attempted per save. Each complete snapshot is
detached before asynchronous work. Its content-addressed row key binds the
workspace, original brief ID and canonical JSON content. The existing
`operations_briefs` table stores the full snapshot; no new table, role or grant
is introduced. Insert-ignore followed by a bounded exact-row reread verifies
the workspace, row ID, original brief ID and canonical digest before replacing
hot detail. A stale writer using the original reporting-row ID cannot replace
this separately keyed snapshot. The existing primary revision CAS remains the
authority for publishing the hot reference. Candidate changes during archive
work are fenced before primary serialization.

Failure of this optional archive work leaves that candidate full and lets the
ordinary save proceed when its existing size and revision fences permit it.
It does not turn an archive outage into a new failure of unrelated completion
bookkeeping. A source race, primary conflict or hard-size failure still rejects
the save. Failed archive attempts count against the same two-attempt budget.

The reference uses `runvara-brief-history/v1` and
`sha256-canonical-json/v1`. Object key order and JSON whitespace are irrelevant;
array order, values, types and key presence are retained. The archive is
append-only by application convention, not immutable against privileged
database changes. Digest verification detects subsequent corruption. It is not
proof that the historical business observations were accurate or complete.

## Read behavior and user access

The Command Centre's Saved briefs control loads the existing retained history
only when opened. It does not hydrate archives during bootstrap, dashboard
refresh or ordinary saves. `GET /api/briefs?view=history` returns a compact list
of up to 30 retained summaries. The unchanged default list endpoint remains
available for existing clients. Selecting a brief calls the existing
authenticated `GET /api/briefs/:originalId` route and exposes the full recorded
snapshot, including a collapsed complete JSON view. Historical observations are
labelled as historical, rather than recalculated using current financial rules.

The server takes scope from the authenticated workspace. Request input selects
only a retained original ID; it cannot supply an archive reference or scan cold
history. The detail route reuses the already authenticated workspace read and
adds at most one bounded archive read. Missing, corrupt, foreign, oversized or
unsupported archives are unavailable; a hot summary is never substituted for
full detail. Metadata lists say an archive still needs to be read; only a
successful verified detail read earns the integrity label.

Unversioned legacy archive references remain readable through their original-ID
path and preserve the existing large-snapshot use case. Their original
insertion-order digest cannot be reliably reinterpreted after JSONB key
reordering, so the interface explicitly does not claim verified legacy
integrity. File-only storage has no archive backend and refuses archive stubs.

Legacy detail responses now have a 2 MiB streamed-body ceiling. This is an
explicit availability change from the previous unbounded reader, including
when new compaction is disabled. The existing 900 KB recovery case remains
tested. A larger legacy record stays stored and is labelled too large to open
through this view; it is not missing, deleted or silently truncated. There is
no separate user-facing export route in this package. Administrative retrieval
or a different reader bound requires a separately reviewed operation. Do not
infer arbitrary-size legacy compatibility from the 900 KB test.

## Cost and capacity limits

Compaction trades additional retained archive storage and a one-time bounded
write/read for smaller repeated workspace snapshots. It is not a reduction in
total database storage. A content-keyed snapshot can coexist with the original
mutable reporting row. There is no automatic deletion, archive-wide scan,
background hydration or added provider request. Archive retention continues
beyond the hot 30-record window; this change does not claim a finite lifetime
archive quota or introduce cleanup.

Two attempted candidates imply up to two insert operations and two verification
reads. The existing insert helper permits one identical retry on an unknown
network outcome, giving at most six transport attempts for this new work in one
save. A new snapshot is at most 64 KiB, its POST body at most 128 KiB, and its
streamed verification/detail response at most 128 KiB. These bounds are checked
separately.
Conservative response sizing includes JSONB whitespace and numeric exponent
expansion. Candidates exceeding those budgets remain full.

Synthetic request-byte and serialized-state measurements accompany the tests.
They are fixture measurements, not provider invoices, physical database sizes
or a prediction of a particular workspace's saving. Preserving all today's
briefs means this is bounded historical relief, not a guarantee that a busy
day's state cannot reach its existing hard limit.

## Reader-first rollout and rollback

1. Deploy the pointer-aware reader, history view and eviction handler with the
   new producer setting absent. Verify exact-source checks and full recovery.
2. Establish that every serving instance and rollback artifact contains those
   readers. Confirm predecessor drain and saved-work reconciliation using the
   existing controlled rollout procedure.
3. Obtain separate approval before setting the producer contract and beginning
   live hot-state reduction. This package does not authorize that activation.
4. To stop new compaction, replace/drain producer-enabled processes with the
   same reader-capable artifact and the setting absent. Already admitted saves
   may finish; closing the setting does not erase references or stop old
   processes automatically.

The earlier `f431036186060f406115a4e6644ec7bb141305b4` reader ignores the new
archive row key, and its eviction path can reinterpret a pointer as legacy
detail. It is therefore not a sufficient rollback reader once new pointers
exist. Before activation, f431 remains the prior code rollback boundary. After
activation, the minimum rollback is this verified reader-capable artifact with
compaction disabled. A farther downgrade would require a separately reviewed,
verified full rehydration under CAS; never overwrite current workspace state
with an old snapshot or delete archive evidence to make a downgrade work.

## Verification scope

Tests cover default-closed configuration, same-day cache preservation,
serialization savings, source races, failed/missing archive data, primary CAS
failure, tenant isolation, digest corruption, legacy large-record recovery,
repeat saves, and the f431 reader boundary. Actual disposable PostgREST and
PostgreSQL exercise insert-ignore, JSONB key order, projected reads, stale
original-ID writes, role restrictions and closed-producer recovery without
changing the fixture schema or grants. Browser checks cover on-demand loading,
full-detail/error states, session/navigation interruption, keyboard dismissal,
and narrow/enlarged-text layouts. Live compaction and its resulting workspace
savings require later activation and observation; test success does not claim
that they have occurred.
