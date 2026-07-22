import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResearchStore } from "../src/store";

const REPO = join(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-retag-cli-"));
  dirs.push(dir);
  return join(dir, "research.db");
}

function decode(value: Uint8Array | string): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function run(args: readonly string[], db: string) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli.ts", ...args, "--db", db],
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function seed(db: string): { githubDocId: number; unchangedDocId: number } {
  const store = new ResearchStore(db);
  const githubDoc = store.upsertDocument({
    sourceType: "url",
    sourceUri: "https://github.com/foo/bar",
    content: "readme body",
    tags: ["legacy-recovery"],
  });
  const unchangedDoc = store.upsertDocument({
    sourceType: "text",
    sourceUri: "local://already-tagged",
    content: "a note with no structural signal",
    tags: ["custom"],
  });
  store.close();
  return {
    githubDocId: githubDoc.document_id,
    unchangedDocId: unchangedDoc.document_id,
  };
}

test("retag --json applies structural tags, syncs FTS, and reports a truthful envelope", () => {
  const db = tempDb();
  const { githubDocId, unchangedDocId } = seed(db);

  const result = run(["retag", "--json"], db);
  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(decode(result.stdout));
  expect(payload).toMatchObject({
    ok: true,
    command: "retag",
    meta: { read_only: false },
    data: {
      dry_run: false,
      documents_scanned: 2,
      documents_changed: 1,
      documents_unchanged: 1,
    },
  });
  expect(payload.data.changes).toEqual([
    {
      document_id: githubDocId,
      before: ["legacy-recovery"],
      after: ["legacy-recovery", "code", "github"],
    },
  ]);

  const store = new ResearchStore(db);
  const githubRow = store.db
    .query("SELECT tags FROM documents WHERE id=?")
    .get(githubDocId) as { tags: string };
  expect(githubRow.tags).toBe('["legacy-recovery", "code", "github"]');
  const unchangedRow = store.db
    .query("SELECT tags FROM documents WHERE id=?")
    .get(unchangedDocId) as { tags: string };
  expect(unchangedRow.tags).toBe('["custom"]');
  const ftsRow = store.db
    .query("SELECT tags FROM chunks_fts WHERE document_id=?")
    .get(githubDocId) as { tags: string };
  expect(ftsRow.tags).toBe("legacy-recovery code github");
  store.close();

  const findable = run(["search", "readme", "--tag", "github", "--json"], db);
  expect(findable.exitCode).toBe(0);
  const found = JSON.parse(decode(findable.stdout));
  expect(
    found.data.results.map((r: { document_id: number }) => r.document_id),
  ).toContain(githubDocId);

  const tagsListing = run(["tags", "--json"], db);
  expect(tagsListing.exitCode).toBe(0);
  const tagsPayload = JSON.parse(decode(tagsListing.stdout));
  expect(tagsPayload.data.tags.map((t: { tag: string }) => t.tag)).toEqual(
    expect.arrayContaining(["code", "github"]),
  );
}, 20_000);

test("retag --dry-run reports the same diff and counts without mutating the database", () => {
  const db = tempDb();
  const { githubDocId } = seed(db);

  const before = new ResearchStore(db);
  const beforeRow = before.db
    .query("SELECT tags FROM documents WHERE id=?")
    .get(githubDocId) as { tags: string };
  before.close();

  const dryRun = run(["retag", "--dry-run", "--json"], db);
  expect(dryRun.exitCode).toBe(0);
  const payload = JSON.parse(decode(dryRun.stdout));
  expect(payload).toMatchObject({
    ok: true,
    meta: { read_only: true },
    data: {
      dry_run: true,
      documents_scanned: 2,
      documents_changed: 1,
      documents_unchanged: 1,
    },
  });
  expect(payload.data.changes).toEqual([
    {
      document_id: githubDocId,
      before: ["legacy-recovery"],
      after: ["legacy-recovery", "code", "github"],
    },
  ]);

  const after = new ResearchStore(db);
  const afterRow = after.db
    .query("SELECT tags FROM documents WHERE id=?")
    .get(githubDocId) as { tags: string };
  after.close();
  expect(afterRow).toEqual(beforeRow);
}, 20_000);

test("running retag twice is idempotent end to end: the second run reports zero changed", () => {
  const db = tempDb();
  seed(db);

  const first = run(["retag", "--json"], db);
  expect(first.exitCode).toBe(0);
  expect(JSON.parse(decode(first.stdout)).data).toMatchObject({
    documents_changed: 1,
  });

  const second = run(["retag", "--json"], db);
  expect(second.exitCode).toBe(0);
  const secondPayload = JSON.parse(decode(second.stdout));
  expect(secondPayload.data).toMatchObject({
    documents_scanned: 2,
    documents_changed: 0,
    documents_unchanged: 2,
  });
  expect(secondPayload.data.changes).toEqual([]);
}, 20_000);

test("invalid retag argv never initializes or mutates a database", () => {
  for (const [args, code] of [
    [["retag", "--bogus", "--json"], "unknown_option"],
    [["retag", "extra-positional", "--json"], "unexpected_args"],
  ] as const) {
    const db = tempDb();
    const proc = run(args, db);
    expect(proc.exitCode).toBe(2);
    expect(existsSync(db)).toBe(false);
    expect(JSON.parse(decode(proc.stdout))).toMatchObject({
      ok: false,
      error: { code },
    });
  }
}, 15_000);

test("retag on a missing database reports db_not_found without creating one", () => {
  const db = tempDb();
  const proc = run(["retag", "--json"], db);
  expect(proc.exitCode).toBe(1);
  expect(existsSync(db)).toBe(false);
  expect(JSON.parse(decode(proc.stdout))).toMatchObject({
    ok: false,
    error: { code: "db_not_found" },
  });
}, 15_000);
