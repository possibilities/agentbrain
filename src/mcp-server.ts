/**
 * The MCP server `agentbrain mcp` serves, constructed but not connected.
 *
 * Two things make this a generated surface rather than a second one. The tools
 * come from the contract through `mcp-tools.ts`, so adding a command to
 * `contract.ts` adds a tool with no edit here. And every call is dispatched
 * through `dispatch.ts`'s own `runParsed`, in this process — the same code path
 * `agentbrain search` runs, with nothing spawned.
 *
 * agentbrain's commands print rather than return: `runParsed` writes the
 * envelope to the process's output and yields nothing. Under this server stdout
 * is the JSON-RPC transport, so each call runs inside `captureOutput` and the
 * text the command would have printed becomes the tool result. That indirection
 * is the whole difference from a sibling whose dispatcher returns a value, and
 * it is why `format.ts` owns a single write path.
 *
 * `mcp.ts` is the entrypoint that connects a transport to what this returns.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ParsedArgv } from "./args";
import { AGENT_CONTRACT, VERSION } from "./contract";
import { runParsed } from "./dispatch";
import { CliError } from "./errors";
import { captureOutput, errorEnvelope } from "./format";
import {
  type AgentTool,
  agentTools,
  invocationFor,
  serverInstructions,
} from "./mcp-tools";

export interface ServerOptions {
  /** The research index every tool call uses, resolved once when the server
   * starts. `--db` is an operator's choice about which index is being served,
   * which is exactly why it is not a tool argument. */
  dbPath: string;
  /** Whether that path came from the default location rather than `--db` or
   * `AGENTBRAIN_DB`, so each call makes the same location check a terminal
   * invocation would. */
  usesDefaultDb: boolean;
}

export function createAgentbrainMcpServer(options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: AGENT_CONTRACT.meta.name, version: VERSION },
    { instructions: serverInstructions() },
  );
  for (const tool of agentTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.annotations,
      },
      // The SDK infers the callback's argument type from the input schema,
      // which is built at runtime and so infers to nothing useful. The shape is
      // whatever the schema just validated: a plain object of argument values.
      (args: unknown) =>
        callTool(tool, (args ?? {}) as Record<string, unknown>, options),
    );
  }
  return server;
}

/**
 * One tool call, dispatched in process.
 *
 * The database is opened by the command and closed after it, exactly as a
 * terminal invocation would: a resident handle would hold a connection open for
 * the server's whole lifetime for no gain, and read commands deliberately open
 * a structurally read-only connection of their own.
 */
async function callTool(
  tool: AgentTool,
  args: Record<string, unknown>,
  options: ServerOptions,
): Promise<CallToolResult> {
  const { command, commandArgv } = invocationFor(tool, args);
  // The parser's own output shape, assembled rather than re-parsed: JSON,
  // because a tool result is read by a program, and the served database, which
  // no caller may redirect.
  const parsed: ParsedArgv = {
    command,
    commandArgv,
    globals: { dbPath: options.dbPath, format: "json", quiet: false },
    showHelp: false,
    showVersion: false,
    showAgentHelp: false,
    showAgentTeaser: false,
    usesDefaultDb: options.usesDefaultDb,
  };
  try {
    const text = await captureOutput(() => runParsed(parsed));
    return { content: [{ type: "text", text: text.trimEnd() }] };
  } catch (error) {
    return toolError(command, error);
  }
}

/**
 * A refusal, as MCP.md rules: the message leads with `error.code`, then the
 * message, then `recovery` when the contract gives one — the recovery line is
 * the difference between a caller that retries correctly and one that retries
 * identically. The envelope follows, so anything already parsing agentbrain
 * parses the same shape here.
 *
 * Every refusal in this CLI carries a contract code, usage faults included: a
 * bad flag is `unknown_option` and exit 2 at a terminal, not a code-less
 * failure. So there is no second, code-less error shape to invent here, and
 * anything that escapes without a `CliError` is `unexpected_error`, exactly as
 * `main` would have reported it.
 */
function toolError(command: string, error: unknown): CallToolResult {
  const domain =
    error instanceof CliError
      ? error
      : new CliError(
          "unexpected_error",
          error instanceof Error ? error.message : String(error),
        );
  const lines = [`${domain.code}: ${domain.message}`];
  if (domain.recovery !== undefined) lines.push(`recovery: ${domain.recovery}`);
  lines.push(
    JSON.stringify(
      errorEnvelope(command, domain.code, domain.message, domain.recovery),
      null,
      2,
    ),
  );
  return { isError: true, content: [{ type: "text", text: lines.join("\n") }] };
}
