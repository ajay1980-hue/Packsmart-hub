# Private Parcel2Go credential entry — local candidate

This supersedes the disconnected candidate's missing-owner-route limitation only. It is unpublished, undeployed and disabled by default. All checks use synthetic identities, state and credentials. No real credential, provider API call, token, quote, purchase or account creation occurred. Previous sealed reports and tests remain historical evidence.

## Existing application and protected route

The existing Runvara Channels view gains a small private entry panel only for the active, server-verified Packsmart strict owner and an explicitly enabled finite admission descriptor. Both fields are masked. The client ID is privately compared to the approved public client identifier; the secret is never put into bootstrap, application state, local/session storage, URLs or logs. Session storage contains only a one-way attempt marker keyed by request UUID. Field values are cleared before awaiting submission and on navigation, session closure and expiry. JavaScript cannot promise forensic memory erasure or control browser/password-manager behaviour; entry must remain private on the trusted owner device.

GET/POST `/api/owner/parcel2go-credentials` use normal verified owner sessions, current tenant/role/session version and the existing API limiter. POST additionally requires normal CSRF validation, the exact same Origin, JSON content type, a maximum 12 KiB strict duplicate-key-safe body, explicit confirmation, exact request/revision/client binding and a current finite capability. Other methods, queries, normal mode, ordinary tenants and disabled configuration are refused. Credential-entry mode cannot invoke the quote operation. There is no provider transport injected into this route.

The status DTO contains only account/connection references, request/revision, admission outcome and server-derived remaining time. No expected client ID, secret, token or ciphertext is returned. The UI subtracts the whole request elapsed time from the server remaining budget using a monotonic clock, retaining the shortest deadline for the same UUID. A slow browser wall clock cannot reopen or extend it. A separate status button reconciles read-only; POST is never retried automatically. Any timeout/failure is shown as unknown/refused, with no raw server/parser/provider exception.

## Internal read and write boundary

Authentication, authorization and CAS reconciliation internally load the full existing saved workspace through the established store. That snapshot may contain already-saved customer/order fields. The approval MUST disclose this private read. No order/customer provider query, projection to the entry DTO, transmission to Parcel2Go, business-record replacement or new source import is performed. The ordinary owner dashboard retains its existing authorized views.

Credential admission writes a durable scoped reservation/audit, then the encrypted connection/completion receipt/audit, with normal retention/archive effects and the existing less-than-2-MiB cap. The module now uses the normal `addAudit` helper: the prior isolated audit shape failed real post-save dashboard bootstrap and is corrected here. No generic connection registry entry is added, so it cannot acquire default auto-sync. Existing connections cannot be replaced. Global quiet, scheduler, agent and other feature settings are not changed by the code.

Concurrent instances are fenced by the existing revision CAS. Lost acknowledgements may be reconciled by exact revision/readback, never by repeated writes. Unresolved saved reservations remain spent; a failed pre-reservation write may leave no durable record, so absence is not permission to replay. The same browser's nonsecret attempt marker and in-process flag also prevent repeat submission. After restart, trust the absolute deadline and durable evidence; the operator must close the control and reconcile an unknown result, not issue a new UUID. No claim is made that an already transmitted database write can be cancelled at expiry. Previously acknowledged archive effects can survive refusal.

## Configuration, expiry and closure

`RUNVARA_QUIET_PARCEL2GO_CREDENTIAL_ENTRY` defaults to `disabled/v1`. Enabling requires existing `RUNVARA_STARTUP_MODE=quiet`, `RUNVARA_QUIET_OWNER_WORKSPACE=enabled/v1`, and both Shopify token/catalogue temporary gates off. Independent support/pilot settings are preserved; this does not turn them on or off.

The reviewed future descriptor also requires:

