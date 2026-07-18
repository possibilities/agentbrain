export const VERSION = "0.2.0";

export const COMMANDS = [
  {
    name: "stats",
    summary:
      "Summarize DB size, counts, source types, tags, relations, and recent documents",
  },
  {
    name: "search",
    summary: "Search chunks with SQLite FTS5 and return ranked snippets",
  },
  {
    name: "get",
    summary: "Retrieve a full document by id/source URI or a chunk by id",
  },
  {
    name: "context",
    summary: "Return bounded citation-ready context for a query",
  },
  {
    name: "submit",
    summary: "Durably queue a text, file, directory, or URL intent",
  },
  {
    name: "ingest",
    summary: "Compatibility alias for durable queued admission",
  },
  {
    name: "worker",
    summary: "Lease and materialize durable ingestion jobs",
  },
  {
    name: "jobs",
    summary: "Safely inspect and operate on the ingestion ledger",
  },
  {
    name: "doctor",
    summary: "Check database, Artifact, lease, and provider health",
  },
  {
    name: "ingest-link",
    summary: "Index one completed Scrapectl payload from stdin",
  },
  {
    name: "delete",
    summary: "Delete one selected document with explicit confirmation",
  },
  { name: "tags", summary: "List indexed tags with document counts" },
  { name: "sources", summary: "List source types and source domains" },
  {
    name: "guide",
    summary: "Print the stable machine-readable agent contract",
  },
  {
    name: "prompt",
    summary: "Print a prompt harnesses can use to write their own docs",
  },
  { name: "help", summary: "Show help for a command" },
] as const;

const COMMAND_LINES = COMMANDS.map(
  (c) => `  ${c.name.padEnd(10)} ${c.summary}`,
).join("\n");

export const TOP_HELP = `agentbrain — agent-friendly CLI for Mike's local research cache

Usage:
  agentbrain [global options] <command> [command options]

Global options:
  --db <path>         SQLite DB path (default: ~/.hermes/research-cache/research.db; env: AGENTBRAIN_DB)
  --json             Emit a stable JSON envelope
  --jsonl            Emit newline-delimited records where supported (search)
  --format <fmt>     human | json | jsonl
  --quiet, -q        Suppress non-essential human output
  --help, -h         Show this help
  --version, -V      Show version

Commands:
${COMMAND_LINES}

Agent defaults:
  1. Start with: agentbrain guide --json
  2. Search before answering from saved resources: agentbrain search "query" --json
  3. Fetch selected evidence: agentbrain get --document-id <id> --json or --chunk-id <id> --json
  4. Cite document_id, chunk_id when present, title, source_uri, and relation provenance when relevant.

Search/get/stats/tags/sources/context use structurally read-only SQLite connections.
Agentbrain submit is the durable admission boundary. Accepted intents are queued before any
extraction or indexing; Scrapectl remains the sole URL extraction and network boundary.
Use --help on any command for command-specific options. Job inspection omits durable
intent bodies and URLs unless jobs show is given the audited --reveal-content option.
`;

