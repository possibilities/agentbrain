import {
  AGENT_CONTRACT,
  type AgentContract,
  isGroup,
  walkCommands,
} from "./contract";

/**
 * `guide --json` emits the fleet agent contract verbatim.
 *
 * It is authored in src/contract.ts and nowhere else: `--help`,
 * `--agent-help`, `--agent-teaser`, and the harness-docs prompt below are all
 * renders of the same document.
 */
export function buildGuide(): AgentContract {
  return AGENT_CONTRACT;
}

/** Every command a harness should look at, so the list cannot go stale. */
function inspectionCommands(): string {
  return walkCommands()
    .filter((node) => !isGroup(node.command))
    .filter((node) => node.command.audience !== "internal")
    .map((node) => `  agentbrain help ${node.path.join(" ")}`)
    .join("\n");
}

export const HARNESS_DOCS_PROMPT = `You are writing local agent-facing documentation for the \`agentbrain\` CLI.

Goal: produce concise docs that make your harness excellent at searching and explicitly updating your local research index through shell calls. Do not use MCP. Prefer stable JSON.

Inspect, in this order:

  agentbrain guide --json
  agentbrain --agent-help
${inspectionCommands()}

Document:
1. When to use context versus search -> get -> cite.
2. Exact --json examples and the citation fields.
3. Zero-result recovery through alternate terms, tags, and sources.
4. Generic explicit ingestion and guarded deletion.
5. The ownership boundary: Agentbrain owns durable admission, ingestion jobs, Artifact snapshots, and index writes; Agentscrape owns URL extraction/network/backend behavior.
6. Queued, duplicate, and already_indexed submission acknowledgements, explicit idempotency conflicts, and --wait observation.
7. The opt-in real Agentscrape smoke (./scripts/smoke-agentscrape-url-ingest.sh [url]): temporary database, queued URL Admission, worker --once, search verification, and preserved failed evidence. The ordinary checks are offline and touch temporary state only.
8. DB override precedence: --db, then AGENTBRAIN_DB, then ~/.local/share/agentbrain/research.db.
9. Share ingress port precedence: --port, then PORT, then 8787; --portless is loopback-only desktop development and never replaces the tailnet address devices use.

Keep it short enough for an AGENTS.md / CLAUDE.md / harness instruction file.`;
