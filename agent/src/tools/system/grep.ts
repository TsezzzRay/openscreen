import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import { rgPath } from "@vscode/ripgrep";

import type { AgentTool } from "../../types.js";
import {
  optionalBoolean,
  optionalInteger,
  optionalString,
  requiredString,
  validateKeys,
} from "../shared/arguments.js";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  truncateLine,
} from "../shared/truncate.js";

const DEFAULT_LIMIT = 100;

export type GrepMatch = {
  filePath: string;
  lineNumber: number;
  lineText: string;
};

export type GrepSearch = (
  options: {
    pattern: string;
    path: string;
    glob?: string;
    ignoreCase: boolean;
    literal: boolean;
    limit: number;
  },
  signal: AbortSignal,
) => Promise<GrepMatch[]>;

async function searchWithRipgrep(
  options: Parameters<GrepSearch>[0],
  signal: AbortSignal,
): Promise<GrepMatch[]> {
  return new Promise((resolveSearch, rejectSearch) => {
    signal.throwIfAborted();
    const args = ["--json", "--line-number", "--color=never", "--hidden"];
    if (options.ignoreCase) args.push("--ignore-case");
    if (options.literal) args.push("--fixed-strings");
    if (options.glob) args.push("--glob", options.glob);
    args.push("--", options.pattern, options.path);
    const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    const matches: GrepMatch[] = [];
    let stderr = "";
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      lines.close();
      signal.removeEventListener("abort", onAbort);
      if (error) rejectSearch(error);
      else resolveSearch(matches);
    };
    const onAbort = () => {
      child.kill();
      settle(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    lines.on("line", (line) => {
      if (matches.length >= options.limit) return;
      try {
        const event = JSON.parse(line) as any;
        if (event.type !== "match") return;
        const filePath = event.data?.path?.text;
        const lineNumber = event.data?.line_number;
        const lineText = event.data?.lines?.text;
        if (typeof filePath === "string" && typeof lineNumber === "number" &&
            typeof lineText === "string") {
          matches.push({
            filePath,
            lineNumber,
            lineText: lineText.replace(/\r?\n$/, ""),
          });
          if (matches.length >= options.limit) child.kill();
        }
      } catch {
        // Ignore non-JSON diagnostic lines.
      }
    });
    child.once("error", (error) => settle(error));
    child.once("close", (code) => {
      if (signal.aborted) return;
      if (code !== 0 && code !== 1 && matches.length === 0) {
        settle(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
      } else {
        settle();
      }
    });
  });
}

function displayPath(filePath: string, searchPath: string) {
  const absoluteFile = isAbsolute(filePath) ? filePath : resolve(filePath);
  if (absoluteFile === searchPath) return basename(absoluteFile);
  const value = relative(searchPath, absoluteFile);
  return (value.startsWith("..") ? basename(absoluteFile) : value).replaceAll("\\", "/");
}

export function createGrepTool(
  cwd: string,
  options: { search?: GrepSearch } = {},
): AgentTool {
  return {
    definition: {
      type: "function",
      name: "grep",
      description: "Search file contents with ripgrep semantics. Returns path, line number, and matching text; defaults to 100 matches, caps output at 50KB, and keeps 500 characters per line.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression or literal text" },
          path: { type: "string", description: "File or directory; defaults to the current working directory" },
          glob: { type: "string", description: "Optional file glob filter" },
          ignoreCase: { type: "boolean", description: "Case-insensitive search" },
          literal: { type: "boolean", description: "Treat pattern as literal text" },
          context: { type: "integer", minimum: 0, description: "Lines before and after each match" },
          limit: { type: "integer", minimum: 1, description: "Maximum matches; defaults to 100" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      strict: false,
    },
    source: "system",
    execute: async (argumentsValue, signal) => {
      validateKeys(argumentsValue, [
        "pattern", "path", "glob", "ignoreCase", "literal", "context", "limit",
      ]);
      const pattern = requiredString(argumentsValue, "pattern");
      const searchPath = resolve(cwd, optionalString(argumentsValue, "path") ?? ".");
      const glob = optionalString(argumentsValue, "glob");
      const ignoreCase = optionalBoolean(argumentsValue, "ignoreCase") ?? false;
      const literal = optionalBoolean(argumentsValue, "literal") ?? false;
      const context = optionalInteger(argumentsValue, "context", 0) ?? 0;
      const limit = optionalInteger(argumentsValue, "limit", 1) ?? DEFAULT_LIMIT;
      const matches = await (options.search ?? searchWithRipgrep)({
        pattern,
        path: searchPath,
        glob,
        ignoreCase,
        literal,
        limit: limit + 1,
      }, signal);
      signal.throwIfAborted();
      if (matches.length === 0) return { content: "No matches found" };
      const matchLimitReached = matches.length > limit;
      let linesTruncated = false;
      const output: string[] = [];
      for (const match of matches.slice(0, limit)) {
        const file = displayPath(match.filePath, searchPath);
        if (context === 0) {
          const truncated = truncateLine(match.lineText.replaceAll("\r", ""));
          linesTruncated ||= truncated.wasTruncated;
          output.push(`${file}:${match.lineNumber}: ${truncated.text}`);
          continue;
        }
        let fileLines: string[] = [];
        try {
          fileLines = (await readFile(match.filePath, "utf8"))
            .replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
        } catch {
          output.push(`${file}:${match.lineNumber}: (unable to read file)`);
          continue;
        }
        const start = Math.max(1, match.lineNumber - context);
        const end = Math.min(fileLines.length, match.lineNumber + context);
        for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
          const truncated = truncateLine(fileLines[lineNumber - 1] ?? "");
          linesTruncated ||= truncated.wasTruncated;
          output.push(lineNumber === match.lineNumber
            ? `${file}:${lineNumber}: ${truncated.text}`
            : `${file}-${lineNumber}- ${truncated.text}`);
        }
      }
      const truncation = truncateHead(output.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      const notices: string[] = [];
      const details: Record<string, unknown> = {};
      if (matchLimitReached) {
        notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
        details.matchLimitReached = limit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      if (linesTruncated) {
        notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
        details.linesTruncated = true;
      }
      return {
        content: `${truncation.content}${notices.length > 0 ? `\n\n[${notices.join(". ")}]` : ""}`,
        ...(Object.keys(details).length > 0 ? { details } : {}),
      };
    },
  };
}
