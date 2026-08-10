import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OutputAccumulator } from "../../src/tools/shared/output-accumulator.js";

test("retains a bounded UTF-8 tail and persists the exact full byte stream", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "openscreen-output-"));
  const output = new OutputAccumulator({
    maxLines: 2,
    maxBytes: 20,
    outputDirectory,
    filePrefix: "bash",
  });
  const bytes = Buffer.from("first\nsecond\n甲乙丙\nlast", "utf8");

  output.append(bytes.subarray(0, 15));
  output.append(bytes.subarray(15, 17));
  output.append(bytes.subarray(17));
  output.finish();
  const snapshot = output.snapshot({ persistIfTruncated: true });
  await output.close();

  assert.equal(snapshot.content, "甲乙丙\nlast");
  assert.equal(snapshot.truncation.truncated, true);
  assert.equal(snapshot.truncation.totalLines, 4);
  assert.equal(snapshot.truncation.totalBytes, bytes.length);
  assert.match(snapshot.fullOutputPath ?? "", /\/bash-[a-f0-9]{16}\.log$/);
  assert.deepEqual(await readFile(snapshot.fullOutputPath!), bytes);
});

test("does not create a sidecar when output remains visible in full", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "openscreen-output-"));
  const output = new OutputAccumulator({ outputDirectory });
  output.append(Buffer.from("complete"));
  output.finish();
  const snapshot = output.snapshot({ persistIfTruncated: true });
  await output.close();

  assert.equal(snapshot.content, "complete");
  assert.equal(snapshot.truncation.truncated, false);
  assert.equal(snapshot.fullOutputPath, undefined);
});
