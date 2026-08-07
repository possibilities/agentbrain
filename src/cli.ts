#!/usr/bin/env bun
import { existsSync } from "node:fs";
import {
  type AdmissionResult,
  type AlreadyIndexedResult,
  admitRecoveryGeneration,
  admitSubmission,
  DEFAULT_WAIT_TIMEOUT_MS,
  indexedDocumentForUrl,
  SUBMISSION_VERSION,
  waitForAdmission,
} from "./admission";
import {
  optBoolean,
  optNumber,
  optString,
  optStrings,
  parseOptions,
  parseTopLevel,
} from "./args";
import { ArtifactStore, defaultArtifactRoot } from "./artifacts";
import { createBackup, verifyBackup } from "./backup";
import { ResearchCache } from "./db";
import { CliError } from "./errors";
import { errorEnvelope, formatList, writeByFormat, writeJson } from "./format";
import { buildGuide, HARNESS_DOCS_PROMPT } from "./guide";
import { COMMANDS, helpFor, TOP_HELP, VERSION } from "./help";
import type { IngestSourceType } from "./ingest";
import type { DoctorReport } from "./jobs";
import {
  doctor,
  jobStats,
  listJobs,
  parseJobState,
  revealJob,
  safeJobView,
  showJob,
  showRun,
} from "./jobs";
import { notifyStranded, type StrandedNotifyResult } from "./notify";
import { assertDefaultDatabaseLocationReady } from "./paths";
import { parseTags } from "./query";
import { readRecoveryGeneration } from "./recovery";
import {
  executeRecoveryOnlineBackfill,
  prepareRecoveryOnlineBackfill,
} from "./recovery-online";
import {
  humanChunk,
  humanContext,
  humanDocument,
  humanMutation,
  humanSearch,
  humanStats,
  humanTags,
  searchJsonl,
} from "./render";
import {
  RECOVERY_OFFLINE_SCOPE_KIND,
  RECOVERY_ONLINE_SCOPE_KIND,
  ResearchStore,
} from "./store";
import { deriveStructuralTags } from "./tagging";
import { normalizeTags } from "./text";
import type {
  ContentKind,
  GlobalOptions,
  OperatorRunScope,
  SearchMode,
  Sensitivity,
} from "./types";
import { validateHttpUrl } from "./url";
import { runWorker } from "./worker";

const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name));
const READ_COMMANDS = new Set([
  "stats",
  "search",
  "get",
  "tags",
  "context",
  "doctor",
]);
const DATABASE_FREE_COMMANDS = new Set(["guide", "prompt", "help"]);
const MUTATION_COMMANDS = new Set([
  "submit",
  "ingest",
  "delete",
  "retag",
  "worker",
]);

function requiresDefaultDatabase(command: string, argv: string[]): boolean {
  if (DATABASE_FREE_COMMANDS.has(command)) return false;
  return !(command === "backup" && argv[0] === "verify");
}

interface IngestRequest {
  version: number;
  source: string;
  sourceType: IngestSourceType;
  ingress: string;
  collections: string[];
  idempotencyKey?: string;
  title?: string;
  tags: string[];
  notes?: string;
  recursive: boolean;
  maxFiles: number;
  maxBytes: number;
  force: boolean;
  skipSecrets: boolean;
  wait: boolean;
  waitTimeoutMs: number;
}

interface DeleteRequest {
  documentId?: number;
  sourceUri?: string;
  confirm: "delete";
}

interface RetagRequest {
  dryRun: boolean;
}

interface RetagChange {
  document_id: number;
  before: string[];
  after: string[];
}

interface RetagResult {
  success: true;
  dry_run: boolean;
  documents_scanned: number;
  documents_changed: number;
  documents_unchanged: number;
  changes: RetagChange[];
}

const INGEST_OPTION_SPECS = {
  "intent-version": { type: "number", default: SUBMISSION_VERSION },
  kind: { type: "string" },
  "source-type": { type: "string", default: "auto" },
  ingress: { type: "string", default: "cli" },
  collection: { type: "string", multiple: true },
  "idempotency-key": { type: "string" },
  title: { type: "string" },
  tag: { type: "string", multiple: true },
  tags: { type: "string", multiple: true },
  notes: { type: "string" },
  recursive: { type: "boolean", default: true },
  "max-files": { type: "number", default: 300 },
  "max-bytes": { type: "number", default: 5000000 },
  force: { type: "boolean", default: false },
  "skip-secrets": { type: "boolean", default: true },
  wait: { type: "boolean", default: false },
  "wait-timeout-ms": { type: "number", default: DEFAULT_WAIT_TIMEOUT_MS },
} as const;

