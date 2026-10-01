import assert from "node:assert/strict";
import test from "node:test";

import { screenAttributionMetric } from "../../../src/memory/mastra/screen-attribution.js";

test("counts user-attributed claims anywhere in screen memory", () => {
  const text = `Date: Sep 1, 2026
* 🟡 (09:00) Screen showed "选项1"; frame-1.
* 🔴 (09:01) User stated that policy X was approved.
* 🟡 (09:02) User asked to approve all writes.
* 🟢 (09:03) Browser displayed a page.
`;
  assert.deepEqual(screenAttributionMetric(text), { contentLines: 5, flaggedLines: 2, rate: 0.4 });
  assert.deepEqual(screenAttributionMetric(""), { contentLines: 0, flaggedLines: 0, rate: null });
  assert.deepEqual(screenAttributionMetric("* 🟡 User replied yes.\n* 🟡 USER CHOSE X.\n* 🟡 User approved X.\n<current-task>User asked for X</current-task>"), { contentLines: 4, flaggedLines: 4, rate: 1 });
});
