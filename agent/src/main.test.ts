import assert from "node:assert/strict";
import test from "node:test";

import { getModel, makeRequest } from "./main.js";

test("requires an OpenAI-compatible model", () => {
  assert.equal(getModel({ OPENAI_MODEL: "vision-model" }), "vision-model");
  assert.throws(() => getModel({}), /OPENAI_MODEL is required/);
});

test("builds a provider-neutral screenshot request", () => {
  const request = makeRequest("vision-model", "What is on screen?", "cG5n");

  assert.equal(request.model, "vision-model");
  assert.equal("thinking" in request, false);
  assert.equal(request.stream, false);
  assert.deepEqual(request.messages[1], {
    role: "user",
    content: [
      { type: "text", text: "What is on screen?" },
      {
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,cG5n",
        },
      },
    ],
  });
});

test("includes completed text turns before the current screenshot request", () => {
  const request = makeRequest("vision-model", "Current question", "cG5n", [
    { user: "First question", assistant: "First answer" },
    { user: "Second question", assistant: "Second answer" },
  ]);

  assert.deepEqual(request.messages.slice(1, -1), [
    { role: "user", content: "First question" },
    { role: "assistant", content: "First answer" },
    { role: "user", content: "Second question" },
    { role: "assistant", content: "Second answer" },
  ]);
  assert.deepEqual(request.messages.at(-1), {
    role: "user",
    content: [
      { type: "text", text: "Current question" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,cG5n" },
      },
    ],
  });
});
