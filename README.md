# agentbrain

Expose Mike's local research cache through an agent-friendly Bun CLI.

`agentbrain` is intentionally CLI-first: every command has stable help, deterministic JSON output, and read-only database access by default so coding agents can discover and use the local resources database without MCP or Hermes internals.

## Quick start

```bash
bun install
bun run src/cli.ts --help
bun run src/cli.ts stats --json
bun run src/cli.ts search "agent memory" --limit 5 --json
bun run src/cli.ts get --document-id 123 --json
```

The default database path is `~/.hermes/research-cache/research.db`. Override it with `--db PATH` or `AGENTBRAIN_DB`.

## Agent contract

Use `agentbrain guide --json` for a machine-readable operating contract and `agentbrain prompt` for the prompt Mike can hand to other harnesses so they generate their own agent-facing docs.
