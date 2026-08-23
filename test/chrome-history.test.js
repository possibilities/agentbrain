/**
 * The Chrome client's share history and how each entry reads in the popover.
 * Plain JavaScript for the same reason as the outbox test: the extension is,
 * and `tsconfig.json` includes only TypeScript.
 *
 * `chrome.storage.local` is the only surface stubbed — the history is storage
 * and derivation, with no browser behavior of its own.
 */

import { beforeEach, expect, test } from "bun:test";

const storage = new Map();

globalThis.chrome = {
  storage: {
    local: {
      async get(defaults) {
        const out = {};
        for (const [key, fallback] of Object.entries(defaults)) {
          out[key] = storage.has(key) ? storage.get(key) : fallback;
        }
        return out;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) {
          storage.set(key, value);
        }
      },
    },
  },
};

const {
  applyLedgerStates,
  clearHistory,
  HISTORY_MAX_ENTRIES,
  OUTCOME,
  pendingJobIds,
  readHistory,
  record,
} = await import("../clients/chrome/history.js");
const { hostFor, labelFor, statusFor } = await import(
  "../clients/chrome/status.js"
);

beforeEach(() => {
  storage.clear();
});

test("a held share becomes one row that delivery updates in place", async () => {
  await record({
    id: "entry-1",
    payload: { url: "https://example.com/post", title: "A post" },
    outcome: OUTCOME.HELD,
    message: "Cannot reach the ingress.",
  });
  let entries = await readHistory();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    outcome: OUTCOME.HELD,
    url: "https://example.com/post",
    job: null,
  });
  const sharedAt = entries[0].sharedAt;

  // The same outbox entry delivered later is the same share, not a second one.
  await record({
    id: "entry-1",
    payload: { url: "https://example.com/post", title: "A post" },
    outcome: OUTCOME.SENT,
    job: 4321,
  });
  entries = await readHistory();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ outcome: OUTCOME.SENT, job: 4321 });
  // Ordering follows when the user shared, not when delivery happened.
  expect(entries[0].sharedAt).toBe(sharedAt);
});

test("history is newest first and bounded", async () => {
  for (let index = 0; index < HISTORY_MAX_ENTRIES + 5; index += 1) {
    await record({
      id: `entry-${index}`,
      payload: { url: `https://example.com/${index}` },
      outcome: OUTCOME.SENT,
      job: index,
    });
  }
  const entries = await readHistory();
  expect(entries).toHaveLength(HISTORY_MAX_ENTRIES);
  expect(entries[0].job).toBe(HISTORY_MAX_ENTRIES + 4);
  expect(await clearHistory()).toBe(HISTORY_MAX_ENTRIES);
  expect(await readHistory()).toEqual([]);
});

test("only unsettled jobs are asked about, and the ingress's word wins", async () => {
  await record({
    id: "a",
    payload: { url: "https://example.com/a" },
    outcome: OUTCOME.SENT,
    job: 1,
  });
  await record({
    id: "b",
    payload: { url: "https://example.com/b" },
    outcome: OUTCOME.SENT,
    job: 2,
  });
  await record({
    id: "c",
    payload: { url: "https://example.com/c" },
    outcome: OUTCOME.HELD,
  });

  // Held shares have no job identity yet; there is nothing to ask about.
  expect(pendingJobIds(await readHistory()).sort()).toEqual([1, 2]);

  await applyLedgerStates([
    { job_id: 1, state: "completed", failure_class: null, document_id: 970 },
    { job_id: 2, state: "running", failure_class: null, document_id: null },
  ]);
  const entries = await readHistory();
  const byJob = new Map(entries.map((entry) => [entry.job, entry]));
  expect(byJob.get(1).ledger).toEqual({
    state: "completed",
    failureClass: null,
    documentId: 970,
  });

  // A terminal job stops being asked about; one still moving does not.
  expect(pendingJobIds(entries)).toEqual([2]);

  // An id the ingress does not report leaves its entry untouched.
  await applyLedgerStates([
    { job_id: 2, state: "completed", failure_class: null, document_id: 971 },
  ]);
  expect((await readHistory()).find((e) => e.job === 1).ledger.documentId).toBe(
    970,
  );
});

test("the ledger outranks the client's memory of delivery", async () => {
  const sent = {
    id: "x",
    url: "https://example.com/x",
    title: "X",
    text: null,
    outcome: OUTCOME.SENT,
    job: 7,
    message: null,
    ledger: null,
  };
  expect(statusFor(sent)).toMatchObject({ label: "Sent", tone: "sent" });

  expect(
    statusFor({
      ...sent,
      ledger: { state: "completed", failureClass: null, documentId: 970 },
    }),
  ).toMatchObject({ label: "Indexed", detail: "Document 970." });

  // A job in failed with a failure class is stranded — the ledger's word.
  expect(
    statusFor({
      ...sent,
      ledger: { state: "failed", failureClass: "permanent", documentId: null },
    }),
  ).toMatchObject({ label: "Stranded", tone: "problem" });

  expect(
    statusFor({
      ...sent,
      ledger: { state: "running", failureClass: null, documentId: null },
    }),
  ).toMatchObject({ label: "Indexing", tone: "working" });
});

test("a held share never reads as saved", async () => {
  const status = statusFor({
    id: "h",
    url: "https://example.com/h",
    title: null,
    text: null,
    outcome: OUTCOME.HELD,
    job: null,
    message: "Cannot reach Agentbrain.",
    ledger: null,
  });
  expect(status.label).toBe("Held");
  expect(status.detail).toBe("Cannot reach Agentbrain.");
  for (const word of ["saved", "queued", "accepted", "indexed"]) {
    expect(`${status.label} ${status.detail}`.toLowerCase()).not.toContain(
      word,
    );
  }
});

test("an entry names itself by title, then URL, then text", () => {
  expect(labelFor({ title: "A post", url: "https://example.com/p" })).toBe(
    "A post",
  );
  expect(labelFor({ title: null, url: "https://example.com/p" })).toBe(
    "https://example.com/p",
  );
  expect(
    labelFor({ title: null, url: null, text: "a note worth keeping" }),
  ).toBe("a note worth keeping");
  expect(hostFor({ url: "https://example.com/p" })).toBe("example.com");
  expect(hostFor({ url: null })).toBe("text note");
});
