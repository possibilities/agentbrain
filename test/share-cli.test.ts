import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src", "cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Waits for a condition the serving process settles asynchronously. */
async function until(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await Bun.sleep(20);
  }
}

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

  // The group's help is the index; the serving contract lives on the leaf
  // that owns it, which is where the contract scopes it.
  const groupHelp = runCli(["share", "--help"]).stdout;
  expect(groupHelp).toContain("serve");
  expect(groupHelp).toContain("token");

  // Rendered help reflows to the terminal width, so match on normalized text.
  const commandHelp = runCli(["share", "serve", "--help"]).stdout.replace(
    /\s+/g,
    " ",
  );
  expect(commandHelp).toContain("/v1/share");
  expect(commandHelp).toContain("Authorization: Bearer");
  // The bind default is a security property; it must be discoverable.
  expect(commandHelp).toContain("127.0.0.1");
  // Precedence is a contract, exactly as --db/AGENTBRAIN_DB is.
  expect(commandHelp).toContain("--port, then PORT, then 8787");
  // The named URL must never read as a replacement for the device path.
  expect(commandHelp).toContain("--portless");
  expect(commandHelp).toContain("supplements the tailnet address");

  const guide = JSON.parse(runCli(["guide", "--json"]).stdout) as {
    data: {
      concepts: { read_only_commands: string[] };
      commands: Array<{ name: string; subcommands?: Array<{ name: string }> }>;
    };
  };
  const share = guide.data.commands.find((command) => command.name === "share");
  expect(share?.subcommands?.map((sub) => sub.name)).toEqual([
    "serve",
    "token",
  ]);
  // share serve mutates, so it must not be claimed as read-only.
  expect(guide.data.concepts.read_only_commands).not.toContain("share serve");
});

interface ServeEnvelope {
  ok: boolean;
  data: { port: number; port_source: string; url: string };
}

/**
 * Starts the ingress, reads the envelope it prints once it is listening, and
 * stops it. The command is long-lived by design, so the test cannot wait for
 * an exit the way every other one here does.
 */
async function serveAndStop(
  args: string[],
  env: Record<string, string>,
  dbPath: string,
): Promise<ServeEnvelope> {
  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      CLI,
      "--db",
      dbPath,
      "--json",
      "share",
      "serve",
      // Never let a test's ingress publish itself into the operator's real
      // state directory, and never let it probe the machine's own service.
      "--registration-file",
      join(dirname(dbPath), "share-ingress.json"),
      "--liveness-interval-ms",
      "0",
      ...args,
    ],
    {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENTBRAIN_SHARE_TOKEN: "", ...env },
    },
  );
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      try {
        return JSON.parse(buffer) as ServeEnvelope;
      } catch {
        // The envelope is pretty-printed over several chunks; keep reading.
      }
    }
    throw new Error(`share serve printed no envelope: ${buffer}`);
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
  }
}

test("share serve binds PORT when no --port is given, and says where it came from", async () => {
  const dir = workspace();
  const tokenFile = join(dir, "share-token");
  const dbPath = join(dir, "research.db");
  runCli(["--json", "share", "token", "init", "--token-file", tokenFile]);

  // PORT is the hook a port-allocating supervisor uses; nothing else changes.
  const fromEnv = await serveAndStop(
    ["--token-file", tokenFile],
    { PORT: "45237" },
    dbPath,
  );
  expect(fromEnv.ok).toBe(true);
  expect(fromEnv.data.port).toBe(45_237);
  expect(fromEnv.data.port_source).toBe("env:PORT");
  expect(fromEnv.data.url).toBe("http://127.0.0.1:45237");

  // The explicit flag stays highest precedence even with PORT present.
  const fromFlag = await serveAndStop(
    ["--token-file", tokenFile, "--port", "45238"],
    { PORT: "45237" },
    dbPath,
  );
  expect(fromFlag.data.port).toBe(45_238);
  expect(fromFlag.data.port_source).toBe("flag");
});

test("serving registers the ingress and withdraws it on shutdown", async () => {
  const dir = workspace();
  const tokenFile = join(dir, "share-token");
  const dbPath = join(dir, "research.db");
  const registrationFile = join(dir, "share-ingress.json");
  runCli(["--json", "share", "token", "init", "--token-file", tokenFile]);

  const proc = Bun.spawn(
    [
      process.execPath,
      "run",
      CLI,
      "--db",
      dbPath,
      "--json",
      "share",
      "serve",
      "--token-file",
      tokenFile,
      "--port",
      "45239",
      "--registration-file",
      registrationFile,
      "--liveness-interval-ms",
      "0",
    ],
    {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, AGENTBRAIN_SHARE_TOKEN: "" },
    },
  );
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      try {
        JSON.parse(buffer);
        break;
      } catch {
        // Keep reading; the envelope is pretty-printed over several chunks.
      }
    }
    // The registration is what tells a later doctor that an ingress is
    // supposed to be answering, so it must exist while one is.
    await until(() => existsSync(registrationFile));
    const published = JSON.parse(
      readFileSync(registrationFile, "utf8"),
    ) as Record<string, unknown>;
    expect(published).toMatchObject({
      url: "http://127.0.0.1:45239",
      port: 45_239,
      pid: proc.pid,
    });
  } finally {
    proc.kill("SIGTERM");
    await proc.exited;
  }

  // A clean shutdown leaves no claim behind; a stale one would make doctor
  // report a dropped ingress that nobody asked for.
  await until(() => !existsSync(registrationFile));
  expect(existsSync(registrationFile)).toBe(false);
});

test("a malformed PORT is refused rather than quietly binding the default", async () => {
  const dir = workspace();
  const tokenFile = join(dir, "share-token");
  runCli(["--json", "share", "token", "init", "--token-file", tokenFile]);

  // Binding 8787 here would leave a supervisor proxying a socket nothing is
  // listening on. The unbound default itself is covered in share.test.ts;
  // this asserts only that a broken PORT never reaches a listener.
  const proc = Bun.spawnSync(
    [
      process.execPath,
      "run",
      CLI,
      "--db",
      join(dir, "research.db"),
      "--json",
      "share",
      "serve",
      "--token-file",
      tokenFile,
    ],
    {
      cwd: REPO,
      env: { ...process.env, AGENTBRAIN_SHARE_TOKEN: "", PORT: "http" },
    },
  );
  expect(proc.exitCode).toBe(2);
  expect(JSON.parse(new TextDecoder().decode(proc.stdout))).toMatchObject({
    ok: false,
    error: { code: "bad_port" },
  });
});
