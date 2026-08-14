import { basename, isAbsolute, relative } from "node:path";

import type { ExecutionEnv } from "@earendil-works/pi-agent-core";

import { shellQuote, unwrapResult } from "./tool-support.js";

export const SEARCH_CAPTURE_MAX_BYTES = 40 * 1024;
export const GREP_BYTE_LIMIT_SENTINEL =
  '{"type":"openscreen_limit","reason":"bytes"}';
export const FIND_BYTE_LIMIT_SENTINEL = "__OPENSCREEN_FIND_BYTE_LIMIT__";

export function boundedGrepCommand(
  command: string,
  recordLimit: number,
): string {
  const program = `
    $0 ~ /"type":"match"/ && !done {
      size = length($0) + 1
      if (used + size > maxBytes) {
        print sentinel
        done = 1
      } else {
        print
        used += size
        count += 1
        if (count >= recordLimit) done = 1
      }
    }
  `;
  const awk = [
    "awk",
    "-v", `recordLimit=${recordLimit}`,
    "-v", `maxBytes=${SEARCH_CAPTURE_MAX_BYTES}`,
    "-v", `sentinel=${GREP_BYTE_LIMIT_SENTINEL}`,
    program,
  ].map(shellQuote).join(" ");
  return `export LC_ALL=C; set -o pipefail; ${command} | ${awk}`;
}

export function boundedFindCommand(
  command: string,
  recordLimit: number,
): string {
  const program = `
    NF > 0 && !done {
      size = length($0) + 1
      if (used + size > maxBytes) {
        print sentinel
        done = 1
      } else {
        print
        used += size
        count += 1
        if (count >= recordLimit) done = 1
      }
    }
  `;
  const awk = [
    "awk",
    "-v", `recordLimit=${recordLimit}`,
    "-v", `maxBytes=${SEARCH_CAPTURE_MAX_BYTES}`,
    "-v", `sentinel=${FIND_BYTE_LIMIT_SENTINEL}`,
    program,
  ].map(shellQuote).join(" ");
  return `export LC_ALL=C; set -o pipefail; ${command} | ${awk}`;
}

export function parseGrepMatches(output: string) {
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let byteLimitReached = false;
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as {
        type?: string;
        reason?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
        };
      };
      if (event.type === "openscreen_limit" && event.reason === "bytes") {
        byteLimitReached = true;
      } else if (
        event.type === "match" &&
        typeof event.data?.path?.text === "string" &&
        typeof event.data.line_number === "number" &&
        typeof event.data.lines?.text === "string"
      ) {
        matches.push({
          path: event.data.path.text,
          line: event.data.line_number,
          text: event.data.lines.text.replace(/\r?\n$/, ""),
        });
      }
    } catch {
      // Ripgrep can emit a final non-JSON fragment when capture truncates it.
    }
  }
  return { matches, byteLimitReached };
}

export async function displayPath(
  env: ExecutionEnv,
  value: string,
  root: string,
) {
  const absoluteRoot = unwrapResult(await env.absolutePath(root));
  const absoluteValue = isAbsolute(value)
    ? value
    : unwrapResult(await env.absolutePath(value));
  const candidate = relative(absoluteRoot, absoluteValue).replaceAll("\\", "/");
  return !candidate || candidate.startsWith("..")
    ? basename(absoluteValue)
    : candidate;
}
