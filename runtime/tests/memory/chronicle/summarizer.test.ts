import assert from "node:assert/strict";
import test from "node:test";

import { buildChronicleContext } from "../../../src/memory/chronicle/summarizer.js";
import type { ChronicleFrameProjection } from "../../../src/memory/chronicle/types.js";

test("Chronicle prompt binds page identity and status to each frame's own evidence", () => {
  const frames = [
    { type: "screenpipe_frame", sourceId: "frame-1", application: "Browser", visibleText: "Deployment dashboard: failed" },
    { type: "screenpipe_frame", sourceId: "frame-2", application: "Browser", visibleText: "Deployment dashboard: succeeded" },
    { type: "screenpipe_frame", sourceId: "frame-3", application: "Browser", visibleText: "" },
  ] as ChronicleFrameProjection[];
  const prompt = buildChronicleContext(frames).systemPrompt ?? "";
  assert.match(prompt, /each frame's own visible text and metadata/i);
  assert.match(prompt, /never carry a page identity or status from an earlier frame/i);
  assert.match(prompt, /empty visibleText.*application metadata.*not.*page/i);
  assert.match(prompt, /different applications.*same activity.*shared visible evidence/i);
  assert.match(prompt, /application name.*not.*window title/i);
  assert.match(prompt, /active.*foreground.*focus.*explicit.*metadata/i);
  assert.match(prompt, /path-like.*not.*source code.*opened file/i);
  assert.match(prompt, /window_title.*null.*never omit/i);
});
