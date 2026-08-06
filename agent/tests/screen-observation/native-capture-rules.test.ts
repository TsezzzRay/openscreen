import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("native AX capture emits value changes and skips title-only changes", () => {
  const source = readFileSync(
    resolve("Sources/ObservationHelper/Monitoring/AXSource.swift"),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /case kAXValueChangedNotification,\s*kAXTitleChangedNotification:/,
  );
  assert.match(
    source,
    /case kAXValueChangedNotification:\s*onEvent\(\.valueChanged\)/s,
  );
  assert.match(source, /case kAXTitleChangedNotification:\s*break/s);
});
