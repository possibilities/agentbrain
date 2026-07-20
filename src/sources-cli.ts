import { optBoolean, optNumber, optString, parseOptions } from "./args";
import { ResearchCache } from "./db";
import { CliError } from "./errors";
import { formatList, writeByFormat } from "./format";
import {
  listSources,
  SourceRegistry,
  showSource,
  sourceStatuses,
} from "./sources";
import { ResearchStore } from "./store";
import type { GlobalOptions } from "./types";

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError("bad_integer", `--${name} must be positive`, {
      exitCode: 2,
    });
  }
  return value;
}

export function runSourceCommands(
  dbPath: string,
  argv: string[],
  globals: GlobalOptions,
): void {
  const subcommand = argv[0]?.startsWith("--") ? "list" : (argv[0] ?? "list");
  const args =
    argv[0]?.startsWith("--") || argv.length === 0 ? argv : argv.slice(1);
  if (subcommand === "list") {
    const opts = parseOptions(args, {
      limit: { type: "number", default: 500 },
    });
    if (opts._.length !== 0) {
      throw new CliError(
        "unexpected_args",
        "sources list accepts no positional arguments",
        { exitCode: 2 },
      );
    }
    const limit = positiveInteger(optNumber(opts, "limit") ?? 500, "limit");
    if (limit > 1_000) {
      throw new CliError("bad_integer", "--limit must not exceed 1000", {
        exitCode: 2,
      });
    }
    const cache = new ResearchCache(dbPath);
    try {
      const data = listSources(cache.db).slice(0, limit);
      writeByFormat("sources list", data, globals, (value) =>
        formatList(
          value.map((source) => ({
            id: source.id,
            kind: source.kind,
            enabled: source.enabled,
            paused: source.paused,
            health: source.executable ? "supported" : "unsupported",
          })),
          ["id", "kind", "enabled", "paused", "health"],
        ),
      );
    } finally {
      cache.close();
    }
    return;
  }
  if (subcommand === "show") {
    const opts = parseOptions(args, {});
    if (opts._.length !== 1) {
      throw new CliError(
        "bad_source_id",
        "sources show requires exactly one stable source ID",
        { exitCode: 2 },
      );
    }
    const cache = new ResearchCache(dbPath);
    try {
      const data = showSource(cache.db, opts._[0]);
      writeByFormat(
        "sources show",
        data,
        globals,
        (value) => `${JSON.stringify(value, null, 2)}\n`,
      );
    } finally {
      cache.close();
    }
    return;
  }
  if (subcommand === "status") {
    const opts = parseOptions(args, {});
    if (opts._.length > 1) {
      throw new CliError(
        "bad_source_id",
        "sources status accepts at most one stable source ID",
        { exitCode: 2 },
      );
    }
    const cache = new ResearchCache(dbPath);
    try {
      const data = sourceStatuses(cache.db, { sourceId: opts._[0] });
      writeByFormat(
        "sources status",
        data,
        globals,
        (value) => `${JSON.stringify(value, null, 2)}\n`,
      );
    } finally {
      cache.close();
    }
    return;
  }
  if (subcommand === "sync") {
    const opts = parseOptions(args, {
      due: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      limit: { type: "number", default: 1000 },
    });
    const due = optBoolean(opts, "due");
    if ((due && opts._.length !== 0) || (!due && opts._.length !== 1)) {
      throw new CliError(
        "bad_source_sync",
        "sources sync requires one stable source ID or --due",
        { exitCode: 2 },
      );
    }
    const dryRun = optBoolean(opts, "dry-run");
    const store = new ResearchStore(dbPath);
    try {
      const registry = new SourceRegistry(store);
      const data = due
        ? registry.syncDueSources({
            dryRun,
            limit: positiveInteger(optNumber(opts, "limit") ?? 1_000, "limit"),
          })
        : [registry.syncSource({ sourceId: opts._[0], dryRun })];
      writeByFormat(
        "sources sync",
        data,
        globals,
        (value) => `${JSON.stringify(value, null, 2)}\n`,
        { readOnly: dryRun },
      );
    } finally {
      store.close();
    }
    return;
  }
  if (subcommand === "pause" || subcommand === "resume") {
    const opts = parseOptions(args, {
      actor: { type: "string", default: "operator" },
      reason: { type: "string" },
    });
    if (opts._.length !== 1) {
      throw new CliError(
        "bad_source_id",
        `sources ${subcommand} requires exactly one stable source ID`,
        { exitCode: 2 },
      );
    }
    const store = new ResearchStore(dbPath);
    try {
      const input = {
        sourceId: opts._[0],
        actor: optString(opts, "actor"),
        reason: optString(opts, "reason"),
      };
      const registry = new SourceRegistry(store);
      const source =
        subcommand === "pause"
          ? registry.pauseSource(input)
          : registry.resumeSource(input);
      const data = {
        id: source.identifier,
        paused: Boolean(source.paused),
        enabled: Boolean(source.enabled),
        audit_action: subcommand === "pause" ? "paused" : "resumed",
      };
      writeByFormat(
        `sources ${subcommand}`,
        data,
        globals,
        (value) => `${JSON.stringify(value, null, 2)}\n`,
        { readOnly: false },
      );
    } finally {
      store.close();
    }
    return;
  }
  throw new CliError(
    "bad_sources_command",
    "sources requires one of: list, show, status, sync, pause, resume",
    { exitCode: 2 },
  );
}
