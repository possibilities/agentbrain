/**
 * Running the share ingress behind Portless on a stable, worktree-aware name.
 *
 * This is a **local desktop development** convenience and nothing more. A
 * `.localhost` name resolves only on the machine that serves it (RFC 6761
 * reserves the whole suffix for loopback), so it cannot carry a share from a
 * phone. The documented device path stays exactly what it was: bind the tailnet
 * address with `--host` and point the clients at it. See
 * docs/runbooks/share-ingress.md.
 *
 * Agentbrain does not vendor Portless and does not proxy anything itself.
 * `portless` is a machine prerequisite, as upstream recommends, and its absence
 * is reported rather than silently ignored — a silent fallback would hand back
 * an unnamed server under a flag that promised a name.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./errors";

/** Overrides the Portless name outright, for two clones of one repository. */
export const PORTLESS_NAME_ENV = "AGENTBRAIN_PORTLESS_NAME";

/** Portless injects this into the child; its presence means "already inside". */
export const PORTLESS_INSIDE_ENV = "PORTLESS_URL";

/**
 * The base name. The share ingress is the only server Agentbrain runs, and
 * `-share` is a suffix on the last label rather than a `share.` label in front
 * so that a second surface could be added later without moving this one.
 */
export const PORTLESS_BASE_NAME = "agentbrain-share";

/** The repository root, which is the checkout this process belongs to. */
export function repositoryRoot(): string {
  return resolve(fileURLToPath(new URL("..", import.meta.url)));
}

/** The CLI entry point to re-enter once Portless owns the process tree. */
export function cliEntryPoint(root: string = repositoryRoot()): string {
  return resolve(root, "src", "cli.ts");
}

/** Names come from directory basenames, so they need DNS-label discipline. */
export function sanitizeLabel(value: string, maxLength = 24): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

/**
 * A linked worktree has a `.git` *file* pointing at the main checkout's
 * metadata; a main checkout has a `.git` directory. Reading it is enough — no
 * git subprocess, and no dependence on what HEAD points at, which is the whole
 * point: an Orca worktree is routinely detached.
 */
export function isLinkedWorktree(root: string): boolean {
  try {
    return statSync(resolve(root, ".git")).isFile();
  } catch {
    // No `.git` at all — a tarball, a copy, a container mount. Treat it as
    // needing an identity of its own rather than as the canonical checkout.
    return true;
  }
}

/**
 * The worktree identity that goes into the name: the checkout's directory name
 * so a human recognizes it, plus six hex of its absolute path so two worktrees
 * cannot collide however similarly they are named or whatever branch is out.
 */
export function worktreeIdentity(root: string): string {
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 6);
  const label = sanitizeLabel(basename(root), 32);
  return label ? `${label}-${digest}` : digest;
}

/** `<identity>.agentbrain-share` for a worktree, `agentbrain-share` otherwise. */
export function shareAppName(identity?: string): string {
  const label = identity ? sanitizeLabel(identity, 40) : "";
  return label ? `${label}.${PORTLESS_BASE_NAME}` : PORTLESS_BASE_NAME;
}

/** The Portless name for this checkout, honoring the environment override. */
export function shareNameFor(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[PORTLESS_NAME_ENV]?.trim();
  if (override) return override;
  return shareAppName(
    isLinkedWorktree(root) ? worktreeIdentity(root) : undefined,
  );
}

/** True once Portless has re-entered us as its child. */
export function alreadyInsidePortless(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env[PORTLESS_INSIDE_ENV]);
}

/**
 * `portless --name <name> -- <command…>` — Portless's *direct named mode*,
 * deliberately not `portless run --name`. Separated out so it is testable.
 *
 * `run` prepends a prefix derived from the branch's last segment, so the URL
 * would follow whichever branch is checked out rather than the worktree, and it
 * is withheld entirely for a detached HEAD — which is the usual state of an
 * Orca worktree, so several would collapse onto one name and the second would
 * take the first's. Direct named mode serves the name verbatim and consults no
 * branch at all.
 */
export function portlessArgv(
  name: string,
  command: readonly string[],
): string[] {
  return ["--name", name, "--", ...command];
}

/**
 * Hand this process's work to `portless`, and return the child's exit code.
 *
 * stdio is inherited so Portless's own banner — the assigned URL, which is the
 * entire point — reaches the terminal unchanged, and the interrupt signals are
 * forwarded because Portless owns the child's process tree.
 */
export async function execPortless(
  name: string,
  command: readonly string[],
): Promise<number> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    // `env` is passed explicitly rather than inherited: without it Bun resolves
    // `portless` against the environment this process started with, so a PATH
    // assigned since then — which is how the tests place a stub in front of a
    // real installation — would not be searched.
    child = Bun.spawn(["portless", ...portlessArgv(name, command)], {
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
    });
  } catch (error) {
    throw new CliError(
      "portless_unavailable",
      `could not run \`portless\`: ${
        error instanceof Error ? error.message : String(error)
      }`,
      {
        exitCode: 1,
        recovery:
          "Portless is a machine prerequisite, not a dependency: install it with `npm i -g portless` (Node >= 24). Without it, run `agentbrain share serve` directly on 127.0.0.1:8787.",
      },
    );
  }

  const forward = (signal: NodeJS.Signals) => (): void => {
    try {
      child.kill(signal);
    } catch {
      // The child is already gone; there is nothing left to forward to.
    }
  };
  const onInterrupt = forward("SIGINT");
  const onTerminate = forward("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}
