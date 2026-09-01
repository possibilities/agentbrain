/**
 * The generated MCP surface.
 *
 * Two halves, and both matter. The mapping is checked in process against
 * `mcp-tools.ts` — what becomes a tool, what is suppressed, and how each
 * constraint lands in the schema. Then a real `agentbrain mcp` is spawned and
 * driven over stdio by a real MCP client: initialize, tools/list, tools/call.
 * A mapping that is only unit-tested is a mapping that has never once been
 * spoken to.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as z4mini from "zod/v4-mini";
import { AGENT_CONTRACT, isGroup, walkCommands } from "../src/contract";
import {
  ANNOTATION_EXCEPTIONS,
  agentTools,
  serverInstructions,
} from "../src/mcp-tools";
import { ResearchStore } from "../src/store";

const MAIN = join(import.meta.dir, "..", "src", "cli.ts");
const TOOLS = agentTools();
const LEAVES = walkCommands()
  .filter((node) => !isGroup(node.command))
  .map((node) => ({ path: node.path.join(" "), leaf: node.command }));

/** The advertised JSON Schema, as a host sees it after the SDK converts. */
function schemaOf(name: string): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return z4mini.toJSONSchema(tool.input, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;
}

function propertiesOf(name: string): Record<string, Record<string, unknown>> {
  return (schemaOf(name)["properties"] ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
}

/** The contract's own claim that a timed-out wait preserves the job — the fact
 * the instructions paragraph is generated from. */
function submissionContractSaysWaitIsSafe(): boolean {
  const model = (AGENT_CONTRACT.concepts.model ?? {}) as Record<
    string,
    unknown
  >;
  const submission = (model["submission_contract"] ?? {}) as Record<
    string,
    unknown
  >;
  return submission["wait_timeout_preserves_job"] === true;
}

describe("which commands become tools", () => {
  test("exactly the agent leaves, and every one of them", () => {
    const wanted = LEAVES.filter(({ leaf }) => leaf.audience === "agent").map(
      ({ path }) => path.replace(/ /g, "_"),
    );
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual([...wanted].sort());
    expect(wanted.length).toBe(15);
  });

  test("no meta verb and no alias reaches the surface", () => {
    const exposed = new Set(TOOLS.map((tool) => tool.name));
    // help and prompt print text about the CLI; every tool already carries its
    // own description and the server's instructions carry the runbook.
    expect(exposed.has("help")).toBe(false);
    expect(exposed.has("prompt")).toBe(false);
    // ingest is submit's older spelling, not a second verb to choose between.
    expect(exposed.has("ingest")).toBe(false);
    expect(exposed.has("submit")).toBe(true);
    expect(exposed.has("guide")).toBe(true);
  });

  test("no operator or internal leaf is exposed, mcp included", () => {
    const exposed = new Set(TOOLS.map((tool) => tool.name));
    const hidden = LEAVES.filter(({ leaf }) => leaf.audience !== "agent");
    expect(hidden.map(({ path }) => path)).toContain("mcp");
    expect(hidden.map(({ path }) => path)).toContain("worker");
    for (const { path } of hidden)
      expect(exposed.has(path.replace(/ /g, "_"))).toBe(false);
  });

  test("mcp declares itself internal, mutating, and blocking", () => {
    const mcp = AGENT_CONTRACT.commands.find(
      (command) => command.name === "mcp",
    );
    expect(mcp).toBeDefined();
    expect(mcp?.audience).toBe("internal");
    expect(mcp?.mutates).toBe(true);
    expect(mcp?.blocking).toBe(true);
  });

  test("a nested leaf is named by its full path, joined with an underscore", () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toContain("jobs_list");
    expect(names).toContain("sources_status");
    // A sibling of an exposed leaf is judged on its own audience.
    expect(names).not.toContain("jobs_retry");
    // Never prefixed with the CLI name: the host namespaces by server.
    expect(names.every((name) => !name.startsWith("agentbrain"))).toBe(true);
  });
});

