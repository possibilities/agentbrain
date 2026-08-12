import { afterEach, expect, test } from "bun:test";
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
  PORTLESS_BASE_NAME,
  PORTLESS_NAME_ENV,
  portlessArgv,
  shareNameFor,
  worktreeIdentity,
} from "../src/portless";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src", "cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-portless-"));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(proc.stderr)}`,
    );
  }
}

/** A main checkout with two linked worktrees, as an ADE may lay them out. */
function checkoutWithWorktrees(): {
  main: string;
  first: string;
  second: string;
} {
  const dir = workspace();
  const main = join(dir, "agentbrain");
  mkdirSync(main, { recursive: true });
  git(main, "init");
  writeFileSync(join(main, "README.md"), "seed\n");
  git(main, "add", "README.md");
  git(main, "commit", "-m", "seed");
  const first = join(dir, "add-portless-aaa111");
  const second = join(dir, "add-portless-bbb222");
  git(main, "worktree", "add", "-b", "topic-one", first);
  git(main, "worktree", "add", "-b", "topic-two", second);
  return { main, first, second };
}

function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([process.execPath, "run", CLI, ...args], {
    cwd: REPO,
    env: { ...process.env, AGENTBRAIN_SHARE_TOKEN: "", ...env },
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

test("a main checkout keeps the bare name and a worktree gets its own label", () => {
  const { main, first } = checkoutWithWorktrees();

  expect(shareNameFor(main, {})).toBe(PORTLESS_BASE_NAME);
  expect(shareNameFor(first, {})).toBe(
    `${worktreeIdentity(first)}.${PORTLESS_BASE_NAME}`,
  );
});

test("a worktree's name survives branch renames and a detached HEAD", () => {
  const { first } = checkoutWithWorktrees();
  const onTopicBranch = shareNameFor(first, {});

  git(first, "checkout", "-b", "renamed-entirely");
  expect(shareNameFor(first, {})).toBe(onTopicBranch);

  // The case Portless's own `run --name` prefix cannot serve: managed
  // worktrees may be detached, and a branch-derived name is withheld entirely.
  git(first, "checkout", "--detach");
  expect(shareNameFor(first, {})).toBe(onTopicBranch);
});

test("sibling worktrees never collide, even sharing a directory name", () => {
  const { main, first, second } = checkoutWithWorktrees();

  const names = new Set([
    shareNameFor(main, {}),
    shareNameFor(first, {}),
    shareNameFor(second, {}),
  ]);
  expect(names.size).toBe(3);

  // Two checkouts named identically under different parents still differ,
  // because the identity hashes the absolute path rather than the basename.
  expect(worktreeIdentity("/one/agentbrain")).not.toBe(
    worktreeIdentity("/two/agentbrain"),
  );
});

test("the name is a usable DNS label and can be overridden outright", () => {
  const dir = workspace();
  const awkward = join(dir, "Feature Branch!!");
  mkdirSync(awkward, { recursive: true });

  expect(worktreeIdentity(awkward)).toMatch(/^[a-z0-9-]+$/);
  expect(shareNameFor(awkward, {})).toMatch(
    new RegExp(`^[a-z0-9-]+\\.${PORTLESS_BASE_NAME}$`),
  );

  // Two clones (as opposed to two worktrees) are both main checkouts; the
  // override is how the second one gets a name of its own.
  expect(shareNameFor(awkward, { [PORTLESS_NAME_ENV]: "chosen" })).toBe(
    "chosen",
  );
});

test("the launcher uses direct named mode, not the branch-prefixed run mode", () => {
  expect(portlessArgv("agentbrain-share", ["bun", "run", "cli.ts"])).toEqual([
    "--name",
    "agentbrain-share",
    "--",
    "bun",
    "run",
    "cli.ts",
  ]);
});

test("share serve --portless execs portless with the name and the full command", () => {
  const dir = workspace();
  const stubDir = join(dir, "bin");
  const record = join(dir, "argv.txt");
  mkdirSync(stubDir, { recursive: true });
  const stub = join(stubDir, "portless");
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\nexit 0\n`,
  );
  chmodSync(stub, 0o755);

  const dbPath = join(dir, "research.db");
  const result = runCli(
    ["--db", dbPath, "--json", "share", "serve", "--portless"],
    {
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      AGENTBRAIN_PORTLESS_NAME: "",
    },
  );
  expect(result.exitCode).toBe(0);

  const lines = readFileSync(record, "utf8").trimEnd().split("\n");
  expect(lines.slice(0, 3)).toEqual(["--name", shareNameFor(REPO, {}), "--"]);
  // The globals were parsed before `share` was dispatched, so the re-exec has
  // to carry them or the child would open a different database.
  expect(lines.slice(3)).toEqual([
    process.execPath,
    "run",
    CLI,
    "--db",
    dbPath,
    "--json",
    "share",
    "serve",
  ]);
});

test("a missing portless is reported rather than silently serving unnamed", () => {
  const dir = workspace();
  const emptyBin = join(dir, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });

  const result = runCli(
    [
      "--db",
      join(dir, "research.db"),
      "--json",
      "share",
      "serve",
      "--portless",
    ],
    { PATH: emptyBin },
  );
  expect(result.exitCode).toBe(1);
  const body = JSON.parse(result.stdout) as {
    ok: boolean;
    error: { code: string; recovery?: string };
  };
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe("portless_unavailable");
  // Truthful about what is missing, and about what still works without it.
  expect(body.error.recovery).toContain("npm i -g portless");
  expect(body.error.recovery).toContain("agentbrain share serve");
});

test("--portless refuses the combinations that would serve nothing", () => {
  const dir = workspace();
  const dbPath = join(dir, "research.db");

  const withPort = runCli([
    "--db",
    dbPath,
    "--json",
    "share",
    "serve",
    "--portless",
    "--port",
    "9123",
  ]);
  expect(withPort.exitCode).toBe(2);
  expect(JSON.parse(withPort.stdout)).toMatchObject({
    ok: false,
    error: { code: "portless_port_conflict" },
  });

  // The tailnet path is the phone's; a `.localhost` name cannot stand in for it.
  const withTailnetHost = runCli([
    "--db",
    dbPath,
    "--json",
    "share",
    "serve",
    "--portless",
    "--host",
    "100.101.102.103",
  ]);
  expect(withTailnetHost.exitCode).toBe(2);
  expect(JSON.parse(withTailnetHost.stdout)).toMatchObject({
    ok: false,
    error: { code: "portless_host_conflict" },
  });
});
