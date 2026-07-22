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
import { scrapeWithAgentscrape } from "../src/agentscrape";
import { ResearchStore } from "../src/store";

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

function decode(value: Uint8Array | string): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function run(
  args: readonly string[],
  options: { db: string; env?: Record<string, string> },
) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli.ts", ...args, "--db", options.db],
    cwd: REPO,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("CLI ingest queues durably while context and guarded delete keep command metadata", () => {
  const { dir, db } = temp();
  const ingest = run(
    [
      "ingest",
      "Citation-ready agent memory",
      "--source-type",
      "text",
      "--tag",
      "memory",
      "--json",
    ],
    { db, env: { XDG_DATA_HOME: join(dir, "data") } },
  );
  expect(ingest.exitCode).toBe(0);
  const ingested = JSON.parse(decode(ingest.stdout));
  expect(ingested).toMatchObject({
    ok: true,
    command: "ingest",
    meta: { read_only: false },
    data: { status: "queued", job_id: 1, state: "queued" },
  });

  const store = new ResearchStore(db);
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM resources").get(),
  ).toEqual({ count: 0 });
  const seeded = store.upsertDocument({
    sourceType: "text",
    sourceUri: "fixture:materialized",
    title: "Materialized fixture",
    content: "Citation-ready agent memory",
    tags: ["memory"],
  });
  store.close();

  const context = run(
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
    document_id: seeded.document_id,
    source_uri: "fixture:materialized",
  });
  expect(contextPayload.data.hits[0].citation).toContain("document_id:");

  const refused = run(
    ["delete", "--document-id", String(seeded.document_id), "--json"],
    { db },
  );
  expect(refused.exitCode).toBe(2);
  expect(JSON.parse(decode(refused.stdout))).toMatchObject({
    ok: false,
    error: { code: "confirmation_required" },
  });

  const deleted = run(
    [
      "delete",
      "--document-id",
      String(seeded.document_id),
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
    data: { deleted_document_id: seeded.document_id },
  });
}, 15_000);

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
    const proc = run(args, { db: state.db });
    expect(proc.exitCode).toBe(2);
    expect(existsSync(state.db)).toBe(false);
    expect(JSON.parse(decode(proc.stdout))).toMatchObject({
      ok: false,
      error: { code },
    });
  }

  const missingDeleteState = temp();
  const missingDelete = run(
    ["delete", "--document-id", "1", "--confirm", "delete", "--json"],
    { db: missingDeleteState.db },
  );
  expect(missingDelete.exitCode).toBe(1);
  expect(existsSync(missingDeleteState.db)).toBe(false);
  expect(JSON.parse(decode(missingDelete.stdout))).toMatchObject({
    ok: false,
    error: { code: "db_not_found" },
  });
}, 40_000);

test("PATH Agentscrape uses explicit X argv and sanitizes nonzero errors", async () => {
  const { dir } = temp();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "agentscrape-args.txt");
  const executable = join(bin, "agentscrape");
  writeFileSync(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nprintf '%s\\n' '# X child'\n`,
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  const result = await scrapeWithAgentscrape(
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
    await scrapeWithAgentscrape("https://x.com/child/status/2000", {
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
