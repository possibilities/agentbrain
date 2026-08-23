import { admitSubmission } from "./admission";
import { ArtifactStore } from "./artifacts";
import { CliError } from "./errors";
import { shareJobStates } from "./jobs";
import {
  bearerToken,
  parseShareRequest,
  parseShareStateIds,
  resolveShare,
  SHARE_CONTRACT_VERSION,
  SHARE_DEFAULT_HOST,
  SHARE_DEFAULT_PORT,
  SHARE_MAX_BODY_BYTES,
  tokenMatches,
} from "./share";
import { shareUrlFor } from "./share-liveness";
import type { ResearchStore } from "./store";
import type { AdmissionStatus } from "./types";

export interface ShareServerOptions {
  store: ResearchStore;
  token: string;
  host?: string;
  port?: number;
  artifactStore?: ArtifactStore;
  maxBodyBytes?: number;
  /** Invoked once per settled request for operational logging. */
  onEvent?: (event: ShareServerEvent) => void;
}

export interface ShareServerEvent {
  method: string;
  path: string;
  status: number;
  /** Safe outcome label; never contains shared content or the token. */
  outcome: string;
  job_id?: number;
}

export interface ShareIngestData {
  version: typeof SHARE_CONTRACT_VERSION;
  client: string;
  status: AdmissionStatus;
  job_id: number;
  idempotency_key: string;
  intent_hash: string;
  state: string;
  resolved_kind: "url" | "text";
  /** Present only for URL jobs; a text body is never echoed back. */
  resolved_url: string | null;
  extracted_from_text: boolean;
  collections: string[];
  tags: string[];
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * Error codes map onto HTTP status so clients can distinguish a retryable
 * server fault from a payload they must not resend unchanged.
 */
const STATUS_BY_CODE: Record<string, number> = {
  bad_payload: 400,
  bad_source: 400,
  unsupported_version: 400,
  unauthorized: 401,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  idempotency_conflict: 409,
};

function corsHeaders(origin: string | null): Record<string, string> {
  // Only extension origins are echoed. A browser page on the tailnet must not
  // be able to read responses, and `*` would allow exactly that.
  if (origin === null || !origin.startsWith("chrome-extension://")) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(origin) },
  });
}

function okBody(command: string, data: unknown, dbPath: string): unknown {
  return {
    schema_version: 1,
    ok: true,
    command,
    data,
    meta: {
      db_path: dbPath,
      read_only: false,
      generated_at: new Date().toISOString(),
    },
  };
}

function errorBody(command: string, error: CliError): unknown {
  return {
    schema_version: 1,
    ok: false,
    command,
    error: {
      code: error.code,
      message: error.message,
      ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
    },
  };
}

function httpStatusFor(error: CliError): number {
  return STATUS_BY_CODE[error.code] ?? 500;
}

async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new CliError(
      "payload_too_large",
      `share payload exceeds ${maxBytes} bytes`,
    );
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new CliError(
      "unsupported_media_type",
      "share payload must be sent as application/json",
    );
  }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > maxBytes) {
    throw new CliError(
      "payload_too_large",
      `share payload exceeds ${maxBytes} bytes`,
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new CliError("bad_payload", "share payload is not valid JSON");
  }
}

/**
 * Builds the request handler. Exported separately from `startShareServer` so
 * tests can exercise the full routing, authentication, and admission seam
 * without binding a socket.
 */
