export function buildGuide(): unknown {
  return {
    name: "agentbrain",
    purpose:
      "Sole schema-v2 reader/writer for Mike's local research index, exposed as an agent-friendly CLI.",
    default_db: "~/.hermes/research-cache/research.db",
    architecture: {
      botctl: "Human-facing saved-link ingress.",
      linkctl: "Link admission and duplicate policy.",
      scrapectl: "Queue ownership and browser-backed extraction.",
      agentbrain:
        "Index schema, migrations, generic ingestion, completed-link writes, search, retrieval, context, and deletion.",
      boundary:
        "Agentbrain has no link queue or browser implementation. External one-hop children use Agentbrain's pinned safe fetch; only canonical X status/article children may use Scrapectl, with preflight and same-item postvalidation.",
      decision_record: "docs/adr/0001-agentbrain-owns-research-index.md",
      glossary: "CONTEXT.md",
    },
    source_types: {
      x: ["tweet", "tweet_article", "scraped_url"],
      generic: ["text", "file", "url", "url_text", "url_pdf"],
      note: "X identities canonicalize to x.com/i/status/ID and x.com/i/article/ID.",
    },
    global_flags: [
      {
        flag: "--db <path>",
        meaning:
          "Override database path; takes precedence over AGENTBRAIN_DB and the legacy default path.",
      },
      {
        flag: "--json",
        meaning: "Stable JSON envelope; preferred for agents.",
      },
      {
        flag: "--jsonl",
        meaning:
          "Streaming-friendly records; currently most useful for search.",
      },
    ],
    output_contract: {
      json_envelope: {
        schema_version: "number",
        ok: "boolean",
        command: "string",
        data: "command-specific payload on success",
        error: "{code,message,hint?} on failure",
        meta: "{db_path,read_only,generated_at} on success",
      },
      read_only_commands: [
        "stats",
        "search",
        "get",
        "context",
        "tags",
        "sources",
      ],
      mutation_commands: ["ingest", "ingest-link", "delete"],
      citation_fields: ["document_id", "chunk_id", "source_uri", "title"],
      legacy_adapter:
        "research-ingest-link emits bare Scrapectl-compatible JSON, not the Agentbrain envelope.",
      completed_link_limits: {
        raw_stdin_bytes: 10000000,
        markdown_utf8_bytes: 5000000,
        markdown_unicode_code_points: 5000000,
      },
      optional_artifacts:
        "save_markdown_copy writes under XDG_DATA_HOME/agentbrain/scraped (default ~/.local/share/agentbrain/scraped); failure is a root-success partial and adds artifact_error.",
      document_relations: {
        outbound_links:
          "Links discovered from the selected document to targets or unresolved URLs.",
        inbound_links:
          "Links whose to_document_id points at the selected document.",
        relation_fields: [
          "id",
          "from_document_id",
          "to_document_id",
          "relation_type",
          "discovered_url",
          "resolved_url",
          "status",
          "error",
          "created_at",
          "updated_at",
        ],
      },
      exit_codes: {
        "0": "success",
        "1": "runtime, validation, root-ingest, not-found, or database failure",
        "2": "argument error; for native ingest-link and research-ingest-link, root committed with child or optional artifact failures",
      },
    },
    recommended_workflow: [
      'Use `agentbrain context "your query" --json` for one bounded search-and-evidence call.',
      'Or run `agentbrain search "your query" --json`, then fetch selected evidence with `agentbrain get --chunk-id ID --json`.',
      "Inspect stats/tags/sources when discovery is poor and retry alternate terms before inferring absence.",
      "Cite document_id, chunk_id when applicable, title, source_uri, and relevant relation provenance.",
      "Use `agentbrain ingest` for explicit generic sources. Send admitted links through Linkctl and let Scrapectl produce the completed payload.",
    ],
    commands: {
      stats:
        "Inventory counts, source types, tags, recent docs, and relation totals.",
      search:
        "FTS5 chunks; data.results include ids, title, source_uri, snippet, tags, score, and offsets.",
      get: "Evidence retrieval by document id, chunk id, or source URI.",
      context: "Bounded compact citation-ready hits for shell-enabled agents.",
      ingest:
        "Index text, files/directories, public URLs, HTML/text, PDF, DOCX, and EPUB.",
      "ingest-link":
        "Read one bounded already-scraped root from stdin; external children use pinned safe fetch, canonical X children may use validated browser Scrapectl, and traversal stops after one hop.",
      delete: "Delete exactly one selected document with --confirm delete.",
      tags: "Tag discovery.",
      sources: "Source-type and domain discovery.",
      prompt: "Prompt another harness to generate docs from this help surface.",
    },
    safety: {
      read_connections:
        "Read commands open SQLite with mode=ro/readonly and never initialize or migrate.",
      writes:
        "Only the separate ResearchStore creates/migrates schema-v2 or mutates documents, chunks, FTS, and relations.",
      urls: "Generic URL fetches resolve/check every DNS address, pin one vetted IP to the socket while preserving Host/TLS verification, verify remoteAddress, and freshly resolve each manual bounded redirect.",
      x_browser_residual:
        "Canonical X child extraction requires Scrapectl's browser. Agentbrain preflights the X URL and rejects a reported URL that is not the same canonical X item, but cannot pin or inspect the browser's own network socket.",
      directories:
        "Traversal streams entries, caps at 20000 entries/10000 supported candidates, and skips sensitive path components by default.",
      deletion: "Requires exactly one selector and literal --confirm delete.",
      no_raw_sql: true,
      no_owned_queue_or_browser_implementation: true,
    },
  };
}

export const HARNESS_DOCS_PROMPT = `You are writing local agent-facing documentation for the \`agentbrain\` CLI.

Goal: produce concise docs that make your harness excellent at searching and explicitly updating Mike's local research index through shell calls. Do not use MCP. Prefer stable JSON.

Inspect:

  agentbrain --help
  agentbrain guide --json
  agentbrain context --help
  agentbrain search --help
  agentbrain get --help
  agentbrain ingest --help
  agentbrain ingest-link --help
  agentbrain delete --help
  agentbrain stats --help
  agentbrain tags --help
  agentbrain sources --help

Document:
1. When to use context versus search -> get -> cite.
2. Exact --json examples and the citation fields.
3. Zero-result recovery through alternate terms, tags, and sources.
4. Generic explicit ingestion and guarded deletion.
5. The ownership boundary: Botctl is human ingress, Linkctl admits/deduplicates, Scrapectl owns queue/extraction, and Agentbrain solely owns index reads/writes; Agentbrain has no queue/browser.
6. Completed-link stdin ingestion and the temporary research-ingest-link compatibility adapter.
7. DB override precedence: --db, then AGENTBRAIN_DB, then ~/.hermes/research-cache/research.db.

Keep it short enough for an AGENTS.md / CLAUDE.md / harness instruction file.`;
