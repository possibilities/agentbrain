import { expect, test } from "bun:test";
import {
  fetchPublicUrl,
  isPublicAddress,
  type PinnedTransport,
} from "../src/url-safety";

test("redirect hop rejects a remote address that differs from its fresh vetted pin", async () => {
  const transport: PinnedTransport = async (request) => {
    if (request.url.hostname === "first.example") {
      return {
        status: 302,
        headers: {
          location: "https://second.example/final",
        } as Record<string, string>,
        data: new Uint8Array(),
        remoteAddress: request.address,
      };
    }
    return {
      status: 200,
      headers: {} as Record<string, string>,
      data: new TextEncoder().encode("nope"),
      remoteAddress: "8.8.8.8",
    };
  };
  const result = fetchPublicUrl("https://first.example", {
    maxBytes: 100,
    resolver: async (hostname) =>
      hostname === "first.example" ? ["1.1.1.1"] : ["9.9.9.9"],
    transport,
  });
  await expect(result).rejects.toThrow("did not match the vetted endpoint");
});

test("vetted endpoints are tried in resolver order after connection and TLS failures", async () => {
  const calls: string[] = [];
  const result = await fetchPublicUrl("https://fallback.example/story", {
    maxBytes: 100,
    resolver: async () => ["93.184.216.34", "1.1.1.1", "8.8.8.8"],
    transport: async (request) => {
      calls.push(request.address);
      if (request.address === "93.184.216.34") {
        throw Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
      }
      if (request.address === "1.1.1.1") {
        throw Object.assign(new Error("TLS certificate failed"), {
          code: "ERR_TLS_CERT_ALTNAME_INVALID",
        });
      }
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        data: new TextEncoder().encode("fallback worked"),
        remoteAddress: request.address,
      };
    },
  });
  expect(calls).toEqual(["93.184.216.34", "1.1.1.1", "8.8.8.8"]);
  expect(new TextDecoder().decode(result.data)).toBe("fallback worked");
});

test("remote-address invariant failure never falls back to another endpoint", async () => {
  const calls: string[] = [];
  const result = fetchPublicUrl("https://invariant.example", {
    maxBytes: 100,
    resolver: async () => ["93.184.216.34", "1.1.1.1"],
    transport: async (request) => {
      calls.push(request.address);
      return {
        status: 200,
        headers: {},
        data: new Uint8Array(),
        remoteAddress: "8.8.8.8",
      };
    },
  });
  await expect(result).rejects.toThrow("did not match the vetted endpoint");
  expect(calls).toEqual(["93.184.216.34"]);
});

test("final compressed responses are rejected even within the body bound", async () => {
  const result = fetchPublicUrl("https://encoded.example", {
    maxBytes: 100,
    resolver: async () => ["1.1.1.1"],
    transport: async (request) => ({
      status: 200,
      headers: { "content-encoding": "gzip" },
      data: new Uint8Array([1, 2, 3]),
      remoteAddress: request.address,
    }),
  });
  await expect(result).rejects.toThrow("unsupported Content-Encoding: gzip");
});

test("IPv6 policy blocks protocol assignments and special-use prefixes", () => {
  for (const address of [
    "2001:1::1",
    "2001:1::2",
    "2001:3::",
    "2001:4:112::",
    "2620:4f:8000::",
    "3fff::",
    "5f00::",
  ]) {
    expect(isPublicAddress(address)).toBe(false);
  }
  for (const address of [
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "2a00:1450:4009:81b::200e",
  ]) {
    expect(isPublicAddress(address)).toBe(true);
  }
});
