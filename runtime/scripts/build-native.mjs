// Builds the macOS Capture and Desktop helpers.
//
// The helper is a plain executable rather than a Node addon so it needs no
// build toolchain beyond the Swift compiler that ships with the Xcode command
// line tools, and no rebuild when Electron's ABI moves.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("runtime/src/capture/native/main.swift");
const output = resolve("runtime/bin/openscreen-capture");
const focusSource = resolve("runtime/src/desktop/native/main.swift");
const focusPolicySource = resolve("runtime/src/desktop/native/focus-policy.swift");
const focusOutput = resolve("runtime/bin/openscreen-ax-focus");

mkdirSync(dirname(output), { recursive: true });

try {
  execFileSync("swiftc", ["-O", "-o", output, source], { stdio: "inherit" });
  execFileSync("swiftc", ["-O", "-o", focusOutput, focusPolicySource, focusSource], { stdio: "inherit" });
} catch (error) {
  if (error.code === "ENOENT") {
    process.stderr.write(
      "swiftc is missing. Install the Xcode command line tools: xcode-select --install\n",
    );
    process.exit(1);
  }
  throw error;
}

process.stdout.write(`built ${output}\n`);
process.stdout.write(`built ${focusOutput}\n`);
