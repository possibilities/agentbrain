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
    name: "backup",
    summary: "Create and verify private SQLite recovery snapshots",
  },
  {
    name: "recovery",
    summary: "Verify and durably admit a frozen legacy recovery generation",
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
Backup creation uses a SQLite-consistent snapshot and never copies a live WAL file.
Recovery import verifies the complete frozen generation and local Artifact hashes before
admission; --dry-run writes no database or Artifact state and performs no network work.
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
  --run <id>                Pin an operator-controlled Run
  --authorization-digest <sha256>  Require the persisted authorization digest
  --allowed-kind <kind>     Require a persisted allowed job kind; repeatable

Scoped execution requires --once and all three scope options. It performs no scheduling,
rejects policy or cardinality mismatches before claim, and never falls back to ordinary
queue claims. Offline Runs cannot authorize URL extraction; online Runs authorize exactly
two URL jobs already bound to that Run and hold a single fenced execution lease. Ordinary
workers skip every operator-controlled Run.

Materialization happens outside SQLite write transactions. URL jobs delegate a versioned
extraction envelope to Scrapectl; unknown envelope versions are protocol defects rather
than provider-schema fallbacks. Completion and failure are fenced by the attempt token.
Signal shutdown stops new claims and leaves unfinished work recoverable through lease
expiry.
`,
  jobs: `agentbrain jobs — inspect and operate on ingestion jobs

Usage:
  agentbrain jobs list [--state STATE] [--run RUN_ID] [--limit N] [--json]
  agentbrain jobs show JOB_ID [--reveal-content] [--actor NAME] [--json]
  agentbrain jobs run RUN_ID [--limit N] [--json]
  agentbrain jobs retry JOB_ID [--reason TEXT] [--actor NAME] [--json]
  agentbrain jobs cancel JOB_ID [--reason TEXT] [--actor NAME] [--json]
  agentbrain jobs exclude JOB_ID --reason TEXT [--actor NAME] [--json]
  agentbrain jobs stats [--run RUN_ID] [--json]

List, ordinary show, Run inspection, and stats are structurally read-only and omit durable
intent, Run checkpoints, Artifact bodies, raw URLs, query values, worker names, and
detailed diagnostics. Run inspection reports only opaque IDs and authorization digests,
state and kind counts, Attempt counts, quiescence, and bounded safe job views.
--reveal-content explicitly reads Artifact bodies and appends a sensitive-inspection
audit record. Retry, cancel, and exclude append transitions and preserve all attempts.
`,
  backup: `agentbrain backup — create and verify recovery snapshots

Usage:
  agentbrain backup create <backup-path> [--artifact-root PATH] [--json]
  agentbrain backup create --output <backup-path> [--artifact-root PATH] [--json]
  agentbrain backup verify <backup-path> [--artifact-root PATH] [--json]
  agentbrain backup verify --backup <backup-path> [--artifact-root PATH] [--json]

Subcommands:
  create              Publish a private, SQLite-consistent backup bundle
  verify              Restore into isolation and run all recovery checks

Options:
  --output <path>      Backup destination for create; it must not already exist
  --backup <path>      Backup bundle to verify
  --artifact-root <p>  Artifact store to check (default: configured local store on
                       create; source path recorded in the manifest on verify)

The bundle contains database.sqlite and a body-free manifest with schema, timestamps,
source paths, configuration, and required Artifact digests/references. Creation uses
SQLite VACUUM INTO through the Index owner's writable store, so committed WAL state is
captured without stopping the Worker permanently. Publication is atomic and never
replaces an existing backup.

Verification never opens or migrates the source database. It copies snapshot bytes into
a private temporary restore, runs SQLite integrity and schema checks, reconciles the
Artifact reference manifest, verifies each required Artifact digest, and proves that FTS
can be rebuilt from retained indexed content. The temporary restore is always removed.
Verification exits 1 if any check fails.
`,
  recovery: `agentbrain recovery — frozen legacy recovery admission

Usage:
  agentbrain recovery import --manifest-generation PATH [options]

Options:
  --manifest-generation <path>  Atomic generation pointer, directory, or generation.json
  --artifact-root <path>         Declared root for legacy Markdown; repeatable
  --artifact-store <path>        Destination Artifact store for admitted searchable bodies
  --authorize-offline            Bind the admitted Run to recovery_offline scoped execution
  --dry-run                      Verify all descriptors, hashes, rows, and frontmatter only
  --json                         Emit a count-only stable envelope

The importer accepts only the hash-bound 1,088-row frozen recovery contract. It verifies
all generation files and approved local Markdown without invoking Scrapectl or any other
network backend. Linkctl frontmatter is parsed locally; its exact URL must match the
candidate, while only the frontmatter-free body enters the Artifact store.

Dry-run performs no database or Artifact-store writes. Admission creates one pending
recovery Run, stable candidate outcomes, 584 ordered legacy-links memberships, body-free
Secretary observations, 581 runnable offline jobs, 11 blocked jobs, and 37 exclusions.
--authorize-offline immutably binds that Run to the generation digest and the logical
recovery_offline scope, which selects only its 581 recovery file jobs while rejecting URL
and unrelated file claims. The two controlled-online jobs remain blocked until a separate
run explicitly authorizes egress. Comparison URIs are diagnostic aliases only and never
merge candidate outcomes.
Output contains opaque generation IDs and aggregate counts, never exact candidate URLs,
private locators, message bodies, credentials, or filesystem paths.
`,
  doctor: `agentbrain doctor — operational health checks

Usage:
  agentbrain doctor [--json]

Uses a structurally read-only database connection. Reports safe status/count data for
SQLite integrity, schema, Artifact references, leases, and Scrapectl availability.
Exits 1 when a required check fails.
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
