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

test("parses an ordered system capture and any number of user uploads", () => {
  assert.deepEqual(
    parseInputEnvelope(JSON.stringify({
      requestId: "request-1",
      type: "chat",
      sessionId: "0EAD33C3-1560-4C6C-A049-A1E9EE8BE62F",
      input: {
        text: "Compare these screenshots",
        images: [
          { id: "system", source: "system_capture", path: "/tmp/system.png" },
          { id: "upload-1", source: "user_upload", path: "/tmp/one.png" },
          { id: "upload-2", source: "user_upload", path: "/tmp/two.png" },
        ],
      },
    })),
    {
      requestId: "request-1",
      type: "chat",
      sessionId: "0ead33c3-1560-4c6c-a049-a1e9ee8be62f",
      input: {
        text: "Compare these screenshots",
        images: [
          { id: "system", source: "system_capture", path: "/tmp/system.png" },
          { id: "upload-1", source: "user_upload", path: "/tmp/one.png" },
          { id: "upload-2", source: "user_upload", path: "/tmp/two.png" },
        ],
      },
    },
  );
});

test("normalizes legacy single-image chat requests", () => {
  const request = parseInputEnvelope(JSON.stringify({
    requestId: "request-1",
    type: "chat",
    sessionId: "session-1",
    input: { text: "What is this?", image: "/tmp/legacy.png" },
  }));

  assert.equal(request.type, "chat");
  assert.deepEqual(request.input.images, [
    { id: "legacy-system", source: "system_capture", path: "/tmp/legacy.png" },
  ]);
});

test("record attempts retain user uploads without requiring a system capture", () => {
  const request = parseInputEnvelope(JSON.stringify({
    requestId: "request-1",
    type: "record_attempt",
    sessionId: "session-1",
    input: {
      text: "Question",
      images: [
        { id: "upload-1", source: "user_upload", path: "/tmp/one.png" },
        { id: "upload-2", source: "user_upload", path: "/tmp/two.png" },
      ],
    },
    status: "failed",
  }));

  assert.equal(request.type, "record_attempt");
  assert.equal(request.input.images.length, 2);
});

test("rejects invalid image source ordering", () => {
  assert.throws(() => parseInputEnvelope(JSON.stringify({
    requestId: "request-1",
    type: "chat",
    sessionId: "session-1",
    input: {
      text: "Question",
      images: [
        { id: "upload-1", source: "user_upload", path: "/tmp/one.png" },
        { id: "system", source: "system_capture", path: "/tmp/system.png" },
      ],
    },
  })), /Invalid agent request/);

  assert.throws(() => parseInputEnvelope(JSON.stringify({
    requestId: "request-1",
    type: "record_attempt",
    sessionId: "session-1",
    input: {
      text: "Question",
      images: [{ id: "system", source: "system_capture", path: "/tmp/system.png" }],
    },
    status: "cancelled",
  })), /Invalid agent request/);
});

test("rejects malformed requests", () => {
  assert.throws(() => parseInputEnvelope("{}"), /Invalid agent request/);
  assert.throws(
    () => parseInputEnvelope(JSON.stringify({ requestId: "request-1", type: "chat" })),
    /Invalid agent request/,
  );
});
