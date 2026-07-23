import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseTopLevel } from "../src/args";

test("database selection defaults to the Agentbrain namespace", () => {
  const home = "/tmp/agentbrain-args-home";
  const parsed = parseTopLevel(["stats"], { HOME: home });
  expect(parsed.globals.dbPath).toBe(
    join(home, ".local", "share", "agentbrain", "research.db"),
  );
  expect(parsed.usesDefaultDb).toBeTrue();
});

test("AGENTBRAIN_DB overrides the default and expands home", () => {
  const parsed = parseTopLevel(["stats"], {
    HOME: "/tmp/agentbrain-home",
    AGENTBRAIN_DB: "~/override.db",
  });
  expect(parsed.globals.dbPath).toBe("/tmp/agentbrain-home/override.db");
  expect(parsed.usesDefaultDb).toBeFalse();
});

test("--db overrides AGENTBRAIN_DB", () => {
  const parsed = parseTopLevel(["--db", "~/argument.db", "stats"], {
    HOME: "/tmp/agentbrain-home",
    AGENTBRAIN_DB: "~/environment.db",
  });
  expect(parsed.globals.dbPath).toBe("/tmp/agentbrain-home/argument.db");
  expect(parsed.usesDefaultDb).toBeFalse();
});
