export function buildGuide(): unknown {
  return {
    name: "agentbrain",
    purpose:
      "Read-only CLI access to Mike's local research cache for coding agents and harnesses.",
    default_db: "~/.hermes/research-cache/research.db",
    source_types: {
      x: ["tweet", "tweet_article", "scraped_url"],
      note: "X-related content arrives through the saved-link/research pipeline; agentbrain only reads the shared Hermes cache.",
    },
    global_flags: [
      {
        flag: "--db <path>",
        meaning: "Override database path; AGENTBRAIN_DB also works.",
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
      citation_fields: ["document_id", "chunk_id", "source_uri", "title"],
      document_relations: {
        outbound_links:
          "Links discovered from the selected document to targets or unresolved URLs.",
        inbound_links:
          "Links whose from_document_id points at other documents and whose to_document_id points at the selected document.",
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
        "1": "runtime failure, not found, or database problem",
        "2": "usage or argument error",
      },
    },
    recommended_workflow: [
      "Run `agentbrain stats --json` if you need to understand available source types/tags/relations.",
      'Run `agentbrain search "your query" --json` before answering from saved resources.',
      "If recall is poor, retry with --mode all for precision or shorter/broader terms for recall; use --tag/--source-type after discovery.",
      "Fetch selected evidence with `agentbrain get --chunk-id ID --json` or `agentbrain get --document-id ID --char-limit 12000 --json`.",
      "When a document has provenance, inspect outbound_links and inbound_links to preserve relation chains.",
      "Cite document_id, chunk_id when applicable, title, source_uri, and relevant relation provenance in your answer.",
      "Do not infer absence from one failed search; try alternate terms before saying the cache has no relevant material.",
    ],
    commands: {
      stats:
        "Inventory counts, source types, tags, recent docs, and relation totals.",
      search:
        "FTS5 chunk search. Key fields: data.results[].{document_id,chunk_id,title,source_uri,snippet,tags,score}.",
      get: "Evidence retrieval by --document-id, --chunk-id, or --source-uri.",
      tags: "Tag discovery.",
      sources: "Source type and domain discovery.",
      prompt:
        "Prompt another harness to generate its own docs from the CLI help surface.",
    },
    safety: {
      read_only: true,
      no_raw_sql: true,
      no_delete_or_reindex: true,
      ingestion:
        "Out of scope for this CLI; use existing explicit ingestion lanes outside agentbrain.",
    },
  };
}

export const HARNESS_DOCS_PROMPT = `You are writing local agent-facing documentation for the \`agentbrain\` CLI.

Goal: produce concise docs that make your own harness/model excellent at using Mike's local research cache through CLI calls. Do not use MCP. Do not assume Hermes-specific tools. Prefer stable JSON output.

Inspect these commands directly and base your docs only on what they say:

  agentbrain --help
  agentbrain guide --json
  agentbrain stats --help
  agentbrain search --help
  agentbrain get --help
  agentbrain tags --help
  agentbrain sources --help

Then write a doc for your harness that includes:

1. When to use agentbrain.
2. The recommended search -> get -> cite workflow.
3. Exact command examples using --json.
4. How to handle zero/poor results: retry broader/shorter terms, try --mode all for precision, inspect tags/sources.
5. The citation rule: cite document_id, chunk_id when present, title, and source_uri.
6. The safety boundary: read-only cache lookup only; no deletion, reindexing, broad ingestion, or raw SQL.
7. A short troubleshooting section for db path override via --db or AGENTBRAIN_DB.

Keep it short enough to paste into an AGENTS.md / CLAUDE.md / harness-specific instruction file.`;
