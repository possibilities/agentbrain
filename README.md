# agentbrain

Expose Mike's local research cache through an agent-friendly Bun CLI.

`agentbrain` is intentionally CLI-first: every command has stable help, deterministic JSON output, and read-only database access by default so coding agents can discover and use the shared Hermes research cache without MCP or Hermes internals.

## Quick start

```bash
bun install
bun run src/cli.ts --help
bun run src/cli.ts stats --json
bun run src/cli.ts search "agent memory" --limit 5 --json
bun run src/cli.ts get --document-id 123 --json
```

Recommended flow: `search -> get -> cite`. Search for candidate evidence, fetch the best document or chunk, then cite `document_id`, `chunk_id` when present, `title`, `source_uri`, and relevant relation provenance from `outbound_links` / `inbound_links`.

The default database path is `~/.hermes/research-cache/research.db`. Override it with `--db PATH` or `AGENTBRAIN_DB`.

X-related source types commonly show up as `tweet`, `tweet_article`, and linked `scraped_url` records. Ingestion arrives through the saved-link/research pipeline; this CLI only reads the shared DB.

## Agent contract

Use `agentbrain guide --json` for a machine-readable operating contract and `agentbrain prompt` for the prompt Mike can hand to other harnesses so they generate their own agent-facing docs.

All DB commands remain read-only.
