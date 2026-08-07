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
import {
  defaultNotifyStatePath,
  notifyOperator,
  notifyStranded,
} from "../src/notify";

const roots: string[] = [];
const originalPath = process.env.PATH;
const T0 = new Date("2026-08-07T00:00:00.000Z");

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentbrain-notify-"));
  roots.push(root);
  mkdirSync(join(root, "bin"), { recursive: true });
  return root;
}

/** Install a fake notifier that records the arguments it was posted. */
function stubNotifier(root: string, name: string): string {
  const bin = join(root, "bin");
  const log = join(root, `${name}.log`);
  writeFileSync(
    join(bin, name),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\n`,
    { mode: 0o755 },
  );
  chmodSync(join(bin, name), 0o755);
  return log;
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("state path lives under the operator's state directory", () => {
  expect(defaultNotifyStatePath("/home/example")).toBe(
    "/home/example/.local/state/agentbrain/doctor-notify.json",
  );
});

test("a missing notifier is not an error", () => {
  const root = makeRoot();
  process.env.PATH = join(root, "empty");
  expect(notifyOperator({ title: "t", message: "m" })).toBeNull();
});

test("funk-notify is preferred and receives the click-through command", () => {
  const root = makeRoot();
  const funkLog = stubNotifier(root, "funk-notify");
  stubNotifier(root, "terminal-notifier");
  process.env.PATH = join(root, "bin");

  const used = notifyOperator({
    title: "Agentbrain",
    message: "stranded",
    group: "agentbrain.doctor",
    terminal: "agentbrain jobs list --state blocked",
  });

  expect(used).not.toBeNull();
  const args = readFileSync(funkLog, "utf8");
  expect(args).toContain("--title");
  expect(args).toContain("--group");
  expect(args).toContain("agentbrain jobs list --state blocked");
});

test("terminal-notifier is used when funk-notify is absent", () => {
  const root = makeRoot();
  const log = stubNotifier(root, "terminal-notifier");
  process.env.PATH = join(root, "bin");

  expect(notifyOperator({ title: "t", message: "m" })).not.toBeNull();
  expect(readFileSync(log, "utf8")).toContain("-ignoreDnD");
});

test("a first stranded job notifies and records the count", () => {
  const root = makeRoot();
  stubNotifier(root, "funk-notify");
  process.env.PATH = join(root, "bin");
  const statePath = join(root, "state.json");

  const result = notifyStranded(3, { statePath, now: T0 });
  expect(result.notified).toBe(true);
  expect(result.reason).toBe("increased");
  expect(result.previous).toBeNull();
  expect(JSON.parse(readFileSync(statePath, "utf8")).stranded).toBe(3);
});

test("an unchanged backlog does not notify again", () => {
  const root = makeRoot();
  stubNotifier(root, "funk-notify");
  process.env.PATH = join(root, "bin");
  const statePath = join(root, "state.json");

  notifyStranded(3, { statePath, now: T0 });
  const second = notifyStranded(3, { statePath, now: T0 });
  expect(second.notified).toBe(false);
  expect(second.reason).toBe("unchanged");
});

test("growth past the recorded count notifies again", () => {
  const root = makeRoot();
  stubNotifier(root, "funk-notify");
  process.env.PATH = join(root, "bin");
  const statePath = join(root, "state.json");

  notifyStranded(3, { statePath, now: T0 });
  const grown = notifyStranded(4, { statePath, now: T0 });
  expect(grown.notified).toBe(true);
  expect(grown.previous).toBe(3);
});

test("clearing the backlog resets the baseline silently", () => {
  const root = makeRoot();
  stubNotifier(root, "funk-notify");
  process.env.PATH = join(root, "bin");
  const statePath = join(root, "state.json");

  notifyStranded(3, { statePath, now: T0 });
  const cleared = notifyStranded(0, { statePath, now: T0 });
  expect(cleared.notified).toBe(false);
  expect(cleared.reason).toBe("cleared");
  expect(JSON.parse(readFileSync(statePath, "utf8")).stranded).toBe(0);

  // After recovery the next failure is news again.
  const again = notifyStranded(1, { statePath, now: T0 });
  expect(again.notified).toBe(true);
});

test("no notifier means no recorded baseline, so the signal is not lost", () => {
  const root = makeRoot();
  process.env.PATH = join(root, "empty");
  const statePath = join(root, "state.json");

  const result = notifyStranded(2, { statePath, now: T0 });
  expect(result.notified).toBe(false);
  expect(result.reason).toBe("no_notifier");
  expect(existsSync(statePath)).toBe(false);
});
