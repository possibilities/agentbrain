#!/usr/bin/env bun
import { existsSync } from "node:fs";
import {
  optBoolean,
  optNumber,
  optString,
  optStrings,
  parseOptions,
  parseTopLevel,
} from "./args";
import {
  type CompletedLinkPayload,
  readCompletedLinkPayload,
} from "./completed-link-input";
import { ResearchCache } from "./db";
import { CliError } from "./errors";
import { errorEnvelope, writeByFormat, writeJson } from "./format";
import { buildGuide, HARNESS_DOCS_PROMPT } from "./guide";
import { COMMANDS, helpFor, TOP_HELP, VERSION } from "./help";
import { type IngestSourceType, ingestSource } from "./ingest";
import { ingestPrescrapedLink } from "./link-ingest";
import {
  humanChunk,
  humanContext,
  humanDocument,
  humanMutation,
  humanSearch,
  humanSources,
  humanStats,
  humanTags,
  searchJsonl,
} from "./render";
import { ResearchStore } from "./store";
import { normalizeTags } from "./text";
import type { GlobalOptions, SearchMode } from "./types";
import { validateHttpUrl } from "./url";

const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name));
const READ_COMMANDS = new Set([
  "stats",
  "search",
  "get",
  "tags",
  "sources",
  "context",
]);
const MUTATION_COMMANDS = new Set(["ingest", "ingest-link", "delete"]);

interface IngestRequest {
  source: string;
  sourceType: IngestSourceType;
  title?: string;
  tags: string[];
  notes?: string;
  recursive: boolean;
  maxFiles: number;
  maxBytes: number;
  force: boolean;
  skipSecrets: boolean;
}

interface DeleteRequest {
  documentId?: number;
  sourceUri?: string;
  confirm: "delete";
}

const INGEST_OPTION_SPECS = {
  "source-type": { type: "string", default: "auto" },
  title: { type: "string" },
  tag: { type: "string", multiple: true },
  tags: { type: "string", multiple: true },
  notes: { type: "string" },
  recursive: { type: "boolean", default: true },
  "max-files": { type: "number", default: 300 },
  "max-bytes": { type: "number", default: 5000000 },
  force: { type: "boolean", default: false },
  "skip-secrets": { type: "boolean", default: true },
} as const;

const DELETE_OPTION_SPECS = {
  "document-id": { type: "number" },
  "source-uri": { type: "string" },
  confirm: { type: "string" },
} as const;

async function runParsed(
  parsed: ReturnType<typeof parseTopLevel>,
): Promise<void> {
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

  if (READ_COMMANDS.has(command)) {
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
        case "context":
          runContext(cache, parsed.commandArgv, parsed.globals);
          break;
      }
    } finally {
      cache.close();
    }
    return;
  }

  if (command === "ingest-link") {
    await runIngestLink(
      parsed.globals.dbPath,
      parsed.commandArgv,
      parsed.globals,
    );
    return;
  }

  if (MUTATION_COMMANDS.has(command)) {
    if (command === "ingest") {
      const request = parseIngestRequest(parsed.commandArgv);
      const store = new ResearchStore(parsed.globals.dbPath);
      try {
        await executeIngest(store, request, parsed.globals);
      } finally {
        store.close();
      }
      return;
    }

    if (command === "delete") {
      const request = parseDeleteRequest(parsed.commandArgv);
      if (!existsSync(parsed.globals.dbPath)) {
        throw new CliError(
          "db_not_found",
          `research cache DB not found: ${parsed.globals.dbPath}`,
          { hint: "Pass --db PATH or set AGENTBRAIN_DB." },
        );
      }
      const store = new ResearchStore(parsed.globals.dbPath);
      try {
        executeDelete(store, request, parsed.globals);
      } finally {
        store.close();
      }
      return;
    }
  }

  throw new CliError(
    "unimplemented_command",
    `command '${command}' is not implemented`,
  );
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

function runContext(
  cache: ResearchCache,
  argv: string[],
  globals: GlobalOptions,
): void {
  const opts = parseOptions(argv, {
    query: { type: "string" },
    limit: { type: "number", default: 6 },
    "max-chars": { type: "number", default: 12000 },
  });
  const query = optString(opts, "query") ?? opts._.join(" ");
  const data = cache.context({
    query,
    limit: optNumber(opts, "limit"),
    maxChars: optNumber(opts, "max-chars"),
  });
  writeByFormat("context", data, globals, humanContext);
}

