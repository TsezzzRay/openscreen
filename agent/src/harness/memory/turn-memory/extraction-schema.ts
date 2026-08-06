export const TURN_MEMORY_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    raw_memory: { type: "string", maxLength: 12_000 },
    turn_summary: { type: "string", maxLength: 4_000 },
    turn_slug: {
      type: "string",
      maxLength: 96,
      pattern: "^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$",
    },
  },
  required: ["raw_memory", "turn_summary", "turn_slug"],
  additionalProperties: false,
} as const;
