export function buildGuide(): unknown {
  return {
    name: "agentbrain",
    purpose:
      "Sole durable ingestion authority and reader/writer for Mike's local research index, exposed as an agent-friendly CLI.",
    default_db: "~/.local/share/agentbrain/research.db",
    architecture: {
      agentbot: "Human-facing saved-link ingress.",
      agentbrain:
        "Durable admission, ingestion jobs and attempts, Artifact storage, index schema, search, retrieval, context, and deletion.",
      agentscrape:
        "All URL fetching, browser/session behavior, backend hardening, and extraction invoked by the Agentbrain worker.",
      boundary:
        "Every public ingestion intent is durable before materialization. Admission performs no network work, and URL workers delegate extraction to Agentscrape without direct HTTP fallback.",
      decision_record:
        "docs/adr/0003-agentbrain-owns-durable-ingestion.md, docs/adr/0005-public-ingestion-admission-contract.md, docs/adr/0014-agentbrain-database-namespace.md, and docs/adr/0015-parser-derived-content-classification.md",
      glossary: "CONTEXT.md",
    },
    source_types: {
      x: ["tweet", "tweet_article"],
      generic: ["scraped_url", "text", "file", "url", "url_text", "url_pdf"],
      note: "X identities canonicalize to x.com/i/status/ID and x.com/i/article/ID.",
    },
    content_classification: {
      field: "content_kind",
      values: ["post", "thread", "article"],
      item_count_field: "content_item_count",
      filter: "--content-kind",
      authority:
        "Parser-derived metadata persisted independently from URL/source identity; null means legacy or not yet classified.",
    },
    global_flags: [
      {
        flag: "--db <path>",
        meaning:
          "Override database path; takes precedence over AGENTBRAIN_DB and the Agentbrain-namespaced default path.",
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
        "jobs list/show/stats",
        "doctor",
      ],
      mutation_commands: [
        "submit",
        "ingest",
        "worker",
        "jobs retry/cancel/exclude",
        "jobs show --reveal-content",
        "delete",
        "retag",
      ],
      submission_contract: {
        version: 1,
        new_status: "queued",
        replay_status: "duplicate",
        success_exit: 0,
        wait_timeout_preserves_job: true,
      },
      citation_fields: ["document_id", "chunk_id", "source_uri", "title"],
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
        "1": "runtime, extraction, indexing, not-found, or database failure",
        "2": "argument or pre-admission validation error",
        "124":
          "source-sync wait observation timeout; the durable Run continues unless separately cancelled",
      },
    },
    recommended_workflow: [
      'Use `agentbrain context "your query" --json` for one bounded search-and-evidence call.',
      'Or run `agentbrain search "your query" --json`, then fetch selected evidence with `agentbrain get --chunk-id ID --json`.',
      "Inspect stats/tags/sources when discovery is poor and retry alternate terms before inferring absence.",
      "Use jobs list/show/stats and doctor for content-safe operations; pass --reveal-content only when Artifact bodies are required and an audit record is appropriate.",
      "Cite document_id, chunk_id when applicable, title, source_uri, and relevant relation provenance.",
      "Use `agentbrain submit` for every text, file, directory, or URL intent. Treat queued and duplicate as successful durable acknowledgements.",
    ],
    commands: {
      stats:
        "Inventory counts, source types, tags, recent docs, and relation totals.",
      search:
        "FTS5 chunks with exact content-kind and provenance filters; data.results include parser-derived content_kind/content_item_count alongside ids, source, snippet, tags, score, and offsets.",
      get: "Evidence retrieval by document id, chunk id, or source URI.",
      context: "Bounded compact citation-ready hits for shell-enabled agents.",
      submit:
        "Validate and durably admit versioned text, file, directory, or URL intent; local bytes are snapshotted and URL admission performs no network work.",
      ingest:
        "Queued compatibility alias for submit; it cannot write documents directly.",
      worker:
        "Lease due jobs, delegate URL extraction through the versioned Agentscrape envelope, materialize outside write transactions, heartbeat, and commit fenced outcomes; --once drains work due now.",
      jobs: "Content-safe ingestion ledger listing, detail, statistics, retry, cancellation, exclusion, and explicit audited Artifact reveal.",
      doctor:
        "Read-only database, Artifact-reference, lease, schema, and provider health checks.",
      delete: "Delete exactly one selected document with --confirm delete.",
      retag:
        "Deterministically derive and apply structural tags (source_type, URL domain, collection) across every document, keeping documents.tags and chunks_fts.tags in sync; idempotent; --dry-run previews without writing.",
      tags: "Tag discovery.",
      sources:
        "Apply and inspect versioned recurring Source definitions, durably admit due X/feed discovery Runs, pause/resume them, and optionally wait for a scheduler-facing discovery/checkpoint receipt without waiting for child URL extraction.",
      prompt: "Prompt another harness to generate docs from this help surface.",
    },
    safety: {
      read_connections:
        "Read commands open SQLite with Bun's readonly option and never initialize or migrate.",
      writes:
        "Submit and its ingest alias write only durable jobs and required Artifact snapshots; materialization is restricted to the fenced worker path. Operator transitions and explicit content reveal are audited.",
      urls: "Admission validates HTTP(S) syntax and queues normalized intent without network work. The worker delegates all URL extraction and network policy to Agentscrape through a versioned envelope and rejects unknown envelope versions.",
      local_documents:
        "Text, file, and directory bytes are captured as immutable Artifacts before acknowledgement and parsed only after a worker leases the job.",
      directories:
        "Traversal streams entries, caps at 20000 entries/10000 supported candidates, and skips sensitive path components by default.",
      deletion: "Requires exactly one selector and literal --confirm delete.",
      retagging:
        "Derives structural tags only from source_type, URL domain, and collection membership; always preserves legacy-recovery and user tags; --dry-run performs no write.",
      no_raw_sql: true,
      owns_durable_ingestion_ledger: true,
      no_browser_or_network_implementation: true,
    },
    opt_in_smoke: {
      command: "./scripts/smoke-agentscrape-url-ingest.sh [url]",
      normal_checks_are_offline: true,
      temporary_state_only: true,
      behavior:
        "Submits a queued URL job into a temporary database, drains it with worker --once, verifies searchability, and preserves temporary evidence on failure.",
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
  agentbrain worker --help
  agentbrain jobs --help
  agentbrain doctor --help
  agentbrain delete --help
  agentbrain retag --help
  agentbrain stats --help
  agentbrain tags --help
  agentbrain sources --help

Document:
1. When to use context versus search -> get -> cite.
2. Exact --json examples and the citation fields.
3. Zero-result recovery through alternate terms, tags, and sources.
4. Generic explicit ingestion and guarded deletion.
5. The ownership boundary: Agentbrain owns durable admission, ingestion jobs, Artifact snapshots, and index writes; Agentscrape owns URL extraction/network/backend behavior.
6. Queued and duplicate submission acknowledgements, explicit idempotency conflicts, and --wait observation.
7. The opt-in real Agentscrape smoke: temporary database, queued URL Admission, worker --once, search verification, and preserved failed evidence.
8. DB override precedence: --db, then AGENTBRAIN_DB, then ~/.local/share/agentbrain/research.db.

Keep it short enough for an AGENTS.md / CLAUDE.md / harness instruction file.`;