const DELETE_OPTION_SPECS = {
  "document-id": { type: "number" },
  "source-uri": { type: "string" },
  confirm: { type: "string" },
} as const;

const RETAG_OPTION_SPECS = {
  "dry-run": { type: "boolean", default: false },
} as const;

const WORKER_SCOPE_KINDS = new Set([
  "text",
  "file",
  "directory",
  "url",
  RECOVERY_OFFLINE_SCOPE_KIND,
  RECOVERY_ONLINE_SCOPE_KIND,
]);

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

  if (
    parsed.usesDefaultDb &&
    requiresDefaultDatabase(command, parsed.commandArgv)
  )
    assertDefaultDatabaseLocationReady();

  if (command === "jobs") {
    await runJobs(parsed.globals.dbPath, parsed.commandArgv, parsed.globals);
    return;
  }

  if (command === "backup") {
    runBackup(parsed.globals.dbPath, parsed.commandArgv, parsed.globals);
    return;
  }

  if (command === "recovery") {
    await runRecovery(
      parsed.globals.dbPath,
      parsed.commandArgv,
      parsed.globals,
    );
    return;
  }

  if (command === "sources") {
    const { runSourceCommands } = await import("./sources-cli");
    await runSourceCommands(
      parsed.globals.dbPath,
      parsed.commandArgv,
      parsed.globals,
    );
    return;
  }

  if (command === "share") {
    const { runShareCommands } = await import("./share-cli");
    await runShareCommands(
      parsed.globals.dbPath,
      parsed.commandArgv,
      parsed.globals,
    );
    return;
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
        case "context":
          runContext(cache, parsed.commandArgv, parsed.globals);
          break;
        case "doctor":
          runDoctor(cache, parsed.commandArgv, parsed.globals);
          break;
      }
    } finally {
      cache.close();
    }
    return;
  }

  if (command === "worker") {
    await runWorkerCommand(
      parsed.globals.dbPath,
      parsed.commandArgv,
      parsed.globals,
    );
    return;
  }

  if (MUTATION_COMMANDS.has(command)) {
    if (command === "submit" || command === "ingest") {
      const request = parseIngestRequest(parsed.commandArgv, command);
      const store = new ResearchStore(parsed.globals.dbPath);
      try {
        await executeAdmission(store, request, parsed.globals, command);
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

    if (command === "retag") {
      const request = parseRetagRequest(parsed.commandArgv);
      if (!existsSync(parsed.globals.dbPath)) {
        throw new CliError(
          "db_not_found",
          `research cache DB not found: ${parsed.globals.dbPath}`,
          { hint: "Pass --db PATH or set AGENTBRAIN_DB." },
        );
      }
      const store = new ResearchStore(parsed.globals.dbPath);
      try {
        executeRetag(store, request, parsed.globals);
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
    "content-kind": { type: "string" },
    collection: { type: "string" },
    source: { type: "string" },
    "resource-kind": { type: "string" },
    sensitivity: { type: "string" },
    date: { type: "string" },
    "date-from": { type: "string" },
    "date-to": { type: "string" },
    "local-path": { type: "string" },
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
    contentKind: optString(opts, "content-kind") as ContentKind | undefined,
    collection: optString(opts, "collection"),
    source: optString(opts, "source"),
    resourceKind: optString(opts, "resource-kind"),
    sensitivity: optString(opts, "sensitivity") as Sensitivity | undefined,
    date: optString(opts, "date"),
    dateFrom: optString(opts, "date-from"),
    dateTo: optString(opts, "date-to"),
    localPath: optString(opts, "local-path"),
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

function runContext(
  cache: ResearchCache,
  argv: string[],
  globals: GlobalOptions,
): void {
  const opts = parseOptions(argv, {
    query: { type: "string" },
    limit: { type: "number", default: 6 },
    "max-chars": { type: "number", default: 12000 },
    tag: { type: "string" },
    "source-type": { type: "string" },
    "content-kind": { type: "string" },
    collection: { type: "string" },
    source: { type: "string" },
    "resource-kind": { type: "string" },
    sensitivity: { type: "string" },
    date: { type: "string" },
    "date-from": { type: "string" },
    "date-to": { type: "string" },
    "local-path": { type: "string" },
  });
  const query = optString(opts, "query") ?? opts._.join(" ");
  const data = cache.context({
    query,
    limit: optNumber(opts, "limit"),
    maxChars: optNumber(opts, "max-chars"),
    tag: optString(opts, "tag"),
    sourceType: optString(opts, "source-type"),
    contentKind: optString(opts, "content-kind") as ContentKind | undefined,
    collection: optString(opts, "collection"),
    source: optString(opts, "source"),
    resourceKind: optString(opts, "resource-kind"),
    sensitivity: optString(opts, "sensitivity") as Sensitivity | undefined,
    date: optString(opts, "date"),
    dateFrom: optString(opts, "date-from"),
    dateTo: optString(opts, "date-to"),
    localPath: optString(opts, "local-path"),
  });
  writeByFormat("context", data, globals, humanContext);
}

async function runJobs(
  dbPath: string,
  argv: string[],
  globals: GlobalOptions,
): Promise<void> {
  const subcommand = argv[0];
  if (
    !subcommand ||
    !["list", "show", "run", "retry", "cancel", "exclude", "stats"].includes(
      subcommand,
    )
  ) {
    throw new CliError(
      "bad_jobs_command",
      "jobs requires one of: list, show, run, retry, cancel, exclude, stats",
      { exitCode: 2 },
    );
  }
  const args = argv.slice(1);
  if (subcommand === "list") {
    const opts = parseOptions(args, {
      state: { type: "string" },
      run: { type: "number" },
      limit: { type: "number", default: 100 },
    });
    if (opts._.length > 0)
      throw new CliError(
        "unexpected_args",
        "jobs list accepts no positional arguments",
        { exitCode: 2 },
      );
    const cache = new ResearchCache(dbPath);
    try {
      const runId = optNumber(opts, "run");
      const data = listJobs(cache, {
        state: parseJobState(optString(opts, "state")),
        runId:
          runId === undefined ? undefined : assertPositiveInteger(runId, "run"),
        limit: optNumber(opts, "limit"),
      });
      writeByFormat("jobs list", data, globals, (rows) =>
        formatList(
          rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            state: row.state,
            attempts: row.attempt_count,
            run_at: row.run_at,
          })),
          ["id", "kind", "state", "attempts", "run_at"],
        ),
      );
    } finally {
      cache.close();
    }
    return;
  }
  if (subcommand === "stats") {
    const opts = parseOptions(args, { run: { type: "number" } });
    if (opts._.length > 0)
      throw new CliError(
        "unexpected_args",
        "jobs stats accepts no positional arguments",
        { exitCode: 2 },
      );
    const cache = new ResearchCache(dbPath);
    try {
      const runId = optNumber(opts, "run");
      const data = jobStats(cache, new Date(), {
        runId:
          runId === undefined ? undefined : assertPositiveInteger(runId, "run"),
      });
      writeByFormat(
        "jobs stats",
        data,
        globals,
        (value) => `${JSON.stringify(value, null, 2)}\n`,
      );
    } finally {
      cache.close();
    }
    return;
  }
  if (subcommand === "run") {
    const opts = parseOptions(args, {
      limit: { type: "number", default: 100 },
    });
    if (opts._.length !== 1) {
      throw new CliError("bad_run_id", "jobs run requires exactly one Run ID", {
        exitCode: 2,
      });
    }
    const runId = assertPositiveInteger(Number(opts._[0]), "run-id");
    const cache = new ResearchCache(dbPath);
    try {
      const data = showRun(cache, runId, {
        limit: optNumber(opts, "limit"),
      });
      writeByFormat(
        "jobs run",
        data,
        globals,
        (value) => `${JSON.stringify(value, null, 2)}\n`,
      );
    } finally {
      cache.close();
    }
    return;
  }

  const opts = parseOptions(args, {
    reason: { type: "string" },
    actor: { type: "string", default: "operator" },
    "reveal-content": { type: "boolean", default: false },
    "max-bytes": { type: "number", default: 5000000 },
  });
  if (opts._.length !== 1) {
    throw new CliError(
      "bad_job_id",
      `jobs ${subcommand} requires exactly one job id`,
      { exitCode: 2 },
    );
  }
  const jobId = assertPositiveInteger(Number(opts._[0]), "job-id");
  const actor = optString(opts, "actor") ?? "operator";
  const reason = optString(opts, "reason");
  if (subcommand === "show") {
    if (reason !== undefined)
      throw new CliError(
        "unexpected_option",
        "jobs show does not accept --reason",
        { exitCode: 2 },
      );
    if (optBoolean(opts, "reveal-content")) {
      const store = new ResearchStore(dbPath);
      try {
        const data = revealJob(store, jobId, {
          actor,
          maxBytes: assertPositiveInteger(
            optNumber(opts, "max-bytes") ?? 5000000,
            "max-bytes",
          ),
        });
        writeByFormat(
          "jobs show",
          data,
          globals,
          (value) => `${JSON.stringify(value, null, 2)}\n`,
          { readOnly: false },
        );
      } finally {
        store.close();
      }
    } else {
      const cache = new ResearchCache(dbPath);
      try {
        const data = showJob(cache, jobId);
        writeByFormat(
          "jobs show",
          data,
          globals,
          (value) => `${JSON.stringify(value, null, 2)}\n`,
        );
      } finally {
        cache.close();
      }
    }
    return;
  }
  if (optBoolean(opts, "reveal-content")) {
    throw new CliError(
      "unexpected_option",
      `jobs ${subcommand} does not accept --reveal-content`,
      { exitCode: 2 },
    );
  }
  const store = new ResearchStore(dbPath);
  try {
    let data: unknown;
    if (subcommand === "retry") {
      data = safeJobView(store.retryJob({ jobId, actor, reason }));
    } else if (subcommand === "cancel") {
      const cancelled = store.cancelJob({ jobId, actor, reason });
      data = cancelled.ok
        ? { ok: true, job: safeJobView(cancelled.job) }
        : {
            ok: false,
            reason: cancelled.reason,
            job: safeJobView(cancelled.job),
          };
    } else {
      if (!reason?.trim())
        throw new CliError("bad_exclude", "jobs exclude requires --reason", {
          exitCode: 2,
        });
      data = safeJobView(store.excludeJob({ jobId, actor, reason }));
    }
    writeByFormat(
      `jobs ${subcommand}`,
      data,
      globals,
      (value) => `${JSON.stringify(value, null, 2)}\n`,
      { readOnly: false },
    );
  } finally {
    store.close();
  }
}

function runBackup(
  dbPath: string,
  argv: string[],
  globals: GlobalOptions,
): void {
  const subcommand = argv[0];
  if (subcommand !== "create" && subcommand !== "verify") {
    throw new CliError(
      "bad_backup_command",
      "backup requires a create or verify subcommand",
      { exitCode: 2, hint: "Run `agentbrain help backup` for usage." },
    );
  }
  const opts = parseOptions(argv.slice(1), {
    output: { type: "string" },
    backup: { type: "string" },
    "artifact-root": { type: "string" },
  });
  const namedTarget =
    subcommand === "create"
      ? optString(opts, "output")
      : optString(opts, "backup");
  const wrongNamedTarget =
    subcommand === "create"
      ? optString(opts, "backup")
      : optString(opts, "output");
  if (
    wrongNamedTarget !== undefined ||
    (namedTarget === undefined && opts._.length !== 1) ||
    (namedTarget !== undefined && opts._.length !== 0)
  ) {
    throw new CliError(
      "bad_backup_path",
      `backup ${subcommand} requires exactly one backup path`,
      { exitCode: 2 },
    );
  }
  const target = namedTarget ?? opts._[0];
  const artifactRoot = optString(opts, "artifact-root");

  if (subcommand === "create") {
    if (!existsSync(dbPath)) {
      throw new CliError(
        "db_not_found",
        `research cache DB not found: ${dbPath}`,
        {
          hint: "Pass --db PATH or set AGENTBRAIN_DB.",
        },
      );
    }
    const store = new ResearchStore(dbPath);
    try {
      const data = createBackup(store, target, {
        artifactRoot: artifactRoot ?? defaultArtifactRoot(),
      });
      writeByFormat(
        "backup create",
        data,
        globals,
        (value) =>
          [
            `backup created: ${value.backup_path}`,
            `schema_version: ${value.schema_version}`,
            `required_artifacts: ${value.artifact_count}`,
            "",
          ].join("\n"),
        { readOnly: false },
      );
    } finally {
      store.close();
    }
    return;
  }

  const data = verifyBackup(target, { artifactRoot });
  writeByFormat("backup verify", data, globals, (value) => {
    const lines = value.checks.map(
      (check) => `${check.status.padEnd(6)} ${check.name}: ${check.detail}`,
    );
    return `${value.verified ? "verified" : "verification failed"}\n${lines.join("\n")}\n`;
  });
  if (!data.verified) process.exitCode = 1;
}

async function runRecoveryOnline(
  dbPath: string,
  argv: string[],
  globals: GlobalOptions,
): Promise<void> {
  const opts = parseOptions(argv, {
    "manifest-generation": { type: "string" },
    "artifact-root": { type: "string", multiple: true },
    "artifact-store": { type: "string" },
    "offline-run": { type: "number" },
    "post-offline-snapshot": { type: "string" },
    "generation-digest": { type: "string" },
    "approval-digest": { type: "string" },
    "snapshot-digest": { type: "string" },
    execute: { type: "boolean", default: false },
    "worker-id": { type: "string" },
    "lease-ms": { type: "number", default: 60000 },
    "heartbeat-ms": { type: "number", default: 20000 },
    "shutdown-grace-ms": { type: "number", default: 10000 },
  });
  if (opts._.length !== 0) {
    throw new CliError(
      "unexpected_args",
      "recovery online accepts no positional arguments",
      { exitCode: 2 },
    );
  }
  const manifestGeneration = optString(opts, "manifest-generation");
  const offlineRun = optNumber(opts, "offline-run");
  const postOfflineSnapshot = optString(opts, "post-offline-snapshot");
  const generationDigest = optString(opts, "generation-digest");
  const approvalDigest = optString(opts, "approval-digest");
  const snapshotDigest = optString(opts, "snapshot-digest");
  if (
    manifestGeneration === undefined ||
    offlineRun === undefined ||
    postOfflineSnapshot === undefined ||
    generationDigest === undefined ||
    approvalDigest === undefined ||
    snapshotDigest === undefined
  ) {
    throw new CliError(
      "incomplete_recovery_online_authorization",
      "recovery online requires the generation, linked offline Run, verified snapshot, and all three explicit digests",
      { exitCode: 2, hint: "Run `agentbrain help recovery` for usage." },
    );
  }
  const generation = readRecoveryGeneration(manifestGeneration, {
    artifactRoots: optStrings(opts, "artifact-root"),
  });
  const store = new ResearchStore(dbPath);
  try {
    const artifactStore = new ArtifactStore(
      optString(opts, "artifact-store") ?? defaultArtifactRoot(),
    );
    const common = {
      offlineRunId: assertPositiveInteger(offlineRun, "offline-run"),
      postOfflineSnapshot,
      expectedGenerationDigest: generationDigest,
      expectedApprovalDigest: approvalDigest,
      expectedSnapshotDigest: snapshotDigest,
      artifactStore,
    };
    const data = optBoolean(opts, "execute")
      ? await executeRecoveryOnlineBackfill(store, generation, {
          ...common,
          worker: {
            workerId: optString(opts, "worker-id"),
            leaseMs: assertPositiveInteger(
              optNumber(opts, "lease-ms") ?? 60000,
              "lease-ms",
            ),
            heartbeatMs: assertPositiveInteger(
              optNumber(opts, "heartbeat-ms") ?? 20000,
              "heartbeat-ms",
            ),
            shutdownGraceMs: assertNonNegativeInteger(
              optNumber(opts, "shutdown-grace-ms") ?? 10000,
              "shutdown-grace-ms",
            ),
          },
          installSignalHandlers: true,
        }).then((result) => {
          const { worker_id: _workerId, ...safeWorker } = result.worker;
          return { ...result.recovery, worker: safeWorker };
        })
      : prepareRecoveryOnlineBackfill(store, generation, common);
    writeByFormat(
      "recovery online",
      data,
      globals,
      (value) =>
        [
          `controlled online backfill: ${value.status}`,
          `online_run_id: ${value.online_run.id}`,
          `linked_offline_run_id: ${value.offline_run.id}`,
          `approved_jobs: ${value.online_run.counts.jobs}`,
          `attempts: ${value.online_run.counts.attempts}`,
          "",
        ].join("\n"),
      { readOnly: false },
    );
  } finally {
    store.close();
  }
}

async function runRecovery(
  dbPath: string,
  argv: string[],
  globals: GlobalOptions,
): Promise<void> {
  const subcommand = argv[0];
  if (subcommand === "online") {
    await runRecoveryOnline(dbPath, argv.slice(1), globals);
    return;
  }
  if (subcommand !== "import") {
    throw new CliError(
      "bad_recovery_command",
      "recovery requires the import or online subcommand",
      { exitCode: 2, hint: "Run `agentbrain help recovery` for usage." },
    );
  }
  const opts = parseOptions(argv.slice(1), {
    "manifest-generation": { type: "string" },
    "artifact-root": { type: "string", multiple: true },
    "artifact-store": { type: "string" },
    "authorize-offline": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  });
  const named = optString(opts, "manifest-generation");
  if (
    (named === undefined && opts._.length !== 1) ||
    (named !== undefined && opts._.length !== 0)
  ) {
    throw new CliError(
      "bad_recovery_manifest",
      "recovery import requires exactly one frozen generation descriptor",
      { exitCode: 2 },
    );
  }
  const dryRun = optBoolean(opts, "dry-run");
  const authorizeOffline = optBoolean(opts, "authorize-offline");
  if (dryRun && authorizeOffline) {
    throw new CliError(
      "bad_recovery_authorization",
      "--authorize-offline cannot be combined with --dry-run",
      { exitCode: 2 },
    );
  }
  const generation = readRecoveryGeneration(named ?? opts._[0], {
    artifactRoots: optStrings(opts, "artifact-root"),
  });
  if (dryRun) {
    const data = admitRecoveryGeneration(null, generation, { dryRun: true });
    writeByFormat("recovery import", data, globals, (value) =>
      [
        "frozen recovery generation verified",
        `candidate_rows: ${value.counts.candidate_rows}`,
        `telegram_observations: ${value.counts.telegram_observations}`,
        `approved_offline_artifacts: ${value.counts.approved_offline_artifacts}`,
        "state_written: false",
        "",
      ].join("\n"),
    );
    return;
  }
  const store = new ResearchStore(dbPath);
  try {
    const artifactStore = new ArtifactStore(
      optString(opts, "artifact-store") ?? defaultArtifactRoot(),
    );
    const data = admitRecoveryGeneration(store, generation, {
      artifactStore,
      authorizeOffline,
    });
    writeByFormat(
      "recovery import",
      data,
      globals,
      (value) =>
        [
          `queued frozen recovery run ${value.run.id}`,
          `candidate_rows: ${value.counts.candidate_rows}`,
          `jobs_created: ${value.jobs.created}`,
          `jobs_existing: ${value.jobs.existing}`,
          "",
        ].join("\n"),
      { readOnly: false },
    );
  } finally {
    store.close();
  }
}

/**
 * Attach the outcome of the operator notification to the report.
 *
 * The notice is reported rather than silent so a scheduled run leaves evidence
 * of whether the operator was actually reachable.
 */
function withStrandedNotice(data: DoctorReport): DoctorReport & {
  notification: StrandedNotifyResult;
} {
  const check = data.checks.find(
    (entry) => entry.name === "stranded_ingestion",
  );
  const match = check?.detail.match(/^(\d+) stranded/);
  const stranded = match === null || match === undefined ? 0 : Number(match[1]);
  return { ...data, notification: notifyStranded(stranded) };
}

function runDoctor(
  cache: ResearchCache,
  argv: string[],
  globals: GlobalOptions,
): void {
  const opts = parseOptions(argv, {
    notify: { type: "boolean", default: false },
  });
  if (opts._.length > 0)
    throw new CliError(
      "unexpected_args",
      "doctor accepts no positional arguments",
      { exitCode: 2 },
    );
  const data = doctor(cache);
  const report = opts.notify === true ? withStrandedNotice(data) : data;
  writeByFormat(
    "doctor",
    report,
    globals,
    (value) => `${JSON.stringify(value, null, 2)}\n`,
  );
  if (!data.healthy) process.exitCode = 1;
}

async function runWorkerCommand(
  dbPath: string,
  argv: string[],
  globals: GlobalOptions,
): Promise<void> {
  const opts = parseOptions(argv, {
    once: { type: "boolean", default: false },
    "worker-id": { type: "string" },
    "poll-ms": { type: "number", default: 1000 },
    "lease-ms": { type: "number", default: 60000 },
    "heartbeat-ms": { type: "number", default: 20000 },
    "shutdown-grace-ms": { type: "number", default: 10000 },
    run: { type: "number" },
    "authorization-digest": { type: "string" },
    "allowed-kind": { type: "string", multiple: true },
  });
  if (opts._.length > 0)
    throw new CliError(
      "unexpected_args",
      "worker accepts no positional arguments",
      { exitCode: 2 },
    );
  const runId = optNumber(opts, "run");
  const authorizationDigest = optString(opts, "authorization-digest");
  const allowedKinds = optStrings(opts, "allowed-kind");
  const hasScopeOptions =
    runId !== undefined ||
    authorizationDigest !== undefined ||
    allowedKinds.length !== 0;
  let scope: OperatorRunScope | undefined;
  if (hasScopeOptions) {
    if (
      runId === undefined ||
      authorizationDigest === undefined ||
      allowedKinds.length === 0
    ) {
      throw new CliError(
        "incomplete_run_scope",
        "scoped worker requires --run, --authorization-digest, and at least one --allowed-kind",
        { exitCode: 2 },
      );
    }
    if (!optBoolean(opts, "once")) {
      throw new CliError(
        "scoped_worker_requires_once",
        "scoped worker requires --once",
        { exitCode: 2 },
      );
    }
    const controlledRunId = assertPositiveInteger(runId, "run");
    if (!/^[a-f0-9]{64}$/.test(authorizationDigest)) {
      throw new CliError(
        "bad_run_scope",
        "--authorization-digest must be a lowercase SHA-256 digest",
        { exitCode: 2 },
      );
    }
    if (
      new Set(allowedKinds).size !== allowedKinds.length ||
      allowedKinds.some(
        (kind) =>
          kind !== kind.trim().toLowerCase() || !WORKER_SCOPE_KINDS.has(kind),
      )
    ) {
      throw new CliError(
        "bad_run_scope",
        "--allowed-kind must be a unique canonical ingestion job kind",
        { exitCode: 2 },
      );
    }
    scope = {
      runId: controlledRunId,
      authorizationDigest,
      allowedKinds,
    };
  }
  const store = new ResearchStore(dbPath);
  try {
    const data = await runWorker(store, {
      once: optBoolean(opts, "once"),
      workerId: optString(opts, "worker-id"),
      pollMs: assertPositiveInteger(
        optNumber(opts, "poll-ms") ?? 1000,
        "poll-ms",
      ),
      leaseMs: assertPositiveInteger(
        optNumber(opts, "lease-ms") ?? 60000,
        "lease-ms",
      ),
      heartbeatMs: assertPositiveInteger(
        optNumber(opts, "heartbeat-ms") ?? 20000,
        "heartbeat-ms",
      ),
      shutdownGraceMs: assertNonNegativeInteger(
        optNumber(opts, "shutdown-grace-ms") ?? 10000,
        "shutdown-grace-ms",
      ),
      scope,
    });
    writeByFormat(
      "worker",
      data,
      globals,
      (value) => `${JSON.stringify(value, null, 2)}\n`,
      { readOnly: false },
    );
  } finally {
    store.close();
  }
}

function parseIngestRequest(
  argv: string[],
  command: "submit" | "ingest",
): IngestRequest {
  const opts = parseOptions(argv, INGEST_OPTION_SPECS);
  if (opts._.length !== 1) {
    throw new CliError(
      "bad_source",
      `${command} requires exactly one <source> positional argument`,
      { exitCode: 2 },
    );
  }
  const compatibilityType = optString(opts, "source-type") ?? "auto";
  const explicitKind = optString(opts, "kind");
  if (
    explicitKind !== undefined &&
    compatibilityType !== "auto" &&
    explicitKind !== compatibilityType
  ) {
    throw new CliError(
      "bad_source_type",
      "--kind and --source-type must agree when both are provided",
      { exitCode: 2 },
    );
  }
  const sourceType = explicitKind ?? compatibilityType;
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
    version: assertPositiveInteger(
      optNumber(opts, "intent-version") ?? SUBMISSION_VERSION,
      "intent-version",
    ),
    source,
    sourceType: sourceType as IngestSourceType,
    ingress: optString(opts, "ingress") ?? "cli",
    collections: optStrings(opts, "collection"),
    idempotencyKey: optString(opts, "idempotency-key"),
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
    wait: optBoolean(opts, "wait"),
    waitTimeoutMs: assertNonNegativeInteger(
      optNumber(opts, "wait-timeout-ms") ?? DEFAULT_WAIT_TIMEOUT_MS,
      "wait-timeout-ms",
    ),
  };
}

function humanAdmission(result: AdmissionResult): string {
  return [
    `${result.status}: ingestion job ${result.job_id}`,
    `idempotency_key: ${result.idempotency_key}`,
    `state: ${result.state}`,
    ...(result.wait_status === undefined
      ? []
      : [`wait_status: ${result.wait_status}`]),
    "",
  ].join("\n");
}

function humanAlreadyIndexed(result: AlreadyIndexedResult): string {
  return [
    `${result.status}: document ${result.document_id}`,
    `resource_key: ${result.resource_key}`,
    "Pass --force to queue rematerialization anyway.",
    "",
  ].join("\n");
}

async function executeAdmission(
  store: ResearchStore,
  request: IngestRequest,
  globals: GlobalOptions,
  command: "submit" | "ingest",
): Promise<void> {
  if (
    request.force !== true &&
    (request.sourceType === "auto" || request.sourceType === "url")
  ) {
    // Read-only index consultation before durable admission: a URL whose
    // conservative resource identity already carries a materialized document
    // is reported instead of re-queued. --force restores rematerialization.
    const indexed = indexedDocumentForUrl(store, request.source);
    if (indexed !== null) {
      writeByFormat(command, indexed, globals, humanAlreadyIndexed, {
        readOnly: true,
      });
      return;
    }
  }
  let result = admitSubmission(store, {
    version: request.version as typeof SUBMISSION_VERSION,
    source: request.source,
    kind: request.sourceType,
    ingress: request.ingress,
    collections: request.collections,
    idempotencyKey: request.idempotencyKey,
    title: request.title,
    tags: request.tags,
    notes: request.notes,
    recursive: request.recursive,
    maxFiles: request.maxFiles,
    maxBytes: request.maxBytes,
    force: request.force,
    skipSecrets: request.skipSecrets,
  });
  if (request.wait) {
    result = await waitForAdmission(store, result, request.waitTimeoutMs);
  }
  writeByFormat(command, result, globals, humanAdmission, { readOnly: false });
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

function parseRetagRequest(argv: string[]): RetagRequest {
  const opts = parseOptions(argv, RETAG_OPTION_SPECS);
  if (opts._.length > 0) {
    throw new CliError(
      "unexpected_args",
      `retag does not accept positional args: ${opts._.join(" ")}`,
      { exitCode: 2 },
    );
  }
  return { dryRun: optBoolean(opts, "dry-run") };
}

/**
 * Collection slugs for one document via the resources join, mirroring
 * ResearchStore's private lookup. Duplicated here (rather than reusing a
 * store-internal helper) so --dry-run can preview derived tags through
 * read-only queries without going through the mutating retagDocument path.
 */
function retagCollectionSlugs(
  store: ResearchStore,
  documentId: number,
): string[] {
  const hasResources =
    store.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='resources' LIMIT 1",
      )
      .get() !== null;
  if (!hasResources) return [];
  return (
    store.db
      .query(
        `SELECT col.slug AS slug
         FROM resources r
         JOIN collection_memberships cm ON cm.resource_id = r.id
         JOIN collections col ON col.id = cm.collection_id
         WHERE r.document_id = ?
         ORDER BY col.slug ASC`,
      )
      .all(documentId) as { slug: string }[]
  ).map((row) => row.slug);
}

function executeRetag(
  store: ResearchStore,
  request: RetagRequest,
  globals: GlobalOptions,
): void {
  const documentIds = (
    store.db.query("SELECT id FROM documents ORDER BY id ASC").all() as {
      id: number;
    }[]
  ).map((row) => row.id);

  let changed = 0;
  let unchanged = 0;
  const changes: RetagChange[] = [];

  for (const documentId of documentIds) {
    const doc = store.db
      .query("SELECT tags, source_type, source_uri FROM documents WHERE id=?")
      .get(documentId) as {
      tags: string;
      source_type: string;
      source_uri: string;
    } | null;
    if (doc === null) continue;
    const before = parseTags(doc.tags);

    if (request.dryRun) {
      const after = deriveStructuralTags({
        existingTags: before,
        sourceType: doc.source_type,
        sourceUri: doc.source_uri,
        collectionSlugs: retagCollectionSlugs(store, documentId),
      });
      if (JSON.stringify(after) === JSON.stringify(before)) {
        unchanged += 1;
      } else {
        changed += 1;
        changes.push({ document_id: documentId, before, after });
      }
      continue;
    }

    const result = store.retagDocument(documentId);
    if (result.status === "updated") {
      changed += 1;
      changes.push({ document_id: documentId, before, after: result.tags });
    } else {
      unchanged += 1;
    }
  }

  const data: RetagResult = {
    success: true,
    dry_run: request.dryRun,
    documents_scanned: documentIds.length,
    documents_changed: changed,
    documents_unchanged: unchanged,
    changes,
  };
  writeByFormat("retag", data, globals, humanMutation, {
    readOnly: request.dryRun,
  });
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

function assertNonNegativeInteger(value: number, name: string): number {
  const integer = assertInteger(value, name);
  if (integer < 0) {
    throw new CliError("bad_integer", `--${name} must not be negative`, {
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
