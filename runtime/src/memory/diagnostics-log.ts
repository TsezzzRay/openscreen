import { appendFileSync, chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Why this file exists: the composition root deliberately logs only
// `<phase> unavailable` to stderr and drops `diagnostic.message`
// (enforced by tests/application/composition-boundary.test.ts). That keeps
// stderr free of paths and content, but it also makes "which phase failed"
// the *only* thing anyone can see — diagnosing a real failure previously
// meant reconstructing it from SQLite state by hand.
//
// Full messages go here instead. This does not weaken the privacy posture:
// the Memory root is already 0700 and already stores screen OCR text and
// conversation history at 0600, so an error string is strictly less sensitive
// than its neighbours. stderr stays content-free.
//
// Writing must never break Memory work, so every failure here is swallowed.

const FILENAME = "diagnostics.log";
const MAX_BYTES = 1_048_576;

export function memoryDiagnosticsLogPath(root: string): string {
  return join(root, FILENAME);
}

function currentSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Appends one diagnostic line. The file is capped and truncated rather than
 * rotated — this is a debugging aid, not an audit trail, and an unbounded
 * file on a long-running desktop process is worse than losing old lines.
 */
export function appendMemoryDiagnostic(
  root: string,
  phase: string,
  message: string,
  now = Date.now(),
): void {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = memoryDiagnosticsLogPath(root);
    const line = `${new Date(now).toISOString()} ${phase} ${message.replace(/\r?\n/g, " ")}\n`;
    if (currentSize(path) + Buffer.byteLength(line) > MAX_BYTES) {
      writeFileSync(
        path,
        `${new Date(now).toISOString()} log truncated at ${MAX_BYTES} bytes\n${line}`,
        { mode: 0o600 },
      );
    } else {
      appendFileSync(path, line, { mode: 0o600 });
    }
    chmodSync(path, 0o600);
  } catch {
    // A diagnostics-log failure must never surface as a Memory failure.
  }
}
