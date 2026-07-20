import assert from "node:assert/strict";
import test from "node:test";

import { parseInputEnvelope } from "../src/protocol.js";

test("parses and normalizes session-scoped requests", () => {
  assert.deepEqual(
    parseInputEnvelope(JSON.stringify({
      requestId: "request-1",
      type: "load_session",
      sessionId: "0EAD33C3-1560-4C6C-A049-A1E9EE8BE62F",
    })),
    {
      requestId: "request-1",
      type: "load_session",
      sessionId: "0ead33c3-1560-4c6c-a049-a1e9ee8be62f",
    },
  );
});

test("rejects malformed requests", () => {
  assert.throws(() => parseInputEnvelope("{}"), /Invalid agent request/);
  assert.throws(
    () => parseInputEnvelope(JSON.stringify({ requestId: "request-1", type: "chat" })),
    /Invalid agent request/,
  );
});
