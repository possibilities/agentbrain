import { optBoolean, optNumber, optString, parseOptions } from "./args";
import { CliError } from "./errors";
import { writeByFormat } from "./format";
import {
  alreadyInsidePortless,
  cliEntryPoint,
  execPortless,
  PORTLESS_INSIDE_ENV,
  repositoryRoot,
  shareNameFor,
} from "./portless";
import {
  defaultShareTokenPath,
  generateShareToken,
  readShareToken,
  resolveSharePort,
  SHARE_CONTRACT_VERSION,
  SHARE_DEFAULT_HOST,
  type SharePortSource,
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
          recovery:
            "Use at least 16 characters, or unset it to use the token file.",
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
        recovery:
          "Bind the Tailscale address instead, for example --host 100.x.y.z.",
      },
    );
  }
}

/**
 * Loopback in the RFC 6761 sense. A Portless `.localhost` name resolves nowhere
 * but this machine, so it can only ever front a loopback bind; asking for both
 * a named URL and a tailnet address is a contradiction worth naming rather than
 * silently resolving one way.
 */
function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "[::1]" ||
    value === "localhost"
  );
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
      // No default: the flag has to stay distinguishable from its absence so
      // PORT can sit underneath it. resolveSharePort applies the default.
      port: { type: "number" },
      "token-file": { type: "string" },
      "allow-any-interface": { type: "boolean" },
      portless: { type: "boolean" },
    });
    if (opts._.length > 0) {
      throw new CliError(
        "unexpected_args",
        `share serve does not accept positional args: ${opts._.join(" ")}`,
        { exitCode: 2 },
      );
    }
    const host = optString(opts, "host") ?? SHARE_DEFAULT_HOST;
    const portFlag = optNumber(opts, "port");

    // --portless re-enters this same command with Portless owning the process
    // tree; the child then arrives with PORTLESS_URL set and simply serves.
    if (optBoolean(opts, "portless") && !alreadyInsidePortless(process.env)) {
      if (portFlag !== undefined) {
        throw new CliError(
          "portless_port_conflict",
          "--port and --portless are mutually exclusive",
          {
            exitCode: 2,
            recovery:
              "Portless allocates a free port and passes it in PORT; drop --port.",
          },
        );
      }
      if (!isLoopbackHost(host)) {
        throw new CliError(
          "portless_host_conflict",
          `--portless is loopback-only and cannot serve --host ${host}`,
          {
            exitCode: 2,
            recovery:
              "A .localhost name resolves only on this machine. For phone shares run share serve --host <tailnet-addr> without --portless.",
          },
        );
      }
      const root = repositoryRoot();
      // The globals (--db, --json, --quiet) were consumed before this function
      // received its arguments, so the child is rebuilt from the process's own
      // argv; only --portless is dropped, so the child does not recurse.
      const passthrough = Bun.argv
        .slice(2)
        .filter(
          (arg) => arg !== "--portless" && !arg.startsWith("--portless="),
        );
      process.exit(
        await execPortless(shareNameFor(root, process.env), [
          process.execPath,
          "run",
          cliEntryPoint(root),
          ...passthrough,
        ]),
      );
    }

    const { port, source: portSource } = resolveSharePort(portFlag);
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

    // Present only when Portless is proxying us, and reported as what it is: a
    // loopback-only development name that supplements the tailnet address.
    const portlessUrl = process.env[PORTLESS_INSIDE_ENV]?.trim();
    const payload: {
      version: number;
      host: string;
      port: number;
      port_source: SharePortSource;
      url: string;
      endpoint: string;
      token_source: string;
      portless_url?: string;
    } = {
      version: SHARE_CONTRACT_VERSION,
      host,
      // Bun types the bound port as optional (unix sockets have none); this
      // server is always a TCP listener, so the requested port is the answer.
      port: running.server.port ?? port,
      port_source: portSource,
      url: running.url,
      endpoint: `${running.url}/v1/share`,
      token_source: source,
      ...(portlessUrl ? { portless_url: portlessUrl } : {}),
    };

    writeByFormat(
      "share serve",
      payload,
      globals,
      (data) =>
        `Agentbrain share ingress listening on ${data.url}\nPOST ${data.endpoint}\ntoken: ${data.token_source}\nport: ${data.port} (${data.port_source})\n${
          data.portless_url === undefined
            ? ""
            : `named URL: ${data.portless_url} (this machine only)\n`
        }`,
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
            { exitCode: 2, recovery: "Pass --force to rotate it." },
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
          {
            exitCode: 2,
            recovery: "Run: agentbrain share token show --reveal",
          },
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
      { exitCode: 2, recovery: "Use init, show, or path." },
    );
  }

  throw new CliError(
    "unknown_subcommand",
    `unknown share subcommand '${subcommand}'`,
    { exitCode: 2, recovery: "Use serve or token." },
  );
}
