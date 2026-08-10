# AgentBrain

[![CI](https://github.com/possibilities/agentbrain/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentbrain/actions/workflows/ci.yml)

Your local research index — the articles, threads, papers, and notes collected
on this machine, searchable offline and citable, through an agent-friendly Bun
CLI.

Agentbrain is the only writer of that index, and it never fetches. Everything
enters through admission, which durably queues an immutable job before it
returns. The worker then leases each job and delegates URL extraction to
[agentscrape](https://github.com/possibilities/agentscrape), which owns
fetching and network policy. The database lives at
`~/.local/share/agentbrain/research.db`; `--db PATH` wins over
`AGENTBRAIN_DB`, which wins over that default.

## Use

```bash
agentbrain context "agent memory" --limit 5 --json    # one bounded evidence call
agentbrain search "agent memory" --json               # or: search -> get -> cite
agentbrain get --document-id 123 --json
agentbrain submit https://example.com/article --json  # durable queued admission
agentbrain jobs stats --json
agentbrain doctor --json
```

`agentbrain --help` lists every command, `--agent-help` prints the agent
runbook, and `guide --json` is the stable machine-readable contract
(`agentbrain prompt` generates harness-local docs from it).

## Services

`scripts/install.sh` installs the command plus three LaunchAgents:
`agentbrain.worker` drains the queue, `agentbrain.share` serves the
authenticated share ingress for the Chrome extension and Android app under
[clients/](clients/README.md), and `agentbrain.doctor` runs interval health
checks. Do not run a manual worker beside the installed one.

## Without agentscrape

URL ingestion needs agentscrape on the worker's `PATH`. Without it, URL
submissions are still admitted — admission does no network work — but every
extraction attempt fails as `infra`, retries, and eventually strands. Recurring
blog and X sources degrade the same way, because discovery is agentscrape's.

Nothing else degrades. Text, file, and directory submissions index normally,
and search, retrieval, tagging, and the share ingress are unaffected. The
stranding is reported rather than silent: `agentbrain doctor` fails its
`stranded_ingestion` check and, when installed, `agentbrain.doctor` notifies
([ADR 0018](docs/adr/0018-stranded-ingestion-is-reported.md)).

## Develop

Bun ≥ 1.3.14.

```bash
bun run check
```

Tests are offline and use the vendored agentscrape contract fixture
(`AGENTSCRAPE_CONTRACT_FIXTURE` overrides its path). The opt-in real-agentscrape
smoke is `./scripts/smoke-agentscrape-url-ingest.sh`, which preserves its
evidence on failure.

[docs/adr/](docs/adr/) records the decisions, starting with [Agentbrain owns
durable ingestion](docs/adr/0003-agentbrain-owns-durable-ingestion.md);
`CONTEXT.md` is the domain glossary.
