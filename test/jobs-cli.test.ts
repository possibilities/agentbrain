import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitSubmission } from "../src/admission";
import { ArtifactStore } from "../src/artifacts";
import { ResearchStore } from "../src/store";

const REPO = join(import.meta.dir, "..");
const roots: string[] = [];

interface Fixture {
  root: string;
  dbPath: string;
  store: ResearchStore;
  artifacts: ArtifactStore;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-jobs-cli-"));
  roots.push(root);
  const dbPath = join(root, "brain.db");
  return {
    root,
    dbPath,
    store: new ResearchStore(dbPath),
    artifacts: new ArtifactStore(join(root, "data", "agentbrain", "artifacts")),
  };
}

function decode(value: Uint8Array | string): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function runCli(
  value: Fixture,
  args: string[],
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "src/cli.ts", ...args, "--db", value.dbPath],
    cwd: REPO,
    env: {
      ...process.env,
      XDG_DATA_HOME: join(value.root, "data"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

interface JsonEnvelope<T> {
  meta: { read_only: boolean };
  data: T;
}

function jsonOutput<T>(result: ReturnType<typeof runCli>): JsonEnvelope<T> {
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout) as JsonEnvelope<T>;
}

test("job list and show redact intent bodies and unsafe URLs", () => {
  const value = fixture();
  const text = admitSubmission(
    value.store,
    {
      version: 1,
      source: "private body needle-92",
      kind: "text",
      ingress: "cli",
    },
    { artifactStore: value.artifacts },
  );
  admitSubmission(
    value.store,
    {
      version: 1,
      source: "https://example.test/report?token=query-secret&name=needle-92",
      kind: "url",
      ingress: "cli",
    },
    { artifactStore: value.artifacts },
  );
  value.store.close();

  const listed = runCli(value, ["jobs", "list", "--json"]);
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout).not.toContain("needle-92");
  expect(listed.stdout).not.toContain("example.test");
  expect(jsonOutput<unknown>(listed).meta.read_only).toBe(true);

  const shown = runCli(value, ["jobs", "show", String(text.job_id), "--json"]);
  expect(shown.exitCode).toBe(0);
  expect(shown.stdout).not.toContain("private body");
  expect(shown.stdout).not.toContain("content_digest");
  expect(jsonOutput<unknown>(shown).meta.read_only).toBe(true);

  const urlShown = runCli(value, ["jobs", "show", "2", "--json"]);
  expect(urlShown.exitCode).toBe(0);
  expect(urlShown.stdout).not.toContain("example.test");
  expect(urlShown.stdout).not.toContain("query-secret");
});

test("explicit Artifact reveal returns content and appends an inspection audit", () => {
  const value = fixture();
  const admitted = admitSubmission(
    value.store,
    {
      version: 1,
      source: "revealed body fixture",
      kind: "text",
      ingress: "cli",
    },
    { artifactStore: value.artifacts },
  );
  value.store.close();

  const revealed = runCli(value, [
    "jobs",
    "show",
    String(admitted.job_id),
    "--reveal-content",
    "--actor",
    "test-operator",
    "--json",
  ]);
  expect(revealed.exitCode).toBe(0);
  const payload = jsonOutput<{ artifacts: unknown[] }>(revealed);
  expect(payload.meta.read_only).toBe(false);
  expect(payload.data.artifacts).toEqual([
    {
      content_digest:
        "6dc4ff21675b6bbce312950e8a779726f510e47e6b06d7621f92be8b485007a4",
      media_type: "text/plain; charset=utf-8",
      byte_size: 21,
      body: "revealed body fixture",
    },
  ]);

  const store = new ResearchStore(value.dbPath);
  expect(
    store.db
      .query(
        "SELECT actor, reason FROM job_transitions WHERE job_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(admitted.job_id),
  ).toEqual({ actor: "test-operator", reason: "sensitive_inspection" });
  store.close();
});

test("operator commands append audits without erasing attempts", () => {
  const value = fixture();
  const failed = value.store.enqueueJob({
    idempotencyKey: "failed",
    kind: "text",
    intent: { version: 1 },
  });
  const claim = value.store.claimJob({ worker: "fixture" });
  if (!claim.claimed) throw new Error("expected claim");
  value.store.failAttempt({
    fencingToken: claim.fencing_token,
    failureClass: "permanent",
    summary: "fixture failure",
  });
  const cancelled = value.store.enqueueJob({
    idempotencyKey: "cancelled",
    kind: "text",
  });
  const excluded = value.store.enqueueJob({
    idempotencyKey: "excluded",
    kind: "text",
  });
  value.store.close();

  expect(
    runCli(value, [
      "jobs",
      "retry",
      String(failed.job.id),
      "--reason",
      "operator retry",
      "--json",
    ]).exitCode,
  ).toBe(0);
  expect(
    runCli(value, [
      "jobs",
      "cancel",
      String(cancelled.job.id),
      "--reason",
      "withdrawn",
      "--json",
    ]).exitCode,
  ).toBe(0);
  expect(
    runCli(value, [
      "jobs",
      "exclude",
      String(excluded.job.id),
      "--reason",
      "duplicate",
      "--json",
    ]).exitCode,
  ).toBe(0);

  const store = new ResearchStore(value.dbPath);
  expect(
    store.db
      .query("SELECT COUNT(*) AS count FROM attempts WHERE job_id=?")
      .get(failed.job.id),
  ).toEqual({
    count: 1,
  });
  expect(
    store.db
      .query(
        "SELECT reason FROM job_transitions WHERE actor='operator' ORDER BY id",
      )
      .all(),
  ).toEqual([
    { reason: "operator retry" },
    { reason: "withdrawn" },
    { reason: "duplicate" },
  ]);
  store.close();
});

test("jobs stats is content-safe and doctor reports missing provider", () => {
  const value = fixture();
  admitSubmission(
    value.store,
    {
      version: 1,
      source: "stats secret body",
      kind: "text",
      ingress: "cli",
    },
    { artifactStore: value.artifacts },
  );
  value.store.close();

  const stats = runCli(value, ["jobs", "stats", "--json"]);
  expect(stats.exitCode).toBe(0);
  expect(stats.stdout).not.toContain("stats secret body");
  expect(
    jsonOutput<{ total: number; runnable_due: number }>(stats).data,
  ).toMatchObject({
    total: 1,
    runnable_due: 1,
  });

  const doctor = runCli(value, ["doctor", "--json"], { PATH: "" });
  expect(doctor.exitCode).toBe(1);
  const report = jsonOutput<{
    healthy: boolean;
    checks: Array<{ name: string; status: string; detail: string }>;
  }>(doctor).data;
  expect(report.healthy).toBe(false);
  expect(report.checks).toContainEqual({
    name: "scrapectl",
    status: "failed",
    detail: "Scrapectl executable not found",
  });
  expect(doctor.stdout).not.toContain("stats secret body");
});
