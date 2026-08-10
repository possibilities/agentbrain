import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const REPO = realpathSync(join(import.meta.dir, ".."));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  dir: string;
  home: string;
  bin: string;
  launchAgents: string;
  state: string;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-install-"));
  dirs.push(dir);
  const home = join(dir, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  return {
    dir,
    home,
    bin,
    launchAgents: join(home, "Library", "LaunchAgents"),
    state: join(home, ".local", "state", "agentbrain"),
  };
}

function runInstaller(
  fixture: Fixture,
  action?: "--install" | "--uninstall" | "--help",
  extraEnv: Record<string, string> = {},
  repo: string = REPO,
) {
  return Bun.spawnSync({
    cmd: ["bash", "scripts/install.sh", ...(action ? [action] : [])],
    cwd: repo,
    env: {
      ...process.env,
      HOME: fixture.home,
      AGENTBRAIN_INSTALL_BIN_DIR: fixture.bin,
      AGENTBRAIN_INSTALL_LAUNCH_AGENTS_DIR: fixture.launchAgents,
      AGENTBRAIN_INSTALL_STATE_DIR: fixture.state,
      AGENTBRAIN_INSTALL_LAUNCHCTL: "none",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function decode(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function gitOutput(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repo, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, decode(result.stderr)).toBe(0);
  return decode(result.stdout).trim();
}

function setupManagedCheckouts(fixture: Fixture) {
  const currentSha = gitOutput(REPO, "rev-parse", "HEAD");
  const targetRoot = join(fixture.dir, "checkouts", "agentbrain");
  const currentCheckout = join(targetRoot, currentSha);
  const previousStaging = join(targetRoot, "previous-staging");
  mkdirSync(targetRoot, { recursive: true });

  for (const checkout of [currentCheckout, previousStaging]) {
    const cloned = Bun.spawnSync({
      cmd: ["git", "clone", "--quiet", REPO, checkout],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(cloned.exitCode, decode(cloned.stderr)).toBe(0);
  }
  gitOutput(
    previousStaging,
    "config",
    "user.name",
    "Agentbrain Installer Test",
  );
  gitOutput(previousStaging, "config", "user.email", "installer-test@invalid");
  gitOutput(
    previousStaging,
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "test previous deployment",
  );
  const previousSha = gitOutput(previousStaging, "rev-parse", "HEAD");
  const previousCheckout = join(targetRoot, previousSha);
  renameSync(previousStaging, previousCheckout);
  copyFileSync(
    join(REPO, "scripts", "install.sh"),
    join(currentCheckout, "scripts", "install.sh"),
  );

  return {
    currentCheckout,
    currentSha,
    previousSha,
    previousSource: join(previousCheckout, "src", "cli.ts"),
  };
}

test("installer ignores pre-namespace files and refuses an unsafe data root", () => {
  const stray = setup();
  const strayPath = join(
    stray.home,
    ".hermes",
    "research-cache",
    "research.db",
  );
  mkdirSync(dirname(strayPath), { recursive: true });
  writeFileSync(strayPath, "stray");
  const installed = runInstaller(stray);
  expect(installed.exitCode, decode(installed.stderr)).toBe(0);
  expect(existsSync(join(stray.bin, "agentbrain"))).toBeTrue();

  const symlinked = setup();
  const share = join(symlinked.home, ".local", "share");
  const realData = join(symlinked.home, "real-agentbrain-data");
  mkdirSync(share, { recursive: true });
  mkdirSync(realData);
  symlinkSync(realData, join(share, "agentbrain"));
  const refusedSymlink = runInstaller(symlinked);
  expect(refusedSymlink.exitCode).not.toBe(0);
  expect(decode(refusedSymlink.stderr)).toContain(
    "refusing non-directory or symlinked Agentbrain data root",
  );
}, 15_000);

test("installer repairs namespaced database permissions", () => {
  const fixture = setup();
  const data = join(fixture.home, ".local", "share", "agentbrain");
  const db = join(data, "research.db");
  mkdirSync(data, { recursive: true, mode: 0o755 });
  writeFileSync(db, "existing");
  chmodSync(data, 0o755);
  chmodSync(db, 0o644);

  expect(runInstaller(fixture).exitCode).toBe(0);
  expect(mode(data)).toBe(0o700);
  expect(mode(db)).toBe(0o600);
}, 15_000);

test("an old-checkout Agentbrain link is foreign: refused, never adopted", () => {
  const fixture = setup();
  const oldSource = join(fixture.dir, "old-checkout", "src", "cli.ts");
  mkdirSync(dirname(oldSource), { recursive: true });
  writeFileSync(oldSource, "#!/usr/bin/env bun\n");
  symlinkSync(oldSource, join(fixture.bin, "agentbrain"));

  const refused = runInstaller(fixture, "--install");
  expect(refused.exitCode).not.toBe(0);
  expect(decode(refused.stderr)).toContain(
    "refusing to overwrite unrelated symlink",
  );
  expect(readlinkSync(join(fixture.bin, "agentbrain"))).toBe(oldSource);
  expect(existsSync(fixture.launchAgents)).toBe(false);
}, 15_000);

test("installer upgrades only a receipt-matched managed checkout link", () => {
  const fixture = setup();
  const managed = setupManagedCheckouts(fixture);
  mkdirSync(fixture.state, { recursive: true });
  const receipt = join(fixture.state, "deployed-sha");
  writeFileSync(receipt, `${managed.previousSha}\n`, { mode: 0o600 });
  const destination = join(fixture.bin, "agentbrain");
  symlinkSync(managed.previousSource, destination);

  const installed = runInstaller(
    fixture,
    "--install",
    {},
    managed.currentCheckout,
  );
  expect(installed.exitCode, decode(installed.stderr)).toBe(0);
  expect(readlinkSync(destination)).toBe(
    join(realpathSync(managed.currentCheckout), "src", "cli.ts"),
  );

  rmSync(destination);
  symlinkSync(managed.previousSource, destination);
  writeFileSync(receipt, `${managed.currentSha}\n`, { mode: 0o600 });
  const refused = runInstaller(
    fixture,
    "--install",
    {},
    managed.currentCheckout,
  );
  expect(refused.exitCode).not.toBe(0);
  expect(decode(refused.stderr)).toContain(
    "refusing to overwrite unrelated symlink",
  );
  expect(readlinkSync(destination)).toBe(managed.previousSource);
}, 30_000);

test("installer resolves frozen dependencies before switching the runtime link", () => {
  const fixture = setup();
  const managed = setupManagedCheckouts(fixture);
  mkdirSync(fixture.state, { recursive: true });
  writeFileSync(
    join(fixture.state, "deployed-sha"),
    `${managed.previousSha}\n`,
    {
      mode: 0o600,
    },
  );
  const destination = join(fixture.bin, "agentbrain");
  symlinkSync(managed.previousSource, destination);

  const realBun = Bun.which("bun");
  if (realBun === null) throw new Error("bun is required for installer tests");
  const wrapperDir = join(fixture.dir, "wrapped-bin");
  const wrapper = join(wrapperDir, "bun");
  const installLog = join(fixture.dir, "bun-install.args");
  const linkAtInstall = join(fixture.dir, "link-at-install");
  mkdirSync(wrapperDir);
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == install ]]; then
  printf '%s\\n' "$*" > "$AGENTBRAIN_TEST_INSTALL_LOG"
  readlink "$AGENTBRAIN_TEST_COMMAND_LINK" > "$AGENTBRAIN_TEST_LINK_AT_INSTALL"
fi
exec "$AGENTBRAIN_TEST_REAL_BUN" "$@"
`,
  );
  chmodSync(wrapper, 0o700);

  const installed = runInstaller(
    fixture,
    "--install",
    {
      AGENTBRAIN_TEST_COMMAND_LINK: destination,
      AGENTBRAIN_TEST_INSTALL_LOG: installLog,
      AGENTBRAIN_TEST_LINK_AT_INSTALL: linkAtInstall,
      AGENTBRAIN_TEST_REAL_BUN: realBun,
      PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
    },
    managed.currentCheckout,
  );
  expect(installed.exitCode, decode(installed.stderr)).toBe(0);
  expect(readFileSync(installLog, "utf8").trim()).toBe(
    "install --frozen-lockfile",
  );
  expect(readFileSync(linkAtInstall, "utf8").trim()).toBe(
    managed.previousSource,
  );
  expect(readlinkSync(destination)).toBe(
    join(realpathSync(managed.currentCheckout), "src", "cli.ts"),
  );
}, 15_000);

test("installer never touches a research-ingest-link, owned-looking or foreign", () => {
  // A link that once pointed at the retired adapter is not the installer's
  // business anymore: no adoption, no cleanup, no migration path.
  const linked = setup();
  const target = relative(
    linked.bin,
    join(REPO, "src/research-ingest-link.ts"),
  );
  const link = join(linked.bin, "research-ingest-link");
  symlinkSync(target, link);
  expect(runInstaller(linked).exitCode).toBe(0);
  expect(readlinkSync(link)).toBe(target);
  expect(runInstaller(linked, "--uninstall").exitCode).toBe(0);
  expect(readlinkSync(link)).toBe(target);

  const unrelated = setup();
  const foreign = join(unrelated.bin, "research-ingest-link");
  writeFileSync(foreign, "foreign command");
  expect(runInstaller(unrelated).exitCode).toBe(0);
  expect(readFileSync(foreign, "utf8")).toBe("foreign command");
  expect(runInstaller(unrelated, "--uninstall").exitCode).toBe(0);
  expect(readFileSync(foreign, "utf8")).toBe("foreign command");
}, 15_000);

test("installer refuses foreign active commands without partial takeover", () => {
  const regular = setup();
  writeFileSync(join(regular.bin, "agentbrain"), "foreign command");
  const refusedRegular = runInstaller(regular);
  expect(refusedRegular.exitCode).not.toBe(0);
  expect(decode(refusedRegular.stderr)).toContain(
    "refusing to overwrite non-symlink",
  );
  expect(existsSync(regular.launchAgents)).toBe(false);

  const unrelated = setup();
  symlinkSync("../dangling/agentbrain", join(unrelated.bin, "agentbrain"));
  const refusedLink = runInstaller(unrelated);
  expect(refusedLink.exitCode).not.toBe(0);
  expect(decode(refusedLink.stderr)).toContain(
    "refusing to overwrite unrelated symlink",
  );

  const installed = setup();
  expect(runInstaller(installed).exitCode).toBe(0);
  rmSync(join(installed.bin, "agentbrain"));
  symlinkSync("../foreign/agentbrain", join(installed.bin, "agentbrain"));
  const foreignBinary = join(installed.bin, "research-ingest-link");
  writeFileSync(foreignBinary, "unrelated local binary");
  const refusedRemoval = runInstaller(installed, "--uninstall");
  expect(refusedRemoval.exitCode).not.toBe(0);
  expect(decode(refusedRemoval.stderr)).toContain(
    "refusing to remove foreign command",
  );
  expect(readFileSync(foreignBinary, "utf8")).toBe("unrelated local binary");
}, 15_000);

test("installed worker drains an offline text job in a temporary database", () => {
  const fixture = setup();
  expect(runInstaller(fixture).exitCode).toBe(0);
  const command = join(fixture.bin, "agentbrain");
  const db = join(fixture.dir, "smoke", "research.db");
  const env = {
    ...process.env,
    HOME: fixture.home,
    XDG_DATA_HOME: join(fixture.home, ".local", "share"),
  };
  const submit = Bun.spawnSync({
    cmd: [
      command,
      "--db",
      db,
      "--json",
      "submit",
      "offline worker smoke",
      "--kind",
      "text",
    ],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(decode(submit.stderr)).toBe("");
  expect(submit.exitCode).toBe(0);

  const worker = Bun.spawnSync({
    cmd: [command, "--db", db, "--json", "worker", "--once"],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(decode(worker.stderr)).toBe("");
  expect(worker.exitCode).toBe(0);
  const output = JSON.parse(decode(worker.stdout));
  expect(output.data.claimed).toBe(1);
  expect(output.data.completed).toBe(1);
  expect(output.data.failed).toBe(0);
}, 15_000);

test("installer help states queue ownership and defers recurring sources", () => {
  const fixture = setup();
  const help = runInstaller(fixture, "--help");
  expect(help.exitCode).toBe(0);
  const output = decode(help.stdout);
  expect(output).toContain("Agentbrain owns the durable SQLite");
  expect(output).toContain(
    "does not create or enable recurring remote sources",
  );
  expect(output).toContain("~/.local/share/agentbrain/research.db");
});
