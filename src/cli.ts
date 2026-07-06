#!/usr/bin/env bun
import {
  optBoolean,
  optNumber,
  optString,
  parseOptions,
  parseTopLevel,
} from "./args";
import { ResearchCache } from "./db";
import { CliError } from "./errors";
import { errorEnvelope, writeByFormat, writeJson } from "./format";
import { buildGuide, HARNESS_DOCS_PROMPT } from "./guide";
import { COMMANDS, helpFor, TOP_HELP, VERSION } from "./help";
import {
  humanChunk,
  humanDocument,
  humanSearch,
  humanSources,
  humanStats,
  humanTags,
  searchJsonl,
} from "./render";
import type { GlobalOptions, SearchMode } from "./types";

const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name));
const DB_COMMANDS = new Set(["stats", "search", "get", "tags", "sources"]);

async function run(argv: string[]): Promise<void> {
  const parsed = parseTopLevel(argv);
  const command = parsed.command;

  if (parsed.showVersion) {
    process.stdout.write(`agentbrain ${VERSION}\n`);
    return;
  }

  if (parsed.showHelp && command === null) {
    process.stdout.write(TOP_HELP);
    return;
  }

  if (command === null) {
    process.stderr.write(TOP_HELP);
    process.exit(1);
  }

  if (command === "help") {
    process.stdout.write(helpFor(parsed.commandArgv[0] ?? null));
    return;
  }

  if (parsed.showHelp) {
    process.stdout.write(helpFor(command));
    return;
  }

  if (!COMMAND_NAMES.has(command as (typeof COMMANDS)[number]["name"])) {
    throw new CliError("unknown_command", `unknown command '${command}'`, {
      exitCode: 2,
      hint: "Run `agentbrain --help` for the command list.",
    });
  }

  if (command === "guide") {
    writeByFormat(
      "guide",
      buildGuide(),
      parsed.globals,
      () => `${JSON.stringify(buildGuide(), null, 2)}\n`,
    );
    return;
  }

  if (command === "prompt") {
    process.stdout.write(`${HARNESS_DOCS_PROMPT}\n`);
    return;
  }

  if (!DB_COMMANDS.has(command)) {
    throw new CliError(
      "unimplemented_command",
      `command '${command}' is not implemented`,
    );
  }

  const cache = new ResearchCache(parsed.globals.dbPath);
  try {
    switch (command) {
      case "stats":
        runStats(cache, parsed.commandArgv, parsed.globals);
        break;
      case "search":
        runSearch(cache, parsed.commandArgv, parsed.globals);
        break;
      case "get":
        runGet(cache, parsed.commandArgv, parsed.globals);
        break;
      case "tags":
        runTags(cache, parsed.commandArgv, parsed.globals);
        break;
      case "sources":
        runSources(cache, parsed.commandArgv, parsed.globals);
        break;
      default:
        throw new CliError(
          "unimplemented_command",
          `command '${command}' is not implemented`,
        );
    }
  } finally {
    cache.close();
  }
}

function runStats(
  cache: ResearchCache,
  argv: string[],
  globals: GlobalOptions,
): void {
  const opts = parseOptions(argv, {
    "top-tags": { type: "number", default: 25 },
    recent: { type: "number", default: 5 },
  });
  if (opts._.length > 0)
    throw new CliError(
      "unexpected_args",
      `stats does not accept positional args: ${opts._.join(" ")}`,
      { exitCode: 2 },
    );
  const data = cache.stats({
    topTags: optNumber(opts, "top-tags") ?? 25,
    recent: optNumber(opts, "recent") ?? 5,
  });
  writeByFormat("stats", data, globals, humanStats);
}

function runSearch(
  cache: ResearchCache,
  argv: string[],
  globals: GlobalOptions,
): void {
  const opts = parseOptions(argv, {
    query: { type: "string" },
    mode: { type: "string", default: "any" },
    limit: { type: "number", default: 10 },
    offset: { type: "number", default: 0 },
    tag: { type: "string" },
    "source-type": { type: "string" },
  });
  const query = optString(opts, "query") ?? opts._.join(" ");
  const mode = parseSearchMode(optString(opts, "mode") ?? "any");
  const data = cache.search({
    query,
    mode,
    limit: optNumber(opts, "limit"),
    offset: optNumber(opts, "offset"),
    tag: optString(opts, "tag"),
    sourceType: optString(opts, "source-type"),
  });
  writeByFormat("search", data, globals, humanSearch, { jsonl: searchJsonl });
}