export function createShareHandler(
  options: ShareServerOptions,
): (request: Request) => Promise<Response> {
  const { store, token } = options;
  const artifactStore = options.artifactStore ?? new ArtifactStore();
  const maxBodyBytes = options.maxBodyBytes ?? SHARE_MAX_BODY_BYTES;
  const dbPath = store.dbPath;
  const emit = options.onEvent ?? (() => {});

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("origin");
    const command = `share ${path}`;

    const settle = (response: Response, outcome: string, jobId?: number) => {
      emit({
        method: request.method,
        path,
        status: response.status,
        outcome,
        ...(jobId === undefined ? {} : { job_id: jobId }),
      });
      return response;
    };

    if (request.method === "OPTIONS") {
      return settle(
        new Response(null, { status: 204, headers: corsHeaders(origin) }),
        "preflight",
      );
    }

    try {
      const presented = bearerToken(request.headers.get("authorization"));
      if (presented === null || !tokenMatches(token, presented)) {
        throw new CliError("unauthorized", "a valid bearer token is required", {
          recovery:
            "Send Authorization: Bearer <token> from the share token file.",
        });
      }

      if (path === "/v1/health") {
        if (request.method !== "GET") {
          throw new CliError(
            "method_not_allowed",
            `${request.method} is not allowed on ${path}`,
          );
        }
        return settle(
          jsonResponse(
            okBody(
              command,
              { version: SHARE_CONTRACT_VERSION, ok: true },
              dbPath,
            ),
            200,
            origin,
          ),
          "health",
        );
      }

      // What became of the shares this client already sent. Read-only, and
      // bounded to ids the client received from its own acknowledgements.
      if (path === "/v1/shares") {
        if (request.method !== "GET") {
          throw new CliError(
            "method_not_allowed",
            `${request.method} is not allowed on ${path}`,
          );
        }
        const ids = parseShareStateIds(url.searchParams.get("job_ids"));
        const states = shareJobStates(store, ids);
        return settle(
          jsonResponse(
            okBody(
              command,
              { version: SHARE_CONTRACT_VERSION, shares: states },
              dbPath,
            ),
            200,
            origin,
          ),
          "states",
        );
      }

      if (path !== "/v1/share") {
        throw new CliError("not_found", `unknown share endpoint ${path}`);
      }
      if (request.method !== "POST") {
        throw new CliError(
          "method_not_allowed",
          `${request.method} is not allowed on ${path}`,
        );
      }

      const parsed = parseShareRequest(
        await readJsonBody(request, maxBodyBytes),
      );
      const resolved = resolveShare(parsed);
      const admitted = admitSubmission(
        store,
        {
          version: 1,
          source: resolved.source,
          kind: resolved.kind,
          ingress: resolved.ingress,
          collections: resolved.collections,
          tags: resolved.tags,
          ...(resolved.title === undefined ? {} : { title: resolved.title }),
          ...(resolved.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: resolved.idempotencyKey }),
        },
        { artifactStore },
      );

      const data: ShareIngestData = {
        version: SHARE_CONTRACT_VERSION,
        client: resolved.ingress,
        status: admitted.status,
        job_id: admitted.job_id,
        idempotency_key: admitted.idempotency_key,
        intent_hash: admitted.intent_hash,
        state: admitted.state,
        resolved_kind: resolved.kind,
        resolved_url: resolved.kind === "url" ? resolved.source : null,
        extracted_from_text: resolved.extractedFromText,
        collections: resolved.collections,
        tags: resolved.tags,
      };
      return settle(
        jsonResponse(okBody(command, data, dbPath), 200, origin),
        admitted.status,
        admitted.job_id,
      );
    } catch (error) {
      const cliError =
        error instanceof CliError
          ? error
          : new CliError(
              "share_failed",
              "share ingestion failed; see the server log",
            );
      const status = httpStatusFor(cliError);
      if (!(error instanceof CliError)) {
        // Unexpected faults are logged locally but never echoed to the client,
        // which could be any peer on the tailnet.
        console.error("[share] unhandled error:", error);
      }
      return settle(
        jsonResponse(errorBody(command, cliError), status, origin),
        cliError.code,
      );
    }
  };
}

export interface RunningShareServer {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  stop: () => Promise<void>;
}

export function startShareServer(
  options: ShareServerOptions,
): RunningShareServer {
  const hostname = options.host ?? SHARE_DEFAULT_HOST;
  const port = options.port ?? SHARE_DEFAULT_PORT;
  const handler = createShareHandler(options);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname,
      port,
      fetch: handler,
      error: () =>
        new Response(
          `${JSON.stringify({
            schema_version: 1,
            ok: false,
            command: "share",
            error: { code: "share_failed", message: "share ingestion failed" },
          })}\n`,
          { status: 500, headers: JSON_HEADERS },
        ),
    });
  } catch (error) {
    // Bun reports every bind fault as "is the port in use?", which sends the
    // operator after the wrong thing when the real cause is an address that is
    // not on any interface yet — a tailnet bind racing Tailscale's start.
    throw new CliError(
      "share_bind_failed",
      `cannot bind ${shareUrlFor(hostname, port)}: ${(error as Error).message}`,
      {
        recovery:
          "Check for an ingress already holding the port (launchctl list | grep agentbrain.share), and that the address exists on an interface (ifconfig | grep <address>).",
      },
    );
  }
  return {
    server,
    url: shareUrlFor(hostname, server.port ?? port),
    stop: async () => {
      await server.stop(true);
    },
  };
}
