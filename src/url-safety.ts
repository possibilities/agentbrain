import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

export type DnsResolver = (hostname: string, port: number) => Promise<string[]>;

export interface PinnedTransportRequest {
  url: URL;
  address: string;
  headers: Record<string, string>;
  maxBytes: number;
  timeoutMs: number;
}

export interface PinnedTransportResponse {
  status: number;
  headers: Record<string, string>;
  data: Uint8Array;
  remoteAddress: string;
}

/** Injectable only so tests can prove resolution, routing, and remote checks. */
export type PinnedTransport = (
  request: PinnedTransportRequest,
) => Promise<PinnedTransportResponse>;

export interface PublicFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  resolver?: DnsResolver;
  transport?: PinnedTransport;
  headers?: Record<string, string>;
}

export interface PublicFetchResult {
  data: Uint8Array;
  finalUrl: string;
  contentType: string;
}

export function validateHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new Error("url must be an http(s) URL with a hostname");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname
  ) {
    throw new Error("url must be an http(s) URL with a hostname");
  }
  if (url.username || url.password) {
    throw new Error("credentialed URLs are not supported");
  }
  return url;
}

export function normalizedWebUrl(input: string): string {
  const url = validateHttpUrl(input);
  url.hash = "";
  url.username = "";
  url.password = "";
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length === 0) url.pathname = "/";
  return url.toString();
}

function ipv4Number(address: string): number | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  return (
    ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]
  );
}

function ipv4In(address: number, base: string, bits: number): boolean {
  const baseNumber = ipv4Number(base) as number;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (baseNumber & mask);
}

function parseIpv6(address: string): bigint | null {
  let value = address.toLowerCase().split("%")[0];
  if (isIP(value) !== 6) return null;
  const mappedMatch = value.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) {
    const ipv4 = ipv4Number(mappedMatch[2]);
    if (ipv4 === null) return null;
    value = `${mappedMatch[1]}${((ipv4 >>> 16) & 0xffff).toString(16)}:${(
      ipv4 & 0xffff
    ).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const group of groups) {
    const parsed = Number.parseInt(group || "0", 16);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff) return null;
    result = (result << 16n) | BigInt(parsed);
  }
  return result;
}

function ipv6In(address: bigint, base: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return bits === 0 || address >> shift === base >> shift;
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const BLOCKED_V6: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

export function isPublicAddress(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== null) {
    return !BLOCKED_V4.some(([base, bits]) => ipv4In(v4, base, bits));
  }
  const v6 = parseIpv6(address);
  if (v6 === null) return false;
  const globalUnicast = parseIpv6("2000::") as bigint;
  if (!ipv6In(v6, globalUnicast, 3)) return false;
  return !BLOCKED_V6.some(([base, bits]) =>
    ipv6In(v6, parseIpv6(base) as bigint, bits),
  );
}

function mappedIpv4(address: string): string | null {
  const match = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return match?.[1] ?? null;
}

export function addressesEqual(first: string, second: string): boolean {
  const firstMapped = mappedIpv4(first);
  const secondMapped = mappedIpv4(second);
  if (firstMapped || secondMapped) {
    return (firstMapped ?? first) === (secondMapped ?? second);
  }
  const firstV6 = parseIpv6(first);
  const secondV6 = parseIpv6(second);
  if (firstV6 !== null || secondV6 !== null) {
    return firstV6 !== null && secondV6 !== null && firstV6 === secondV6;
  }
  return first === second;
}

export const defaultDnsResolver: DnsResolver = async (hostname, _port) => {
  const bareHost = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bareHost)) return [bareHost];
  const rows = await lookup(bareHost, { all: true, verbatim: true });
  return rows.map((row) => row.address);
};

function hostAndPort(url: URL): { hostname: string; port: number } {
  return {
    hostname: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
  };
}

async function resolveVettedAddresses(
  input: string,
  resolver: DnsResolver,
): Promise<{ url: URL; addresses: string[] }> {
  const url = validateHttpUrl(input);
  const { hostname, port } = hostAndPort(url);
  if (
    hostname === "localhost" ||
    hostname === "ip6-localhost" ||
    hostname.endsWith(".local")
  ) {
    throw new Error("private/internal hostname is blocked");
  }
  let addresses: string[];
  try {
    addresses = await resolver(hostname, port);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DNS lookup failed: ${message}`);
  }
  const unique = [...new Set(addresses)];
  if (unique.length === 0) throw new Error("DNS lookup returned no addresses");
  for (const address of unique) {
    if (!isPublicAddress(address)) {
      throw new Error(`private/internal address blocked: ${address}`);
    }
  }
  return { url, addresses: unique };
}

