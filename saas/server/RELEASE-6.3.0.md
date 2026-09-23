# Runvara 6.3.0 — discovery recovery and guided setup

Continues the existing 6.2.1 production tree, preserving the existing service,
workspace document schema, encrypted connection records, OAuth state validation,
approval centre and eBay Manager. No production data migration or credential change.

- Meta discovery checks app-verified granular Page grants for Pages omitted by
  `/me/accounts`. Only targets returned for the current workspace token and matching
  application are queried. Instagram linkage is additionally checked with each Page
  token. Optional discovery failures retain working Page results. Public diagnostics
  include counts and numeric error references, never raw responses or credentials.
- eBay support diagnostics expose existing per-surface HTTP and numeric provider
  error references. This release does not claim to have resolved an unobserved live
  marketing failure.
- Workspace setup persists platform choices and reviewed permission revisions.
  Completion requires connection tests, successful imports and permission review;
  failed connections or later settings changes invalidate readiness. All mutations
  use the existing authenticated owner, CSRF and workspace transaction controls.
- Signup UI uses the existing signup endpoint and remains hidden unless the existing
  operator beta-signup gate is enabled. No public signup gate is silently enabled.
- Shopify tag addition/removal uses exact Approval Centre requests and always needs
  approval even in automatic mode. Same connection binding, actor audit, claim before
  sending, uncertain-result handling and replay protections as existing writes.
  Tags may affect collections/automation, so none were executed on production.
- Google operator instructions: GOOGLE-PRODUCTION-SETUP.md. Existing YouTube reads,
  callback and refresh flow are retained. Google Ads, Gmail and Merchant Center
  remain unimplemented; do not label them provider restrictions.

Local verification: 90 server tests, syntax checks, SaaS guard and existing eBay
Manager regression passed. Tests include OAuth binding/cancellation, tenant
isolation, approval tampering/replay, credential failure, discovery recovery,
wrong-app grant rejection, onboarding persistence/readiness and tag approvals.
Live discovery, provider setup and mobile browser verification are separate gates;
local mocks are not evidence that a provider account is operational.
