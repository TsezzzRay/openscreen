import assert from "node:assert/strict";
import test from "node:test";

import { strictJsonText } from "../../src/harness/memory/shared/structured-output.js";

test("builds a strict Responses JSON schema text format", () => {
  const schema = {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  } as const;

  assert.deepEqual(strictJsonText("chronicle_summary", schema), {
    format: {
      type: "json_schema",
      name: "chronicle_summary",
      strict: true,
      schema,
    },
  });
});

test("rejects invalid structured-output schema names", () => {
  assert.throws(() => strictJsonText("Chronicle summary", {}), /schema name/i);
});
