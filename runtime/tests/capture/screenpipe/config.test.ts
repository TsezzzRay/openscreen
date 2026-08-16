import assert from "node:assert/strict";
import test from "node:test";

import {
  parseScreenpipeCaptureConfig,
} from "../../../src/capture/screenpipe/config.js";

const valid = {
  enabled: true,
  ignoredWindows: ["OpenScreen", "Password Manager"],
  ignoredUrls: ["bank.example", "accounts.example"],
  retention: {
    maxAgeMilliseconds: 7 * 24 * 60 * 60_000,
    maxBytes: 10 * 1024 * 1024 * 1024,
  },
};

test("strictly parses Screenpipe capture policy", () => {
  assert.deepEqual(parseScreenpipeCaptureConfig(valid), valid);
});

test("rejects unknown, duplicate, empty, and malformed Screenpipe settings", () => {
  const invalid = [
    { ...valid, legacyScheduling: {} },
    { ...valid, enabled: "yes" },
    { ...valid, ignoredWindows: ["OpenScreen", "OpenScreen"] },
    { ...valid, ignoredWindows: [""] },
    { ...valid, ignoredUrls: ["x".repeat(2_049)] },
    { ...valid, retention: { ...valid.retention, maxAgeMilliseconds: 0 } },
    { ...valid, retention: { ...valid.retention, maxBytes: -1 } },
    { ...valid, retention: { ...valid.retention, extra: 1 } },
  ];
  for (const value of invalid) {
    assert.throws(
      () => parseScreenpipeCaptureConfig(value),
      /Invalid Screenpipe capture config/,
    );
  }
});
