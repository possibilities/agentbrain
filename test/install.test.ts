import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

function plistProgramArguments(plist: string): string[] {
  const block = plist.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  )?.[1];
  if (block === undefined) throw new Error("missing ProgramArguments");
  return [...block.matchAll(/<string>(.*?)<\/string>/g)].map(
    (match) => match[1],
  );
}

test("installer renders one private owned worker service idempotently", () => {
  const fixture = setup();
  expect(runInstaller(fixture).exitCode).toBe(0);

  expect(readlinkSync(join(fixture.bin, "agentbrain"))).toBe(
    join(REPO, "src/cli.ts"),
  );
  expect(existsSync(join(fixture.bin, "research-ingest-link"))).toBe(false);
  expect(readdirSync(fixture.launchAgents).sort()).toEqual([
    "agentbrain.doctor.plist",
    "agentbrain.worker.plist",
  ]);

  const service = join(fixture.launchAgents, "agentbrain.worker.plist");
  const log = join(fixture.state, "worker.log");
  const data = join(fixture.home, ".local", "share", "agentbrain");
  const plist = readFileSync(service, "utf8");
  expect(plist).toContain("agentbrain-installer-owned: agentbrain.worker.v1");
  expect(plist).toContain("<string>agentbrain.worker</string>");
  expect(plist).toContain(`<string>${fixture.home}</string>`);
  expect(plist).toContain(`<string>${log}</string>`);
  expect(plist).toContain("<key>Umask</key>\n\t<integer>63</integer>");
  expect(plistProgramArguments(plist)).toEqual([
    join(fixture.bin, "agentbrain"),
    "worker",
  ]);
  expect(plist).not.toContain("__AGENTBRAIN_");
  expect(mode(fixture.state)).toBe(0o700);
  expect(mode(data)).toBe(0o700);
  expect(mode(log)).toBe(0o600);
  expect(mode(service)).toBe(0o600);
  expect(existsSync(join(fixture.state, "deployed-sha"))).toBe(false);

  const plutil = Bun.which("plutil");
  if (plutil !== null) {
    expect(
      Bun.spawnSync({ cmd: [plutil, "-lint", service], stdout: "pipe" })
        .exitCode,
    ).toBe(0);
  }

  expect(runInstaller(fixture, "--install").exitCode).toBe(0);
  expect(readdirSync(fixture.launchAgents).sort()).toEqual([
    "agentbrain.doctor.plist",
    "agentbrain.worker.plist",
  ]);
  expect(mode(fixture.state)).toBe(0o700);
  expect(mode(data)).toBe(0o700);
  expect(mode(log)).toBe(0o600);
}, 15_000);

