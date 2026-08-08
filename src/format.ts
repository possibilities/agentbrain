import {
  type Envelope,
  type ErrorEnvelope,
  type GlobalOptions,
  SCHEMA_VERSION,
} from "./types";

export function envelope<T>(
  command: string,
  data: T,
  globals: GlobalOptions,
  readOnly = true,
): Envelope<T> {
  return {
    schema_version: SCHEMA_VERSION,
    ok: true,
    command,
    data,
    meta: {
      db_path: globals.dbPath,
      read_only: readOnly,
      generated_at: new Date().toISOString(),
    },
  };
}

export function errorEnvelope(
  command: string,
  code: string,
  message: string,
  recovery?: string,
): ErrorEnvelope {
  return {
    schema_version: SCHEMA_VERSION,
    ok: false,
    command,
    error: {
      code,
      message,
      ...(recovery !== undefined ? { recovery } : {}),
    },
  };
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeByFormat<T>(
  command: string,
  data: T,
  globals: GlobalOptions,
  human: (data: T) => string,
  options: {
    jsonl?: (data: T) => unknown[];
    readOnly?: boolean;
  } = {},
): void {
  if (globals.format === "json") {
    writeJson(envelope(command, data, globals, options.readOnly ?? true));
    return;
  }
  if (globals.format === "jsonl") {
    const records = options.jsonl?.(data) ?? [
      envelope(command, data, globals, options.readOnly ?? true),
    ];
    for (const record of records)
      process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }
  process.stdout.write(human(data));
}

export function formatList(
  rows: Array<Record<string, unknown>>,
  columns: string[],
): string {
  if (rows.length === 0) return "(none)\n";
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => String(row[col] ?? "").length)),
  );
  const render = (values: string[]) =>
    values.map((value, i) => value.padEnd(widths[i] ?? 0)).join("  ");
  const lines = [render(columns), render(widths.map((w) => "─".repeat(w)))];
  for (const row of rows)
    lines.push(render(columns.map((col) => String(row[col] ?? ""))));
  return `${lines.join("\n")}\n`;
}
