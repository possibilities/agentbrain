/**
 * Generates `config/sources.schema.json` from the zod schema in
 * `src/source-manifest-schema.ts` — the same schema the loader validates
 * manifests with, so the published file cannot drift from what
 * `sources apply` accepts. The schema is the manifest surface's
 * documentation, and this generator refuses to emit an undocumented key.
 *
 * Regenerate with `bun run generate:schema`. `test/sources-schema.test.ts`
 * fails when the checked-in file drifts from this source.
 */
import { join } from "node:path";
import { z } from "zod";
import { sourceManifestFileSchema } from "../src/source-manifest-schema.ts";

const TITLE = "agentbrain source manifest";
const DESCRIPTION =
  "A versioned, declarative manifest of external Sources for `agentbrain sources apply`, which durably creates or updates matching Source definitions. The repo bundles one at config/sources.json as the documented example — one disabled Source per supported kind — and an operator may pass their own with --manifest. Applying a manifest never fetches anything and never deletes a definition; enabling a Source is a separate, explicit act. This file is generated from the zod schema in src/source-manifest-schema.ts by `bun run generate:schema` — the same schema the loader validates with — so edit the schema module, never this file. Unrecognised keys are rejected with the key path named, except `$schema` here at the root and the deliberately open payload subtree. Validation faults are bad_source_manifest CliErrors exiting 2, with their own codes for a schema_version mismatch (unsupported_source_manifest_version), a repeated id (duplicate_source_id), and a credential-shaped payload member (source_contains_credential); a malformed URL inside a payload surfaces as an unexpected error exiting 1.";

type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function properties(node: unknown, name: string): Schema {
  if (!isObject(node)) {
    throw new Error(`schema node "${name}" is not an object`);
  }
  const props = node.properties;
  if (!isObject(props)) {
    throw new Error(`schema node "${name}" has no properties`);
  }
  return props;
}

/**
 * zod emits `z.literal(1)` as `{type: "number", const: 1}`; the published
 * schema keeps the historical const-only form. Refuses anything but that
 * exact emission so a changed version constraint is never silently erased.
 */
function constOnly(parent: Schema, key: string): void {
  const node = parent[key];
  if (
    !isObject(node) ||
    node.type !== "number" ||
    node.const !== 1 ||
    typeof node.description !== "string" ||
    Object.keys(node).length !== 3
  ) {
    throw new Error(`"${key}" is no longer the expected literal-1 node`);
  }
  parent[key] = { description: node.description, const: node.const };
}

/**
 * The payload forwards to the kind-specific fetchers with unknown members
 * preserved, so it stays open: zod spells that `additionalProperties: {}`,
 * the published schema keeps the historical `true`. Its documented members
 * ride in from `.meta()` and must all be present and described. Refuses to
 * rewrite a payload that gained real constraints.
 */
function openPayload(parent: Schema): void {
  const node = parent.payload;
  if (!isObject(node) || node.type !== "object") {
    throw new Error("payload is not an object schema");
  }
  const additional = node.additionalProperties;
  const open =
    additional === undefined ||
    additional === true ||
    (isObject(additional) && Object.keys(additional).length === 0);
  if (!open) throw new Error("payload is no longer an open passthrough");
  node.additionalProperties = true;
  properties(node, "payload");
}

/**
 * The loader has always read a null credential_refs as "none stated". The
 * schema models that as an array-or-null union, and the published file keeps
 * documenting the array alone — the historical, intended form. Refuses any
 * union but exactly array-with-items-or-null.
 */
function liftCredentialRefs(parent: Schema): void {
  const node = parent.credential_refs;
  if (
    !isObject(node) ||
    !Array.isArray(node.anyOf) ||
    node.anyOf.length !== 2
  ) {
    throw new Error("credential_refs is no longer the array-or-null union");
  }
  const [arrayBranch, nullBranch] = node.anyOf as [unknown, unknown];
  if (
    !isObject(arrayBranch) ||
    arrayBranch.type !== "array" ||
    !isObject(arrayBranch.items) ||
    !isObject(nullBranch) ||
    nullBranch.type !== "null" ||
    Object.keys(nullBranch).length !== 1
  ) {
    throw new Error("credential_refs is no longer the array-or-null union");
  }
  const { anyOf: _branches, ...annotations } = node;
  parent.credential_refs = { ...annotations, ...arrayBranch };
}

/** The schema is the manifest surface's documentation; every key carries it. */
function assertDocumented(props: Schema, scope: string): void {
  for (const [key, value] of Object.entries(props)) {
    const description = isObject(value) ? value.description : undefined;
    if (typeof description !== "string" || description.length === 0) {
      throw new Error(`schema property "${scope}${key}" has no description`);
    }
  }
}

/**
 * Cosmetic, recursive: description first, then the constraint keywords, in
 * one canonical order so regeneration is byte-stable. Purely a reordering —
 * nothing is added or dropped.
 */
const KEY_ORDER = [
  "description",
  "type",
  "const",
  "enum",
  "additionalProperties",
  "required",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "anyOf",
  "allOf",
  "if",
  "then",
  "items",
  "properties",
];

function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (!isObject(value)) return value;
  const remaining = new Map(Object.entries(value));
  const ordered: Schema = {};
  for (const key of KEY_ORDER) {
    if (remaining.has(key)) {
      ordered[key] = remaining.get(key);
      remaining.delete(key);
    }
  }
  for (const [key, child] of remaining) ordered[key] = child;
  for (const [key, child] of Object.entries(ordered)) {
    // Property bags keep their declared key order; only their values recurse.
    if (key === "properties" && isObject(child)) {
      ordered[key] = Object.fromEntries(
        Object.entries(child).map(([name, node]) => [name, reorder(node)]),
      );
    } else {
      ordered[key] = reorder(child);
    }
  }
  return ordered;
}

/**
 * The "input" io mode is deliberate: the schema describes what a human may
 * write on disk, where optional fields are omittable. The default "output"
 * mode would describe post-parse values instead.
 */
export function buildSourcesSchema(): Schema {
  const generated = z.toJSONSchema(sourceManifestFileSchema, {
    target: "draft-7",
    io: "input",
  }) as Schema;
  const { $schema, ...body } = generated;

  const top = properties(body, "top level");
  constOnly(top, "schema_version");
  const sources = top.sources;
  if (!isObject(sources) || !isObject(sources.items)) {
    throw new Error("sources is no longer an array of definitions");
  }
  const definition = sources.items as Schema;
  const definitionProps = properties(definition, "sources.items");
  openPayload(definitionProps);
  liftCredentialRefs(definitionProps);

  assertDocumented(top, "");
  assertDocumented(definitionProps, "sources.items.");
  assertDocumented(properties(definitionProps.payload, "payload"), "payload.");
  assertDocumented(
    properties(definitionProps.schedule, "schedule"),
    "schedule.",
  );
  assertDocumented(properties(definitionProps.limits, "limits"), "limits.");

  return {
    $schema,
    title: TITLE,
    description: DESCRIPTION,
    ...(reorder(body) as Schema),
  };
}

/** The exact bytes that belong in config/sources.schema.json. */
export function renderSourcesSchema(): string {
  return `${JSON.stringify(buildSourcesSchema(), null, 2)}\n`;
}

if (import.meta.main) {
  const path = join(import.meta.dir, "..", "config", "sources.schema.json");
  await Bun.write(path, renderSourcesSchema());
  console.log(`wrote ${path}`);
}
