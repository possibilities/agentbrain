import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CliError } from "./errors";

const DEFAULT_DATABASE_DISPLAY = "~/.local/share/agentbrain/research.db";

interface PathState {
  exists: boolean;
  symlink: boolean;
  directory: boolean;
  regularFile: boolean;
}

function runtimeHome(home?: string): string {
  return home?.trim() || process.env.HOME?.trim() || homedir();
}

export function defaultDatabasePath(home?: string): string {
  return join(
    runtimeHome(home),
    ".local",
    "share",
    "agentbrain",
    "research.db",
  );
}

function pathState(path: string): PathState {
  try {
    const stat = lstatSync(path);
    return {
      exists: true,
      symlink: stat.isSymbolicLink(),
      directory: stat.isDirectory(),
      regularFile: stat.isFile(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        exists: false,
        symlink: false,
        directory: false,
        regularFile: false,
      };
    throw error;
  }
}

function locationConflict(message: string, recovery: string): never {
  throw new CliError("db_location_conflict", message, { recovery });
}

export function isDefaultDatabasePath(path: string, home?: string): boolean {
  return resolve(path) === resolve(defaultDatabasePath(home));
}

export function assertDefaultDatabaseTargetSafe(
  path: string,
  home?: string,
): void {
  if (!isDefaultDatabasePath(path, home)) return;
  const target = defaultDatabasePath(home);
  const dataDirectory = dirname(target);
  const directoryState = pathState(dataDirectory);
  const targetState = pathState(target);

  if (
    directoryState.exists &&
    (directoryState.symlink || !directoryState.directory)
  )
    locationConflict(
      `Agentbrain data directory must be a real directory: ${dataDirectory}`,
      `Create ${dirname(DEFAULT_DATABASE_DISPLAY)} as a private directory, not a symlink.`,
    );
  if (targetState.exists && (targetState.symlink || !targetState.regularFile))
    locationConflict(
      `Agentbrain default database must be a regular file: ${target}`,
      `Restore a verified standalone database at ${DEFAULT_DATABASE_DISPLAY}.`,
    );
}

export function assertDefaultDatabaseLocationReady(home?: string): void {
  assertDefaultDatabaseTargetSafe(defaultDatabasePath(home), home);
}
