// Builds the macOS capture helper.
//
// The helper is a plain executable rather than a Node addon so it needs no
// build toolchain beyond the Swift compiler that ships with the Xcode command
// line tools, and no rebuild when Electron's ABI moves.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("native/capture/main.swift");
const output = resolve("native/bin/openscreen-capture");

mkdirSync(dirname(output), { recursive: true });

try {
  execFileSync("swiftc", ["-O", "-o", output, source], { stdio: "inherit" });
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
