# Bounded owner quote review persistence

The protected owner-input quote preparation and decision now use the existing
primary-only Supabase save path. Previously an ordinary save committed the review,
refreshed unrelated normalized reporting tables and attempted a reporting-status
commit before returning. This could leave a durable pending review after its
two-second confirmation deadline. Ordinary persistence also permitted internal
primary-CAS retries.

Synthetic real-server/SupabaseStore transport reproduction (controlled clock):

| Case | Before | After |
| --- | --- | --- |
| No artificial delay | 16 operations, HTTP 200 | 3 reads + 1 primary CAS, HTTP 200 |
| 250 ms per operation | HTTP 409 after 14 operations; pending review saved | HTTP 200 in 1,000 ms |
| 500 ms per primary operation | Not an acceptance target | HTTP 200 in 2,000 ms |
| Archive-needed state, 300 ms per operation | Not an acceptance target | 3 reads + 5 archive writes + 1 primary CAS; HTTP 200 in 2,700 ms |

These are synthetic timings, not measurements of production database latency or
proof of the exact stage of any historical failure. Real-timer tests also cover
a large synthetic workspace and a primary write settling after the HTTP deadline.

Preparation also consolidates redundant primary reads. The three remaining reads
are initial signed-cookie authentication, fresh authentication under the workspace
lock, and fresh signed-cookie authentication after the single save attempt. The
locked snapshot is cloned before adding the approval/audit, preserving the
predecessor used by the one-use permit and primary revision CAS. The final snapshot
is checked for the same session, current owner/tenant, credential receipt, input
and exact saved row, then reused within that request to construct the response.
It is never cached across requests or included in the serializable result. The
host confirmation callback must be synchronous and cannot turn failed validation
into success. Even an existing-identity result requires fresh authentication.
Generic approval callers and recorded-evidence mode retain their original reads;
decisions already have one final authenticated readback and keep that path.

A separate synthetic uneven-latency case includes a 1.6 MB workspace, one audit
archive, 450 ms pre-save reads, a 600 ms archive, a 1,400 ms primary commit and a
650 ms readback. Before consolidation it committed a pending review but returned
HTTP 409 at 4,000 ms after four reads. After consolidation it confirms at 3,550 ms
with three reads and the same one archive/one CAS. These chosen test delays are a
model, not an assertion of an exact historical timing trace. The server/browser
deadlines and absolute expiry are unchanged; slower writes can still be uncertain.

The one-use persistence permit allows only an exact owner-input review creation
or decision, together with its expected audit entry. It binds the revision and
full JSON snapshot, preserves other approvals, credentials, quote receipts and
unrelated state, and cannot be copied, reused or mixed with other capabilities.
Required archives and normal capacity/CAS checks remain. Reporting is marked
pending/degraded for a later ordinary refresh. No primary CAS or provider retry
is introduced; existing idempotent archive transport behavior is unchanged.

Initial owner authentication, origin/CSRF and bounded body admission retain two
seconds. Only a valid owner-input preparation/decision envelope receives a
four-second server budget, measured from the original request start. Its browser
budget is five seconds. Read-only and recorded-evidence paths retain their prior
bounds; quote execution retains twelve seconds. All remain capped by the original
activation expiry. The browser checks an absolute monotonic request deadline
after both fetch and body reading, even when the timer callback is delayed.

Fresh owner, tenant, session, input, credential-receipt and saved-row checks remain.
A timeout is still uncertain: an already-dispatched write may settle later. Read
the exact request without resubmitting or replacing its UUID. A saved pending
review does not authorize provider transport; a separate durable decision and
execution confirmation are still required. Existing pending reviews are unchanged.

Relevant tests: `parcel2go-review-latency.test.mjs`,
`parcel2go-owner-input-ui.test.mjs`, owner-input/mount/recorded-review tests,
approval-request/store tests, exact-approval tests and live credential/admission
regressions. Fixtures contain no live credentials or production state.

This change does not activate routes or authorize publication, deployment,
credential entry, provider traffic, bookings or spending.
