import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrapeWithScrapectl } from "../src/scrapectl";

const REPO = join(import.meta.dir, "..");
const dirs: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function temp(): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-cli-write-"));
  dirs.push(dir);
  return { dir, db: join(dir, "research.db") };
}

function permanentFailurePath(dir: string): string {
  const bin = join(dir, "fake-scrapectl");
  mkdirSync(bin);
  const executable = join(bin, "scrapectl");
  writeFileSync(
    executable,
    "#!/bin/sh\nprintf '%s\\n' 'invalid input URL fixture' >&2\nexit 2\n",
  );
  chmodSync(executable, 0o755);
  return `${bin}:${originalPath}`;
}

function decode(value: Uint8Array | string): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function run(
  entrypoint: "agentbrain" | "legacy",
  args: readonly string[],
  options: { db: string; input?: unknown; env?: Record<string, string> },
) {
  return Bun.spawnSync({
    cmd: [
      "bun",
      "run",
      entrypoint === "agentbrain"
        ? "src/cli.ts"
        : "src/research-ingest-link.ts",
      ...args,
      "--db",
      options.db,
    ],
    cwd: REPO,
    env: { ...process.env, ...options.env },
    stdin:
      options.input === undefined
        ? undefined
        : new TextEncoder().encode(JSON.stringify(options.input)),
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("CLI text ingest, context, and guarded delete use command-specific metadata", () => {
  const { db } = temp();
  const ingest = run(
    "agentbrain",
    [
      "ingest",
      "Citation-ready agent memory",
      "--source-type",
      "text",
      "--tag",
      "memory",
      "--json",
    ],
    { db },
  );
  expect(ingest.exitCode).toBe(0);
  const ingested = JSON.parse(decode(ingest.stdout));
  expect(ingested).toMatchObject({
    ok: true,
    command: "ingest",
    meta: { read_only: false },
    data: { status: "created" },
  });

  const context = run(
    "agentbrain",
    ["context", "agent memory", "--max-chars", "500", "--json"],
    { db },
  );
  expect(context.exitCode).toBe(0);
  const contextPayload = JSON.parse(decode(context.stdout));
  expect(contextPayload).toMatchObject({
    ok: true,
    command: "context",
    meta: { read_only: true },
  });
  expect(contextPayload.data.hits[0]).toMatchObject({
    document_id: ingested.data.document_id,
    source_uri: ingested.data.source_uri,
  });
  expect(contextPayload.data.hits[0].citation).toContain("document_id:");

  const refused = run(
    "agentbrain",
    ["delete", "--document-id", String(ingested.data.document_id), "--json"],
    { db },
  );
  expect(refused.exitCode).toBe(2);
  expect(JSON.parse(decode(refused.stdout))).toMatchObject({
    ok: false,
    error: { code: "confirmation_required" },
  });

  const deleted = run(
    "agentbrain",
    [
      "delete",
      "--document-id",
      String(ingested.data.document_id),
      "--confirm",
      "delete",
      "--json",
    ],
    { db },
  );
  expect(deleted.exitCode).toBe(0);
  expect(JSON.parse(decode(deleted.stdout))).toMatchObject({
    ok: true,
    meta: { read_only: false },
    data: { deleted_document_id: ingested.data.document_id },
  });
});

test("agentbrain ingest-link uses the normal envelope", () => {
  const { db } = temp();
  const proc = run("agentbrain", ["ingest-link", "--json"], {
    db,
    input: {
      url: "https://example.com/root",
      markdown: "# Completed root",
      source: "agentbot",
    },
  });
  expect(proc.exitCode).toBe(0);
  expect(JSON.parse(decode(proc.stdout))).toMatchObject({
    ok: true,
    command: "ingest-link",
    meta: { read_only: false },
    data: {
      success: true,
      root_success: true,
      linked_count: 0,
    },
  });
});

test("legacy adapter emits exact bare success fields and exit 0", () => {
  const { db } = temp();
  const proc = run("legacy", ["--json"], {
    db,
    input: {
      url: "https://example.com/root",
      markdown: "# Root",
      source: "agentbot",
    },
  });
  expect(proc.exitCode).toBe(0);
  expect(decode(proc.stderr)).toBe("");
  const payload = JSON.parse(decode(proc.stdout));
  expect(Object.keys(payload)).toEqual([
    "success",
    "root_success",
    "root",
    "ingest",
    "artifact_path",
    "linked_results",
    "linked_count",
    "linked_failed_count",
  ]);
  expect(payload).toMatchObject({
    success: true,
    root_success: true,
    linked_count: 0,
  });
  expect(payload.ok).toBeUndefined();
  expect(payload.data).toBeUndefined();
});

test("invalid ingest and delete argv never initialize a database", () => {
  for (const [args, code] of [
    [["ingest", "--json"], "bad_source"],
    [["ingest", "", "--source-type", "text", "--json"], "bad_source"],
    [["ingest", "not a url", "--source-type", "url", "--json"], "bad_source"],
    [["ingest", "note", "--source-type", "bogus", "--json"], "bad_source_type"],
    [["ingest", "note", "--max-bytes", "0", "--json"], "bad_integer"],
    [["ingest", "note", "--max-files", "1.5", "--json"], "bad_integer"],
    [["ingest", "note", "--bogus", "--json"], "unknown_option"],
    [["delete", "--confirm", "delete", "--json"], "bad_selector"],
    [["delete", "--document-id", "1", "--json"], "confirmation_required"],
  ] as const) {
    const state = temp();
    const proc = run("agentbrain", args, { db: state.db });
    expect(proc.exitCode).toBe(2);
    expect(existsSync(state.db)).toBe(false);
    expect(JSON.parse(decode(proc.stdout))).toMatchObject({
      ok: false,
      error: { code },
    });
  }

  const missingDeleteState = temp();
  const missingDelete = run(
    "agentbrain",
    ["delete", "--document-id", "1", "--confirm", "delete", "--json"],
    { db: missingDeleteState.db },
  );
  expect(missingDelete.exitCode).toBe(1);
  expect(existsSync(missingDeleteState.db)).toBe(false);
  expect(JSON.parse(decode(missingDelete.stdout))).toMatchObject({
    ok: false,
    error: { code: "db_not_found" },
  });
});

test("invalid and oversized completed-link input never initializes a database", () => {
  const invalidState = temp();
  const invalid = run("agentbrain", ["ingest-link", "--json"], {
    db: invalidState.db,
    input: { url: "https://example.com" },
  });
  expect(invalid.exitCode).toBe(1);
  expect(existsSync(invalidState.db)).toBe(false);

  const oversizedState = temp();
  const oversized = run("agentbrain", ["ingest-link", "--json"], {
    db: oversizedState.db,
    input: {
      url: "https://example.com",
      markdown: "x".repeat(5_000_001),
    },
  });
  expect(oversized.exitCode).toBe(1);
  expect(JSON.parse(decode(oversized.stdout)).error.message).toContain(
    "markdown exceeds",
  );
  expect(existsSync(oversizedState.db)).toBe(false);
});

test("malformed URLs and wrong optional types never open native or legacy DBs", () => {
  for (const entrypoint of ["agentbrain", "legacy"] as const) {
    for (const input of [
      { url: "file:///tmp/not-http", markdown: "body" },
      { url: "https://example.com", markdown: "body", title: 42 },
    ]) {
      const state = temp();
      const proc = run(
        entrypoint,
        entrypoint === "agentbrain" ? ["ingest-link", "--json"] : [],
        { db: state.db, input },
      );
      expect(proc.exitCode).toBe(1);
      expect(existsSync(state.db)).toBe(false);
      const payload = JSON.parse(decode(proc.stdout));
      if (entrypoint === "agentbrain") {
        expect(payload).toMatchObject({
          ok: false,
          error: { code: "invalid_payload" },
        });
      } else {
        expect(payload).toMatchObject({
          success: false,
          root_success: false,
          error_kind: "invalid_payload",
        });
      }
    }
  }
});

test("legacy help exits zero without stdin or database initialization", () => {
  const state = temp();
  const help = run("legacy", ["--help"], { db: state.db });
  expect(help.exitCode).toBe(0);
  expect(decode(help.stdout)).toContain("Usage:");
  expect(existsSync(state.db)).toBe(false);
});

test("native ingest-link exits 2 for a root-success child partial", () => {
  const state = temp();
  const partial = run("agentbrain", ["ingest-link", "--json"], {
    db: state.db,
    env: { PATH: permanentFailurePath(state.dir) },
    input: {
      url: "https://x.com/example/status/998",
      markdown: "post",
      structured: { links: [{ url: "http://127.0.0.1/private" }] },
      source: "agentbot",
    },
  });
  expect(partial.exitCode).toBe(2);
  expect(JSON.parse(decode(partial.stdout))).toMatchObject({
    ok: true,
    data: {
      success: false,
      root_success: true,
      linked_failed_count: 1,
    },
  });
});

test("legacy adapter exits 1 on invalid input and 2 after root-first child failure", () => {
  const invalidState = temp();
  const invalid = run("legacy", [], {
    db: invalidState.db,
    input: { url: "https://example.com" },
  });
  expect(invalid.exitCode).toBe(1);
  expect(existsSync(invalidState.db)).toBe(false);
  expect(JSON.parse(decode(invalid.stdout))).toMatchObject({
    success: false,
    root_success: false,
    error_kind: "invalid_payload",
  });

  const partialState = temp();
  const partial = run("legacy", [], {
    db: partialState.db,
    env: { PATH: permanentFailurePath(partialState.dir) },
    input: {
      url: "https://x.com/example/status/999",
      markdown: "post",
      structured: { links: [{ url: "http://127.0.0.1/private" }] },
      source: "agentbot",
    },
  });
  expect(partial.exitCode).toBe(2);
  const payload = JSON.parse(decode(partial.stdout));
  expect(payload).toMatchObject({
    success: false,
    root_success: true,
    linked_failed_count: 1,
  });
  expect(payload.linked_results[0]).toMatchObject({
    success: false,
    relation: { status: "failed" },
  });
});

test("legacy artifact failure exits 2 with root committed and optional metadata", () => {
  const { dir, db } = temp();
  const blockedDataHome = join(dir, "not-a-directory");
  writeFileSync(blockedDataHome, "block mkdir");
  const proc = run("legacy", [], {
    db,
    input: {
      url: "https://example.com/artifact",
      markdown: "committed root",
      save_markdown_copy: true,
    },
    env: { XDG_DATA_HOME: blockedDataHome },
  });
  expect(proc.exitCode).toBe(2);
  const payload = JSON.parse(decode(proc.stdout));
  expect(payload).toMatchObject({
    success: false,
    root_success: true,
    artifact_path: null,
  });
  expect(typeof payload.artifact_error).toBe("string");
  expect(existsSync(db)).toBe(true);
});

test("PATH Scrapectl uses explicit X argv and sanitizes nonzero errors", async () => {
  const { dir } = temp();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "scrapectl-args.txt");
  const executable = join(bin, "scrapectl");
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nprintf '%s\\n' '# X child'\n`,
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  const result = await scrapeWithScrapectl(
    "https://twitter.com/child/status/2000",
    { timeoutMs: 1000 },
  );
  expect(result.url).toBe("https://twitter.com/child/status/2000");
  expect(readFileSync(log, "utf8")).toBe(
    "fetch-markdown\n--markdown\nhttps://twitter.com/child/status/2000\n",
  );

  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' 'stdout token=must-not-leak'\nprintf '%s\\n' 'Authorization: Bearer super.secret password=hunter2' >&2\nexit 7\n`,
  );
  let message = "";
  try {
    await scrapeWithScrapectl("https://x.com/child/status/2000", {
      timeoutMs: 1000,
      retry: { maxAttempts: 1 },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("[REDACTED]");
  expect(message).not.toContain("must-not-leak");
  expect(message).not.toContain("super.secret");
  expect(message).not.toContain("hunter2");
});
