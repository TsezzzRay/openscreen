import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AgentTool } from "../../types.js";
import {
  requiredString,
  requiredText,
  validateKeys,
} from "../shared/arguments.js";
import { withFileMutationQueue } from "../shared/file-mutation-queue.js";

export type WriteOperations = {
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
};

const defaultOperations: WriteOperations = {
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  writeFile: async (path, content) => { await writeFile(path, content, "utf8"); },
};

export function createWriteTool(
  cwd: string,
  operations: WriteOperations = defaultOperations,
): AgentTool {
  return {
    definition: {
      type: "function",
      name: "write",
      description: "Create or completely overwrite a UTF-8 file, creating parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative or absolute file path" },
          content: { type: "string", description: "Complete replacement content" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      strict: true,
    },
    source: "system",
    guidelines: ["Use write only for new files or complete rewrites."],
    execute: async (argumentsValue, signal) => {
      validateKeys(argumentsValue, ["path", "content"]);
      const path = requiredString(argumentsValue, "path");
      const content = requiredText(argumentsValue, "content");
      const absolutePath = resolve(cwd, path);
      return withFileMutationQueue(absolutePath, async () => {
        signal.throwIfAborted();
        await operations.mkdir(dirname(absolutePath));
        signal.throwIfAborted();
        await operations.writeFile(absolutePath, content);
        signal.throwIfAborted();
        const bytesWritten = Buffer.byteLength(content, "utf8");
        return {
          content: `Successfully wrote ${bytesWritten} bytes to ${path}`,
          details: { bytesWritten },
        };
      });
    },
  };
}
