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
| No artificial delay | 16 operations, HTTP 200 | 6 reads + 1 primary CAS, HTTP 200 |
| 250 ms per operation | HTTP 409 after 14 operations; pending review saved | HTTP 200 in 1,750 ms |
| 500 ms per primary operation | Not an acceptance target | HTTP 200 in 3,500 ms |
| Archive-needed state, 300 ms per operation | Not an acceptance target | 6 reads + 5 archive writes + 1 primary CAS; HTTP 200 in 3,600 ms |

These are synthetic timings, not measurements of production database latency or
proof of the exact stage of any historical failure. Real-timer tests also cover
a large synthetic workspace and a primary write settling after the HTTP deadline.

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
