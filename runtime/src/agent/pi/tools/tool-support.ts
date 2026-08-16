export function unwrapResult<T>(
  result: { ok: true; value: T } | { ok: false; error: Error },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

export function textResult(
  text: string,
  details: Record<string, unknown> = {},
) {
  return { content: [{ type: "text" as const, text }], details };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
