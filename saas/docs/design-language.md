# Runvara — Signal & Judgement

Runvara's product language builds on its own blue/gold identity. Operational
screens use midnight surfaces, blue observation lines, and gold decision edges.
The readiness orbit and Commander core are brand signatures, not background art.
The marketing presentation can be cinematic; operational data stays unobstructed.

## Shared system

`styles.css` owns semantic surface, colour, spacing, type, radius, focus and motion
tokens. Reuse cards, facts, tags, evidence disclosures, data panels and controls.
`presentation.js` projects customer-facing descriptions, provider marks, recorded
work status and incident groups. It never fetches, persists, grants access or
changes state. New UI scripts load after it.

Blue means observation or navigation. Gold means judgement, permission or a
review. Success and failure keep their semantic colours and written labels.
Do not animate idle agents to imply work. Motion must respect reduced motion.

## Evidence and information architecture

The Command Centre leads with readiness, the most important recorded condition,
and review areas. Revenue trends reuse the authoritative net order revenue
calculation. Unknown amounts create gaps; imported data does not imply complete
business coverage. Comparisons use equal rolling periods and require a positive,
known previous baseline. No unsupported forecast or generated savings is shown.

The activity stream uses persisted work records. Agent metrics describe the recent
returned team history, not lifetime performance. Decision counts mean decisions
consulted, not decisions made. Rules-based confidence is labelled explicitly.

Connection cards expose authentication checks, last successful sync, eligible
schedule, selected data, counts and permission policy. Schedule eligibility is
subject to Autopilot limits; it is not a guaranteed next execution time.

Incidents may absorb a dependent automation record only when its run evidence
identifies one matching connection cause. Ambiguous causes remain separate.
Stock, margin and order collections are explicitly review categories, not claims
of a shared root cause. All records, severity, evidence, ownership, histories and
existing status forms remain accessible. Grouping never mutates source records.

Approvals lead with the decision queue. Gold approval controls retain owner-only
checks, proposal revisions, exact-write integrity and separate execution. The
request form is an expandable secondary action. Never add an execution shortcut.

## Responsive and accessible behaviour

Grid children use `minmax(0,1fr)`. Narrow layouts stack decision summaries, incident
facts and forms. Tables scroll within their own panel. Native dialogs/disclosures,
visible focus, text status labels, 44px controls and reduced-motion support are
retained. Revenue has a labelled SVG and an exact-value table.

Regression coverage uses the existing isolated HTTP/JSDOM harness for all routes,
real persisted forms, search, owner controls and connection interactions. The
available production browser supports desktop verification but does not expose
phone viewport emulation. Source/DOM checks are not a substitute for a real mobile
device acceptance pass.
