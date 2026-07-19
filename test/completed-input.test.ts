import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

test("retired completed-link adapter source files are absent", () => {
  expect(existsSync(join(REPO, "src/research-ingest-link.ts"))).toBe(false);
  expect(existsSync(join(REPO, "src/completed-link-input.ts"))).toBe(false);
});

test("the package exposes only the durable Agentbrain executable", async () => {
  const pkg = await Bun.file(join(REPO, "package.json")).json();
  expect(pkg.bin).toEqual({ agentbrain: "src/cli.ts" });
});

test("extraction fanout helpers cannot write indexed resources directly", () => {
  const implementation = readFileSync(join(REPO, "src/link-ingest.ts"), "utf8");
  expect(implementation).toContain("planQueuedUrlFanout");
  expect(implementation).not.toContain("ResearchStore");
  expect(implementation).not.toContain("upsertDocument");
  expect(implementation).not.toContain("CompletedLinkPayload");
});