export async function assertSafePublicUrl(
  input: string,
  resolver: DnsResolver = defaultDnsResolver,
): Promise<URL> {
  return (await resolveVettedAddresses(input, resolver)).url;
}

function responseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined)
      output[name.toLowerCase()] = Array.isArray(value)
        ? value.join(", ")
        : value;
  }
  return output;
}

function redirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

const REMOTE_ADDRESS_MISMATCH =
  "connected socket address did not match the vetted endpoint";

/** Production transport: hostname is an already-vetted IP, never the original DNS name. */
export const pinnedNodeTransport: PinnedTransport = async (input) => {
  const originalHostname = input.url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(input.address);
  if (family !== 4 && family !== 6)
    throw new Error("selected endpoint is not an IP address");
  const { port } = hostAndPort(input.url);

  return await new Promise<PinnedTransportResponse>((resolve, reject) => {
    let settled = false;
    let response: import("node:http").IncomingMessage | undefined;
    let absoluteTimer: ReturnType<typeof setTimeout> | undefined;
    let request: import("node:http").ClientRequest | undefined;
    const transportDeadline = Date.now() + input.timeoutMs;

    const clearAbsoluteTimer = (): void => {
      if (absoluteTimer !== undefined) {
        clearTimeout(absoluteTimer);
        absoluteTimer = undefined;
      }
    };
    const finishError = (error: Error, destroy = false): void => {
      if (settled) return;
      settled = true;
      clearAbsoluteTimer();
      if (destroy) {
        response?.destroy(error);
        request?.socket?.destroy(error);
        request?.destroy(error);
      }
      reject(error);
    };
    const finishResponse = (result: PinnedTransportResponse): void => {
      if (settled) return;
      settled = true;
      clearAbsoluteTimer();
      resolve(result);
    };
    const requestOptions = {
      protocol: input.url.protocol,
      hostname: input.address,
      port,
      method: "GET",
      path: `${input.url.pathname}${input.url.search}`,
      headers: input.headers,
      family,
      agent: false,
      lookup: (
        _hostname: string,
        _options: unknown,
        callback: (
          error: Error | null,
          address: string,
          family: number,
        ) => void,
      ) => callback(null, input.address, family),
    };
    const onResponse = (
      incoming: import("node:http").IncomingMessage,
    ): void => {
      response = incoming;
      // Bun's node:http compatibility layer may not expose remoteAddress even
      // though this request connects with the vetted IP as both hostname and
      // custom lookup result. Verify the observed address when available;
      // otherwise the directly pinned endpoint remains authoritative.
      const remoteAddress = incoming.socket.remoteAddress || input.address;
      if (
        !addressesEqual(remoteAddress, input.address) ||
        !isPublicAddress(remoteAddress)
      ) {
        finishError(new Error(REMOTE_ADDRESS_MISMATCH), true);
        return;
      }
      const status = incoming.statusCode ?? 0;
      const headers = responseHeaders(incoming.headers);
      if (redirectStatus(status) || status < 200 || status >= 300) {
        finishResponse({
          status,
          headers,
          data: new Uint8Array(),
          remoteAddress,
        });
        incoming.destroy();
        return;
      }
      const declared = Number(headers["content-length"]);
      if (Number.isFinite(declared) && declared > input.maxBytes) {
        finishError(
          new Error(`response is larger than max_bytes (${input.maxBytes})`),
          true,
        );
        return;
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      incoming.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > input.maxBytes) {
          finishError(
            new Error(`response is larger than max_bytes (${input.maxBytes})`),
            true,
          );
          return;
        }
        chunks.push(new Uint8Array(chunk));
      });
      incoming.on("end", () => {
        if (settled) return;
        const data = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.byteLength;
        }
        finishResponse({ status, headers, data, remoteAddress });
      });
      incoming.on("error", finishError);
    };

    absoluteTimer = setTimeout(
      () => finishError(new Error("URL fetch timed out"), true),
      Math.max(0, transportDeadline - Date.now()),
    );
    try {
      request =
        input.url.protocol === "https:"
          ? httpsRequest(
              {
                ...requestOptions,
                servername: isIP(originalHostname)
                  ? undefined
                  : originalHostname,
                rejectUnauthorized: true,
                checkServerIdentity: (_hostname, certificate) =>
                  checkServerIdentity(originalHostname, certificate),
              },
              onResponse,
            )
          : httpRequest(requestOptions, onResponse);
      request.setTimeout(input.timeoutMs, () =>
        finishError(new Error("URL fetch timed out"), true),
      );
      request.on("error", finishError);
      request.end();
    } catch (error) {
      finishError(
        error instanceof Error ? error : new Error(String(error)),
        true,
      );
    }
  });
};

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("URL fetch timed out");
  return remaining;
}

