import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src", "cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-share-cli-"));
  tempDirs.push(dir);
  return dir;
}

function runCli(args: string[], dbPath?: string) {
  const proc = Bun.spawnSync(
    ["bun", "run", CLI, ...(dbPath ? ["--db", dbPath] : []), ...args],
    { cwd: REPO, env: { ...process.env, AGENTBRAIN_SHARE_TOKEN: "" } },
  );
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

test("share token init writes an owner-only token and refuses silent rotation", () => {
  const dir = workspace();
  const tokenFile = join(dir, "share-token");

  const created = runCli([
    "--json",
    "share",
    "token",
    "init",
    "--token-file",
    tokenFile,
  ]);
  expect(created.exitCode).toBe(0);
  const body = JSON.parse(created.stdout) as {
    ok: boolean;
    data: { token: string; token_file: string };
  };
  expect(body.ok).toBe(true);
  expect(body.data.token.length).toBeGreaterThanOrEqual(32);
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600);

  // A second init must not silently replace a token every device already holds.
  const again = runCli([
    "--json",
    "share",
    "token",
    "init",
    "--token-file",
    tokenFile,
  ]);
  expect(again.exitCode).toBe(2);
  expect(JSON.parse(again.stdout)).toMatchObject({
    ok: false,
    error: { code: "share_token_exists" },
  });

  const rotated = runCli([
    "--json",
    "share",
    "token",
    "init",
    "--force",
    "--token-file",
    tokenFile,
  ]);
  expect(rotated.exitCode).toBe(0);
  expect(
    (JSON.parse(rotated.stdout) as { data: { token: string } }).data.token,
  ).not.toBe(body.data.token);
});

test("share token show requires an explicit reveal", () => {
  const dir = workspace();
  const tokenFile = join(dir, "share-token");
  runCli(["--json", "share", "token", "init", "--token-file", tokenFile]);

  const hidden = runCli([
    "--json",
    "share",
    "token",
    "show",
    "--token-file",
    tokenFile,
  ]);
  expect(hidden.exitCode).toBe(2);
  expect(JSON.parse(hidden.stdout)).toMatchObject({
    ok: false,
    error: { code: "reveal_required" },
  });

  const revealed = runCli([
    "--json",
    "share",
    "token",
    "show",
    "--reveal",
    "--token-file",
    tokenFile,
  ]);
  expect(revealed.exitCode).toBe(0);
});

test("share serve refuses to bind every interface without an explicit opt-in", () => {
  const dir = workspace();
  const tokenFile = join(dir, "share-token");
  runCli(["--json", "share", "token", "init", "--token-file", tokenFile]);

  const refused = runCli(
    [
      "--json",
      "share",
      "serve",
      "--host",
      "0.0.0.0",
      "--token-file",
      tokenFile,
    ],
    join(dir, "research.db"),
  );
  expect(refused.exitCode).toBe(2);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    ok: false,
    error: { code: "share_bind_refused" },
  });
});

test("share serve reports a missing token instead of listening unauthenticated", () => {
  const dir = workspace();
  const result = runCli(
    ["--json", "share", "serve", "--token-file", join(dir, "absent")],
    join(dir, "research.db"),
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "share_token_missing" },
  });
});

test("unknown share subcommands are rejected", () => {
  const dir = workspace();
  const result = runCli(["--json", "share", "bogus"], join(dir, "research.db"));
  expect(result.exitCode).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    error: { code: "unknown_subcommand" },
  });
});

test("share appears on every public discovery surface", () => {
  const topHelp = runCli(["--help"]).stdout;
  expect(topHelp).toContain("share");

  const commandHelp = runCli(["share", "--help"]).stdout;
  expect(commandHelp).toContain("/v1/share");
  expect(commandHelp).toContain("Authorization: Bearer");
  // The bind default is a security property; it must be discoverable.
  expect(commandHelp).toContain("127.0.0.1");

  const guide = JSON.parse(runCli(["guide", "--json"]).stdout) as {
    data: {
      output_contract: { mutation_commands: string[] };
      commands: Record<string, string>;
    };
  };
  expect(guide.data.commands.share).toBeDefined();
  expect(guide.data.output_contract.mutation_commands).toContain("share serve");
});
