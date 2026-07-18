import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitSubmission, waitForAdmission } from "../src/admission";
import { ArtifactStore } from "../src/artifacts";
import { ResearchStore } from "../src/store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): {
  root: string;
  store: ResearchStore;
  artifacts: ArtifactStore;
} {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-admission-"));
  roots.push(root);
  return {
    root,
    store: new ResearchStore(join(root, "research.db")),
    artifacts: new ArtifactStore(join(root, "artifacts")),
  };
}

test("text admission returns exact queued and duplicate identities without indexing", () => {
  const { store, artifacts } = fixture();
  const intent = {
    version: 1,
    source: "hello",
    kind: "text",
    ingress: "cli",
    idempotencyKey: "hello-once",
  } as const;
  const queued = admitSubmission(store, intent, { artifactStore: artifacts });
  expect(queued).toEqual({
    version: 1,
    status: "queued",
    job_id: 1,
    idempotency_key: "hello-once",
    intent_hash:
      "09b1123940451be8d7b8983172e67b1b2fcf852f4b87f1a7a2a9e5ed748ca64a",
    state: "queued",
  });
  expect(admitSubmission(store, intent, { artifactStore: artifacts })).toEqual({
    ...queued,
    status: "duplicate",
  });
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 1,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM artifacts").get(),
  ).toEqual({ count: 1 });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("explicit idempotency reuse with changed intent is rejected", () => {
  const { store, artifacts } = fixture();
  admitSubmission(
    store,
    {
      version: 1,
      source: "first",
      kind: "text",
      ingress: "cli",
      idempotencyKey: "same-key",
    },
    { artifactStore: artifacts },
  );
  expect(() =>
    admitSubmission(
      store,
      {
        version: 1,
        source: "second",
        kind: "text",
        ingress: "cli",
        idempotencyKey: "same-key",
      },
      { artifactStore: artifacts },
    ),
  ).toThrow("idempotency_key already belongs to a different intent");
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 1,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM artifacts").get(),
  ).toEqual({ count: 1 });
  store.close();
});

test("structurally invalid intent creates no job or Artifact metadata", () => {
  const { store, artifacts } = fixture();
  expect(() =>
    admitSubmission(
      store,
      {
        version: 2 as 1,
        source: "hello",
        kind: "text",
        ingress: "cli",
      },
      { artifactStore: artifacts },
    ),
  ).toThrow("submission version must be 1");
  expect(store.db.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 0,
  });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM artifacts").get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("file admission snapshots immutable bytes and stores no local path", () => {
  const { root, store, artifacts } = fixture();
  const source = join(root, "private-note.md");
  writeFileSync(source, "hello");
  const result = admitSubmission(
    store,
    {
      version: 1,
      source,
      kind: "file",
      ingress: "cli",
      skipSecrets: false,
    },
    { artifactStore: artifacts },
  );
  writeFileSync(source, "changed");
  expect(
    artifacts.readUtf8(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    ),
  ).toBe("hello");
  const row = store.db
    .query("SELECT intent FROM jobs WHERE id=?")
    .get(result.job_id) as { intent: string };
  expect(row.intent).not.toContain(root);
  expect(row.intent).not.toContain("private-note.md");
  expect(row.intent).toContain(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  store.close();
});

test("directory admission snapshots supported files without parsing them", () => {
  const { root, store, artifacts } = fixture();
  const directory = join(root, "notes");
  mkdirSync(directory);
  writeFileSync(join(directory, "b.md"), "second");
  writeFileSync(join(directory, "a.txt"), "first");
  writeFileSync(join(directory, "ignored.bin"), "ignored");
  const result = admitSubmission(
    store,
    {
      version: 1,
      source: directory,
      kind: "directory",
      ingress: "cli",
    },
    { artifactStore: artifacts },
  );
  expect(result).toMatchObject({ status: "queued", job_id: 1 });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM artifacts").get(),
  ).toEqual({ count: 2 });
  expect(
    store.db.query("SELECT COUNT(*) AS count FROM documents").get(),
  ).toEqual({ count: 0 });
  const row = store.db.query("SELECT intent FROM jobs").get() as {
    intent: string;
  };
  const intent = JSON.parse(row.intent);
  expect(intent.payload.directory.artifacts).toHaveLength(2);
  expect(row.intent).not.toContain(directory);
  store.close();
});

test("wait timeout observes the same active job", async () => {
  const { store, artifacts } = fixture();
  const queued = admitSubmission(
    store,
    { version: 1, source: "waiting", kind: "text", ingress: "cli" },
    { artifactStore: artifacts },
  );
  expect(await waitForAdmission(store, queued, 0)).toEqual({
    ...queued,
    wait_status: "timeout",
  });
  expect(
    store.db.query("SELECT id, state FROM jobs WHERE id=?").get(queued.job_id),
  ).toEqual({ id: queued.job_id, state: "queued" });
  store.close();
});
