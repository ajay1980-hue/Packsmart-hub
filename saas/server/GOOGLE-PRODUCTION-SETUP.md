# Existing Google / YouTube connector

The implementation supports authenticated YouTube channel identity and statistics,
including pagination, offline refresh, PKCE and workspace-bound OAuth callbacks.
It does not implement Gmail, Google Ads or Merchant Center. Those remain development
work, not provider restrictions. Do not create another Runvara service or database.

## Operator configuration

Use the chosen business-owned Google Cloud project. Enable **YouTube Data API v3**.
Configure Google Auth Platform branding with Runvara's name, support contact,
application home page, privacy policy and terms URLs owned by the operator.
Choose External audience for customers outside the operator's organisation.
During testing add the intended business Google account as a test user.
Public launch requires the applicable Google OAuth verification and published
consent configuration; testing-mode access is not a public production launch.

Create a **Web application** OAuth client with this exact authorised redirect URI:

`https://packsmart-ops.onrender.com/api/integrations/google_youtube/oauth/callback`

The only requested scope is:

`https://www.googleapis.com/auth/youtube.readonly`

No browser JavaScript origin is needed by this server-side code exchange. Keep the
existing `APP_PUBLIC_URL=https://packsmart-ops.onrender.com` unchanged.
Set these keys securely on the existing Render `packsmart-ops` service:

- `GOOGLE_CLIENT_ID`: web application client ID
- `GOOGLE_CLIENT_SECRET`: corresponding client secret, entered only in Render
- `GOOGLE_OAUTH_ENABLED=true`

Never paste the secret into chat, source control or a client-side configuration.
Redeploy the existing service, open Google & YouTube in Connection Centre, connect
with the business Google account, test access and sync channels. Confirm its channel
identity before enabling automatic reads. No Google write capability is claimed.

The cloud browser's Site Unavailable message prevented console configuration; it
does not establish a Google API restriction or a service outage.

Sources checked 2026-09-23:
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/youtube/v3/docs/channels/list
