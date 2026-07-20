import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createSession } from "./store.js";

const execFileAsync = promisify(execFile);

test("serializes the same session across processes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openscreen-sessions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const session = await createSession(directory);
  const marker = join(directory, "marker.txt");
  const moduleURL = new URL("./lock.js", import.meta.url).href;
  const script = `
    import { appendFile } from "node:fs/promises";
    import { withSessionLock } from ${JSON.stringify(moduleURL)};
    const [directory, sessionId, marker, label] = process.argv.slice(1);
    await withSessionLock(directory, sessionId, async () => {
      await appendFile(marker, label + "-start\\n");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await appendFile(marker, label + "-end\\n");
    });
  `;

  await Promise.all([
    execFileAsync(process.execPath, ["--input-type=module", "--eval", script, directory, session.id, marker, "A"]),
    execFileAsync(process.execPath, ["--input-type=module", "--eval", script, directory, session.id, marker, "B"]),
  ]);

  const lines = (await readFile(marker, "utf8")).trim().split("\n");
  assert.ok(
    JSON.stringify(lines) === JSON.stringify(["A-start", "A-end", "B-start", "B-end"]) ||
    JSON.stringify(lines) === JSON.stringify(["B-start", "B-end", "A-start", "A-end"]),
    `lock events overlapped: ${lines.join(", ")}`,
  );
});
