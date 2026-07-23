import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "../src/errors";
import {
  assertDefaultDatabaseLocationReady,
  defaultDatabasePath,
  isDefaultDatabasePath,
  legacyDatabasePath,
} from "../src/paths";

function fixture(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "agentbrain-paths-"));
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "db");
}

function errorCode(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return (error as CliError).code;
  }
}

test("database paths live in the Agentbrain namespace", () => {
  const { home, cleanup } = fixture();
  try {
    expect(defaultDatabasePath(home)).toBe(
      join(home, ".local", "share", "agentbrain", "research.db"),
    );
    expect(legacyDatabasePath(home)).toBe(
      join(home, ".hermes", "research-cache", "research.db"),
    );
    expect(isDefaultDatabasePath(defaultDatabasePath(home), home)).toBeTrue();
    expect(isDefaultDatabasePath(legacyDatabasePath(home), home)).toBeFalse();
    expect(
      errorCode(() => assertDefaultDatabaseLocationReady(home)),
    ).toBeNull();
  } finally {
    cleanup();
  }
});

test("default database use fails closed around legacy and conflicting state", () => {
  const { home, cleanup } = fixture();
  try {
    touch(legacyDatabasePath(home));
    expect(errorCode(() => assertDefaultDatabaseLocationReady(home))).toBe(
      "db_migration_required",
    );

    touch(defaultDatabasePath(home));
    expect(errorCode(() => assertDefaultDatabaseLocationReady(home))).toBe(
      "db_location_conflict",
    );

    rmSync(legacyDatabasePath(home));
    expect(
      errorCode(() => assertDefaultDatabaseLocationReady(home)),
    ).toBeNull();
  } finally {
    cleanup();
  }
});

test("default database use rejects compatibility symlinks", () => {
  const { home, cleanup } = fixture();
  try {
    const target = defaultDatabasePath(home);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(join(home, "missing.db"), target);
    expect(errorCode(() => assertDefaultDatabaseLocationReady(home))).toBe(
      "db_location_conflict",
    );
  } finally {
    cleanup();
  }
});

test("default database use rejects symlinked roots and non-regular targets", () => {
  const symlinked = fixture();
  try {
    const share = join(symlinked.home, ".local", "share");
    const real = join(symlinked.home, "real-agentbrain");
    mkdirSync(share, { recursive: true });
    mkdirSync(real);
    symlinkSync(real, join(share, "agentbrain"));
    expect(
      errorCode(() => assertDefaultDatabaseLocationReady(symlinked.home)),
    ).toBe("db_location_conflict");
  } finally {
    symlinked.cleanup();
  }

  const nonRegular = fixture();
  try {
    mkdirSync(defaultDatabasePath(nonRegular.home), { recursive: true });
    expect(
      errorCode(() => assertDefaultDatabaseLocationReady(nonRegular.home)),
    ).toBe("db_location_conflict");
  } finally {
    nonRegular.cleanup();
  }
});
