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
at its login screen. At that audit checkpoint, a real customer authorisation could not
be completed or claimed as verified. The update below supersedes that setup status.

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

## Live platform verification — 22 September 2026

The existing Runvara Meta app is now configured:

- App ID: `3722844954529826`; business portfolio: `1336706635213396`.
- Facebook Login for Business configuration: `1964796287487673`, General
  variation, user access token (personal Facebook login).
- Configuration permissions: `instagram_basic`, `pages_read_engagement`,
  `pages_show_list`. No publishing or catalogue scopes were added to this configuration.
- Registered and validated redirect:
  `https://packsmart-ops.onrender.com/api/integrations/meta/oauth/callback`.
  HTTPS and strict redirect matching remain enabled.
- The owner entered the app secret in Render. All four `META_*` configuration
  keys were verified by name only. The secret was not read or recorded.
- Render deployment `dep-dapd7po473hc7392qld0` succeeded with the existing main
  commit `1a296b9490249e9ccec22dc67eaa7c186b20d9c2`. The destination guard in
  this branch remains undeployed.

The production Connect action opened the standard Facebook OAuth dialog, the
owner authorised access, and the callback returned to Runvara successfully.
The connection identity is `Freedom To Buy`. Test connection passed, automatic
account sync completed, and a requested account sync completed at 20:31 UTC.
Runvara imported two Facebook Pages: `Freedom 2 buy.` (`133211586549372`) and
`Freedom 2 buy` (`146910685161511`). The connection remains read-only. Shopify
was still connected; eBay retained its pre-existing degraded state.

An independent read-only Meta Business settings audit confirmed Instagram
`@packsmartsolutions` (`17841438552467339`) belongs to the existing portfolio
and is linked to `Packsmart Solutions Ltd` (`1266597316536573`). The Facebook
owner has full access to that Page and partial Instagram access (content,
messages, community activity, ads and insights). This Page and Instagram account
were not returned to Runvara in the verified sync. Their presence in Meta
Business settings is not evidence of successful API discovery in Runvara.

A reconnect review offered all three current Facebook Pages; all three were
selected. The Instagram selector was changed to current accounts only, but the
browser connection stalled before its selection and final consent could be
verified. Do not claim that reconnect completed or that Instagram is connected.
Do not infer the reason for the missing Page from this evidence alone.

The 83-test local regression suite was rerun and passed after live Facebook
verification. These tests include simulated Instagram responses; they do not
remove the outstanding live Instagram release gate. Catalogue and publishing
permissions, production write validation, app-review readiness, and final guard
deployment remain outstanding. No live publication or destructive test occurred.
