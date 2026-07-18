import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { sanitizeArtifactError } from "./sanitize";

export const DEFAULT_MAX_ARTIFACT_BYTES = 50_000_000;
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const COPY_BUFFER_BYTES = 64 * 1024;

export type ArtifactErrorCode =
  | "artifact_too_large"
  | "digest_mismatch"
  | "invalid_digest"
  | "invalid_staging"
  | "source_changed"
  | "source_not_regular"
  | "artifact_missing"
  | "artifact_corrupt";

/** An artifact error whose default message never contains a private path. */
export class ArtifactStoreError extends Error {
  readonly code: ArtifactErrorCode;

  constructor(code: ArtifactErrorCode, message: string) {
    super(message);
    this.name = "ArtifactStoreError";
    this.code = code;
  }
}

export interface StagedArtifact {
  stagingId: string;
  contentDigest: string;
  byteSize: number;
}

export interface StoredArtifact {
  contentDigest: string;
  byteSize: number;
  /** Relative to the Artifact store root; private absolute paths stay out of metadata. */
  storagePath: string;
}

export interface LocalFileSnapshot extends StoredArtifact {
  kind: "local_file_snapshot";
  mediaType: string;
  capturedAt: string;
  /** A display-only filename, not the mutable source locator. */
  sourceName: string;
}

export interface ReconciliationEntry {
  id: string;
  ageMs: number;
  byteSize: number;
  removed: boolean;
}

export interface PermissionDrift {
  kind: "directory" | "staging" | "artifact";
  id: string;
  expectedMode: number;
  actualMode: number;
  repaired: boolean;
}

export interface IntegrityDefect {
  digest: string;
  code: "digest_mismatch" | "invalid_object";
  detail: string;
}

export interface ArtifactReconciliationReport {
  staleStaging: ReconciliationEntry[];
  promotedOrphans: ReconciliationEntry[];
  permissionDrift: PermissionDrift[];
  integrityDefects: IntegrityDefect[];
}

export interface ReconcileOptions {
  now?: Date;
  staleStagingAgeMs?: number;
  deleteStaleStaging?: boolean;
  deleteOrphans?: boolean;
  /** Required when deleting promoted orphans. Garbage collection is never age-blind. */
  orphanRetentionMs?: number;
  repairPermissions?: boolean;
  verifyPromoted?: boolean;
}

export interface StageOptions {
  expectedDigest?: string;
  maxBytes?: number;
}

export function defaultArtifactRoot(): string {
  const dataHome =
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "agentbrain", "artifacts");
}