async function beforeDeadline<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = remainingTime(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("URL fetch timed out")),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const RETRYABLE_TRANSPORT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTCONN",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_SOCKET_CLOSED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

function isRemoteAddressMismatch(error: unknown): boolean {
  return error instanceof Error && error.message === REMOTE_ADDRESS_MISMATCH;
}

function isRetryableTransportError(error: unknown): boolean {
  if (isRemoteAddressMismatch(error)) return false;
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (
    RETRYABLE_TRANSPORT_CODES.has(code) ||
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("CERT_") ||
    code.startsWith("DEPTH_ZERO_") ||
    code.startsWith("UNABLE_TO_")
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|TLS|SSL|certificate)\b/i.test(
      message,
    ) ||
    /\b(?:connect(?:ion)?|network|socket)\b.*\b(?:closed|error|failed|failure|hang up|refused|reset|timed? ?out|unreachable)\b/i.test(
      message,
    )
  );
}

/** Resolve every hop, try its vetted IPs in order, and manually follow redirects. */
export async function fetchPublicUrl(
  input: string,
  options: PublicFetchOptions,
): Promise<PublicFetchResult> {
  const resolver = options.resolver ?? defaultDnsResolver;
  const transport = options.transport ?? pinnedNodeTransport;
  const maxRedirects = options.maxRedirects ?? 5;
  const deadline = Date.now() + (options.timeoutMs ?? 25_000);
  let current = validateHttpUrl(input).toString();

  for (let redirects = 0; ; redirects += 1) {
    const vetted = await beforeDeadline(
      resolveVettedAddresses(current, resolver),
      deadline,
    );
    const customHeaders = Object.fromEntries(
      Object.entries(options.headers ?? {}).filter(
        ([name]) => !["host", "accept-encoding"].includes(name.toLowerCase()),
      ),
    );
    const headers = {
      "user-agent": "AgentbrainResearchIndex/0.2 (+local personal research)",
      accept:
        "text/html,application/xhtml+xml,application/pdf,text/plain,*/*;q=0.8",
      ...customHeaders,
      host: vetted.url.host,
      "accept-encoding": "identity",
    };
    let response: PinnedTransportResponse | undefined;
    for (const [index, selectedAddress] of vetted.addresses.entries()) {
      try {
        response = await beforeDeadline(
          transport({
            url: vetted.url,
            address: selectedAddress,
            headers,
            maxBytes: options.maxBytes,
            timeoutMs: remainingTime(deadline),
          }),
          deadline,
        );
      } catch (error) {
        if (
          isRemoteAddressMismatch(error) ||
          !isRetryableTransportError(error) ||
          index === vetted.addresses.length - 1
        ) {
          throw error;
        }
        continue;
      }
      if (
        !addressesEqual(response.remoteAddress, selectedAddress) ||
        !isPublicAddress(response.remoteAddress)
      ) {
        throw new Error(REMOTE_ADDRESS_MISMATCH);
      }
      break;
    }
    if (response === undefined) throw new Error("no vetted endpoint succeeded");
    if (response.data.byteLength > options.maxBytes) {
      throw new Error(
        `response is larger than max_bytes (${options.maxBytes})`,
      );
    }
    if (redirectStatus(response.status)) {
      if (redirects >= maxRedirects) throw new Error("too many URL redirects");
      const location = response.headers.location;
      if (!location)
        throw new Error("redirect response has no Location header");
      current = new URL(location, current).toString();
      validateHttpUrl(current);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status} fetching URL`);
    }
    const contentEncoding = (response.headers["content-encoding"] ?? "")
      .trim()
      .toLowerCase();
    if (contentEncoding && contentEncoding !== "identity") {
      throw new Error(`unsupported Content-Encoding: ${contentEncoding}`);
    }
    return {
      data: response.data,
      finalUrl: current,
      contentType: (response.headers["content-type"] ?? "")
        .split(";", 1)[0]
        .toLowerCase(),
    };
  }
}
