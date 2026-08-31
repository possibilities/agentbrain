import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AGENT_CONTRACT,
  type ContractCommand,
  isGroup,
  walkCommands,
} from "../src/contract";
import { COMMAND_NAMES } from "../src/dispatch";
import { AGENT_HELP, AGENT_TEASER, helpFor, TOP_HELP } from "../src/help";

const REPO = join(import.meta.dir, "..");

const nodes = walkCommands();
const leaves = nodes.filter((node) => !isGroup(node.command));
const groups = nodes.filter((node) => isGroup(node.command));

/**
 * Conformance is this repository's own gate.
 *
 * agentstart owns the schema and validates against it when it is present, but
 * a contract that only agentstart can check is a contract this repository can
 * break silently between fleet installs. The invariants below are the ones a
 * caller depends on, restated as executable assertions here.
 */

test("the contract passes agentstart's validator when it is installed", () => {
  const validator = join(
    homedir(),
    "code",
    "agentstart",
    "scripts",
    "validate-agent-contract.ts",
  );
  if (!Bun.file(validator).size) return;
  const emitted = Bun.spawnSync(
    [process.execPath, "run", join(REPO, "src/cli.ts"), "guide", "--json"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(emitted.exitCode).toBe(0);
  const contractPath = join(
    process.env.TMPDIR ?? "/tmp",
    `agentbrain-contract-${process.pid}.json`,
  );
  Bun.write(contractPath, emitted.stdout);
  const run = Bun.spawnSync(
    [process.execPath, "run", validator, "--file", contractPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(run.stderr.toString() + run.stdout.toString()).toContain(
    "conforms to version 1",
  );
  expect(run.exitCode).toBe(0);
});

test("guide --json emits the contract inside the ordinary envelope", () => {
  const run = Bun.spawnSync(
    [process.execPath, "run", join(REPO, "src/cli.ts"), "guide", "--json"],
    { stdout: "pipe" },
  );
  const envelope = JSON.parse(run.stdout.toString()) as {
    schema_version: number;
    ok: boolean;
    command: string;
    data: typeof AGENT_CONTRACT;
  };
  expect(envelope.schema_version).toBe(1);
  expect(envelope.ok).toBe(true);
  expect(envelope.command).toBe("guide");
  expect(envelope.data.contract_version).toBe(1);
  expect(envelope.data.meta.name).toBe("agentbrain");
  expect(envelope.data.meta.audience).toBe("agent");
  // An agent-facing CLI owes the conceptual layer.
  expect(envelope.data.guidance.length).toBeGreaterThan(0);
  expect(
    envelope.data.concepts.output_contract.exit_codes["124"],
  ).toBeDefined();
});

test("every dispatched command is declared, and every declared one dispatches", () => {
  const declared = AGENT_CONTRACT.commands.map((command) => command.name);
  expect([...COMMAND_NAMES].sort()).toEqual([...declared].sort());
});

test("a group is not invocable and a leaf is fully described", () => {
  for (const { path, command } of groups) {
    expect({
      path: path.join(" "),
      mutates: command.mutates,
      arguments: command.arguments,
    }).toEqual({
      path: path.join(" "),
      mutates: undefined,
      arguments: undefined,
    });
    expect(command.subcommands?.length ?? 0).toBeGreaterThan(0);
  }
  for (const { path, command } of leaves) {
    expect(typeof command.mutates).toBe("boolean");
    expect(Array.isArray(command.arguments)).toBe(true);
    expect(command.summary.length).toBeGreaterThan(0);
    expect(["agent", "operator", "internal"]).toContain(command.audience);
    expect(path.join(" ")).toBeTruthy();
  }
});

test("read_only_commands is exactly the non-mutating leaves, by full path", () => {
  const nonMutating = leaves
    .filter((node) => node.command.mutates === false)
    .map((node) => node.path.join(" "))
    .sort();
  expect(
    [...(AGENT_CONTRACT.concepts.read_only_commands ?? [])].sort(),
  ).toEqual(nonMutating);
});

test("a flag wears its dashes, a positional does not, and direction needs a path", () => {
  const all = [
    ...AGENT_CONTRACT.global_arguments.map((argument) => ({
      where: "global_arguments",
      argument,
    })),
    ...leaves.flatMap((node) =>
      (node.command.arguments ?? []).map((argument) => ({
        where: node.path.join(" "),
        argument,
      })),
    ),
  ];
  for (const { where, argument } of all) {
    const label = `${where}: ${argument.name}`;
    if (argument.positional === true) {
      expect([label, argument.name.startsWith("-")]).toEqual([label, false]);
    } else {
      expect([label, argument.name.startsWith("--")]).toEqual([label, true]);
    }
    if (argument.direction !== undefined) {
      expect([label, argument.format]).toEqual([label, "path"]);
    }
  }
});

test("a constraint names arguments its own command accepts", () => {
  for (const { path, command } of leaves) {
    const names = new Set((command.arguments ?? []).map((a) => a.name));
    for (const constraint of command.constraints ?? []) {
      expect(constraint.arguments.length).toBeGreaterThan(1);
      for (const name of constraint.arguments) {
        expect([`${path.join(" ")}: ${name}`, names.has(name)]).toEqual([
          `${path.join(" ")}: ${name}`,
          true,
        ]);
      }
    }
  }
});

test("no agent command demands stdin, because a caller has no pipe", () => {
  for (const { command } of leaves) {
    if (command.audience !== "agent") continue;
    expect(command.stdin?.required ?? false).toBe(false);
  }
});

test("sibling command names are unique, so every path resolves", () => {
  const byParent = new Map<string, string[]>();
  for (const { path } of nodes) {
    const parent = path.slice(0, -1).join(" ");
    const own = path[path.length - 1] as string;
    byParent.set(parent, [...(byParent.get(parent) ?? []), own]);
  }
  for (const [parent, names] of byParent) {
    expect([parent, names.length]).toEqual([parent, new Set(names).size]);
  }
});

/**
 * The refusal sites in code are the only other place an error code may appear
 * (README: "Authored here once"). This is what keeps that true: a new
 * `new CliError("…")` that nobody documented fails the build.
 */
test("every refusal code a CLI call can surface is documented in the contract", () => {
  // The share ingress answers HTTP with these; they never reach a CLI
  // envelope, so documenting them as CLI error codes would be a lie.
  const httpOnly = new Set([
    "bad_payload",
    "method_not_allowed",
    "payload_too_large",
    "share_failed",
    "unauthorized",
    "unsupported_media_type",
  ]);
  const found = new Set<string>();
  for (const file of readdirSync(join(REPO, "src"))) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(REPO, "src", file), "utf8");
    for (const match of source.matchAll(/new CliError\(\s*"([a-z0-9_]+)"/g)) {
      const code = match[1] as string;
      if (!httpOnly.has(code)) found.add(code);
    }
  }
  const documented = new Set(
    AGENT_CONTRACT.concepts.error_codes.map((entry) => entry.code),
  );
  expect([...found].filter((code) => !documented.has(code)).sort()).toEqual([]);
  // And nothing documented that no longer exists, apart from the envelope's
  // own catch-all for an error that escaped without a code.
  expect(
    [...documented].filter(
      (code) => code !== "unexpected_error" && !found.has(code),
    ),
  ).toEqual([]);
});

test("every help surface is rendered from the contract, not written beside it", () => {
  // Rendered help reflows, so compare against whitespace-normalized text.
  const flat = (text: string) => text.replace(/\s+/g, " ");
  const topHelp = flat(TOP_HELP);
  expect(AGENT_TEASER).toBe(AGENT_CONTRACT.meta.purpose);
  for (const command of AGENT_CONTRACT.commands) {
    expect(topHelp).toContain(command.name);
    expect(topHelp).toContain(flat(command.summary));
  }
  // Guidance reaches the reader rather than sitting only in the JSON.
  expect(flat(AGENT_HELP)).toContain(flat(AGENT_CONTRACT.guidance));
  for (const { path, command } of leaves) {
    const rendered = helpFor(path.join(" "));
    expect(rendered).toContain(`agentbrain ${path.join(" ")}`);
    for (const argument of command.arguments ?? []) {
      expect([path.join(" "), rendered.includes(argument.name)]).toEqual([
        path.join(" "),
        true,
      ]);
    }
  }
  for (const { path, command } of groups) {
    const rendered = helpFor(path.join(" "));
    for (const sub of command.subcommands as ContractCommand[]) {
      expect(rendered).toContain(sub.name);
    }
  }
});

test("help resolves the deepest command a noisy argv still matches", () => {
  expect(helpFor("jobs show 12")).toContain("agentbrain jobs show");
  expect(helpFor("search transformer scaling")).toContain("agentbrain search");
  expect(helpFor(null)).toBe(TOP_HELP);
  expect(helpFor("nonsense")).toBe(TOP_HELP);
});
