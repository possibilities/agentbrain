import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DurableSubmissionIntent,
  RECOVERY_JOB_PREFIX,
} from "../src/admission";
import { ArtifactStore } from "../src/artifacts";
import { ScrapectlExtractionError } from "../src/scrapectl";
import { ResearchStore } from "../src/store";
import { type JobMaterializer, runWorker } from "../src/worker";

const roots: string[] = [];
const originalPath = process.env.PATH;
const T0 = new Date("2026-06-01T00:00:00.000Z");

function at(milliseconds: number): Date {
  return new Date(T0.getTime() + milliseconds);
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.COUNT_FILE;
  delete process.env.ARGV_FILE;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  root: string;
  store: ResearchStore;
  artifacts: ArtifactStore;
} {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-worker-"));
  roots.push(root);
  return {
    root,
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

function extractionEnvelope(url: string, content: string): string {
  return JSON.stringify({
    schema_version: "1",
    status: "success",
    requested_url: url,
    final_url: "https://example.test/final",
    extractor: {
      name: "scrapectl",
      version: "1.2.3",
      implementation: "generic-page",
      implementation_version: "1",
    },
    artifacts: [
      {
        artifact_type: "document",
        media_type: "text/markdown",
        encoding: "utf-8",
        content,
        size_bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
    metadata: {
      content_type: "web_page",
      title: "Queued URL",
      author_name: "",
      author_handle: "",
      published_at: "",
      source_id: "",
      warnings: [],
    },
    relations: [],
    failure: null,
  });
}

function installExtractionCommand(root: string, envelope: string): void {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const executable = join(bin, "scrapectl");
  writeFileSync(
    executable,
    `#!/bin/sh
printf x >> "$COUNT_FILE"
printf '%s\\n' "$@" > "$ARGV_FILE"
printf '%s' '${envelope.replaceAll("'", `'\\''`)}'
`,
  );
  chmodSync(executable, 0o755);
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.COUNT_FILE = join(root, "count");
  process.env.ARGV_FILE = join(root, "argv");
}

const materialize: JobMaterializer = (job) => [
  {
    sourceType: "text",
    sourceUri: `test-job:${job.id}`,
    title: `Job ${job.id}`,
    content: `materialized ${job.id}`,
  },
];

test("queued URL extraction promotes and commits through fenced completion", async () => {
  const { root, store, artifacts } = fixture();
  const queued = store.enqueueJob({
    idempotencyKey: "queued-url",
    kind: "url",
    intent: intent("url"),
    now: T0,
  });
  const requested = "https://example.test/private?token=%5BREDACTED%5D";
  const content = "# Queued URL\n\nDurable body";
  installExtractionCommand(root, extractionEnvelope(requested, content));

  const result = await runWorker(store, {
    once: true,
    workerId: "url-worker",
    now: () => T0,
    artifactStore: artifacts,
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  expect(
    store.db
      .query("SELECT state, resource_id FROM jobs WHERE id=?")
      .get(queued.job.id),
  ).toMatchObject({ state: "completed", resource_id: 1 });
  const artifact = store.db
    .query(
      "SELECT content_hash, artifact_role, storage_path FROM artifacts WHERE artifact_role='extracted_markdown'",
    )
    .get() as {
    content_hash: string;
    artifact_role: string;
    storage_path: string;
  };
  expect(artifacts.readUtf8(artifact.content_hash)).toBe(content);
  expect(
    store.db
      .query("SELECT evidence_type, raw_metadata FROM provenance ORDER BY id")
      .all(),
  ).toEqual([
    {
      evidence_type: "ingestion_materialized",
      raw_metadata: JSON.stringify({ job_id: queued.job.id, item: 1 }),
    },
    {
      evidence_type: "url_extraction",
      raw_metadata: expect.stringContaining('"name":"scrapectl"'),
    },
  ]);
  expect(readFileSync(process.env.ARGV_FILE ?? "", "utf8")).toContain(
    "--envelope\n",
  );
  expect(readFileSync(process.env.ARGV_FILE ?? "", "utf8")).not.toContain(
    "--markdown",
  );
  store.close();
});

test("retry after index failure reuses the promoted URL Artifact", async () => {
  const { root, store, artifacts } = fixture();
  const queued = store.enqueueJob({
    idempotencyKey: "url-index-retry",
    kind: "url",
    intent: intent("url"),
    now: T0,
  });
  const content = "# Reusable\n\nExtract once";
  installExtractionCommand(
    root,
    extractionEnvelope(
      "https://example.test/private?token=%5BREDACTED%5D",
      content,
    ),
  );
  const upsert = store.upsertDocument.bind(store);
  let indexAvailable = false;
  store.upsertDocument = ((input) => {
    if (!indexAvailable) {
      throw new Error("simulated index temporarily unavailable");
    }
    return upsert(input);
  }) as ResearchStore["upsertDocument"];
  const policy = { infraBaseMs: 1000, infraCapMs: 1000, jitterRatio: 0 };

  await runWorker(store, {
    once: true,
    workerId: "first-index-attempt",
    now: () => T0,
    artifactStore: artifacts,
    policy,
    installSignalHandlers: false,
  });
  expect(readFileSync(process.env.COUNT_FILE ?? "", "utf8")).toBe("x");
  expect(
    store.db.query("SELECT state FROM jobs WHERE id=?").get(queued.job.id),
  ).toEqual({ state: "retry_wait" });

  indexAvailable = true;
  const retried = await runWorker(store, {
    once: true,
    workerId: "second-index-attempt",
    now: () => at(1000),
    artifactStore: artifacts,
    policy,
    installSignalHandlers: false,
  });
  expect(retried).toMatchObject({ claimed: 1, completed: 1 });
  expect(readFileSync(process.env.COUNT_FILE ?? "", "utf8")).toBe("x");
  expect(
    store.db
      .query("SELECT state, attempt_count FROM jobs WHERE id=?")
      .get(queued.job.id),
  ).toEqual({ state: "completed", attempt_count: 2 });
  expect(store.db.query("SELECT content FROM documents").get()).toEqual({
    content,
  });
  store.close();
});

test("recovery completion links a cross-candidate collision job to the document owner", async () => {
  const { store, artifacts } = fixture();
  const exactUrl = "https://legacy-collision.test/item/1";
  const document = store.upsertDocument({
    sourceType: "url",
    sourceUri: exactUrl,
    content: "content from a newer generation",
  });
  const existingResourceId = Number(
    store.db
      .query(
        `INSERT INTO resources(
           key_type, key_value, kind, document_id, created_at, updated_at
         ) VALUES ('url', 'foreign-owner', 'url', ?, ?, ?)`,
      )
      .run(document.document_id, T0.toISOString(), T0.toISOString())
      .lastInsertRowid,
  );
  const recoveryResourceId = Number(
    store.db
      .query(
        `INSERT INTO resources(
           key_type, key_value, kind, sensitivity, created_at, updated_at
         ) VALUES (
           'recovery_candidate', 'aaaaaaaaaaaaaaaa', 'url', 'private', ?, ?
         )`,
      )
      .run(T0.toISOString(), T0.toISOString()).lastInsertRowid,
  );
  store.db
    .query(
      `INSERT INTO resource_aliases(
         resource_id, alias_type, locator, evidence, first_observed_at,
         last_observed_at
       ) VALUES (?, 'legacy_exact_url', ?, 'legacy test', ?, ?)`,
    )
    .run(recoveryResourceId, exactUrl, T0.toISOString(), T0.toISOString());
  const recoveryIntent: DurableSubmissionIntent = {
    version: 1,
    kind: "file",
    ingress: "legacy-recovery",
    collections: [],
    payload: {
      file: {
        content_digest: "0".repeat(64),
        byte_size: 1,
        media_type: "text/markdown",
        artifact_role: "imported_markdown",
      },
    },
    options: { tags: [], force: false, max_bytes: 1000 },
  };
  const queued = store.enqueueJob({
    idempotencyKey: `${RECOVERY_JOB_PREFIX}aaaaaaaaaaaaaaaa`,
    kind: "file",
    intent: recoveryIntent,
    resourceId: recoveryResourceId,
    now: T0,
  });

  const result = await runWorker(store, {
    once: true,
    workerId: "recovery-collision",
    now: () => T0,
    artifactStore: artifacts,
    materialize: () => [
      {
        sourceType: "file",
        sourceUri: "ignored-for-recovery",
        title: "Recovered collision",
        content: "offline body from the older generation",
      },
    ],
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
  expect(
    store.db
      .query("SELECT state, resource_id, failure_class FROM jobs WHERE id=?")
      .get(queued.job.id),
  ).toEqual({
    state: "completed",
    resource_id: existingResourceId,
    failure_class: null,
  });
  expect(
    store.db
      .query(
        `SELECT d.id AS document_id
         FROM jobs j
         JOIN resources r ON r.id=j.resource_id
         JOIN documents d ON d.id=r.document_id
         WHERE j.id=?`,
      )
      .get(queued.job.id),
  ).toEqual({ document_id: document.document_id });
  expect(
    store.db
      .query("SELECT document_id, sensitivity FROM resources WHERE id=?")
      .get(recoveryResourceId),
  ).toEqual({ document_id: null, sensitivity: "private" });
  expect(
    store.db
      .query("SELECT document_id, sensitivity FROM resources WHERE id=?")
      .get(existingResourceId),
  ).toEqual({ document_id: document.document_id, sensitivity: "private" });
  expect(
    store.db
      .query(
        `SELECT COUNT(*) AS count FROM provenance
         WHERE resource_id=? AND evidence_type='ingestion_materialized'`,
      )
      .get(existingResourceId),
  ).toEqual({ count: 1 });
  const replay = await runWorker(store, {
    once: true,
    now: () => T0,
    artifactStore: artifacts,
    materialize,
    installSignalHandlers: false,
  });
  expect(replay.claimed).toBe(0);
  expect(
    store.db
      .query(
        `SELECT COUNT(*) AS count FROM provenance
         WHERE resource_id=? AND evidence_type='ingestion_materialized'`,
      )
      .get(existingResourceId),
  ).toEqual({ count: 1 });
  store.close();
});

test("permanent completion failures terminate instead of retrying as infrastructure", async () => {
  const { store, artifacts } = fixture();
  const queued = store.enqueueJob({
    idempotencyKey: "permanent-completion-failure",
    kind: "text",
    intent: intent(),
    now: T0,
  });
  store.upsertDocument = (() => {
    throw new Error("UNIQUE constraint failed: resources.document_id");
  }) as ResearchStore["upsertDocument"];

  const result = await runWorker(store, {
    once: true,
    workerId: "permanent-completion",
    now: () => T0,
    artifactStore: artifacts,
    materialize,
    installSignalHandlers: false,
  });

  expect(result).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
  expect(
    store.db
      .query("SELECT state, failure_class, attempt_count FROM jobs WHERE id=?")
      .get(queued.job.id),
  ).toEqual({ state: "failed", failure_class: "permanent", attempt_count: 1 });
  expect(
    store.db
      .query("SELECT state, failure_class FROM attempts WHERE job_id=?")
      .get(queued.job.id),
  ).toEqual({ state: "failed", failure_class: "permanent" });
  store.close();
});

test("extraction dispositions reach accepted durable job states", async () => {
  const cases = [
    ["infra", "infrastructure", "retry_wait"],
    ["item_transient", "item", "retry_wait"],
    ["auth_config", "auth_config", "blocked"],
    ["permanent", "policy", "failed"],
    ["permanent", "protocol", "failed"],
    ["cancelled", "cancellation", "cancelled"],
  ] as const;
  for (const [disposition, outcome, expectedState] of cases) {
    const { store, artifacts } = fixture();
    const queued = store.enqueueJob({
      idempotencyKey: `disposition-${outcome}`,
      kind: "url",
      intent: intent("url"),
      now: T0,
    });
    await runWorker(store, {
      once: true,
      workerId: `worker-${outcome}`,
      now: () => T0,
      artifactStore: artifacts,
      extract: async () => {
        throw new ScrapectlExtractionError(
          `safe ${outcome} failure`,
          disposition,
          outcome,
        );
      },
      policy: {
        infraBaseMs: 1000,
        infraCapMs: 1000,
        itemBaseMs: 1000,
        itemCapMs: 1000,
        jitterRatio: 0,
      },
      installSignalHandlers: false,
    });
    expect(
      store.db.query("SELECT state FROM jobs WHERE id=?").get(queued.job.id),
    ).toEqual({ state: expectedState });
    store.close();
  }
});

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