function parseIngestRequest(argv: string[]): IngestRequest {
  const opts = parseOptions(argv, INGEST_OPTION_SPECS);
  if (opts._.length !== 1) {
    throw new CliError(
      "bad_source",
      "ingest requires exactly one <source> positional argument",
      { exitCode: 2 },
    );
  }
  const sourceType = optString(opts, "source-type") ?? "auto";
  if (!["auto", "url", "file", "directory", "text"].includes(sourceType)) {
    throw new CliError(
      "bad_source_type",
      `unknown source type '${sourceType}'`,
      { exitCode: 2, hint: "Use auto, url, file, directory, or text." },
    );
  }
  const source = opts._[0].trim();
  if (!source) {
    throw new CliError("bad_source", "ingest source must not be empty", {
      exitCode: 2,
    });
  }
  if (sourceType === "url") {
    try {
      validateHttpUrl(source);
    } catch (error) {
      throw new CliError(
        "bad_source",
        error instanceof Error ? error.message : String(error),
        { exitCode: 2 },
      );
    }
  }
  return {
    source,
    sourceType: sourceType as IngestSourceType,
    title: optString(opts, "title"),
    tags: [...optStrings(opts, "tag"), ...optStrings(opts, "tags")].flatMap(
      (tag) => normalizeTags(tag),
    ),
    notes: optString(opts, "notes"),
    recursive: optBoolean(opts, "recursive"),
    maxFiles: assertPositiveInteger(
      optNumber(opts, "max-files") ?? 300,
      "max-files",
    ),
    maxBytes: assertPositiveInteger(
      optNumber(opts, "max-bytes") ?? 5000000,
      "max-bytes",
    ),
    force: optBoolean(opts, "force"),
    skipSecrets: optBoolean(opts, "skip-secrets"),
  };
}

async function executeIngest(
  store: ResearchStore,
  request: IngestRequest,
  globals: GlobalOptions,
): Promise<void> {
  const result = await ingestSource(store, request);
  writeByFormat("ingest", result, globals, humanMutation, { readOnly: false });
}

async function runIngestLink(
  dbPath: string,
  argv: string[],
  globals: GlobalOptions,
): Promise<void> {
  const opts = parseOptions(argv, {});
  if (opts._.length > 0) {
    throw new CliError(
      "unexpected_args",
      "ingest-link reads its payload from stdin",
      {
        exitCode: 2,
      },
    );
  }
  let payload: CompletedLinkPayload;
  try {
    payload = await readCompletedLinkPayload();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError("invalid_payload", message);
  }
  const store = new ResearchStore(dbPath);
  try {
    const result = await ingestPrescrapedLink(store, payload);
    writeByFormat("ingest-link", result, globals, humanMutation, {
      readOnly: false,
    });
    if (!result.success) process.exitCode = result.root_success ? 2 : 1;
  } finally {
    store.close();
  }
}

function parseDeleteRequest(argv: string[]): DeleteRequest {
  const opts = parseOptions(argv, DELETE_OPTION_SPECS);
  if (opts._.length > 0) {
    throw new CliError(
      "unexpected_args",
      `delete does not accept positional args: ${opts._.join(" ")}`,
      { exitCode: 2 },
    );
  }
  const selectors =
    Number(opts["document-id"] !== undefined) +
    Number(opts["source-uri"] !== undefined);
  if (selectors !== 1) {
    throw new CliError(
      "bad_selector",
      "delete requires exactly one of --document-id or --source-uri",
      { exitCode: 2 },
    );
  }
  if (optString(opts, "confirm") !== "delete") {
    throw new CliError(
      "confirmation_required",
      "delete requires the explicit token --confirm delete",
      { exitCode: 2 },
    );
  }
  const documentId = optNumber(opts, "document-id");
  return {
    documentId:
      documentId === undefined
        ? undefined
        : assertInteger(documentId, "document-id"),
    sourceUri: optString(opts, "source-uri"),
    confirm: "delete",
  };
}

function executeDelete(
  store: ResearchStore,
  request: DeleteRequest,
  globals: GlobalOptions,
): void {
  const result = store.deleteDocument(request);
  writeByFormat("delete", result, globals, humanMutation, { readOnly: false });
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

function assertPositiveInteger(value: number, name: string): number {
  const integer = assertInteger(value, name);
  if (integer < 1) {
    throw new CliError("bad_integer", `--${name} must be positive`, {
      exitCode: 2,
    });
  }
  return integer;
}

function requestsJson(argv: string[]): boolean {
  return argv.some(
    (arg, index) =>
      arg === "--json" ||
      arg === "--format=json" ||
      (arg === "--format" && argv[index + 1] === "json"),
  );
}

async function main(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseTopLevel> | undefined;
  try {
    parsed = parseTopLevel(argv);
    await runParsed(parsed);
  } catch (err: unknown) {
    const command = parsed?.command ?? "(none)";
    const json = parsed?.globals.format === "json" || requestsJson(argv);
    if (err instanceof CliError) {
      if (json) {
        writeJson(errorEnvelope(command, err.code, err.message, err.hint));
      } else {
        process.stderr.write(`agentbrain: ${err.message}\n`);
        if (err.hint !== undefined) process.stderr.write(`hint: ${err.hint}\n`);
      }
      process.exit(err.exitCode);
    }
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      writeJson(errorEnvelope(command, "unexpected_error", message));
    } else {
      process.stderr.write(`agentbrain: unexpected error: ${message}\n`);
    }
    process.exit(1);
  }
}

if (import.meta.main) void main(Bun.argv.slice(2));
