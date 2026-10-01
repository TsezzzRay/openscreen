import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MemoryCitationStreamFilter,
  MemoryFileAccessTracker,
  validateProseMemoryCitation,
  stripMemoryCitationBlock,
  validateMemoryCitation,
} from "../../../src/agent/pi/memory-citation.js";

test("strips a split citation block from streaming and final assistant text", () => {
  const filter = new MemoryCitationStreamFilter();
  const visible = [
    filter.push("Historical answer.\n<oai-mem-"),
    filter.push("citation>{\"entries\":[]"),
    filter.push(",\"rolloutIds\":[]}</oai-mem-citation>"),
    filter.finish(),
  ].join("");
  assert.equal(visible, "Historical answer.\n");
  assert.deepEqual(stripMemoryCitationBlock(
    "Historical answer.\n<oai-mem-citation>{\"entries\":[],\"rolloutIds\":[]}</oai-mem-citation>",
  ), {
    text: "Historical answer.",
    citationJson: "{\"entries\":[],\"rolloutIds\":[]}",
  });

  const incomplete = new MemoryCitationStreamFilter();
  assert.equal(incomplete.push("Answer<oai-mem-citation>{"), "Answer");
  assert.equal(incomplete.finish(), "");
  assert.deepEqual(stripMemoryCitationBlock(
    "Answer<oai-mem-citation>{",
  ), { text: "Answer" });

  const partialMarker = new MemoryCitationStreamFilter();
  assert.equal(partialMarker.push("Answer<oai-mem-cit"), "Answer");
  assert.equal(partialMarker.finish(), "");
});

test("validates an explicit prose Memory line citation only when read this Turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-citation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "MEMORY.md"), "2026-09-01: User chose pnpm for Project Cedar.\n");
  const tracker = new MemoryFileAccessTracker(root, "/workspace");
  tracker.recordFileRange(join(root, "MEMORY.md"), 1, 1);

  assert.deepEqual(await validateProseMemoryCitation(
    "You chose pnpm. Source: `memory/MEMORY.md:1` — User chose pnpm for Project Cedar.",
    root,
    tracker,
  ), {
    entries: [{ path: "MEMORY.md", lineStart: 1, lineEnd: 1, note: "Explicit source cited in the answer" }],
    rolloutIds: [],
  });
  assert.equal(await validateProseMemoryCitation("You chose pnpm from memory.", root, tracker), undefined);
  assert.equal(await validateProseMemoryCitation("Source: `MEMORY.md:2`", root, tracker), undefined);
});

test("validates a backticked Memory filename followed by an explicit line number", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-citation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "MEMORY.md"), "2026-09-01: User chose pnpm for Project Cedar.\n");
  const tracker = new MemoryFileAccessTracker(root, "/workspace");
  const answer = "You chose pnpm. The remembered source is `MEMORY.md` line 1: User chose pnpm for Project Cedar.";

  assert.equal(await validateProseMemoryCitation(answer, root, tracker), undefined);
  tracker.recordFileRange(join(root, "MEMORY.md"), 1, 1);
  assert.deepEqual(await validateProseMemoryCitation(answer, root, tracker), {
    entries: [{ path: "MEMORY.md", lineStart: 1, lineEnd: 1, note: "Explicit source cited in the answer" }],
    rolloutIds: [],
  });
});

test("accepts only actual Memory file ranges read during the current Turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openscreen-memory-citation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "rollout_summaries"));
  await writeFile(join(root, "MEMORY.md"), "# Memory\nline two\nline three\n");
  await writeFile(join(root, "ACTIVITY.md"), "# Activity\nline two\n");
  await writeFile(
    join(root, "rollout_summaries", "turn-a.md"),
    "rollout_id: turn:a\n# Turn A\nresult\n",
  );
  const tracker = new MemoryFileAccessTracker(root, "/workspace");
  tracker.recordFileRange(join(root, "MEMORY.md"), 1, 2);
  tracker.recordFileRange(join(root, "ACTIVITY.md"), 1, 1);
  tracker.recordFileRange(join(root, "rollout_summaries", "turn-a.md"), 1, 3);

  const citation = await validateMemoryCitation(JSON.stringify({
    entries: [{
      path: "MEMORY.md",
      lineStart: 1,
      lineEnd: 2,
      note: "Task group registry",
    }, {
      path: "ACTIVITY.md",
      lineStart: 1,
      lineEnd: 1,
      note: "Screen activity observation",
    }, {
      path: "rollout_summaries/turn-a.md",
      lineStart: 2,
      lineEnd: 3,
      note: "Detailed Turn evidence",
    }],
    rolloutIds: ["turn:a"],
  }), root, tracker);

  assert.equal(citation.entries.length, 3);
  assert.deepEqual(citation.rolloutIds, ["turn:a"]);
  await assert.rejects(validateMemoryCitation(JSON.stringify({
    entries: [{
      path: "MEMORY.md",
      lineStart: 3,
      lineEnd: 3,
      note: "Unread line",
    }],
    rolloutIds: [],
  }), root, tracker), /not read/i);
  await assert.rejects(validateMemoryCitation(JSON.stringify({
    entries: [{
      path: "../secret.md",
      lineStart: 1,
      lineEnd: 1,
      note: "escape",
    }],
    rolloutIds: [],
  }), root, tracker), /path/i);
});
