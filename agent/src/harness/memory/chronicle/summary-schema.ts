export const CHRONICLE_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    activities: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 2_000 },
          source_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1 },
          },
          application: { type: ["string", "null"], maxLength: 500 },
          window_title: { type: ["string", "null"], maxLength: 500 },
        },
        required: ["summary", "source_ids", "application", "window_title"],
        additionalProperties: false,
      },
    },
    source_summary: { type: "string", minLength: 1, maxLength: 4_000 },
  },
  required: ["activities", "source_summary"],
  additionalProperties: false,
} as const;
