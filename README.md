# agentbrain

Agentbrain owns Mike's local research index and is its sole durable ingestion authority. It owns Admission, the SQLite ingestion queue, Attempts, Artifacts, schema, Resources, Documents, chunks, FTS, and provenance. Read commands use structurally read-only SQLite connections; mutation commands use the separate writable store. The database remains at `~/.hermes/research-cache/research.db`; `--db PATH` wins over `AGENTBRAIN_DB`, which wins over that default.

An Ingress such as the CLI submits intent at Admission. Admission validates it and durably creates or identifies an immutable ingestion job before returning; it does not materialize content. The Worker is Agentbrain's executor: it leases jobs, delegates extraction, and commits fenced outcomes, while Agentbrain remains the index owner. A retry creates another Attempt instead of replacing the job. Scrapectl remains the URL extraction and network-policy boundary, but it does not own Agentbrain's queue or index.

Architecture references:

- [Agentbrain owns durable ingestion](docs/adr/0003-agentbrain-owns-durable-ingestion.md)
- [Durable ingestion job lifecycle](docs/adr/0004-durable-ingestion-job-lifecycle.md)
- [Public Admission contract](docs/adr/0005-public-ingestion-admission-contract.md)
- [Single Worker operation](docs/adr/0011-single-worker-source-scheduling.md)

## Quick start

```bash
bun install
bun run src/cli.ts --help
bun run src/cli.ts stats --json
bun run src/cli.ts context "agent memory" --limit 5 --max-chars 10000 --json
bun run src/cli.ts search "agent memory" --limit 5 --json
bun run src/cli.ts get --document-id 123 --json
```

Recommended evidence flow: `context`, or `search -> get -> cite`. Cite `document_id`, `chunk_id` when present, `title`, `source_uri`, and relevant relation provenance.

## Durable Admission and ingestion

Use `submit` for new integrations. `ingest` is a compatibility alias with the same queued behavior.

```bash
agentbrain submit "A pasted research note" --kind text --tag notes --json
agentbrain submit ./paper.pdf --kind file --tag paper --json
agentbrain submit ./research --kind directory --recursive=true --json
agentbrain submit https://example.com/article --kind url --max-bytes 5000000 --json
```

Text and local file bytes are captured as immutable Artifacts before acknowledgement. URL Admission performs syntax validation and queues normalized intent without network work. A new intent returns `queued`; a replay returns `duplicate` with the same job identity. Materialization happens only after a Worker leases the job.

For URL jobs, the Worker invokes PATH-resolved `scrapectl fetch-markdown --markdown URL` without a shell. Scrapectl owns fetching, browser/session behavior, redirects, credentials, backend retries, and extraction hardening. Agentbrain bounds and sanitizes provider output and remains the only component allowed to mutate the index.

Operate the queue explicitly with:

```bash
agentbrain jobs stats --json
agentbrain jobs list --state queued --json
agentbrain jobs show JOB_ID --json
agentbrain jobs retry JOB_ID --reason "provider repaired" --json
agentbrain doctor --json
agentbrain worker --once --json
```

`worker --once` recovers stale leases, drains eligible jobs, and exits, so it is the deterministic offline and repair seam. The long-running `agentbrain worker` stops taking claims on `SIGTERM`, observes its shutdown grace, and leaves unfinished work recoverable through lease expiry. Do not run a manual long-lived Worker alongside the installed LaunchAgent.

## Worker LaunchAgent

First prove the checked-out Worker against a temporary database without launchd, a browser farm, or network access:

```bash
scratch="$(mktemp -d)"
mkdir -p "$scratch/home"
HOME="$scratch/home" XDG_DATA_HOME="$scratch/data" \
  bun run src/cli.ts --db "$scratch/research.db" --json \
  submit "offline worker smoke" --kind text
HOME="$scratch/home" XDG_DATA_HOME="$scratch/data" \
  bun run src/cli.ts --db "$scratch/research.db" --json worker --once
rm -rf "$scratch"
```

Then install the commands and the one user service:

```bash
./scripts/install.sh --help
./scripts/install.sh --install
```

The idempotent installer creates only these owned entries:

- `~/.local/bin/agentbrain` and `~/.local/bin/research-ingest-link`, linked to this checkout;
- `~/Library/LaunchAgents/agentbrain.worker.plist`, invoking only the installed `agentbrain worker` command;
- `${XDG_STATE_HOME:-~/.local/state}/agentbrain/worker.log` in a private state directory.

The state directory is mode `0700`; the rendered plist and log are mode `0600`; the service uses umask `077`. Its arguments contain no submitted content, URLs, Artifact paths, or credentials. Reinstall unloads the known label, atomically replaces only a marker-owned plist, and loads it again. The installer refuses unrelated command links, regular files, and foreign service files rather than taking them over.

Check operation with:

```bash
launchctl print "gui/$(id -u)/agentbrain.worker"
agentbrain jobs stats --json
agentbrain doctor --json
tail -n 100 "${XDG_STATE_HOME:-$HOME/.local/state}/agentbrain/worker.log"
```

For repair, rerun `./scripts/install.sh --install`; this clears a stale service with the owned label before loading the rendered plist. If queue state needs deterministic reconciliation, unload the service, run `agentbrain worker --once`, and reinstall it:

```bash
launchctl bootout "gui/$(id -u)/agentbrain.worker" || true
agentbrain worker --once --json
./scripts/install.sh --install
```

Uninstall is also idempotent:

```bash
./scripts/install.sh --uninstall
```

It gracefully unloads the Worker and removes only owned command links and the marker-owned service file. It intentionally preserves the database, Artifacts, and private log. For rollback, uninstall the service before restoring a pre-migration database snapshot, restore the matching Agentbrain code, run the temporary-database smoke with that version, and only then install its service. Never start the newer Worker against a snapshot being restored.

The LaunchAgent drains already admitted ingestion jobs only. Installation does **not** create, discover, schedule, or enable recurring remote Sources. Remote Source activation remains deferred to a later, explicit operator rollout.

## Completed-link compatibility adapter

`research-ingest-link` remains a temporary Scrapectl compatibility executable. It reads one bounded completed payload from stdin and emits legacy bare JSON rather than Agentbrain's `{ok,data}` envelope. New Ingress integrations should use durable `agentbrain submit` instead.

```bash
printf '%s' '{"url":"https://example.com","markdown":"# Saved"}' \
  | agentbrain ingest-link --json
```

## Deletion

Deletion is intentionally guarded:

```bash
agentbrain delete --document-id 123 --confirm delete --json
```

## Agent discovery and checks

Use `agentbrain guide --json` for the machine-readable command and ownership contract, and `agentbrain prompt` to generate harness-local instructions.

Run all project checks with:

```bash
bun run check
```

An opt-in real Scrapectl smoke exists outside `bun test` and always uses a temporary database. Run it only after the human has brought Scrapectl up: `./scripts/smoke-scrapectl-url-ingest.sh [https://example.com/]`.
