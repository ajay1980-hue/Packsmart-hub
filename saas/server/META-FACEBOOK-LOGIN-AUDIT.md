# Facebook OAuth destination audit — 21 September 2026

Audited main commit: 1a296b9490249e9ccec22dc67eaa7c186b20d9c2 (6.2.0).

## Findings

The existing server authorisation endpoint is already
`https://www.facebook.com/v26.0/dialog/oauth`. Code exchange uses
`https://graph.facebook.com/v26.0/oauth/access_token`. Neither uses Meta Work.
There is no configurable authorisation-host override. Optional `META_LOGIN_CONFIG_ID`
adds a Facebook Login for Business configuration ID to the same Facebook endpoint;
it does not select a Managed Meta Account login. Removing a valid configuration ID
without inspecting its app would risk breaking an existing Facebook Login setup.

The browser opened earlier for platform administration was the **developer
portal**, which redirected to `business.facebook.com/business/loginpage/` and
showed Facebook and Managed Meta Account choices. It was not a Runvara OAuth URL.
No live redirect from Runvara to `work.meta.com` was reproduced.

A read-only production Render environment-name audit found no `META_CLIENT_ID`,
`META_CLIENT_SECRET`, `META_OAUTH_ENABLED` or `META_LOGIN_CONFIG_ID`. Existing
Shopify/eBay secrets were not read or changed. The Runvara browser session was
at its login screen. Therefore a real customer authorisation cannot currently
be completed or claimed as verified.

## Change on this branch

The existing customer Connect handler now rejects destinations unless their
origin is exactly `https://www.facebook.com` and their path is a versioned
`/dialog/oauth` endpoint. URLs containing user-info are rejected too. Meta Work,
developer login pages and lookalike domains fail closed, with a plain-English
message and the button re-enabled. Other connectors retain their existing flows.
The Meta onboarding text explicitly directs customers to their normal Facebook
account and says that no Meta Work account is needed.

The server endpoint, tenant binding, one-time OAuth state, cookie binding,
credential encryption, granted-scope discovery and account checks are preserved.
This destination guard cannot control redirects made by Facebook after a valid
OAuth request; app-side login configuration must still be verified live.

## Tests and release gate

83/83 local tests pass. Added tests verify:

- The start endpoint returns the exact Facebook origin/path despite attempted
  environment/body endpoint overrides, including with a business configuration ID.
- A simulated provider grant returns to Runvara, then a connection test and sync
  expose the authorised Page and linked Instagram identity in only the right tenant.
- Invalid browser binding and replayed callbacks are rejected.
- The actual customer form refuses Meta Work, developer-portal and lookalike URLs
  without navigation, restores its button and displays the recovery explanation.

Syntax, whitespace and SaaS safety guards pass. Provider HTTP responses in these
flow tests are fixtures; they do not prove real Facebook account authorisation.

Do not deploy this branch until the requested live Connect → Facebook authorise →
Runvara callback → connected Page/Instagram verification is complete. This requires
an actual configured Meta Facebook Login app and an authenticated Runvara owner
session. No Meta Work account should be created or requested. Keep the existing
6.2.0 production deployment until that gate is met.
