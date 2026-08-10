# agentbrain

[![CI](https://github.com/possibilities/agentbrain/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentbrain/actions/workflows/ci.yml)

Agentbrain owns your local research index and is its sole durable ingestion authority: Admission, the SQLite ingestion queue, Attempts, Artifacts, schema, FTS search, retrieval, and provenance. Read commands open structurally read-only connections. The database lives at `~/.local/share/agentbrain/research.db`; `--db PATH` wins over `AGENTBRAIN_DB`, which wins over that default.

An Ingress submits intent at Admission, which durably queues an immutable job before returning — it never materializes content. The Worker leases jobs and delegates URL extraction to Agentscrape, which owns fetching and network policy while Agentbrain remains the only index writer. [docs/adr/](docs/adr/) records the decisions, starting with [Agentbrain owns durable ingestion](docs/adr/0003-agentbrain-owns-durable-ingestion.md); `CONTEXT.md` is the domain glossary.

## Siblings

Agentbrain never fetches, so URL ingestion requires [agentscrape](https://github.com/possibilities/agentscrape) on the worker's `PATH`. Without it, URL submissions are still admitted — admission performs no network work — but every extraction attempt fails as `infra`, retries, and eventually strands. Recurring blog and X sources degrade the same way: source sync admits its Runs, but discovery is Agentscrape's.

Nothing else degrades. Text, file, and directory submissions index normally, and search, retrieval, tagging, and the share ingress are unaffected. The stranding is reported rather than silent: `agentbrain doctor` fails its `stranded_ingestion` check and, when installed, `agentbrain.doctor` notifies ([ADR 0018](docs/adr/0018-stranded-ingestion-is-reported.md)).

## Use

```bash
bun install
agentbrain context "agent memory" --limit 5 --json    # one bounded evidence call
agentbrain search "agent memory" --json               # or: search -> get -> cite
agentbrain get --document-id 123 --json
agentbrain submit https://example.com/article --json  # durable queued admission
agentbrain jobs stats --json
agentbrain doctor --json
```

`agentbrain --help` lists every command, `agentbrain --agent-help` prints the agent runbook, and `agentbrain guide --json` is the stable machine-readable contract (`agentbrain prompt` generates harness-local docs from it).

## Services

`scripts/install.sh` installs the command plus three LaunchAgents: `agentbrain.worker` drains the queue, `agentbrain.share` serves the authenticated share ingress for the Chrome extension and Android app under [clients/](clients/README.md), and `agentbrain.doctor` runs interval health checks that notify when ingestion strands, per [ADR 0018](docs/adr/0018-stranded-ingestion-is-reported.md). Do not run a manual long-lived worker beside the installed one.

## Develop

Bun ≥ 1.3.14.

```bash
bun run check
```

Tests are offline and use the vendored Agentscrape contract fixture (`AGENTSCRAPE_CONTRACT_FIXTURE` overrides its path). The opt-in real-Agentscrape smoke is `./scripts/smoke-agentscrape-url-ingest.sh`: a temporary database, one queued URL job, `worker --once`, search verification, and preserved evidence on failure.
