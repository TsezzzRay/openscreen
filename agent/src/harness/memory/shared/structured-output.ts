export type JsonSchema = Record<string, unknown>;

export function strictJsonText<TSchema extends JsonSchema>(
  name: string,
  schema: TSchema,
) {
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,63})$/.test(name)) {
    throw new Error(`Invalid structured-output schema name: ${name}`);
  }
  return {
    format: {
      type: "json_schema" as const,
      name,
      strict: true,
      schema,
    },
  };
}
