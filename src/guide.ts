export function buildGuide(): unknown {
  return {
    name: "agentbrain",
    purpose:
      "Sole durable ingestion authority and reader/writer for Mike's local research index, exposed as an agent-friendly CLI.",
    default_db: "~/.hermes/research-cache/research.db",
    architecture: {
      agentbot: "Human-facing saved-link ingress.",
      agentbrain:
        "Durable admission, ingestion jobs and attempts, Artifact storage, index schema, search, retrieval, context, and deletion.",
      scrapectl:
        "All URL fetching, browser/session behavior, backend hardening, and extraction invoked by the Agentbrain worker.",
      boundary:
        "Every public ingestion intent is durable before materialization. Admission performs no network work, and URL workers delegate extraction to Scrapectl without direct HTTP fallback.",
      decision_record:
        "docs/adr/0003-agentbrain-owns-durable-ingestion.md and docs/adr/0005-public-ingestion-admission-contract.md",
      glossary: "CONTEXT.md",
    },
    source_types: {
      x: ["tweet", "tweet_article"],
      generic: ["scraped_url", "text", "file", "url", "url_text", "url_pdf"],
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
      mutation_commands: ["submit", "ingest", "ingest-link", "delete"],
      submission_contract: {
        version: 1,
        new_status: "queued",
        replay_status: "duplicate",
        success_exit: 0,
        wait_timeout_preserves_job: true,
      },
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
        "1": "runtime, root-ingest, not-found, or database failure",
        "2": "argument or pre-admission validation error; for ingest-link adapters, root committed with child or optional artifact failures",
      },
    },
    recommended_workflow: [
      'Use `agentbrain context "your query" --json` for one bounded search-and-evidence call.',
      'Or run `agentbrain search "your query" --json`, then fetch selected evidence with `agentbrain get --chunk-id ID --json`.',
      "Inspect stats/tags/sources when discovery is poor and retry alternate terms before inferring absence.",
      "Cite document_id, chunk_id when applicable, title, source_uri, and relevant relation provenance.",
      "Use `agentbrain submit` for every text, file, directory, or URL intent. Treat queued and duplicate as successful durable acknowledgements.",
    ],
    commands: {
      stats:
        "Inventory counts, source types, tags, recent docs, and relation totals.",
      search:
        "FTS5 chunks; data.results include ids, title, source_uri, snippet, tags, score, and offsets.",
      get: "Evidence retrieval by document id, chunk id, or source URI.",
      context: "Bounded compact citation-ready hits for shell-enabled agents.",
      submit:
        "Validate and durably admit versioned text, file, directory, or URL intent; local bytes are snapshotted and URL admission performs no network work.",
      ingest:
        "Queued compatibility alias for submit; it cannot write documents directly.",
      "ingest-link":
        "Read one bounded already-scraped root from stdin; generic roots do not fan out, while every child discovered from an X root uses the same Scrapectl provider adapter and traversal stops after one hop.",
      delete: "Delete exactly one selected document with --confirm delete.",
      tags: "Tag discovery.",
      sources: "Source-type and domain discovery.",
      prompt: "Prompt another harness to generate docs from this help surface.",
    },
    safety: {
      read_connections:
        "Read commands open SQLite with mode=ro/readonly and never initialize or migrate.",
      writes:
        "Submit and its ingest alias write only durable jobs and required Artifact snapshots; materialization is restricted to the fenced worker path.",
      urls: "Admission validates HTTP(S) syntax and queues normalized intent without network work. The worker delegates all URL extraction and network policy to Scrapectl.",
      local_documents:
        "Text, file, and directory bytes are captured as immutable Artifacts before acknowledgement and parsed only after a worker leases the job.",
      directories:
        "Traversal streams entries, caps at 20000 entries/10000 supported candidates, and skips sensitive path components by default.",
      deletion: "Requires exactly one selector and literal --confirm delete.",
      no_raw_sql: true,
      owns_durable_ingestion_ledger: true,
      no_browser_or_network_implementation: true,
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
  agentbrain submit --help
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
5. The ownership boundary: Agentbrain owns durable admission, ingestion jobs, Artifact snapshots, and index writes; Scrapectl owns URL extraction/network/backend behavior.
6. Queued and duplicate submission acknowledgements, explicit idempotency conflicts, --wait observation, and the temporary completed-link compatibility adapter.
7. DB override precedence: --db, then AGENTBRAIN_DB, then ~/.hermes/research-cache/research.db.

Keep it short enough for an AGENTS.md / CLAUDE.md / harness instruction file.`;
