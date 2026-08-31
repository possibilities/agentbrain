/**
 * The transport. `agentbrain mcp` calls this and does not return until the host
 * closes stdio.
 *
 * Nothing else may write to stdout while this is running: stdout is the
 * protocol channel. Every command's output goes back through the tool result
 * instead, which is what `format.ts`'s capture is for.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentbrainMcpServer, type ServerOptions } from "./mcp-server";

export async function serveAgentbrainMcp(
  options: ServerOptions,
): Promise<void> {
  const server = createAgentbrainMcpServer(options);
  await server.connect(new StdioServerTransport());
  // connect() returns as soon as the transport is listening. The process stays
  // alive on stdin, and this resolves when the host closes it.
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
}
