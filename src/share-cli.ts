import { optBoolean, optNumber, optString, parseOptions } from "./args";
import { CliError } from "./errors";
import { writeByFormat } from "./format";
import {
  defaultShareTokenPath,
  generateShareToken,
  readShareToken,
  SHARE_CONTRACT_VERSION,
  SHARE_DEFAULT_HOST,
  SHARE_DEFAULT_PORT,
  writeShareToken,
} from "./share";
import { type ShareServerEvent, startShareServer } from "./share-server";
import { ResearchStore } from "./store";
import type { GlobalOptions } from "./types";

function tokenPathFor(opts: Record<string, unknown> & { _: string[] }): string {
  return optString(opts, "token-file") ?? defaultShareTokenPath();
}

/**
 * Resolves the token the server will require. The environment override exists
 * for supervised/service contexts that inject a secret without a file; the
 * file remains the default so ADR 0012 permission rules apply.
 */
function resolveServerToken(path: string): { token: string; source: string } {
  const fromEnv = process.env.AGENTBRAIN_SHARE_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (fromEnv.length < 16) {
      throw new CliError(
        "share_token_invalid",
        "AGENTBRAIN_SHARE_TOKEN is too short to be usable",
        {
          hint: "Use at least 16 characters, or unset it to use the token file.",
        },
      );
    }
    return { token: fromEnv, source: "env:AGENTBRAIN_SHARE_TOKEN" };
  }
  return { token: readShareToken(path), source: path };
}

function assertBindableHost(host: string, allowAny: boolean): void {
  if ((host === "0.0.0.0" || host === "::") && !allowAny) {
    throw new CliError(
      "share_bind_refused",
      `refusing to bind every interface (${host}) without --allow-any-interface`,
      {
        exitCode: 2,
        hint: "Bind the Tailscale address instead, for example --host 100.x.y.z.",
      },
    );
  }
}

export async function runShareCommands(
  dbPath: string,
  argv: string[],
  globals: GlobalOptions,
): Promise<void> {
  const subcommand = argv[0]?.startsWith("--") ? "serve" : (argv[0] ?? "serve");
  const args =
    argv[0]?.startsWith("--") || argv.length === 0 ? argv : argv.slice(1);

  if (subcommand === "serve") {
    const opts = parseOptions(args, {
      host: { type: "string", default: SHARE_DEFAULT_HOST },
      port: { type: "number", default: SHARE_DEFAULT_PORT },
      "token-file": { type: "string" },
      "allow-any-interface": { type: "boolean" },
    });
    if (opts._.length > 0) {
      throw new CliError(
        "unexpected_args",
        `share serve does not accept positional args: ${opts._.join(" ")}`,
        { exitCode: 2 },
      );
    }
    const host = optString(opts, "host") ?? SHARE_DEFAULT_HOST;
    const port = optNumber(opts, "port") ?? SHARE_DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new CliError("bad_port", "--port must be between 1 and 65535", {
        exitCode: 2,
      });
    }
    assertBindableHost(host, optBoolean(opts, "allow-any-interface"));
    const tokenPath = tokenPathFor(opts);
    const { token, source } = resolveServerToken(tokenPath);

    const store = new ResearchStore(dbPath);
    const onEvent = (event: ShareServerEvent): void => {
      if (globals.quiet) return;
      // Never logs shared URLs, titles, or bodies — only safe routing facts.
      process.stderr.write(
        `[share] ${event.method} ${event.path} ${event.status} ${event.outcome}${
          event.job_id === undefined ? "" : ` job=${event.job_id}`
        }\n`,
      );
    };
    const running = startShareServer({ store, token, host, port, onEvent });

    writeByFormat(
      "share serve",
      {
        version: SHARE_CONTRACT_VERSION,
        host,
        port: running.server.port,
        url: running.url,
        endpoint: `${running.url}/v1/share`,
        token_source: source,
      },
      globals,
      (data) =>
        `Agentbrain share ingress listening on ${data.url}\nPOST ${data.endpoint}\ntoken: ${data.token_source}\n`,
      { readOnly: false },
    );

    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        void running.stop().then(() => {
          store.close();
          resolve();
        });
      };
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.on(signal, stop);
      }
    });
    return;
  }

  if (subcommand === "token") {
    const action = args[0] ?? "path";
    const opts = parseOptions(args.slice(1), {
      "token-file": { type: "string" },
      force: { type: "boolean" },
      reveal: { type: "boolean" },
    });
    const path = tokenPathFor(opts);

    if (action === "path") {
      writeByFormat(
        "share token path",
        { token_file: path },
        globals,
        (data) => `${data.token_file}\n`,
      );
      return;
    }

    if (action === "init") {
      const force = optBoolean(opts, "force");
      if (!force) {
        try {
          readShareToken(path);
          throw new CliError(
            "share_token_exists",
            `a share token already exists at ${path}`,
            { exitCode: 2, hint: "Pass --force to rotate it." },
          );
        } catch (error) {
          if (
            !(error instanceof CliError) ||
            (error.code !== "share_token_missing" &&
              error.code !== "share_token_invalid")
          ) {
            throw error;
          }
        }
      }
      const token = generateShareToken();
      writeShareToken(path, token);
      writeByFormat(
        "share token init",
        { token_file: path, rotated: force, token },
        globals,
        (data) =>
          `wrote share token to ${data.token_file}\n${data.token}\n\nConfigure this token in the Chrome extension and Android app.\n`,
        { readOnly: false },
      );
      return;
    }

    if (action === "show") {
      // Explicit reveal, per ADR 0012's rule that secrets are not casually
      // displayed by default.
      if (!optBoolean(opts, "reveal")) {
        throw new CliError(
          "reveal_required",
          "share token show requires --reveal",
          { exitCode: 2, hint: "Run: agentbrain share token show --reveal" },
        );
      }
      const token = readShareToken(path);
      writeByFormat(
        "share token show",
        { token_file: path, token },
        globals,
        (data) => `${data.token}\n`,
      );
      return;
    }

    throw new CliError(
      "unknown_subcommand",
      `unknown share token action '${action}'`,
      { exitCode: 2, hint: "Use init, show, or path." },
    );
  }

  throw new CliError(
    "unknown_subcommand",
    `unknown share subcommand '${subcommand}'`,
    { exitCode: 2, hint: "Use serve or token." },
  );
}
