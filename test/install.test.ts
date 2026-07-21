import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
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
) {
  return Bun.spawnSync({
    cmd: ["bash", "scripts/install.sh", ...(action ? [action] : [])],
    cwd: REPO,
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
  expect(readdirSync(fixture.launchAgents)).toEqual([
    "agentbrain.worker.plist",
  ]);

  const service = join(fixture.launchAgents, "agentbrain.worker.plist");
  const log = join(fixture.state, "worker.log");
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
  expect(mode(log)).toBe(0o600);
  expect(mode(service)).toBe(0o600);

  const plutil = Bun.which("plutil");
  if (plutil !== null) {
    expect(
      Bun.spawnSync({ cmd: [plutil, "-lint", service], stdout: "pipe" })
        .exitCode,
    ).toBe(0);
  }

  expect(runInstaller(fixture, "--install").exitCode).toBe(0);
  expect(readdirSync(fixture.launchAgents)).toEqual([
    "agentbrain.worker.plist",
  ]);
  expect(mode(fixture.state)).toBe(0o700);
  expect(mode(log)).toBe(0o600);
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

test("installer unloads stale service before load and uninstall is idempotent", () => {
  const fixture = setup();
  const launchctl = join(fixture.dir, "launchctl");
  const calls = join(fixture.dir, "launchctl.calls");
  writeFileSync(
    launchctl,
    '#!/usr/bin/env bash\nif [[ "$1" == print ]]; then\n  printf "program = %s\\n" "$AGENTBRAIN_TEST_PROGRAM"\n  exit 0\nfi\nprintf "%s\\n" "$*" >> "$AGENTBRAIN_TEST_LAUNCHCTL_LOG"\n',
  );
  chmodSync(launchctl, 0o700);
  const env = {
    AGENTBRAIN_INSTALL_LAUNCHCTL: launchctl,
    AGENTBRAIN_TEST_LAUNCHCTL_LOG: calls,
    AGENTBRAIN_TEST_PROGRAM: join(fixture.bin, "agentbrain"),
  };

  expect(runInstaller(fixture, "--install", env).exitCode).toBe(0);
  expect(runInstaller(fixture, "--install", env).exitCode).toBe(0);
  expect(runInstaller(fixture, "--uninstall", env).exitCode).toBe(0);
  expect(runInstaller(fixture, "--uninstall", env).exitCode).toBe(0);

  const domain = `gui/${process.getuid?.() ?? 0}`;
  expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
    `bootout ${domain}/agentbrain.worker`,
    `bootstrap ${domain} ${join(fixture.launchAgents, "agentbrain.worker.plist")}`,
    `bootout ${domain}/agentbrain.worker`,
    `bootstrap ${domain} ${join(fixture.launchAgents, "agentbrain.worker.plist")}`,
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
});
