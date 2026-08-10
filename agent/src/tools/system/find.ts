import { spawn } from "node:child_process";
import { basename, isAbsolute, matchesGlob, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import { rgPath } from "@vscode/ripgrep";

import type { AgentTool } from "../../types.js";
import {
  optionalInteger,
  optionalString,
  requiredString,
  validateKeys,
} from "../shared/arguments.js";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
} from "../shared/truncate.js";

const DEFAULT_LIMIT = 1_000;

export type FindSearch = (
  options: { pattern: string; path: string; limit: number },
  signal: AbortSignal,
) => Promise<string[]>;

async function searchWithRipgrep(
  options: Parameters<FindSearch>[0],
  signal: AbortSignal,
): Promise<string[]> {
  return new Promise((resolveSearch, rejectSearch) => {
    signal.throwIfAborted();
    const child = spawn(rgPath, [
      "--files",
      "--hidden",
      "--", options.path,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    const results: string[] = [];
    let stderr = "";
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      lines.close();
      signal.removeEventListener("abort", onAbort);
      if (error) rejectSearch(error);
      else resolveSearch(results);
    };
    const onAbort = () => {
      child.kill();
      settle(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    lines.on("line", (line) => {
      if (results.length >= options.limit) return;
      const value = line.replace(/\r$/, "");
      const absolute = isAbsolute(value) ? value : resolve(value);
      const candidate = relative(options.path, absolute).replaceAll("\\", "/");
      const matchTarget = options.pattern.includes("/") ? candidate : basename(candidate);
      if (value && matchesGlob(matchTarget, options.pattern)) results.push(value);
      if (results.length >= options.limit) child.kill();
    });
    child.once("error", (error) => settle(error));
    child.once("close", (code) => {
      if (signal.aborted) return;
      if (code !== 0 && code !== 1 && results.length === 0) {
        settle(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
      } else {
        settle();
      }
    });
  });
}

function relativeResult(value: string, root: string) {
  const result = isAbsolute(value) ? relative(root, value) : value;
  return result.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function createFindTool(
  cwd: string,
  options: { search?: FindSearch } = {},
): AgentTool {
  return {
    definition: {
      type: "function",
      name: "find",
      description: "Find files by glob pattern while respecting ignore files. Returns relative paths, defaults to 1000 results, and caps output at 50KB.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob such as '*.ts' or 'src/**/*.spec.ts'" },
          path: { type: "string", description: "Directory; defaults to the current working directory" },
          limit: { type: "integer", minimum: 1, description: "Maximum results; defaults to 1000" },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
      strict: false,
    },
    source: "system",
    execute: async (argumentsValue, signal) => {
      validateKeys(argumentsValue, ["pattern", "path", "limit"]);
      const pattern = requiredString(argumentsValue, "pattern");
      const searchPath = resolve(cwd, optionalString(argumentsValue, "path") ?? ".");
      const limit = optionalInteger(argumentsValue, "limit", 1) ?? DEFAULT_LIMIT;
      const results = await (options.search ?? searchWithRipgrep)({
        pattern,
        path: searchPath,
        limit: limit + 1,
      }, signal);
      signal.throwIfAborted();
      if (results.length === 0) return { content: "No files found matching pattern" };
      const resultLimitReached = results.length > limit;
      const output = results.slice(0, limit).map((value) => relativeResult(value, searchPath));
      const truncation = truncateHead(output.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      const notices: string[] = [];
      const details: Record<string, unknown> = {};
      if (resultLimitReached) {
        notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
        details.resultLimitReached = limit;
      }
      if (truncation.truncated) {
        notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
        details.truncation = truncation;
      }
      return {
        content: `${truncation.content}${notices.length > 0 ? `\n\n[${notices.join(". ")}]` : ""}`,
        ...(Object.keys(details).length > 0 ? { details } : {}),
      };
    },
  };
}
