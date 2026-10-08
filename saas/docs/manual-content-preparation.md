# Exact manual Shopify content preparation

This contract covers new manual `shopify/product_content` requests only. It
does not add objective-originated execution, a multi-store executor, provider
reads, automatic proposals, financial qualification or permission changes.

## Account shown and confirmed

Connection Centre's channel label can come from its first saved Shopify row.
Content preparation now has a separate exact target, resolved by one shared
server helper from the same retained state used by the proposer. It requires
one credential-bearing Shopify row, a unique connection ID, valid workspace
scope, exact saved `*.myshopify.com` domain, product-write scope and permitted
connection settings. Two credential-bearing rows, duplicate IDs, malformed or
foreign scope, missing write scope and read-only settings refuse preparation.
One uncredentialed A followed by credential-bearing B presents B explicitly.

The helper does not decrypt credentials or call Shopify. Its singleton choice
matches the existing `shopifyConnection` and `connectorCredentials` selectors.
It does not prove that encrypted `storeDomain` matches metadata `shopDomain`;
the unchanged apply path verifies the actual configuration/account before
dispatch. Environment credentials are not an alternative preparation target.
Product choices are retained workspace references. They do not establish a
current provider baseline or prove the original import belonged to the chosen
store; the owner deliberately reviews the destination and exact product ID.

The form requires deliberate account and product choices, exact content review
and acknowledgement. Old clients without the strict target assertion receive
`WRITE_TARGET_REVIEW_REQUIRED`; the server never infers an account for them.
New content bodies accept only operation, requestId, productId, title,
description and target. The target has exactly schema, connectionId, account
and settingsRevision. Other manual operations keep their existing contract.

The settings revision guards an open reviewed draft. Settings edits, supported
reconnection/replacement, disconnect and setup requests increment it. Token
rotation does not. It is not a credential hash or proof of historical credential
generation. It is deliberately not persisted into the write. A fresh assertion
with the same account/connection may reuse an existing same-intent request;
that does not prove the old request's connection generation. Existing exact
approved manual apply behavior is unchanged.

## Identity and approval

One request ID means one provider, product-content operation, normalized input,
exact connection/account and original requester. Title trimming and the input
digest remain byte-compatible. Duplicate request IDs and a collision with
another actor, account or input refuse rather than selecting a first row.
Pending reuse also verifies the current target, unique exact approval and
current objective-policy binding. Terminal exact matches are history only.

Owner/admin API preparation roles remain unchanged. The visible content editor
remains owner-only. Approval and apply remain separate owner-only actions.
Current actor, active role, password-change requirement and session version are
rechecked through the existing authentication/mutation boundary. Supabase
workspace CAS rejects concurrent conflicting snapshots; no new table or ledger
is introduced. Existing financial/stock/profit-first/pause/expiry restrictions
still block dispatch when applicable, including explicit zero limits.

The submitted target is a preparation assertion, not a new persisted authority
field. Existing write connectionId/account/requestedBy and input digest retain
their meaning. No existing v1 policy envelope, write identity, claim, recorded
manual action or source_action is rewritten. Held SQL fixtures are unchanged.

## Unknown response and exact reconciliation

An in-memory attempt retains one request ID and frozen reviewed intent.
Repeated clicks and a lost response do not create a new ID. The user explicitly
checks `/api/connections/shopify/content-requests/:requestId`; it is not polled.
The authenticated current manager must be the original requester. Unknown
query fields, duplicate/foreign/malformed records or incomplete bounded scan
coverage refuse the read. The small exact response contains only the request
identity, normalized content, approval reference and status, with a 64 KiB cap.

A missing row means absence at that read's snapshot. An earlier POST may still
commit on another replica. It does not prove cancellation. After an explicit
check and renewed review, the user can explicitly retry the same ID/intent;
exact reuse plus CAS prevents another approval for that ID. There is no
automatic POST, new-ID retry, approval, apply or provider call. Rejected and
other terminal states remain history, never fresh execution permission.

This GET uses identity-only authentication (a narrow identity read on
Supabase), followed by the existing workspace lock/current-user validation and
one ordinary full `store.get`. It scans at most 10,000 retained write rows and
returns one bounded projection. The scan/response caps do not bound the size of
the underlying full workspace database response. FileStore's identity read
also loads its ordinary stored workspace. This slice adds no provider traffic,
periodic task, background reconciliation or separate data adapter.

Close/cancel and other same-session interruptions retain an unknown attempt for
an explicit check on return, while generation/context checks suppress late
responses. Identity/workspace/session loss clears private draft content.
Account/settings changes and editing require new deliberate review. No private
draft is persisted into browser storage, and no cross-browser or full-page
reload exactly-once guarantee is claimed. Aborting a browser request does not
cancel a server commit.

## Release and rollback boundary

The enforcing backend must precede the new UI in a later authorized release.
Rolling back only the UI can stop preparation until refresh; it must not remove
the assertion check. A backend rollback that removes this check reintroduces
the original target/requester ambiguity: retain the guard or disable new
content preparation. Preserve all existing dispatch restrictions. This prepared
change performs no migration, grant, provider operation, activation or release.