describe("the input schema", () => {
  test("every global is suppressed, because none of them is a call knob", () => {
    for (const global of AGENT_CONTRACT.global_arguments) {
      expect([global.name, global.role ?? "call"]).not.toEqual([
        global.name,
        "call",
      ]);
    }
    for (const tool of TOOLS) {
      const properties = Object.keys(propertiesOf(tool.name));
      for (const global of AGENT_CONTRACT.global_arguments) {
        expect(properties).not.toContain(global.name.replace(/^--/, ""));
      }
    }
  });

  test("the two spellings of a query collapse to one property", () => {
    for (const name of ["search", "context"]) {
      const properties = propertiesOf(name);
      expect(Object.keys(properties)).toContain("query");
      expect(properties["query"]?.["type"]).toBe("string");
      expect(String(properties["query"]?.["description"])).toContain("--query");
      // Required, because the contract's one_of over the two spellings is no
      // longer a choice once they are one property.
      expect(schemaOf(name)["required"]).toContain("query");
      expect(schemaOf(name)["oneOf"]).toBeUndefined();
    }
  });

  test("a csv argument says every entry is comma-joined", () => {
    const submit = propertiesOf("submit");
    expect(submit["tags"]?.["type"]).toBe("array");
    expect(String(submit["tags"]?.["description"])).toContain("comma-joined");
    // A repeatable flag without csv is an array too, and is repeated instead.
    expect(submit["tag"]?.["type"]).toBe("array");
    expect(String(submit["tag"]?.["description"])).not.toContain(
      "comma-joined",
    );
  });

  test("choices become an enum, a default a default, a bound a bound", () => {
    const search = propertiesOf("search");
    expect(search["mode"]?.["enum"]).toEqual(["any", "all", "raw"]);
    expect(search["mode"]?.["default"]).toBe("any");
    expect(search["limit"]?.["type"]).toBe("integer");
    expect(search["limit"]?.["minimum"]).toBe(1);
    expect(search["limit"]?.["maximum"]).toBe(50);
    const context = propertiesOf("context");
    expect(context["max-chars"]?.["minimum"]).toBe(500);
    expect(context["max-chars"]?.["maximum"]).toBe(50000);
  });

  test("a bound the CLI enforces reaches the schema, on every tool", () => {
    // A bound enforced in code but absent from the contract is a bound the
    // generated tool lets a caller violate, so the contract's own numbers are
    // the assertion: every one of them has to land in the advertised schema.
    let checked = 0;
    for (const tool of TOOLS) {
      const properties = propertiesOf(tool.name);
      for (const argument of tool.arguments) {
        const property = properties[argument.name.replace(/^--/, "")];
        if (property === undefined) continue;
        if (argument.minimum !== undefined) {
          expect([tool.name, argument.name, property["minimum"]]).toEqual([
            tool.name,
            argument.name,
            argument.minimum,
          ]);
          checked += 1;
        }
        if (argument.maximum !== undefined) {
          expect([tool.name, argument.name, property["maximum"]]).toEqual([
            tool.name,
            argument.name,
            argument.maximum,
          ]);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test("the ledger's own bounds are the ones the CLI refuses past", () => {
    const jobs = propertiesOf("jobs_list");
    expect(jobs["limit"]?.["minimum"]).toBe(1);
    expect(jobs["limit"]?.["maximum"]).toBe(1000);
    expect(propertiesOf("jobs_show")["job-id"]?.["minimum"]).toBe(1);
    // A wait budget of zero is legal — it observes nothing and returns.
    expect(propertiesOf("submit")["wait-timeout-ms"]?.["minimum"]).toBe(0);
  });

  test("a required argument is required", () => {
    expect(schemaOf("submit")["required"]).toContain("source");
    expect(schemaOf("delete")["required"]).toContain("confirm");
    expect(schemaOf("jobs_show")["required"]).toContain("job-id");
  });
});

describe("constraints", () => {
  test("a required one_of becomes oneOf, and is said in the description", () => {
    expect(schemaOf("get")["oneOf"]).toEqual([
      { required: ["document-id"] },
      { required: ["chunk-id"] },
      { required: ["source-uri"] },
    ]);
    const get = TOOLS.find((tool) => tool.name === "get");
    expect(get?.description).toContain(
      "exactly one of document-id, chunk-id, source-uri",
    );
  });

  test("delete's selector rule reaches the caller both ways", () => {
    expect(schemaOf("delete")["oneOf"]).toEqual([
      { required: ["document-id"] },
      { required: ["source-uri"] },
    ]);
    expect(TOOLS.find((tool) => tool.name === "delete")?.description).toContain(
      "exactly one of document-id, source-uri",
    );
  });
});

describe("descriptions", () => {
  test("a blocking command says so first, before anything else", () => {
    for (const tool of TOOLS) {
      expect([tool.name, tool.description.startsWith("Blocks:")]).toEqual([
        tool.name,
        tool.leaf.blocking === true,
      ]);
    }
    expect(
      TOOLS.find((tool) => tool.name === "submit")?.description,
    ).toStartWith("Blocks:");
  });

  test("per-command guidance lands in the tool that owns it", () => {
    const submit = TOOLS.find((tool) => tool.name === "submit");
    expect(submit?.description).toContain("status queued");
    expect(submit?.description).toContain("already_indexed");
    expect(submit?.description).toContain("never searchable");
    expect(
      TOOLS.find((tool) => tool.name === "context")?.description,
    ).toContain("first move");
  });
});

describe("annotations", () => {
  const annotationsOf = (name: string) =>
    TOOLS.find((tool) => tool.name === name)?.annotations ?? {};

  test("readOnlyHint is the contract's own mutates judgment", () => {
    for (const tool of TOOLS) {
      expect(tool.annotations.readOnlyHint).toBe(tool.leaf.mutates === false);
    }
    expect(annotationsOf("search")).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
    });
  });

  test("a removing verb is destructive and durable admission is not", () => {
    expect(annotationsOf("delete")).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    // An equivalent intent comes back `duplicate` with the same job_id rather
    // than queuing a second one, which is what idempotent means here.
    expect(annotationsOf("submit")).toMatchObject({
      destructiveHint: false,
      idempotentHint: true,
    });
    // Every reveal appends an audit record, so a second call is not a no-op.
    expect(annotationsOf("jobs_show")).toMatchObject({ idempotentHint: false });
  });

  test("nothing served here reaches the network", () => {
    // Admission performs no network work; the worker fetches, and it is
    // operator-audience.
    for (const tool of TOOLS)
      expect(tool.annotations.openWorldHint).toBe(false);
  });

  test("the mapping's exception lists name commands that exist", () => {
    const paths = new Set(TOOLS.map((tool) => tool.path.join(" ")));
    for (const path of ANNOTATION_EXCEPTIONS.appending)
      expect(paths.has(path)).toBe(true);
    for (const path of ANNOTATION_EXCEPTIONS.network)
      expect(paths.has(path)).toBe(true);
  });
});

describe("the server's instructions", () => {
  const instructions = serverInstructions();

  test("carry the guidance, the envelope, every error code, and the opening moves", () => {
    expect(instructions).toContain(AGENT_CONTRACT.guidance);
    expect(instructions).toContain("schema_version");
    for (const entry of AGENT_CONTRACT.concepts.error_codes) {
      expect(instructions).toContain(entry.code);
      if (entry.recovery !== undefined)
        expect(instructions).toContain(entry.recovery);
    }
    for (const line of AGENT_CONTRACT.concepts.agent_defaults ?? [])
      expect(instructions).toContain(line);
  });

  test("say that submission is asynchronous, because a caller assumes otherwise", () => {
    expect(instructions).toContain(
      "never expect a submitted URL to be searchable immediately",
    );
    expect(instructions).toContain("context");
  });

  test("name the three admission statuses, so none of them reads as a failure", () => {
    const submission = (
      (AGENT_CONTRACT.concepts.model ?? {}) as Record<string, unknown>
    )["submission_contract"] as Record<string, unknown>;
    for (const key of [
      "new_status",
      "replay_status",
      "indexed_url_status",
      "indexed_url_force_flag",
    ]) {
      expect(instructions).toContain(String(submission[key]));
    }
    expect(instructions).toContain("successful acknowledgements");
    expect(instructions).toContain("names an existing document");
  });

  test("say a wait timeout is an observation, not a lost submission", () => {
    expect(submissionContractSaysWaitIsSafe()).toBe(true);
    expect(instructions).toContain("Waiting is observation only");
    expect(instructions).toContain("the durable job");
    expect(instructions).toContain("instead of resubmitting");
  });
});

/**
 * The round trip. A real server process, a real client, a real handshake — the
 * one thing that cannot be faked by agreeing with the mapping module.
 */
describe("a live stdio server", () => {
  let directory: string;
  let dbPath: string;
  let client: Client;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentbrain-mcp-"));
    dbPath = join(directory, "research.db");
    // A real index, initialized the way every other write path initializes one.
    new ResearchStore(dbPath).db.close();
    client = new Client({ name: "agentbrain-test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [MAIN, "mcp", "--db", dbPath],
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("initialize names the CLI and hands back the contract's instructions", () => {
    expect(client.getServerVersion()?.name).toBe("agentbrain");
    expect(client.getInstructions() ?? "").toContain(
      "sole durable ingestion authority",
    );
  });

  test("tools/list is exactly the agent leaves the mapping generated", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      TOOLS.map((tool) => tool.name).sort(),
    );
    expect(tools.map((tool) => tool.name)).toContain("jobs_list");
    expect(tools.map((tool) => tool.name)).not.toContain("mcp");
    expect(tools.map((tool) => tool.name)).not.toContain("worker");
    expect(tools.map((tool) => tool.name)).not.toContain("jobs_retry");
  });

  test("a read-only tool returns the CLI's own envelope", async () => {
    const result = (await client.callTool({
      name: "stats",
      arguments: {},
    })) as { isError?: boolean; content: { type: string; text: string }[] };
    expect(result.isError ?? false).toBe(false);
    const envelope = JSON.parse(result.content[0]?.text ?? "");
    expect(envelope).toMatchObject({
      schema_version: 1,
      ok: true,
      command: "stats",
    });
    expect(envelope.data.document_count).toBe(0);
    expect(envelope.meta.db_path).toBe(dbPath);
  });

  test("a search runs against the served index and finds nothing yet", async () => {
    const result = (await client.callTool({
      name: "search",
      arguments: { query: "transformer scaling" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError ?? false).toBe(false);
    const envelope = JSON.parse(result.content[0]?.text ?? "");
    expect(envelope.ok).toBe(true);
    expect(envelope.data.results).toEqual([]);
  });

  test("submission is durable and asynchronous, exactly as the tool says", async () => {
    const submitted = (await client.callTool({
      name: "submit",
      arguments: {
        source: "Sparse attention notes for the MCP round trip.",
        kind: "text",
        tags: ["attention", "mcp"],
      },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(submitted.isError ?? false).toBe(false);
    const envelope = JSON.parse(submitted.content[0]?.text ?? "");
    expect(envelope.ok).toBe(true);
    expect(envelope.data.status).toBe("queued");
    const jobId = envelope.data.job_id;
    expect(typeof jobId).toBe("number");

    // The nested tool sees the queued job, and nothing is searchable until a
    // worker leases it — which is the whole reason that warning is in the
    // instructions.
    const listed = (await client.callTool({
      name: "jobs_list",
      arguments: {},
    })) as { content: { text: string }[] };
    const jobs = JSON.parse(listed.content[0]?.text ?? "");
    expect(jobs.data.map((job: { id: number }) => job.id)).toContain(jobId);

    const searched = (await client.callTool({
      name: "search",
      arguments: { query: "sparse attention" },
    })) as { content: { text: string }[] };
    expect(JSON.parse(searched.content[0]?.text ?? "").data.results).toEqual(
      [],
    );

    // The same intent again is the same job, which is why submit is annotated
    // idempotent rather than appending.
    const again = (await client.callTool({
      name: "submit",
      arguments: {
        source: "Sparse attention notes for the MCP round trip.",
        kind: "text",
        tags: ["attention", "mcp"],
      },
    })) as { content: { text: string }[] };
    const replay = JSON.parse(again.content[0]?.text ?? "");
    expect(replay.data.status).toBe("duplicate");
    expect(replay.data.job_id).toBe(jobId);
  });

  /**
   * The distinction the instructions promise, proved rather than asserted.
   *
   * At a terminal a wait observation that runs out is exit 124 — deliberately
   * not 1, because the durable run continues. Over MCP there is no exit code,
   * and the danger is that the timeout arrives looking like a failure and the
   * caller resubmits work that was never lost. It must come back a SUCCESS
   * carrying `wait_status: timeout`, with the job still queued and findable in
   * the ledger.
   *
   * No worker runs in this test, so a zero budget observes nothing and returns
   * immediately — the timeout path without a sleep.
   */
  test("a wait that times out is a success, not a lost submission", async () => {
    const result = (await client.callTool({
      name: "submit",
      arguments: {
        source: "Wait-timeout probe for the MCP round trip.",
        kind: "text",
        wait: true,
        "wait-timeout-ms": 0,
      },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError ?? false).toBe(false);
    const envelope = JSON.parse(result.content[0]?.text ?? "");
    expect(envelope.ok).toBe(true);
    expect(envelope.data.wait_status).toBe("timeout");
    // Queued and durable: the observation ended, the work did not.
    expect(envelope.data.status).toBe("queued");
    expect(envelope.data.state).toBe("queued");

    const listed = (await client.callTool({
      name: "jobs_list",
      arguments: {},
    })) as { content: { text: string }[] };
    const jobs = JSON.parse(listed.content[0]?.text ?? "");
    expect(jobs.data.map((job: { id: number }) => job.id)).toContain(
      envelope.data.job_id,
    );
  });

  test("a refusal leads with its code, then the envelope", async () => {
    const result = (await client.callTool({
      name: "get",
      arguments: { "document-id": 1, "chunk-id": 2 },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text.startsWith("bad_selector:")).toBe(true);
    expect(JSON.parse(text.slice(text.indexOf("{")))).toMatchObject({
      ok: false,
      error: { code: "bad_selector" },
    });
  });

  test("a refusal that has a recovery carries it on its own line", async () => {
    const result = (await client.callTool({
      name: "jobs_list",
      arguments: { state: "nonsense" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? "";
    expect(text.startsWith("bad_job_state:")).toBe(true);
    expect(text).toContain("recovery: Use one of:");
    expect(JSON.parse(text.slice(text.indexOf("{"))).error.recovery).toContain(
      "Use one of:",
    );
  });

  test("a value the schema rejects never reaches the CLI", async () => {
    const result = (await client.callTool({
      name: "search",
      arguments: { query: "anything", mode: "fuzzy" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? "").toContain("mode");
  });
});
