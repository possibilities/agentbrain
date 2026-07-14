export const VERSION = "0.1.0";

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

All DB access is read-only. Ingestion arrives through the saved-link/research pipeline outside this CLI.
Use --help on any command for command-specific options.
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
  --source-type <t>   Require source_type, e.g. tweet, tweet_article, scraped_url
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
