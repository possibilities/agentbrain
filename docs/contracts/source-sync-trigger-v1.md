# Source sync trigger JSON contract (v1)

The external-scheduler command is direct argv:

```text
/absolute/path/to/agentbrain
sources
sync
<SOURCE_ID>
--due
--wait
--wait-timeout-seconds
300
--wait-timeout-ok
--json
```

It emits exactly one JSON document on stdout, in the ordinary schema-version-1 Agentbrain envelope (`agentbrain guide --json` describes that envelope). For a per-Source trigger, `data` always contains exactly one result of this shape:

```json
{
  "admission": {
    "source_id": "x.example",
    "source_database_id": 42,
    "status": "queued",
    "run_id": 91,
    "job_id": 104,
    "scheduled_for": "2026-07-23T12:00:00.000Z",
    "dry_run": false
  },
  "execution": {
    "source_id": "x.example",
    "run_id": 91,
    "run_state": "completed",
    "outcome": "success",
    "terminal": true,
    "warnings": 0,
    "counts": { "discovered": 8, "admitted": 3, "suppressed": 5 },
    "checkpoint_committed": true,
    "created_at": "2026-07-23T12:00:00.000Z",
    "started_at": "2026-07-23T12:00:01.000Z",
    "finished_at": "2026-07-23T12:00:04.000Z",
    "job": {
      "id": 104,
      "state": "completed",
      "failure_class": null,
      "failure_summary": null
    }
  },
  "timed_out": false
}
```

## Admission status

`admission.status` is one of:

- `queued`: a new Run/job was durably admitted;
- `duplicate`: the pending/active Run shown by `run_id` was rejoined;
- `not_due`: no new Run was admitted; under `--wait`, `execution` contains the latest terminal Source Run when one exists, otherwise it is `null`;
- `disabled`, `paused`, or `unsupported`: policy prevented admission;
- `would_queue`: dry-run only; invalid with `--wait`.

## Completion and exit status

- Run/job settled with `outcome: "success"`: exit 0.
- `not_due` with no prior Run or a latest successful Run: exit 0. A latest failed, partial, or cancelled Run remains visible and exits 1.
- `timed_out: true`: exit 124 by default; exit 0 with `--wait-timeout-ok`. `execution` contains the latest queued/running/retrying durable state and the Run continues independently.
- A blocked or otherwise settled job returns immediately with `timed_out:false` and exits 1, even when its Run has no terminal outcome yet.
- Settled `partial`, `failed`, or `cancelled`: exit 1.
- Disabled, paused, or unsupported under `--wait`: exit 1.
- CLI/argument contract error: exit 2 with the standard `ok:false` JSON error envelope when `--json` was requested.

Observer process termination does not cancel the durable Run.

## Bounds and disclosure

A per-Source result contains no discovered item bodies, warning bodies, checkpoint payload, feed content, credentials, or Source payload. It includes only IDs, enums, timestamps, three integer counts, a warning count, and a sanitized failure summary capped by Agentbrain's 600-character external-error limit. The output is therefore a small single receipt (normally below 4 KiB and structurally bounded well below a 1 MiB supervisor stream limit).

A source-sync Run completes after its discovery window, observations, suppressions, child admissions, and checkpoint are committed. It does not wait for every admitted child URL job to finish.
