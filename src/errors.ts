export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly hint?: string;

  constructor(
    code: string,
    message: string,
    options: { exitCode?: number; hint?: string } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
    this.hint = options.hint;
  }
}

export function assertNever(value: never): never {
  throw new Error(`unreachable value: ${String(value)}`);
}
