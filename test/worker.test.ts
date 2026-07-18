import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableSubmissionIntent } from "../src/admission";
import { ArtifactStore } from "../src/artifacts";
import { ResearchStore } from "../src/store";
import { type JobMaterializer, runWorker } from "../src/worker";

const roots: string[] = [];
const T0 = new Date("2026-06-01T00:00:00.000Z");

function at(milliseconds: number): Date {
  return new Date(T0.getTime() + milliseconds);
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(): { store: ResearchStore; artifacts: ArtifactStore } {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-worker-"));
  roots.push(root);
  return {
    store: new ResearchStore(join(root, "brain.db")),
    artifacts: new ArtifactStore(join(root, "artifacts")),
  };
}

function intent(kind: "text" | "url" = "text"): DurableSubmissionIntent {
  return {
    version: 1,
    kind,
    ingress: "test",
    collections: [],
    payload:
      kind === "url"
        ? { url: { url: "https://example.test/private?token=hidden" } }
        : {
            text: {
              content_digest: "0".repeat(64),
              byte_size: 1,
              media_type: "text/plain",
              artifact_role: "original",
            },
          },
    options: { tags: [], force: false, max_bytes: 1000 },
  };
}

const materialize: JobMaterializer = (job) => [
  {
    sourceType: "text",
    sourceUri: `test-job:${job.id}`,
    title: `Job ${job.id}`,
    content: `materialized ${job.id}`,
  },
];

test("worker once drains only eligible jobs", async () => {
  const { store, artifacts } = fixture();
  const blocked = store.enqueueJob({
    idempotencyKey: "blocked",
    kind: "url",
    intent: intent("url"),
    now: T0,
  });
  const blockedClaim = store.claimJob({
    worker: "setup",
    now: T0,
    leaseMs: 1000,
  });
  if (!blockedClaim.claimed) throw new Error("expected setup claim");
  store.failAttempt({
    fencingToken: blockedClaim.fencing_token,
    failureClass: "auth_config",
    summary: "configuration missing",
    now: T0,
  });
  const eligible = store.enqueueJob({
    idempotencyKey: "eligible",
    kind: "text",
    intent: intent(),
    now: T0,
  });
  const future = store.enqueueJob({
    idempotencyKey: "future",
    kind: "text",
    intent: intent(),
    now: at(60_000),
  });

  const result = await runWorker(store, {
    once: true,
    workerId: "once-test",
    now: () => T0,
    artifactStore: artifacts,
    materialize,
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({
    claimed: 1,
    completed: 1,
    failed: 0,
    fenced: 0,
  });
  expect(
    store.db.query("SELECT id, state FROM jobs ORDER BY id").all(),
  ).toEqual([
    { id: blocked.job.id, state: "blocked" },
    { id: eligible.job.id, state: "completed" },
    { id: future.job.id, state: "queued" },
  ]);
  expect(store.db.query("SELECT content FROM documents").all()).toEqual([
    { content: `materialized ${eligible.job.id}` },
  ]);
  store.close();
});

test("shutdown wakes an idle long-loop without waiting for its poll interval", async () => {
  const { store, artifacts } = fixture();
  const stop = new AbortController();
  const started = performance.now();
  const running = runWorker(store, {
    pollMs: 10_000,
    signal: stop.signal,
    artifactStore: artifacts,
    installSignalHandlers: false,
  });
  setTimeout(() => stop.abort(), 10);
  const result = await running;
  expect(result.stopped).toBe(true);
  expect(performance.now() - started).toBeLessThan(500);
  store.close();
});

test("bounded shutdown leaves an unfinished attempt recoverable", async () => {
  const { store, artifacts } = fixture();
  const queued = store.enqueueJob({
    idempotencyKey: "shutdown",
    kind: "text",
    intent: intent(),
    now: T0,
  });
  const stop = new AbortController();
  let started: (() => void) | undefined;
  const materializerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const waitingMaterializer: JobMaterializer = async (
    _job,
    _intent,
    context,
  ) => {
    started?.();
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        {
          once: true,
        },
      );
    });
    return [];
  };
  const running = runWorker(store, {
    workerId: "shutdown-test",
    now: () => T0,
    leaseMs: 1000,
    heartbeatMs: 100,
    shutdownGraceMs: 0,
    signal: stop.signal,
    artifactStore: artifacts,
    materialize: waitingMaterializer,
    installSignalHandlers: false,
  });
  await materializerStarted;
  stop.abort();
  const result = await running;
  expect(result).toMatchObject({
    stopped: true,
    claimed: 1,
    completed: 0,
    fenced: 1,
  });
  expect(
    store.db.query("SELECT state FROM jobs WHERE id=?").get(queued.job.id),
  ).toEqual({
    state: "running",
  });
  expect(
    store.recoverExpiredLeases({
      now: at(2000),
      policy: { infraBaseMs: 0, infraCapMs: 0, jitterRatio: 0 },
    }),
  ).toEqual([
    { job_id: queued.job.id, attempt_id: 1, disposition: "retry_wait" },
  ]);
  store.close();
});

test("lease recovery fences a stale completion", async () => {
  const { store, artifacts } = fixture();
  const queued = store.enqueueJob({
    idempotencyKey: "stale",
    kind: "text",
    intent: intent(),
    now: T0,
  });
  const reclaimingMaterializer: JobMaterializer = () => {
    store.recoverExpiredLeases({
      now: at(2000),
      policy: { infraBaseMs: 0, infraCapMs: 0, jitterRatio: 0 },
    });
    const reclaimed = store.claimJob({
      worker: "replacement",
      now: at(2000),
      leaseMs: 1000,
    });
    if (!reclaimed.claimed) throw new Error("expected replacement claim");
    store.completeJob({ fencingToken: reclaimed.fencing_token, now: at(2000) });
    return [
      {
        sourceType: "text",
        sourceUri: "must-not-commit",
        title: "Stale",
        content: "stale body",
      },
    ];
  };
  const result = await runWorker(store, {
    once: true,
    workerId: "stale-worker",
    now: () => T0,
    leaseMs: 1000,
    artifactStore: artifacts,
    materialize: reclaimingMaterializer,
    installSignalHandlers: false,
  });
  expect(result).toMatchObject({ claimed: 1, completed: 0, fenced: 1 });
  expect(
    store.db
      .query("SELECT state, attempt_count FROM jobs WHERE id=?")
      .get(queued.job.id),
  ).toEqual({
    state: "completed",
    attempt_count: 2,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  store.close();
});
