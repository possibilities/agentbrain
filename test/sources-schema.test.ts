import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSourcesSchema,
  renderSourcesSchema,
} from "../scripts/generate-sources-schema";
import {
  MANIFEST_KEYS,
  SOURCE_DEFINITION_KEYS,
  sourceManifestFileSchema,
} from "../src/source-manifest-schema";

const REPO = join(import.meta.dir, "..");
const SCHEMA_PATH = join(REPO, "config", "sources.schema.json");

test("config/sources.schema.json matches the generator (fix with `bun run generate:schema`)", () => {
  // Byte-for-byte: the emitted file is the formatter, so drift in content or
  // rendering both fail here.
  expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(renderSourcesSchema());
});

test("the generated schema keeps its contract: strict where repo-owned, open payload", () => {
  const schema = buildSourcesSchema() as Record<string, unknown>;
  expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
  expect(schema.title).toBe("agentbrain source manifest");
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toEqual(["schema_version", "sources"]);

  const top = schema.properties as Record<string, Record<string, unknown>>;
  expect(Object.keys(top)).toEqual(["$schema", ...MANIFEST_KEYS]);
  expect(top.schema_version).toMatchObject({ const: 1 });

  const sources = top.sources as {
    maxItems: number;
    items: Record<string, unknown>;
  };
  expect(sources.maxItems).toBe(1000);
  const definition = sources.items;
  expect(definition.additionalProperties).toBe(false);
  const definitionProps = definition.properties as Record<
    string,
    Record<string, unknown>
  >;
  expect(Object.keys(definitionProps)).toEqual([...SOURCE_DEFINITION_KEYS]);

  // The payload subtree forwards to the fetchers and stays open.
  expect(definitionProps.payload?.additionalProperties).toBe(true);
  // The alias-bearing sections are repo-owned and strict.
  expect(definitionProps.schedule?.additionalProperties).toBe(false);
  expect(definitionProps.limits?.additionalProperties).toBe(false);
  expect(definitionProps.sensitivity?.enum).toEqual([
    "public",
    "normal",
    "sensitive",
    "private",
  ]);
});

test("the published schema accepts the bundled manifest verbatim, $schema included", () => {
  const bundled = JSON.parse(
    readFileSync(join(REPO, "config", "sources.json"), "utf8"),
  );
  const parsed = sourceManifestFileSchema.safeParse(bundled);
  expect(parsed.success).toBe(true);
});
