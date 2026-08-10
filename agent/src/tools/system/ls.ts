import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { AgentTool } from "../../types.js";
import {
  optionalInteger,
  optionalString,
  validateKeys,
} from "../shared/arguments.js";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
} from "../shared/truncate.js";

const DEFAULT_LIMIT = 500;

export function createLsTool(cwd: string): AgentTool {
  return {
    definition: {
      type: "function",
      name: "ls",
      description: "List a directory alphabetically, including dotfiles and '/' directory suffixes. Output defaults to 500 entries and is capped at 50KB.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path; defaults to the current working directory" },
          limit: { type: "integer", minimum: 1, description: "Maximum entries; defaults to 500" },
        },
        additionalProperties: false,
      },
      strict: false,
    },
    source: "system",
    execute: async (argumentsValue, signal) => {
      validateKeys(argumentsValue, ["path", "limit"]);
      const path = optionalString(argumentsValue, "path") ?? ".";
      const limit = optionalInteger(argumentsValue, "limit", 1) ?? DEFAULT_LIMIT;
      signal.throwIfAborted();
      const entries = await readdir(resolve(cwd, path), {
        withFileTypes: true,
        encoding: "utf8",
      });
      signal.throwIfAborted();
      entries.sort((left, right) => (
        left.name.toLowerCase().localeCompare(right.name.toLowerCase())
      ));
      const entryLimitReached = entries.length > limit;
      const formatted = (await Promise.all(entries.slice(0, limit).map(async (entry) => {
        try {
          const entryStat = await stat(join(resolve(cwd, path), entry.name));
          return `${entry.name}${entryStat.isDirectory() ? "/" : ""}`;
        } catch {
          return undefined;
        }
      }))).filter((entry): entry is string => entry !== undefined);
      signal.throwIfAborted();
      if (formatted.length === 0) return { content: "(empty directory)" };
      const truncation = truncateHead(formatted.join("\n"), {
        maxLines: Number.MAX_SAFE_INTEGER,
      });
      const notices: string[] = [];
      const details: Record<string, unknown> = {};
      if (entryLimitReached) {
        notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
        details.entryLimitReached = limit;
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
