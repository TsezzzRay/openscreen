import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateLine,
  truncateTail,
} from "../../src/tools/shared/truncate.js";

test("uses Pi-compatible default truncation limits", () => {
  assert.equal(DEFAULT_MAX_LINES, 2_000);
  assert.equal(DEFAULT_MAX_BYTES, 50 * 1_024);
});

test("head truncation keeps complete leading lines and reports the first limit hit", () => {
  const result = truncateHead("one\ntwo\nthree\n", { maxLines: 2, maxBytes: 100 });

  assert.equal(result.content, "one\ntwo");
  assert.equal(result.truncated, true);
  assert.equal(result.truncatedBy, "lines");
  assert.equal(result.totalLines, 3);
  assert.equal(result.outputLines, 2);
  assert.equal(result.firstLineExceedsLimit, false);
});

test("head truncation never returns a partial first line", () => {
  const result = truncateHead("123456\nnext", { maxLines: 20, maxBytes: 5 });

  assert.equal(result.content, "");
  assert.equal(result.truncatedBy, "bytes");
  assert.equal(result.firstLineExceedsLimit, true);
});

test("tail truncation keeps final lines and preserves valid UTF-8 at a byte boundary", () => {
  const lines = truncateTail("one\ntwo\nthree", { maxLines: 2, maxBytes: 100 });
  assert.equal(lines.content, "two\nthree");
  assert.equal(lines.truncatedBy, "lines");

  const bytes = truncateTail("prefix\n甲乙丙丁", { maxLines: 20, maxBytes: 7 });
  assert.equal(bytes.content, "丙丁");
  assert.equal(bytes.truncatedBy, "bytes");
  assert.equal(bytes.lastLinePartial, true);
  assert.equal(Buffer.byteLength(bytes.content), 6);
});

test("grep line truncation uses the Pi suffix", () => {
  assert.deepEqual(truncateLine("abcdef", 3), {
    text: "abc... [truncated]",
    wasTruncated: true,
  });
});