- `RUNVARA_PARCEL2GO_ENTRY_REQUEST_ID`: new approved UUID.
- `RUNVARA_PARCEL2GO_ENTRY_EXPECTED_REVISION`: exact approved predecessor revision.
- `RUNVARA_PARCEL2GO_ENTRY_OPENED_AT` and `RUNVARA_PARCEL2GO_ENTRY_EXPIRES_AT`: absolute UTC, no more than five minutes including rollout.
- `RUNVARA_PARCEL2GO_ENTRY_CONNECTION_ID`, `RUNVARA_PARCEL2GO_ENTRY_ACCOUNT_ID`: exact verified sandbox binding.
- `RUNVARA_PARCEL2GO_ENTRY_EXPECTED_CLIENT_ID`: approved public identifier, not returned to the browser.
- `RUNVARA_PARCEL2GO_ENTRY_TERMS_REFERENCE`: the actual scoped approval reference; a string alone is not proof of legal consent.

The existing encryption key stays server-side. No new secret environment variable or key is introduced. The finite permit checks absolute and monotonic expiry and backward-clock closure, including immediately before persistence after retention waits. Expired configuration boots closed for POST while allowing authenticated status reconciliation; disabling the flag closes the entire route and removes the panel. Future activation and same-build closure/instance termination require separate approval and verified infrastructure headroom. Expiry alone is not configuration cleanup, instance shutdown or credential revocation.

## Corrected account statement and remaining facts

Official documentation establishes separate sandbox/live API credentials. The inspected sandbox UI establishes a separate sign-in/session. It does NOT establish that the underlying live and sandbox account identities must differ or that a live account is eligible for sandbox access. Subsequent parent-verified browser evidence confirms Aj separately created the sandbox account and its My Details page verifies his chosen Packsmart email and name. Marketing remained unchecked; the displayed GBP 10,000 is a test balance, not funded money or quote-tax evidence. The empty VAT-number field does not establish VAT registration status. This local task performed none of those browser/account actions. No API credentials have been created, read or stored. The empty API-client form requires Application Name, Application URL, a user-chosen unrecoverable Secret, and explicit prohibited/restricted-items and API-terms agreements. No scope selector is shown; scopes are requested at token issuance. Registration links https://www.parcel2go.com/api/docs/articles/terms.html ; the parent also verified https://sandbox.parcel2go.com/api/docs/articles/terms.html . No API agreement acceptance is implied here.

The previous documents describe their original disconnected snapshot; any earlier assertion that accounts necessarily are separate is superseded by the correction above. Only credentials and the observed sessions are established as separate. The stable quote scope discrepancy (Swagger openid versus public-api guide), real account currency/VAT facts and actual provider eligibility still need resolution. No payment/my-profile scope or broader fallback has been added. Public-api is broad access and must never be described as provider-enforced read-only.

## Finite next checklist — no approval requested now

1. Independently review this exact final code, including HTTP, browser, storage, redaction and expiry evidence. Publish/deploy disabled only after a separate code-release approval and exact online checks.
2. Retain the parent-verified sandbox identity and empty creation-form evidence; confirm the account at action time and resolve applicable API/third-party terms, public-api scope discrepancy and real quote currency/VAT eligibility. Account registration is completed separately; API credential creation and checkbox acceptance are still unapproved. Do not assume live-account eligibility or consent.
3. Verify the intended owner can privately reach this reviewed same-origin entry page, the trusted account/client binding, current saved revision/capacity and included infrastructure cost/closure route. Do not read or paste real secrets through chat, terminals or agent tools.
4. Ask for one sandbox credential creation and private encrypted admission with exact account, public-api risk, full saved-workspace internal read, reservation/audit/retention writes, five-minute window, one attempt, uncertain-save/no-replay procedure, explicit cost and immediate closure. Closing does not revoke stored access; code rollback cannot remove it or erase evidence.
5. After encrypted admission is separately proven and closed, prepare the next bounded sandbox-test approval. The real token/quote transport is still deliberately absent. It needs a separately reviewed implementation and release, plus exact synthetic parcel, currency/VAT, terms, response/time/count limits, no retries and no orders/payment/labels/live/resale. No existing allowance renews automatically.

This candidate implements secure private entry, not a working deployed Parcel2Go connection and not a completed sandbox quote test.
