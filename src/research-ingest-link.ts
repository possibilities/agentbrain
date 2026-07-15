#!/usr/bin/env bun
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  COMPLETED_LINK_MARKDOWN_MAX_BYTES,
  COMPLETED_LINK_MARKDOWN_MAX_CODE_POINTS,
  COMPLETED_LINK_STDIN_MAX_BYTES,
  type CompletedLinkPayload,
  readCompletedLinkPayload,
} from "./completed-link-input";
import { ingestPrescrapedLink } from "./link-ingest";
import { ResearchStore } from "./store";

const HELP = `research-ingest-link — Scrapectl-compatible completed-link adapter

Usage:
  research-ingest-link [--db PATH] [--json] < payload.json

Reads one {url, markdown, structured?, source?, ...} JSON object from stdin.
Raw stdin is capped at ${COMPLETED_LINK_STDIN_MAX_BYTES} bytes; markdown is capped at
${COMPLETED_LINK_MARKDOWN_MAX_BYTES} UTF-8 bytes and ${COMPLETED_LINK_MARKDOWN_MAX_CODE_POINTS} Unicode code points.
Output is legacy bare JSON, not the Agentbrain envelope.

Exit codes:
  0  complete success
  1  invalid input or root failure
  2  root committed with child or optional artifact failure
`;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function parseArgs(argv: string[]): { dbPath: string; help: boolean } {
  let path =
    process.env.AGENTBRAIN_DB ?? "~/.hermes/research-cache/research.db";
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--db") {
      const value = argv[++index];
      if (!value) throw new Error("--db requires a path");
      path = value;
      continue;
    }
    if (arg.startsWith("--db=")) {
      path = arg.slice("--db=".length);
      continue;
    }
    throw new Error(`unknown option ${arg}`);
  }
  return { dbPath: expandHome(path), help };
}

function errorPayload(message: string, kind: string): Record<string, unknown> {
  return {
    success: false,
    root_success: false,
    error: message,
    error_kind: kind,
  };
}

export async function legacyMain(argv: string[]): Promise<number> {
  let args: { dbPath: string; help: boolean };
  try {
    args = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify(errorPayload(message, "invalid_payload"), null, 2)}\n`,
    );
    return 1;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let payload: CompletedLinkPayload;
  try {
    payload = await readCompletedLinkPayload();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify(errorPayload(message, "invalid_payload"), null, 2)}\n`,
    );
    return 1;
  }

  let store: ResearchStore | undefined;
  try {
    store = new ResearchStore(args.dbPath);
    const result = await ingestPrescrapedLink(store, payload);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.success ? 0 : result.root_success ? 2 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify(errorPayload(message, "root_ingest"), null, 2)}\n`,
    );
    return 1;
  } finally {
    store?.close();
  }
}

if (import.meta.main) process.exit(await legacyMain(Bun.argv.slice(2)));
