# ADR 0005: Public ingestion admission contract

- Status: Accepted
- Date: 2026-07-18

## Context

Agentbrain currently exposes synchronous ingestion commands, while Agentbot relies on Linkctl's unusual duplicate contract: a duplicate is JSON on stdout with exit code 1. Durable ingestion requires every accepted intent to exist before parsing or extraction starts, but persisting malformed CLI input as failed work would fill the operator queue with requests that never formed a valid ingestion intent.

The public contract must also support asynchronous callers without preventing an interactive caller from waiting for a result. Duplicate submission is expected under at-least-once delivery and should not be represented as an operational error.

## Decision

- **`agentbrain submit` is the canonical public ingestion command.** It accepts a versioned typed intent with an explicit or inferred kind, ingress, collection membership, and kind-specific payload.
- **Admission validates before persistence.** Malformed syntax, unsupported options, invalid envelope versions, and structurally invalid intent exit nonzero without creating a job. Once admission accepts an intent, the corresponding job is durable before any parsing, extraction, or indexing begins.
- **New admission is a successful acknowledgement.** It exits 0 and returns a structured result containing `status: "queued"`, `job_id`, and the resolved resource or idempotency key when available.
- **Equivalent admission is also successful.** It exits 0 with `status: "duplicate"` and identifies the existing job. Reuse of an explicit idempotency key with different intent is an error rather than a duplicate.
- **Waiting never bypasses durability.** `--wait` may observe the accepted job until a terminal or caller-timeout condition, but it uses the same persisted job and worker path as asynchronous submission.
- **Every current public ingestion path converges on admission.** Existing command names may temporarily parse into the same submission contract during cutover, but they cannot retain a direct-write implementation. Specialized completed-link and compatibility entrypoints are retired after their producers move to the versioned job/result contract.
- **Agentbot invokes Agentbrain through explicit argv.** Saved links submit URL jobs with `ingress=agentbot` and `collection=saved-links`; Agentbot renders queued and duplicate acknowledgements without treating idempotent duplication as failure.
- **Operator commands are separate from admission.** `jobs list`, `jobs show`, `jobs retry`, `jobs cancel`, and `jobs exclude` inspect or transition durable jobs. Internal claim, heartbeat, and completion interfaces are worker surfaces rather than public ingestion shortcuts.
- **Machine output is versioned and structured.** Human-readable output remains available, while Agentbot and other automation consume JSON envelopes and stable exit semantics.

## Consequences

- Callers can trust exit 0 to mean the intent is durably represented, not that ingestion has completed.
- Invalid CLI requests remain immediate user errors; accepted extraction and content failures remain inspectable jobs.
- Agentbot no longer needs Linkctl's duplicate exit-code exception.
- Every compatibility command retained during rollout must be a parser or alias over the same admission path, increasing the importance of tests that prohibit direct writes.
- A caller waiting for completion can time out or disconnect without cancelling or losing the durable job.
- Idempotency identity and intent hashing become part of the stable admission contract.

## Related

This applies the ownership decision in [ADR 0003](0003-agentbrain-owns-durable-ingestion.md) and the lifecycle in [ADR 0004](0004-durable-ingestion-job-lifecycle.md). See [`CONTEXT.md`](../../CONTEXT.md) for admission, ingress, job, and ingestion terminology.
