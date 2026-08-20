import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateShareToken, writeShareToken } from "../src/share";
import {
  clearIngressRegistration,
  defaultIngressRegistrationPath,
  type IngressProbe,
  probeShareIngress,
  readIngressRegistration,
  shareIngressCheck,
  shareUrlFor,
  startIngressLiveness,
  writeIngressRegistration,
} from "../src/share-liveness";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentbrain-liveness-"));
  roots.push(dir);
  return dir;
}

function registration(dir: string, url: string, pid = process.pid) {
  const path = join(dir, "share-ingress.json");
  writeIngressRegistration(path, {
    version: 1,
    url,
    host: "127.0.0.1",
    port: 45_900,
    pid,
    started_at: new Date("2026-08-20T00:00:00.000Z").toISOString(),
  });
  return path;
}

test("the registration is owner-only, round-trips, and is removed on clear", () => {
  const dir = workspace();
  const path = registration(dir, "http://127.0.0.1:45900");

  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readIngressRegistration(path)).toMatchObject({
    url: "http://127.0.0.1:45900",
    port: 45_900,
    pid: process.pid,
  });

  clearIngressRegistration(path);
  expect(readIngressRegistration(path)).toBeNull();
  // Clearing a registration that was already gone is not a failure: a crashed
  // ingress and a clean one must both leave the same absence behind.
  clearIngressRegistration(path);
});

test("an unreadable or malformed registration reads as no ingress at all", () => {
  const dir = workspace();
  const path = join(dir, "share-ingress.json");
  writeFileSync(path, "{not json");
  expect(readIngressRegistration(path)).toBeNull();
  writeFileSync(path, JSON.stringify({ version: 1, host: "127.0.0.1" }));
  expect(readIngressRegistration(path)).toBeNull();
});

test("the default registration path follows HOME and brackets IPv6", () => {
  expect(defaultIngressRegistrationPath("/home/example")).toBe(
    "/home/example/.local/state/agentbrain/share-ingress.json",
  );
  expect(shareUrlFor("100.64.0.1", 8787)).toBe("http://100.64.0.1:8787");
  expect(shareUrlFor("fd7a::1", 8787)).toBe("http://[fd7a::1]:8787");
});

test("the probe answers healthy only for a served request", async () => {
  const token = generateShareToken();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      request.headers.get("authorization") === `Bearer ${token}`
        ? Response.json({ ok: true })
        : new Response("no", { status: 401 }),
  });
  const url = shareUrlFor("127.0.0.1", server.port ?? 0);
  try {
    expect(await probeShareIngress(url, token)).toMatchObject({ ok: true });
    // A wrong token proves the ingress is serving but says nothing good about
    // this caller, so it is a failure with its own code rather than "healthy".
    expect(await probeShareIngress(url, "wrong-token-value")).toMatchObject({
      ok: false,
      code: "http_401",
    });
  } finally {
    server.stop(true);
  }

  // A socket nobody holds: the shape a torn-down ingress leaves behind.
  const dead = await probeShareIngress(shareUrlFor("127.0.0.1", 1), token);
  expect(dead.ok).toBe(false);
  expect(dead.code).toBe("unreachable");
});

test("a socket that accepts and drops every connection reads as unreachable", async () => {
  // The wedge this loop exists for: the listener is up, so connecting works,
  // but no request is ever answered. Only a completed exchange is health.
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (socket) => {
        socket.end();
      },
      data: () => {},
    },
  });
  try {
    const probe = await probeShareIngress(
      shareUrlFor("127.0.0.1", server.port),
      generateShareToken(),
      1_000,
    );
    expect(probe.ok).toBe(false);
    expect(probe.code).toBe("unreachable");
  } finally {
    server.stop(true);
  }
});

test("liveness exits only after sustained failure, and resets on recovery", async () => {
  const outcomes: IngressProbe[] = [];
  const failures: number[] = [];
  const fatals: number[] = [];
  let next: IngressProbe = {
    ok: false,
    code: "unreachable",
    detail: "no answer",
  };

  const liveness = startIngressLiveness({
    intervalMs: 0,
    failureThreshold: 3,
    probe: async () => {
      outcomes.push(next);
      return next;
    },
    onFailure: (_probe, consecutive) => failures.push(consecutive),
    onFatal: (_probe, consecutive) => fatals.push(consecutive),
  });

  await liveness.check();
  await liveness.check();
  expect(fatals).toEqual([]);

  // A flap that recovers must not carry its history into the next outage.
  next = { ok: true, code: "healthy", detail: "answered" };
  await liveness.check();
  next = { ok: false, code: "unreachable", detail: "no answer" };
  await liveness.check();
  await liveness.check();
  expect(fatals).toEqual([]);
  await liveness.check();
  expect(fatals).toEqual([3]);

  // Past the fatal round the loop is done; it must not fire twice.
  const rounds = outcomes.length;
  await liveness.check();
  expect(outcomes.length).toBe(rounds);
  expect(failures).toEqual([1, 2, 1, 2, 3]);
  liveness.stop();
});

test("doctor's ingress check reads absence, a dead pid, and a dead socket", async () => {
  const dir = workspace();
  const tokenPath = join(dir, "share-token");
  writeShareToken(tokenPath, generateShareToken());

  // Opt-in service: no registration is not a defect.
  const absent = await shareIngressCheck({
    registrationPath: join(dir, "absent.json"),
    tokenPath,
  });
  expect(absent).toMatchObject({ name: "share_ingress", status: "ok" });
  expect(absent.detail).toContain("No share ingress registered");

  // A registration whose process is gone is a stale file, not a broken
  // ingress: nothing is holding a socket, so nothing is silently dropping.
  const stale = await shareIngressCheck({
    registrationPath: registration(
      dir,
      "http://127.0.0.1:45900",
      2_147_483_600,
    ),
    tokenPath,
  });
  expect(stale.status).toBe("warning");
  expect(stale.detail).toContain("is not running");

  // The wedge: the process is alive and registered, and it answers nothing.
  const wedged = await shareIngressCheck({
    registrationPath: registration(dir, "http://127.0.0.1:45900"),
    tokenPath,
    probe: async () => ({
      ok: false,
      code: "unreachable",
      detail: "http://127.0.0.1:45900 did not answer (TimeoutError)",
    }),
  });
  expect(wedged.status).toBe("failed");
  expect(wedged.detail).toContain("listening but not serving");

  const healthy = await shareIngressCheck({
    registrationPath: registration(dir, "http://127.0.0.1:45900"),
    tokenPath,
    probe: async () => ({ ok: true, code: "healthy", detail: "answered" }),
  });
  expect(healthy.status).toBe("ok");
});

test("an unreadable token fails the check rather than reporting health", async () => {
  const dir = workspace();
  const check = await shareIngressCheck({
    registrationPath: registration(dir, "http://127.0.0.1:45900"),
    tokenPath: join(dir, "no-such-token"),
    probe: async () => ({ ok: true, code: "healthy", detail: "answered" }),
  });
  expect(check.status).toBe("failed");
  expect(check.detail).toContain("token unreadable");
});
