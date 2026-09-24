# Runvara 6.7.0 — pre-deployment validation

Implemented and regression-tested against production 6.6.0 at
`5e97b82071703abec4f57781cbb9c9bcf2cc5553`. This document records validation
before the push; GitHub and Render remain authoritative for deployment status.
Branch: `runvara/operating-system-6.7.0`.

## Changes

- Shared Signal & Judgement design language built on Runvara blue/gold tokens.
- Command Centre prioritises readiness, recommendations, incident review areas,
  actual revenue trends and recorded work.
- Daily revenue retains unknown amounts as gaps, includes refunds and excludes
  cancelled/future orders. Equal-period comparisons require a valid baseline.
- Connection cards surface provider marks, authentication, sync eligibility,
  coverage, selected reads, permission policy and primary recovery actions.
- Successful reconnection verifies identity and retries selected reads once.
  Permission failures pause scheduled retries until access is repaired.
- Incident grouping uses recorded causal evidence. Category collections retain
  all individual records, severity, owners, evidence and resolution forms.
- Approval Centre leads with owner-controlled decisions. Existing exact-change
  integrity, revision checks and separate execution remain intact.
- Agent cards surface role, latest finding, recent analysis count, decisions
  consulted and actual pending approvals. Policy controls remain available.
- Responsive shared layouts, chart data table, native disclosures, focus states,
  readable statuses and reduced-motion behaviour are retained.

## Verification completed

- JavaScript syntax/build checks passed.
- SaaS guards passed.
- 114/114 server and UI regression tests passed (Node 24 local runtime).
- Reconnect tests verify one-time callback protection, selected reads, encrypted
  credentials, preservation after failed reads, tenant separation and no writes.
- Presentation tests cover causal ambiguity, complete record retention, unknown
  revenue, period boundaries, refunds, future/cancelled orders and escaping.
- 10,000-order projection benchmark: 20 iterations, median 28.6 ms, p95 34.7 ms.
- Diff whitespace checks passed. No detected live GitHub, Shopify or Stripe token
  patterns or private-key patterns in changed source files.

## Release boundary

The user explicitly authorised pushing Runvara 6.7.0 to
`ajay1980-hue/Packsmart-hub` on 24 September 2026, resolving the earlier automatic
review block. This repository is configured on the existing Render
`packsmart-ops` service. The user's verified `9bbe334` production commit is an
ancestor of the release base.

Release gates: create the commit and pull request, pass GitHub CI, merge into
existing main, observe the existing Render pipeline, and verify live health,
assets, retained data and rendered desktop screens.

Actual phone-viewport acceptance remains unverified because the available browser
has no viewport emulation. Source and DOM checks do not establish device acceptance.
No live provider write was executed. The previously required exact-action owner
approval remains separate from this release.