function validateDigest(digest: string): string {
  const normalized = String(digest || "").toLowerCase();
  if (!SHA256_DIGEST_PATTERN.test(normalized)) {
    throw new ArtifactStoreError(
      "invalid_digest",
      "invalid SHA-256 content digest",
    );
  }
  return normalized;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function writeAll(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.byteLength) {
    offset += writeSync(fd, data, offset, data.byteLength - offset);
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function statIdentity(path: string): {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
} {
  const value = statSync(path, { bigint: true });
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function fdIdentity(
  fd: number,
): ReturnType<typeof statIdentity> & { regular: boolean } {
  const value = fstatSync(fd, { bigint: true });
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
    regular: value.isFile(),
  };
}

function sameIdentity(
  left: ReturnType<typeof statIdentity>,
  right: ReturnType<typeof statIdentity>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Content-addressed filesystem for immutable Artifact bytes. SQLite owns typed
 * metadata and Resource references; this class owns staging, verification,
 * atomic promotion, snapshots, and filesystem reconciliation.
 */
export class ArtifactStore {
  readonly root: string;
  readonly stagingRoot: string;
  readonly objectsRoot: string;

  constructor(root = defaultArtifactRoot()) {
    this.root = root;
    this.stagingRoot = join(root, "staging");
    this.objectsRoot = join(root, "sha256");
    ensurePrivateDirectory(this.root);
    ensurePrivateDirectory(this.stagingRoot);
    ensurePrivateDirectory(this.objectsRoot);
  }

  relativePath(contentDigest: string): string {
    const digest = validateDigest(contentDigest);
    return join("sha256", digest.slice(0, 2), digest.slice(2, 4), digest);
  }

  pathFor(contentDigest: string): string {
    return join(this.root, this.relativePath(contentDigest));
  }

  /** Stage in-memory bytes. Large acquisitions should use stageFile. */
  stageBytes(
    bytes: Uint8Array | string,
    options: StageOptions = {},
  ): StagedArtifact {
    const expectedDigest =
      options.expectedDigest === undefined
        ? undefined
        : validateDigest(options.expectedDigest);
    const data =
      typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (data.byteLength > maxBytes) {
      throw new ArtifactStoreError(
        "artifact_too_large",
        "artifact exceeds the byte limit",
      );
    }
    const stagingId = randomUUID();
    const path = join(this.stagingRoot, stagingId);
    const fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      PRIVATE_FILE_MODE,
    );
    try {
      writeAll(fd, data);
      fsyncSync(fd);
    } catch (error) {
      safeUnlink(path);
      throw error;
    } finally {
      closeSync(fd);
    }
    chmodSync(path, PRIVATE_FILE_MODE);
    const contentDigest = createHash("sha256").update(data).digest("hex");
    if (expectedDigest !== undefined && expectedDigest !== contentDigest) {
      safeUnlink(path);
      throw new ArtifactStoreError(
        "digest_mismatch",
        "staged bytes do not match the expected SHA-256 digest",
      );
    }
    return { stagingId, contentDigest, byteSize: data.byteLength };
  }

  /**
   * Copy a regular local file into owned staging with bounded memory. Symlinks
   * are rejected and before/after descriptor metadata detects a changing file.
   */
  stageFile(sourcePath: string, options: StageOptions = {}): StagedArtifact {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    try {
      if (lstatSync(sourcePath).isSymbolicLink()) {
        throw new ArtifactStoreError(
          "source_not_regular",
          "local snapshot source must be a regular file, not a symlink",
        );
      }
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        "source_not_regular",
        sanitizeArtifactError(error, [sourcePath]),
      );
    }

    let sourceFd: number | undefined;
    const stagingId = randomUUID();
    const stagingPath = join(this.stagingRoot, stagingId);
    let destinationFd: number | undefined;
    try {
      sourceFd = openSync(
        sourcePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const before = fdIdentity(sourceFd);
      if (!before.regular) {
        throw new ArtifactStoreError(
          "source_not_regular",
          "local snapshot source must be a regular file",
        );
      }
      if (before.size > BigInt(maxBytes)) {
        throw new ArtifactStoreError(
          "artifact_too_large",
          "artifact exceeds the byte limit",
        );
      }
      destinationFd = openSync(
        stagingPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        PRIVATE_FILE_MODE,
      );
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let byteSize = 0;
      while (true) {
        const count = readSync(sourceFd, buffer, 0, buffer.byteLength, null);
        if (count === 0) break;
        byteSize += count;
        if (byteSize > maxBytes) {
          throw new ArtifactStoreError(
            "artifact_too_large",
            "artifact exceeds the byte limit",
          );
        }
        const chunk = buffer.subarray(0, count);
        hash.update(chunk);
        writeAll(destinationFd, chunk);
      }
      fsyncSync(destinationFd);
      const after = fdIdentity(sourceFd);
      if (!sameIdentity(before, after)) {
        throw new ArtifactStoreError(
          "source_changed",
          "local snapshot source changed while it was being captured",
        );
      }
      const contentDigest = hash.digest("hex");
      if (
        options.expectedDigest !== undefined &&
        validateDigest(options.expectedDigest) !== contentDigest
      ) {
        throw new ArtifactStoreError(
          "digest_mismatch",
          "staged bytes do not match the expected SHA-256 digest",
        );
      }
      closeSync(destinationFd);
      destinationFd = undefined;
      chmodSync(stagingPath, PRIVATE_FILE_MODE);
      return { stagingId, contentDigest, byteSize };
    } catch (error) {
      safeUnlink(stagingPath);
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        "source_not_regular",
        sanitizeArtifactError(error, [sourcePath, this.root]),
      );
    } finally {
      if (destinationFd !== undefined) closeSync(destinationFd);
      if (sourceFd !== undefined) closeSync(sourceFd);
    }
  }

  /** Re-hash staged bytes, then atomically link them to their immutable address. */
  promote(staged: StagedArtifact): StoredArtifact {
    if (!/^[a-f0-9-]{36}$/.test(staged.stagingId)) {
      throw new ArtifactStoreError(
        "invalid_staging",
        "invalid Artifact staging identifier",
      );
    }
    const digest = validateDigest(staged.contentDigest);
    const stagingPath = join(this.stagingRoot, staged.stagingId);
    const verified = this.hashRegularFile(stagingPath, staged.byteSize);
    if (
      verified.contentDigest !== digest ||
      verified.byteSize !== staged.byteSize
    ) {
      throw new ArtifactStoreError(
        "digest_mismatch",
        "staged Artifact changed before promotion",
      );
    }

    const finalPath = this.pathFor(digest);
    ensurePrivateDirectory(dirname(finalPath));
    let linked = false;
    try {
      linkSync(stagingPath, finalPath);
      linked = true;
      chmodSync(finalPath, PRIVATE_FILE_MODE);
      const promoted = this.hashRegularFile(finalPath, staged.byteSize);
      if (
        promoted.contentDigest !== digest ||
        promoted.byteSize !== staged.byteSize
      ) {
        safeUnlink(finalPath);
        throw new ArtifactStoreError(
          "digest_mismatch",
          "staged Artifact changed during promotion",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (linked) safeUnlink(finalPath);
        throw error;
      }
      const existing = this.hashRegularFile(finalPath, staged.byteSize);
      if (
        existing.contentDigest !== digest ||
        existing.byteSize !== staged.byteSize
      ) {
        throw new ArtifactStoreError(
          "artifact_corrupt",
          "existing content-addressed Artifact failed verification",
        );
      }
      chmodSync(finalPath, PRIVATE_FILE_MODE);
    }
    safeUnlink(stagingPath);
    fsyncDirectory(dirname(finalPath));
    fsyncDirectory(this.stagingRoot);
    return {
      contentDigest: digest,
      byteSize: staged.byteSize,
      storagePath: this.relativePath(digest),
    };
  }

  captureBytes(
    bytes: Uint8Array | string,
    options: StageOptions = {},
  ): StoredArtifact {
    return this.promote(this.stageBytes(bytes, options));
  }

  /** Capture immutable bytes for a local-file intent before it is accepted. */
  snapshotLocalFile(
    sourcePath: string,
    options: StageOptions & { mediaType?: string; now?: Date } = {},
  ): LocalFileSnapshot {
    const stored = this.promote(this.stageFile(sourcePath, options));
    return {
      kind: "local_file_snapshot",
      ...stored,
      mediaType: options.mediaType ?? "application/octet-stream",
      capturedAt: (options.now ?? new Date()).toISOString(),
      sourceName: basename(sourcePath),
    };
  }

  verify(contentDigest: string): StoredArtifact {
    const digest = validateDigest(contentDigest);
    const path = this.pathFor(digest);
    if (!existsSync(path)) {
      throw new ArtifactStoreError(
        "artifact_missing",
        "content-addressed Artifact is missing",
      );
    }
    const value = this.hashRegularFile(path);
    if (value.contentDigest !== digest) {
      throw new ArtifactStoreError(
        "artifact_corrupt",
        "content-addressed Artifact failed SHA-256 verification",
      );
    }
    return { ...value, storagePath: this.relativePath(digest) };
  }

  readBytes(
    contentDigest: string,
    maxBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  ): Uint8Array {
    const verified = this.verify(contentDigest);
    if (verified.byteSize > maxBytes) {
      throw new ArtifactStoreError(
        "artifact_too_large",
        "artifact exceeds the byte limit",
      );
    }
    return readFileSync(this.pathFor(verified.contentDigest));
  }

  readUtf8(
    contentDigest: string,
    maxBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  ): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      this.readBytes(contentDigest, maxBytes),
    );
  }

  /**
   * Report filesystem/database gaps without private paths. Staging cleanup is
   * opt-in. Promoted-orphan deletion additionally requires an explicit
   * retention window and never removes bytes that fail digest verification.
   */
  reconcile(
    referencedDigests: Iterable<string>,
    options: ReconcileOptions = {},
  ): ArtifactReconciliationReport {
    const nowMs = (options.now ?? new Date()).getTime();
    const staleAge = options.staleStagingAgeMs ?? 24 * 60 * 60 * 1000;
    if (staleAge < 0) throw new Error("staleStagingAgeMs must be non-negative");
    if (options.deleteOrphans && options.orphanRetentionMs === undefined) {
      throw new Error(
        "orphanRetentionMs is required to delete promoted orphans",
      );
    }
    const orphanRetention =
      options.orphanRetentionMs ?? Number.POSITIVE_INFINITY;
    if (orphanRetention < 0)
      throw new Error("orphanRetentionMs must be non-negative");
    const referenced = new Set(Array.from(referencedDigests, validateDigest));
    const report: ArtifactReconciliationReport = {
      staleStaging: [],
      promotedOrphans: [],
      permissionDrift: [],
      integrityDefects: [],
    };

    this.checkDirectoryMode(this.root, "root", options, report);
    this.checkDirectoryMode(this.stagingRoot, "staging", options, report);
    this.checkDirectoryMode(this.objectsRoot, "sha256", options, report);
    for (const first of readdirSync(this.objectsRoot)) {
      const firstPath = join(this.objectsRoot, first);
      if (!lstatSync(firstPath).isDirectory()) continue;
      this.checkDirectoryMode(firstPath, `sha256/${first}`, options, report);
      for (const second of readdirSync(firstPath)) {
        const secondPath = join(firstPath, second);
        if (!lstatSync(secondPath).isDirectory()) continue;
        this.checkDirectoryMode(
          secondPath,
          `sha256/${first}/${second}`,
          options,
          report,
        );
      }
    }

    for (const name of readdirSync(this.stagingRoot)) {
      const path = join(this.stagingRoot, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      this.checkFileMode(path, "staging", name, options, report);
      const ageMs = Math.max(0, nowMs - stat.mtimeMs);
      if (ageMs < staleAge) continue;
      let removed = false;
      if (options.deleteStaleStaging) {
        safeUnlink(path);
        removed = true;
      }
      report.staleStaging.push({
        id: name,
        ageMs,
        byteSize: stat.size,
        removed,
      });
    }

    for (const object of this.objectFiles()) {
      const digest = basename(object);
      if (!SHA256_DIGEST_PATTERN.test(digest)) {
        report.integrityDefects.push({
          digest: "invalid",
          code: "invalid_object",
          detail: "non-addressed file exists in the Artifact object tree",
        });
        continue;
      }
      const stat = lstatSync(object);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        report.integrityDefects.push({
          digest,
          code: "invalid_object",
          detail: "content-addressed object is not a regular file",
        });
        continue;
      }
      this.checkFileMode(object, "artifact", digest, options, report);
      let verified = true;
      if (
        options.verifyPromoted ||
        (!referenced.has(digest) && options.deleteOrphans)
      ) {
        const actual = this.hashRegularFile(object);
        if (actual.contentDigest !== digest) {
          verified = false;
          report.integrityDefects.push({
            digest,
            code: "digest_mismatch",
            detail: "content-addressed Artifact failed SHA-256 verification",
          });
        }
      }
      if (referenced.has(digest)) continue;
      const ageMs = Math.max(0, nowMs - stat.mtimeMs);
      let removed = false;
      if (options.deleteOrphans && verified && ageMs >= orphanRetention) {
        safeUnlink(object);
        removed = true;
      }
      report.promotedOrphans.push({
        id: digest,
        ageMs,
        byteSize: stat.size,
        removed,
      });
    }
    return report;
  }

  private hashRegularFile(path: string, expectedSize?: number): StoredArtifact {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const before = fdIdentity(fd);
      if (!before.regular) {
        throw new ArtifactStoreError(
          "invalid_staging",
          "Artifact bytes must be a regular file",
        );
      }
      if (expectedSize !== undefined && before.size !== BigInt(expectedSize)) {
        throw new ArtifactStoreError(
          "digest_mismatch",
          "Artifact byte size changed before verification",
        );
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
      let byteSize = 0;
      while (true) {
        const count = readSync(fd, buffer, 0, buffer.byteLength, null);
        if (count === 0) break;
        byteSize += count;
        hash.update(buffer.subarray(0, count));
      }
      const after = fdIdentity(fd);
      if (!sameIdentity(before, after)) {
        throw new ArtifactStoreError(
          "digest_mismatch",
          "Artifact changed while it was being verified",
        );
      }
      return {
        contentDigest: hash.digest("hex"),
        byteSize,
        storagePath: "",
      };
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError(
        "artifact_missing",
        sanitizeArtifactError(error, [this.root, path]),
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private objectFiles(): string[] {
    const files: string[] = [];
    if (!existsSync(this.objectsRoot)) return files;
    for (const first of readdirSync(this.objectsRoot)) {
      const firstPath = join(this.objectsRoot, first);
      if (!lstatSync(firstPath).isDirectory()) {
        files.push(firstPath);
        continue;
      }
      for (const second of readdirSync(firstPath)) {
        const secondPath = join(firstPath, second);
        if (!lstatSync(secondPath).isDirectory()) {
          files.push(secondPath);
          continue;
        }
        for (const name of readdirSync(secondPath))
          files.push(join(secondPath, name));
      }
    }
    return files;
  }

  private checkDirectoryMode(
    path: string,
    id: string,
    options: ReconcileOptions,
    report: ArtifactReconciliationReport,
  ): void {
    const actualMode = modeOf(path);
    if (actualMode === PRIVATE_DIRECTORY_MODE) return;
    if (options.repairPermissions) chmodSync(path, PRIVATE_DIRECTORY_MODE);
    report.permissionDrift.push({
      kind: "directory",
      id,
      expectedMode: PRIVATE_DIRECTORY_MODE,
      actualMode,
      repaired: options.repairPermissions === true,
    });
  }

  private checkFileMode(
    path: string,
    kind: "staging" | "artifact",
    id: string,
    options: ReconcileOptions,
    report: ArtifactReconciliationReport,
  ): void {
    const actualMode = modeOf(path);
    if (actualMode === PRIVATE_FILE_MODE) return;
    if (options.repairPermissions) chmodSync(path, PRIVATE_FILE_MODE);
    report.permissionDrift.push({
      kind,
      id,
      expectedMode: PRIVATE_FILE_MODE,
      actualMode,
      repaired: options.repairPermissions === true,
    });
  }
}

/** Reject metadata paths that could escape or disclose an Artifact store root. */
export function isSafeArtifactStoragePath(
  storagePath: string,
  contentDigest: string,
): boolean {
  if (isAbsolute(storagePath)) return false;
  const digest = validateDigest(contentDigest);
  const expected = join(
    "sha256",
    digest.slice(0, 2),
    digest.slice(2, 4),
    digest,
  );
  return relative(expected, storagePath) === "" && storagePath === expected;
}
