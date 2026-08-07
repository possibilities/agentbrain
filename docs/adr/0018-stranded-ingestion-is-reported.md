# ADR 0018: Stranded ingestion is unhealthy and notifies the operator

## Status

Accepted.

## Context

Admission acknowledges a submission synchronously and durably, long before
extraction and indexing decide whether it succeeded. That separation is
deliberate ([ADR 0005](0005-public-ingestion-admission-contract.md)): accepted
admission does not imply extraction success, and it is what lets the share
ingress answer a phone immediately without holding a fetch open.

The cost is that a submitter is never told when the job later stops moving. A
job in `blocked` (item retries exhausted, or `auth_config`) or `failed`
(permanent) has no attempt scheduled and no request left to fail. Nothing polls
the ledger. The operator's only signal is the absence of a search result, which
is indistinguishable from never having submitted the link at all.

This was not hypothetical: 24 jobs sat in those states across three weeks while
`agentbrain doctor` reported `healthy: true`, because doctor checked the
database, artifacts, leases, and the extractor, but never the dispositions of
the jobs themselves.

## Decision

`doctor` gains a `stranded_ingestion` check that fails when a job is in
`blocked` or `failed` **and carries a failure class**. A failure class is written
by an attempt, so its presence is what distinguishes ingestion that broke from
ingestion that never ran. `excluded` and `cancelled` are operator dispositions
and are never stranded, which gives the operator an existing, auditable way to
make the check pass without pretending the job succeeded: `agentbrain jobs
exclude` with a reason.

A job blocked at admission before any attempt — as the recovery import does when
a disposition reserves the decision for an operator — is reported separately as
`admission_review`, at warning. It is an undecided question, not a defect, and
counting the two together would report breakage that does not exist.

`doctor --notify` posts an operator notification, and an installer-owned
`agentbrain.doctor` LaunchAgent runs it on an interval. Notification fires only
when the stranded count rises above the last notified value; a steady backlog is
silent, and recovery to zero resets the baseline. Delivery prefers `funk-notify`
and falls back to `terminal-notifier`, and a machine with neither is not an
error.

## Consequences

- Doctor is unhealthy while any job is stranded. That is the intended reading:
  links the operator submitted are not searchable. Jobs awaiting admission review
  warn instead, so an unmade decision never masquerades as a broken pipeline.
- Triage stays an explicit operator act. The reporter reads; it never retries,
  excludes, or mutates the ledger, so nothing silently disposes of evidence.
- Notification is best-effort and out of band. Agentbrain does not depend on a
  notifier being installed, and the ingestion outcome remains the product.
- A count is not a diagnosis. The notification's click-through opens the job
  lists rather than trying to summarize causes that differ per job.
