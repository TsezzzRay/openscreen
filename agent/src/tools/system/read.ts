import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentTool } from "../../types.js";
import {
  optionalInteger,
  requiredString,
  validateKeys,
} from "../shared/arguments.js";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
} from "../shared/truncate.js";

export function createReadTool(cwd: string): AgentTool {
  return {
    definition: {
      type: "function",
      name: "read",
      description: "Read a UTF-8 text file. Output keeps the first 2000 lines or 50KB. Use offset and limit to continue large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute file path" },
          offset: { type: "integer", minimum: 1, description: "1-indexed first line" },
          limit: { type: "integer", minimum: 1, description: "Maximum lines to read" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      strict: false,
    },
    source: "system",
    guidelines: [
      "Use read instead of shell text commands when examining a file.",
      "When output is truncated, continue from the offset shown in the notice.",
    ],
    execute: async (argumentsValue, signal) => {
      validateKeys(argumentsValue, ["path", "offset", "limit"]);
      const path = requiredString(argumentsValue, "path");
      const offset = optionalInteger(argumentsValue, "offset", 1);
      const limit = optionalInteger(argumentsValue, "limit", 1);
      signal.throwIfAborted();
      const buffer = await readFile(resolve(cwd, path), { signal });
      signal.throwIfAborted();
      const allLines = buffer.toString("utf8").split("\n");
      const start = (offset ?? 1) - 1;
      if (start >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
      }
      const end = limit === undefined
        ? allLines.length
        : Math.min(start + limit, allLines.length);
      const selected = allLines.slice(start, end).join("\n");
      const truncation = truncateHead(selected);
      const startDisplay = start + 1;
      let content: string;
      if (truncation.firstLineExceedsLimit) {
        const lineSize = formatSize(Buffer.byteLength(allLines[start] ?? "", "utf8"));
        content = `[Line ${startDisplay} is ${lineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash to inspect a bounded byte range.]`;
      } else if (truncation.truncated) {
        const endDisplay = startDisplay + truncation.outputLines - 1;
        const byteNotice = truncation.truncatedBy === "bytes"
          ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`
          : "";
        content = `${truncation.content}\n\n[Showing lines ${startDisplay}-${endDisplay} of ${allLines.length}${byteNotice}. Use offset=${endDisplay + 1} to continue.]`;
      } else if (limit !== undefined && end < allLines.length) {
        const remaining = allLines.length - end;
        content = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${end + 1} to continue.]`;
      } else {
        content = truncation.content;
      }
      return {
        content,
        ...(truncation.truncated ? { details: { truncation } } : {}),
      };
    },
  };
}