export const HELP: Record<string, string> = {
  stats: `agentbrain stats — database inventory

Usage:
  agentbrain stats [--top-tags N] [--recent N] [--json]

Options:
  --top-tags <n>      Number of top tags to include (default: 25, max: 500)
  --recent <n>        Number of recent documents to include (default: 5, max: 50)

Examples:
  agentbrain stats
  agentbrain stats --json
`,
  search: `agentbrain search — ranked FTS chunk search

Usage:
  agentbrain search <query> [options]

Options:
  --query <text>      Query text; useful when the query begins with '-'
  --mode <mode>       any | all | raw (default: any)
  --limit <n>         Results per page (default: 10, max: 50)
  --offset <n>        Page offset (default: 0)
  --tag <tag>         Require a document tag, exact match
  --source-type <t>   Require a legacy document source_type
  --collection <slug> Require exact collection membership
  --source <id>       Require an exact source identifier (or source_type:identifier)
  --resource-kind <k> Require an exact resource kind
  --sensitivity <s>   Require effective public | normal | sensitive | private policy
  --date <yyyy-mm-dd> Require the document update date
  --date-from <date>  Require updates on or after a date or ISO timestamp
  --date-to <date>    Require updates through a date or ISO timestamp
  --local-path <path> Require an exact local document path or resource alias
  --json             Emit an envelope with data.results[]
  --jsonl            Emit one result per line; first line is a metadata record

Query modes:
  any                 Tokenize query and join terms with OR; best first pass
  all                 Tokenize query and require every term/phrase
  raw                 Pass raw SQLite FTS5 MATCH syntax through unchanged

Examples:
  agentbrain search "agent memory systems" --json
  agentbrain search "karpathy llm" --tag source-item --limit 5
  agentbrain search --mode all "cli mcp agents" --json
`,
  get: `agentbrain get — retrieve evidence

Usage:
  agentbrain get (--document-id ID | --chunk-id ID | --source-uri URI) [options]

Options:
  --document-id <id>  Retrieve a document by document id
  --chunk-id <id>     Retrieve a single chunk by chunk id
  --source-uri <uri>  Retrieve the most recently updated document with this source URI
  --char-limit <n>    Limit document content with head/tail truncation (default: 20000; min: 500)
  --full              Return full document content; ignored for chunk retrieval
  --json              Emit stable JSON envelope

Output fields:
  document get results include outbound_links and inbound_links relation arrays when document_links exists.
  Each relation object carries id, from_document_id, to_document_id, relation_type, discovered_url, resolved_url, status, error, created_at, updated_at.

Examples:
  agentbrain get --chunk-id 4044 --json
  agentbrain get --document-id 347 --char-limit 12000 --json
  agentbrain get --source-uri https://example.com/article --full
`,
  context: `agentbrain context — bounded citation-ready evidence

Usage:
  agentbrain context <query> [--limit N] [--max-chars N] [filters] [--json]

Options:
  --query <text>      Query text instead of positional words
  --limit <n>         Maximum resource hits (default: 6, max: 20)
  --max-chars <n>     Total chunk-content budget (default: 12000; 500..50000)
  --tag <tag>         Require an exact document tag
  --source-type <t>   Require a legacy document source_type
  --collection <slug> Require exact collection membership
  --source <id>       Require an exact source identifier (or source_type:identifier)
  --resource-kind <k> Require an exact resource kind
  --sensitivity <s>   Require effective public | normal | sensitive | private policy
  --date <yyyy-mm-dd> Require the document update date
  --date-from <date>  Require updates on or after a date or ISO timestamp
  --date-to <date>    Require updates through a date or ISO timestamp
  --local-path <path> Require an exact local document path or resource alias

The JSON data.hits objects include resource provenance, typed relation summaries,
citation, bounded chunk content, offsets, tags, score, and per-hit truncation. Linked
resource content is never concatenated into a context hit.
`,
  submit: `agentbrain submit — durable ingestion admission

Usage:
  agentbrain submit <source> [options]

Options:
  --intent-version <n> Versioned intent contract (default: 1)
  --kind <kind>        auto | url | file | directory | text (default: auto)
  --ingress <name>     Submitting actor/interface (default: cli)
  --collection <slug> Request collection membership; repeatable
  --idempotency-key <key> Explicit replay identity
  --title <text>       Requested title
  --tag <tag>          Add a tag; repeatable
  --tags <tags>        Add comma/hash-separated tags; repeatable
  --notes <text>       Store requested notes
  --recursive=<bool>   Recurse through directories (default: true)
  --max-files <n>      Directory snapshot cap (default: 300; max: 5000)
  --max-bytes <n>      Text or per-file snapshot cap (default: 5000000)
  --force              Request rematerialization
  --skip-secrets=<b>   Skip sensitive files/path components (default: true)
  --wait               Observe the admitted job without bypassing the worker
  --wait-timeout-ms <n> Stop observing after this duration (default: 30000)
  --json               Emit a versioned success or error envelope

A new intent exits 0 with status queued. An equivalent intent exits 0 with status
duplicate and the same job_id. Reusing an explicit idempotency key for different intent
fails. Local bytes are snapshotted into the Artifact store before acknowledgement. URL
admission performs no network work. A wait timeout leaves the job queued and recoverable.
`,
  ingest: `agentbrain ingest — queued compatibility alias

Usage:
  agentbrain ingest <source> [options]

This command accepts the same options and returns the same acknowledgement as
\`agentbrain submit\`. It never extracts, parses, or writes a document directly.
Prefer \`agentbrain submit\` for new integrations. \`--source-type\` remains an alias for
\`--kind\` during cutover.
`,
  worker: `agentbrain worker — execute durable ingestion jobs

Usage:
  agentbrain worker [--once] [options]

Options:
  --once                    Recover stale leases, drain work due now, and exit
  --worker-id <id>          Diagnostic worker identity
  --poll-ms <n>             Idle polling interval (default: 1000)
  --lease-ms <n>            Attempt lease duration (default: 60000)
  --heartbeat-ms <n>        Active lease heartbeat interval (default: 20000)
  --shutdown-grace-ms <n>   Bounded completion grace after a signal (default: 10000)

Materialization happens outside SQLite write transactions. Completion and failure are
fenced by the attempt token. Signal shutdown stops new claims and leaves unfinished work
recoverable through lease expiry.
`,
  jobs: `agentbrain jobs — inspect and operate on ingestion jobs

Usage:
  agentbrain jobs list [--state STATE] [--limit N] [--json]
  agentbrain jobs show JOB_ID [--reveal-content] [--actor NAME] [--json]
  agentbrain jobs retry JOB_ID [--reason TEXT] [--actor NAME] [--json]
  agentbrain jobs cancel JOB_ID [--reason TEXT] [--actor NAME] [--json]
  agentbrain jobs exclude JOB_ID --reason TEXT [--actor NAME] [--json]
  agentbrain jobs stats [--json]

List, ordinary show, and stats are structurally read-only and omit durable intent,
Artifact bodies, raw URLs, query values, worker names, and detailed diagnostics.
--reveal-content explicitly reads Artifact bodies and appends a sensitive-inspection
audit record. Retry, cancel, and exclude append transitions and preserve all attempts.
`,
  doctor: `agentbrain doctor — operational health checks

Usage:
  agentbrain doctor [--json]

Uses a structurally read-only database connection. Reports safe status/count data for
SQLite integrity, schema, Artifact references, leases, and Scrapectl availability.
Exits 1 when a required check fails.
`,
  "ingest-link": `agentbrain ingest-link — index a completed scraped link

Usage:
  printf '%s' '{"url":"https://example.com","markdown":"# Saved"}' | agentbrain ingest-link --json

Reads exactly one JSON object from stdin. Fields: url, markdown, optional structured,
source, title, category, tags, summary, notes, preset, and save_markdown_copy. Raw stdin
is capped at 10000000 bytes; markdown is capped at 5000000 UTF-8 bytes and 5000000
Unicode code points. Invalid/oversize input is rejected before the database is opened.

Every completed root is indexed without re-scraping it. Generic roots do not fan out.
Every discovered one-hop child from an X root (external and X alike) is extracted through
the same Scrapectl provider adapter.
Agentbrain performs no DNS/network checks, direct HTTP fallback, or X-specific extraction
route. Transient provider-command availability retries automatically; permanent failure is
recorded as a child failure. There is never a second child hop.

Optional artifacts are written below XDG_DATA_HOME/agentbrain/scraped (default
~/.local/share/agentbrain/scraped). Artifact failure leaves the root committed and is a
partial result. Exit 0 means complete; exit 1 means invalid/root failure; exit 2 means
a root-success child/artifact partial. The separate research-ingest-link adapter uses
the same limits/exits but emits temporary legacy bare JSON.

Linkctl owns admission/duplicates. Scrapectl owns queueing and URL extraction.
Agentbrain owns the research index.
`,
  delete: `agentbrain delete — delete one indexed document

Usage:
  agentbrain delete (--document-id ID | --source-uri URI) --confirm delete [--json]

Exactly one selector and the literal confirmation token are required. The document,
chunks, and FTS rows are removed transactionally; inbound relation targets become null.
`,
  tags: `agentbrain tags — list tags

Usage:
  agentbrain tags [--limit N] [--json]

Options:
  --limit <n>         Number of tags (default: 100, max: 500)
`,
  sources: `agentbrain sources — list source types and domains

Usage:
  agentbrain sources [--limit N] [--json]

Options:
  --limit <n>         Number of domains (default: 100, max: 500)
`,
  guide: `agentbrain guide — machine-readable CLI contract for agents

Usage:
  agentbrain guide [--json]

The JSON output documents commands, output contracts, citation expectations, and failure handling.
`,
  prompt: `agentbrain prompt — prompt for harness-authored docs

Usage:
  agentbrain prompt

Prints a ready-to-use prompt asking another harness/model to inspect this CLI's --help output and write its own local agent-facing docs.
`,
};

export function helpFor(command: string | null): string {
  if (command === null) return TOP_HELP;
  return HELP[command] ?? TOP_HELP;
}