function runGet(
  cache: ResearchCache,
  argv: string[],
  globals: GlobalOptions,
): void {
  const opts = parseOptions(argv, {
    "document-id": { type: "number" },
    "chunk-id": { type: "number" },
    "source-uri": { type: "string" },
    "char-limit": { type: "number", default: 20000 },
    full: { type: "boolean", default: false },
  });
  if (opts._.length > 0)
    throw new CliError(
      "unexpected_args",
      `get does not accept positional args: ${opts._.join(" ")}`,
      { exitCode: 2 },
    );
  const selectors = [
    opts["document-id"] !== undefined,
    opts["chunk-id"] !== undefined,
    opts["source-uri"] !== undefined,
  ].filter(Boolean).length;
  if (selectors !== 1) {
    throw new CliError(
      "bad_selector",
      "get requires exactly one of --document-id, --chunk-id, or --source-uri",
      { exitCode: 2 },
    );
  }
  const chunkId = optNumber(opts, "chunk-id");
  if (chunkId !== undefined) {
    const data = cache.getChunk(assertInteger(chunkId, "chunk-id"));
    writeByFormat("get", data, globals, humanChunk);
    return;
  }
  const charLimit = optBoolean(opts, "full")
    ? null
    : assertInteger(optNumber(opts, "char-limit") ?? 20000, "char-limit");
  const documentId = optNumber(opts, "document-id");
  const data = cache.getDocument({
    documentId:
      documentId === undefined
        ? undefined
        : assertInteger(documentId, "document-id"),
    sourceUri: optString(opts, "source-uri"),
    charLimit,
  });
  writeByFormat("get", data, globals, humanDocument);
}

function runTags(
  cache: ResearchCache,
  argv: string[],
  globals: GlobalOptions,
): void {
  const opts = parseOptions(argv, { limit: { type: "number", default: 100 } });
  if (opts._.length > 0)
    throw new CliError(
      "unexpected_args",
      `tags does not accept positional args: ${opts._.join(" ")}`,
      { exitCode: 2 },
    );
  writeByFormat(
    "tags",
    cache.tags(optNumber(opts, "limit")),
    globals,
    humanTags,
  );
}

function runSources(
  cache: ResearchCache,
  argv: string[],
  globals: GlobalOptions,
): void {
  const opts = parseOptions(argv, { limit: { type: "number", default: 100 } });
  if (opts._.length > 0)
    throw new CliError(
      "unexpected_args",
      `sources does not accept positional args: ${opts._.join(" ")}`,
      { exitCode: 2 },
    );
  writeByFormat(
    "sources",
    cache.sources(optNumber(opts, "limit")),
    globals,
    humanSources,
  );
}

function parseSearchMode(value: string): SearchMode {
  if (value === "any" || value === "all" || value === "raw") return value;
  throw new CliError("bad_mode", `unknown search mode '${value}'`, {
    exitCode: 2,
    hint: "Use one of: any, all, raw.",
  });
}

function assertInteger(value: number, name: string): number {
  if (!Number.isInteger(value))
    throw new CliError("bad_integer", `--${name} must be an integer`, {
      exitCode: 2,
    });
  return value;
}

if (import.meta.main) {
  run(Bun.argv.slice(2)).catch((err: unknown) => {
    const command = parseTopLevel(Bun.argv.slice(2)).command ?? "(none)";
    if (err instanceof CliError) {
      if (Bun.argv.includes("--json") || Bun.argv.includes("--format=json")) {
        writeJson(errorEnvelope(command, err.code, err.message, err.hint));
      } else {
        process.stderr.write(`agentbrain: ${err.message}\n`);
        if (err.hint !== undefined) process.stderr.write(`hint: ${err.hint}\n`);
      }
      process.exit(err.exitCode);
    }
    process.stderr.write(
      `agentbrain: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
