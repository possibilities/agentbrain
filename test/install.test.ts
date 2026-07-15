import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const REPO = realpathSync(join(import.meta.dir, ".."));
const INSTALL_REPO = process.env.PWD ?? REPO;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function setup(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-install-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  return { dir, bin };
}

function install(bin: string) {
  return Bun.spawnSync({
    cmd: ["bash", "scripts/install.sh"],
    cwd: REPO,
    env: { ...process.env, AGENTBRAIN_INSTALL_BIN_DIR: bin },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function decode(value: string | Uint8Array): string {
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

test("installer creates and safely refreshes only its two owned symlinks", () => {
  const { bin } = setup();
  expect(install(bin).exitCode).toBe(0);
  expect(readlinkSync(join(bin, "agentbrain"))).toBe(
    join(INSTALL_REPO, "src/cli.ts"),
  );
  expect(readlinkSync(join(bin, "research-ingest-link"))).toBe(
    join(INSTALL_REPO, "src/research-ingest-link.ts"),
  );
  expect(install(bin).exitCode).toBe(0);
});

test("installer accepts relative owned target and exact dangling sibling legacy target", () => {
  const { bin } = setup();
  symlinkSync(
    relative(bin, join(INSTALL_REPO, "src/cli.ts")),
    join(bin, "agentbrain"),
  );
  symlinkSync(
    join(dirname(INSTALL_REPO), "hermes-greybird/bin/research-ingest-link"),
    join(bin, "research-ingest-link"),
  );
  expect(install(bin).exitCode).toBe(0);
  expect(readlinkSync(join(bin, "research-ingest-link"))).toBe(
    join(INSTALL_REPO, "src/research-ingest-link.ts"),
  );
});

test("installer refuses regular files and unrelated symlinks without partial takeover", () => {
  const regular = setup();
  writeFileSync(join(regular.bin, "research-ingest-link"), "foreign command");
  const refusedRegular = install(regular.bin);
  expect(refusedRegular.exitCode).not.toBe(0);
  expect(decode(refusedRegular.stderr)).toContain(
    "refusing to overwrite non-symlink",
  );
  expect(existsSync(join(regular.bin, "agentbrain"))).toBe(false);

  const unrelated = setup();
  symlinkSync("../dangling/agentbrain", join(unrelated.bin, "agentbrain"));
  const refusedLink = install(unrelated.bin);
  expect(refusedLink.exitCode).not.toBe(0);
  expect(decode(refusedLink.stderr)).toContain(
    "refusing to overwrite unrelated symlink",
  );

  const lookalike = setup();
  symlinkSync(
    join(lookalike.dir, "foreign/hermes-greybird/bin/research-ingest-link"),
    join(lookalike.bin, "research-ingest-link"),
  );
  const refusedLookalike = install(lookalike.bin);
  expect(refusedLookalike.exitCode).not.toBe(0);
  expect(decode(refusedLookalike.stderr)).toContain(
    "refusing to overwrite unrelated symlink",
  );
});
