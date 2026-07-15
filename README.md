# agentbrain

Own and expose Mike's local research index through an agent-friendly Bun CLI.

Agentbrain is the sole owner of schema-v2 creation, additive migration, reads, and writes. Read commands use structurally read-only SQLite connections; mutation commands open a separate writable store. The first cutover intentionally keeps the database at `~/.hermes/research-cache/research.db`. `--db PATH` wins over `AGENTBRAIN_DB`, which wins over that default.

Architecture and vocabulary:

- [ADR 0001: Agentbrain owns the research index](docs/adr/0001-agentbrain-owns-research-index.md)
- [Research consolidation glossary](CONTEXT.md)

Botctl is human ingress, Linkctl owns admission and duplicate policy, Scrapectl owns queueing and browser extraction, and Agentbrain owns indexing. Agentbrain does **not** add another queue or browser.

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

## Ingestion and deletion

Explicit generic sources support text, files, directories, safe public HTTP(S), HTML/text responses, PDF through PATH-resolved `pdftotext`, DOCX, and EPUB:

```bash
agentbrain ingest "A pasted research note" --source-type text --tag notes --json
agentbrain ingest ./paper.pdf --tag paper --json
agentbrain ingest ./research --source-type directory --recursive=true --json
agentbrain ingest https://example.com/article --max-bytes 5000000 --json
```

URL fetching checks every resolved DNS address, rejects any non-public answer, tries vetted endpoints in resolver order on connection/TLS failure, pins each attempt to the actual HTTP(S) socket while preserving the original Host header and TLS hostname verification, verifies the connected remote address, and freshly resolves every manually bounded redirect. Both the overall operation and production transport have absolute deadlines, response bodies are bounded, and non-identity `Content-Encoding` responses are rejected.

Directory ingestion streams traversal rather than collecting a whole tree. It caps traversal at 20,000 entries / 10,000 supported candidates and, by default, rejects a selected root or skips descendants with sensitive path components such as `.ssh`, `.aws`, `.gnupg`, credentials, tokens, and secrets.

Completed Scrapectl output is accepted on stdin without re-scraping the root:

```bash
printf '%s' '{"url":"https://example.com","markdown":"# Saved"}' \
  | agentbrain ingest-link --json
```

Input is validated and bounded before the database opens: `url` must be HTTP(S), optional scalar fields must have their documented types, raw JSON is limited to 10,000,000 bytes, and `markdown` to 5,000,000 UTF-8 bytes / 5,000,000 Unicode code points.

X tweet/article roots canonicalize to stable `x.com/i/...` identities. External one-hop children use Agentbrain's pinned safe fetch; only canonical X status/article children may invoke PATH-resolved browser Scrapectl. X children receive public-address preflight and same-canonical-item postvalidation, and extraction never recurses beyond that hop. The narrow X browser exception retains residual risk because Agentbrain cannot pin or inspect the browser's own socket. One-hop fan-out is capped at 25 URLs in stable discovery order; larger discoveries return a root-success partial with `linked_truncated` and `linked_discovered_count`, and omitted URLs receive no relation rows. Child success/failure provenance is durable and retryable.

With `save_markdown_copy: true`, artifacts go under `$XDG_DATA_HOME/agentbrain/scraped` (default `~/.local/share/agentbrain/scraped`). Artifact failure does not roll back the root; it returns a root-success partial with `artifact_error`.

Deletion is intentionally guarded:

```bash
agentbrain delete --document-id 123 --confirm delete --json
```

## Scrapectl compatibility adapter

`research-ingest-link` is a separate executable for the temporary Scrapectl contract. It reads the same bounded stdin object but emits legacy bare JSON rather than Agentbrain's `{ok,data}` envelope. Both native `agentbrain ingest-link` and the adapter exit 0 for complete success, 1 for invalid/root failure, and 2 when the root committed but a child or optional artifact failed. The adapter also supports `--help` / `-h`.

## Agent discovery

Use `agentbrain guide --json` for the complete machine-readable command/ownership contract and `agentbrain prompt` to generate harness-local instructions.

Run the project checks with `bun run check`. The conservative `scripts/install.sh` installs both executables only when each destination is absent or an explicitly owned/expected symlink.