test("installer refuses unmigrated and conflicting legacy database state", () => {
  const unmigrated = setup();
  const unmigratedPath = join(
    unmigrated.home,
    ".hermes",
    "research-cache",
    "research.db",
  );
  mkdirSync(dirname(unmigratedPath), { recursive: true });
  writeFileSync(unmigratedPath, "legacy");
  const refusedUnmigrated = runInstaller(unmigrated);
  expect(refusedUnmigrated.exitCode).not.toBe(0);
  expect(decode(refusedUnmigrated.stderr)).toContain(
    "legacy Agentbrain database requires migration",
  );
  expect(existsSync(join(unmigrated.bin, "agentbrain"))).toBeFalse();

  const conflicting = setup();
  const legacyPath = join(
    conflicting.home,
    ".hermes",
    "research-cache",
    "research.db",
  );
  const targetPath = join(
    conflicting.home,
    ".local",
    "share",
    "agentbrain",
    "research.db",
  );
  mkdirSync(dirname(legacyPath), { recursive: true });
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(legacyPath, "legacy");
  writeFileSync(targetPath, "target");
  const refusedConflict = runInstaller(conflicting);
  expect(refusedConflict.exitCode).not.toBe(0);
  expect(decode(refusedConflict.stderr)).toContain(
    "refusing conflicting legacy and Agentbrain databases",
  );

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

test("installer replaces only the explicitly known legacy Agentbrain link", () => {
  const fixture = setup();
  const legacySource = join(fixture.dir, "legacy-checkout", "src", "cli.ts");
  mkdirSync(dirname(legacySource), { recursive: true });
  writeFileSync(legacySource, "#!/usr/bin/env bun\n");
  symlinkSync(legacySource, join(fixture.bin, "agentbrain"));

  const installed = runInstaller(fixture, "--install", {
    AGENTBRAIN_INSTALL_LEGACY_SOURCE: legacySource,
  });
  expect(installed.exitCode, decode(installed.stderr)).toBe(0);
  expect(readlinkSync(join(fixture.bin, "agentbrain"))).toBe(
    join(REPO, "src/cli.ts"),
  );
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

test("legacy migration allowlist still refuses an unrelated Agentbrain link", () => {
  const fixture = setup();
  const legacySource = join(fixture.dir, "legacy-checkout", "src", "cli.ts");
  const unrelatedSource = join(fixture.dir, "unrelated", "cli.ts");
  mkdirSync(dirname(legacySource), { recursive: true });
  mkdirSync(dirname(unrelatedSource), { recursive: true });
  writeFileSync(legacySource, "legacy");
  writeFileSync(unrelatedSource, "unrelated");
  const destination = join(fixture.bin, "agentbrain");
  symlinkSync(unrelatedSource, destination);

  const refused = runInstaller(fixture, "--install", {
    AGENTBRAIN_INSTALL_LEGACY_SOURCE: legacySource,
  });
  expect(refused.exitCode).not.toBe(0);
  expect(decode(refused.stderr)).toContain(
    "refusing to overwrite unrelated symlink",
  );
  expect(readlinkSync(destination)).toBe(unrelatedSource);
  expect(existsSync(fixture.launchAgents)).toBe(false);
}, 15_000);

test("installer resolves frozen dependencies before switching the runtime link", () => {
  const fixture = setup();
  const legacySource = join(fixture.dir, "legacy-checkout", "src", "cli.ts");
  mkdirSync(dirname(legacySource), { recursive: true });
  writeFileSync(legacySource, "#!/usr/bin/env bun\n");
  const destination = join(fixture.bin, "agentbrain");
  symlinkSync(legacySource, destination);

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

  const installed = runInstaller(fixture, "--install", {
    AGENTBRAIN_INSTALL_LEGACY_SOURCE: legacySource,
    AGENTBRAIN_TEST_COMMAND_LINK: destination,
    AGENTBRAIN_TEST_INSTALL_LOG: installLog,
    AGENTBRAIN_TEST_LINK_AT_INSTALL: linkAtInstall,
    AGENTBRAIN_TEST_REAL_BUN: realBun,
    PATH: `${wrapperDir}:${process.env.PATH ?? ""}`,
  });
  expect(installed.exitCode, decode(installed.stderr)).toBe(0);
  expect(readFileSync(installLog, "utf8").trim()).toBe(
    "install --frozen-lockfile",
  );
  expect(readFileSync(linkAtInstall, "utf8").trim()).toBe(legacySource);
  expect(readlinkSync(destination)).toBe(join(REPO, "src/cli.ts"));
}, 15_000);

test("installer waits for stale service removal before load and uninstall is idempotent", () => {
  const fixture = setup();
  const launchctl = join(fixture.dir, "launchctl");
  const calls = join(fixture.dir, "launchctl.calls");
  const removalPending = join(fixture.dir, "launchctl.removal-pending");
  writeFileSync(
    launchctl,
    '#!/usr/bin/env bash\nif [[ "$1" == print ]]; then\n  if [[ -e "$AGENTBRAIN_TEST_REMOVAL_PENDING" ]]; then\n    rm -f "$AGENTBRAIN_TEST_REMOVAL_PENDING"\n    exit 1\n  fi\n  printf "program = %s\\n" "$AGENTBRAIN_TEST_PROGRAM"\n  exit 0\nfi\nif [[ "$1" == bootout ]]; then\n  touch "$AGENTBRAIN_TEST_REMOVAL_PENDING"\nelif [[ "$1" == bootstrap && -e "$AGENTBRAIN_TEST_REMOVAL_PENDING" ]]; then\n  exit 37\nfi\nprintf "%s\\n" "$*" >> "$AGENTBRAIN_TEST_LAUNCHCTL_LOG"\n',
  );
  chmodSync(launchctl, 0o700);
  const env = {
    AGENTBRAIN_INSTALL_LAUNCHCTL: launchctl,
    AGENTBRAIN_TEST_LAUNCHCTL_LOG: calls,
    AGENTBRAIN_TEST_PROGRAM: join(fixture.bin, "agentbrain"),
    AGENTBRAIN_TEST_REMOVAL_PENDING: removalPending,
  };

  expect(runInstaller(fixture, "--install", env).exitCode).toBe(0);
  expect(runInstaller(fixture, "--install", env).exitCode).toBe(0);
  expect(runInstaller(fixture, "--uninstall", env).exitCode).toBe(0);
  expect(runInstaller(fixture, "--uninstall", env).exitCode).toBe(0);

  const domain = `gui/${process.getuid?.() ?? 0}`;
  const sourceSha = decode(
    Bun.spawnSync({
      cmd: ["git", "-C", REPO, "rev-parse", "HEAD"],
      stdout: "pipe",
    }).stdout,
  ).trim();
  const receipt = join(fixture.state, "deployed-sha");
  expect(readFileSync(receipt, "utf8")).toBe(`${sourceSha}\n`);
  expect(mode(receipt)).toBe(0o600);
  // Each install reloads the worker and then the health reporter that watches
  // it; each uninstall withdraws the reporter first, so the worker is never the
  // only thing still running.
  expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
    `bootout ${domain}/agentbrain.worker`,
    `bootstrap ${domain} ${join(fixture.launchAgents, "agentbrain.worker.plist")}`,
    `bootout ${domain}/agentbrain.doctor`,
    `bootstrap ${domain} ${join(fixture.launchAgents, "agentbrain.doctor.plist")}`,
    `bootout ${domain}/agentbrain.worker`,
    `bootstrap ${domain} ${join(fixture.launchAgents, "agentbrain.worker.plist")}`,
    `bootout ${domain}/agentbrain.doctor`,
    `bootstrap ${domain} ${join(fixture.launchAgents, "agentbrain.doctor.plist")}`,
    `bootout ${domain}/agentbrain.doctor`,
    `bootout ${domain}/agentbrain.worker`,
    `bootout ${domain}/agentbrain.worker`,
  ]);
  expect(existsSync(join(fixture.bin, "agentbrain"))).toBe(false);
  expect(existsSync(join(fixture.bin, "research-ingest-link"))).toBe(false);
  expect(
    existsSync(join(fixture.launchAgents, "agentbrain.worker.plist")),
  ).toBe(false);
  expect(existsSync(join(fixture.state, "worker.log"))).toBe(true);
}, 15_000);

test("installer does not update a receipt when bootstrap or service verification fails", () => {
  for (const body of [
    '#!/usr/bin/env bash\nif [[ "$1" == bootstrap ]]; then exit 73; fi\nexit 1\n',
    '#!/usr/bin/env bash\nif [[ "$1" == bootstrap ]]; then exit 0; fi\nexit 1\n',
  ]) {
    const fixture = setup();
    mkdirSync(fixture.state, { recursive: true });
    const receipt = join(fixture.state, "deployed-sha");
    writeFileSync(receipt, `${"2".repeat(40)}\n`, { mode: 0o600 });
    const launchctl = join(fixture.dir, "launchctl");
    writeFileSync(launchctl, body);
    chmodSync(launchctl, 0o700);

    const failed = runInstaller(fixture, "--install", {
      AGENTBRAIN_INSTALL_LAUNCHCTL: launchctl,
    });
    expect(failed.exitCode).not.toBe(0);
    expect(readFileSync(receipt, "utf8")).toBe(`${"2".repeat(40)}\n`);
  }
}, 30_000);

test("installer stops before mutation when an owned service cannot unload", () => {
  const fixture = setup();
  expect(runInstaller(fixture).exitCode).toBe(0);
  const service = join(fixture.launchAgents, "agentbrain.worker.plist");
  const originalPlist = readFileSync(service, "utf8");
  const launchctl = join(fixture.dir, "failing-launchctl");
  writeFileSync(
    launchctl,
    '#!/usr/bin/env bash\nif [[ "$1" == print ]]; then\n  printf "program = %s\\n" "$AGENTBRAIN_TEST_PROGRAM"\n  exit 0\nfi\nif [[ "$1" == bootout ]]; then exit 73; fi\nexit 91\n',
  );
  chmodSync(launchctl, 0o700);
  const env = {
    AGENTBRAIN_INSTALL_LAUNCHCTL: launchctl,
    AGENTBRAIN_TEST_PROGRAM: join(fixture.bin, "agentbrain"),
  };

  const refusedInstall = runInstaller(fixture, "--install", env);
  expect(refusedInstall.exitCode).not.toBe(0);
  expect(decode(refusedInstall.stderr)).toContain(
    "failed to unload owned service",
  );
  expect(readFileSync(service, "utf8")).toBe(originalPlist);

  const refusedUninstall = runInstaller(fixture, "--uninstall", env);
  expect(refusedUninstall.exitCode).not.toBe(0);
  expect(decode(refusedUninstall.stderr)).toContain(
    "failed to unload owned service",
  );
  expect(readFileSync(service, "utf8")).toBe(originalPlist);
  expect(existsSync(join(fixture.bin, "agentbrain"))).toBe(true);
  expect(existsSync(join(fixture.bin, "research-ingest-link"))).toBe(false);
}, 15_000);

test("installer removes only known retired links and preserves unrelated binaries", () => {
  const owned = setup();
  symlinkSync(
    relative(owned.bin, join(REPO, "src/research-ingest-link.ts")),
    join(owned.bin, "research-ingest-link"),
  );
  expect(runInstaller(owned).exitCode).toBe(0);
  expect(existsSync(join(owned.bin, "research-ingest-link"))).toBe(false);

  const legacy = setup();
  symlinkSync(
    join(dirname(REPO), "hermes-greybird/bin/research-ingest-link"),
    join(legacy.bin, "research-ingest-link"),
  );
  expect(runInstaller(legacy).exitCode).toBe(0);
  expect(existsSync(join(legacy.bin, "research-ingest-link"))).toBe(false);

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
  expect(
    existsSync(join(installed.launchAgents, "agentbrain.worker.plist")),
  ).toBe(true);
}, 15_000);

test("installer never overwrites or removes a foreign service", () => {
  const fixture = setup();
  mkdirSync(fixture.launchAgents, { recursive: true });
  const service = join(fixture.launchAgents, "agentbrain.worker.plist");
  writeFileSync(service, "foreign service");

  const refusedInstall = runInstaller(fixture);
  expect(refusedInstall.exitCode).not.toBe(0);
  expect(decode(refusedInstall.stderr)).toContain(
    "refusing to overwrite foreign service",
  );
  expect(readFileSync(service, "utf8")).toBe("foreign service");
  expect(existsSync(join(fixture.bin, "agentbrain"))).toBe(false);

  const refusedUninstall = runInstaller(fixture, "--uninstall");
  expect(refusedUninstall.exitCode).not.toBe(0);
  expect(decode(refusedUninstall.stderr)).toContain(
    "refusing to overwrite foreign service",
  );
  expect(readFileSync(service, "utf8")).toBe("foreign service");

  const loaded = setup();
  const launchctl = join(loaded.dir, "foreign-launchctl");
  writeFileSync(
    launchctl,
    '#!/usr/bin/env bash\nif [[ "$1" == print ]]; then\n  printf "program = %s\\n" "$HOME/foreign-worker"\n  exit 0\nfi\nexit 91\n',
  );
  chmodSync(launchctl, 0o700);
  const loadedEnv = { AGENTBRAIN_INSTALL_LAUNCHCTL: launchctl };
  const refusedLoaded = runInstaller(loaded, "--install", loadedEnv);
  expect(refusedLoaded.exitCode).not.toBe(0);
  expect(decode(refusedLoaded.stderr)).toContain(
    "refusing to unload foreign service",
  );
  expect(existsSync(join(loaded.bin, "agentbrain"))).toBe(false);
  expect(existsSync(loaded.launchAgents)).toBe(false);
  expect(runInstaller(loaded, "--uninstall", loadedEnv).exitCode).not.toBe(0);
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
  expect(output).toContain("refuses unmigrated legacy DB state");
});

test("installer owns no share ingress until a bind address is named", () => {
  const fixture = setup();
  expect(runInstaller(fixture, "--install").exitCode).toBe(0);

  // ADR 0017 admits no configuration in which the ingress is exposed by
  // default, so the default install must leave the listener uninstalled.
  expect(readdirSync(fixture.launchAgents).sort()).toEqual([
    "agentbrain.doctor.plist",
    "agentbrain.worker.plist",
  ]);
  expect(existsSync(join(fixture.state, "share.log"))).toBe(false);
});

test("naming a bind address installs a private owned share ingress", () => {
  const fixture = setup();
  const host = "100.101.102.103";
  const result = runInstaller(fixture, "--install", {
    AGENTBRAIN_INSTALL_SHARE_HOST: host,
  });
  expect(result.exitCode).toBe(0);

  expect(readdirSync(fixture.launchAgents).sort()).toEqual([
    "agentbrain.doctor.plist",
    "agentbrain.share.plist",
    "agentbrain.worker.plist",
  ]);

  const service = join(fixture.launchAgents, "agentbrain.share.plist");
  const plist = readFileSync(service, "utf8");
  expect(plist).toContain("agentbrain-installer-owned: agentbrain.share.v1");
  expect(plist).toContain("<string>agentbrain.share</string>");
  expect(plist).toContain("<key>Umask</key>\n\t<integer>63</integer>");
  expect(plist).not.toContain("__AGENTBRAIN_");
  expect(plistProgramArguments(plist)).toEqual([
    join(fixture.bin, "agentbrain"),
    "share",
    "serve",
    "--host",
    host,
  ]);

  const log = join(fixture.state, "share.log");
  expect(plist).toContain(`<string>${log}</string>`);
  expect(mode(log)).toBe(0o600);
  expect(mode(service)).toBe(0o600);

  // The token is never rendered into a service description: the plist records
  // how to reach the ingress, and the 0600 token file remains the credential.
  expect(plist).not.toContain("AGENTBRAIN_SHARE_TOKEN");

  if (Bun.which("plutil")) {
    expect(Bun.spawnSync({ cmd: ["plutil", "-lint", service] }).exitCode).toBe(
      0,
    );
  }
});

test("an unnamed address leaves an installed ingress alone", () => {
  const fixture = setup();
  const host = "100.101.102.103";
  expect(
    runInstaller(fixture, "--install", { AGENTBRAIN_INSTALL_SHARE_HOST: host })
      .exitCode,
  ).toBe(0);
  const service = join(fixture.launchAgents, "agentbrain.share.plist");
  const before = readFileSync(service, "utf8");

  // Re-running without the variable must not silently withdraw a service the
  // operator asked for; only an explicit `none` removes it.
  expect(runInstaller(fixture, "--install").exitCode).toBe(0);
  expect(readFileSync(service, "utf8")).toBe(before);

  expect(
    runInstaller(fixture, "--install", {
      AGENTBRAIN_INSTALL_SHARE_HOST: "none",
    }).exitCode,
  ).toBe(0);
  expect(existsSync(service)).toBe(false);
  expect(readdirSync(fixture.launchAgents).sort()).toEqual([
    "agentbrain.doctor.plist",
    "agentbrain.worker.plist",
  ]);
});

test("installer refuses an any-interface or unsafe share bind", () => {
  for (const host of ["0.0.0.0", "::", "-oProxyCommand=x", "a b"]) {
    const fixture = setup();
    const result = runInstaller(fixture, "--install", {
      AGENTBRAIN_INSTALL_SHARE_HOST: host,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("refusing");
    // A refused bind must not leave a half-installed machine behind.
    expect(existsSync(join(fixture.bin, "agentbrain"))).toBe(false);
    expect(existsSync(fixture.launchAgents)).toBe(false);
  }
});

test("installer never overwrites a foreign share service", () => {
  const fixture = setup();
  mkdirSync(fixture.launchAgents, { recursive: true });
  const service = join(fixture.launchAgents, "agentbrain.share.plist");
  writeFileSync(service, "foreign", { mode: 0o600 });

  const result = runInstaller(fixture, "--install", {
    AGENTBRAIN_INSTALL_SHARE_HOST: "100.101.102.103",
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(
    "refusing to overwrite foreign service",
  );
  expect(readFileSync(service, "utf8")).toBe("foreign");
  expect(existsSync(join(fixture.bin, "agentbrain"))).toBe(false);
});

test("uninstall removes both owned services and keeps both logs", () => {
  const fixture = setup();
  expect(
    runInstaller(fixture, "--install", {
      AGENTBRAIN_INSTALL_SHARE_HOST: "100.101.102.103",
    }).exitCode,
  ).toBe(0);

  expect(runInstaller(fixture, "--uninstall").exitCode).toBe(0);
  expect(readdirSync(fixture.launchAgents)).toEqual([]);
  expect(existsSync(join(fixture.bin, "agentbrain"))).toBe(false);
  expect(existsSync(join(fixture.state, "worker.log"))).toBe(true);
  expect(existsSync(join(fixture.state, "share.log"))).toBe(true);
});

test("worker carries conduit pass-through, empty unless configured", () => {
  const bare = setup();
  expect(runInstaller(bare, "--install").exitCode).toBe(0);
  const unset = readFileSync(
    join(bare.launchAgents, "agentbrain.worker.plist"),
    "utf8",
  );
  expect(unset).toContain("<key>AGENTSCRAPE_CONDUIT_SOCKET</key>");
  expect(unset).toContain("<string></string>");
  expect(unset).not.toContain("__AGENTBRAIN_");

  const fixture = setup();
  const socket = join(fixture.home, "runtime", "agentweb.sock");
  const tokenFile = join(fixture.home, "state", "worker-token");
  expect(
    runInstaller(fixture, "--install", {
      AGENTBRAIN_INSTALL_CONDUIT_SOCKET: socket,
      AGENTBRAIN_INSTALL_CONDUIT_TOKEN_FILE: tokenFile,
    }).exitCode,
  ).toBe(0);

  const plist = readFileSync(
    join(fixture.launchAgents, "agentbrain.worker.plist"),
    "utf8",
  );
  expect(plist).toContain(`<string>${socket}</string>`);
  // The credential is named by path and read by the process that needs it, so
  // a service description never carries the token itself.
  expect(plist).toContain(`<string>${tokenFile}</string>`);
  expect(plist).not.toContain("__AGENTBRAIN_");
});

test("a reinstall that says nothing preserves the installed conduit", () => {
  const fixture = setup();
  const socket = join(fixture.home, "runtime", "agentweb.sock");
  const tokenFile = join(fixture.home, "state", "worker-token");
  expect(
    runInstaller(fixture, "--install", {
      AGENTBRAIN_INSTALL_CONDUIT_SOCKET: socket,
      AGENTBRAIN_INSTALL_CONDUIT_TOKEN_FILE: tokenFile,
    }).exitCode,
  ).toBe(0);

  // A plain reinstall must not silently blank a conduit already in use.
  expect(runInstaller(fixture, "--install").exitCode).toBe(0);
  const kept = readFileSync(
    join(fixture.launchAgents, "agentbrain.worker.plist"),
    "utf8",
  );
  expect(kept).toContain(`<string>${socket}</string>`);
  expect(kept).toContain(`<string>${tokenFile}</string>`);

  // Clearing stays possible, but has to be asked for.
  expect(
    runInstaller(fixture, "--install", {
      AGENTBRAIN_INSTALL_CONDUIT_SOCKET: "",
      AGENTBRAIN_INSTALL_CONDUIT_TOKEN_FILE: "",
    }).exitCode,
  ).toBe(0);
  const cleared = readFileSync(
    join(fixture.launchAgents, "agentbrain.worker.plist"),
    "utf8",
  );
  expect(cleared).not.toContain(`<string>${socket}</string>`);
});
