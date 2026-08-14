import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";

import { byteLength, textResult, unwrapResult } from "./tool-support.js";

export function createWriteTool(env: ExecutionEnv) {
  const parameters = Type.Object({
    path: Type.String({ description: "Relative or absolute file path" }),
    content: Type.String({ description: "Complete replacement content" }),
  }, { additionalProperties: false });
  return {
    name: "write",
    label: "Write",
    description:
      "Create or overwrite a UTF-8 file, recursively creating parent directories.",
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      unwrapResult(await env.writeFile(params.path, params.content, signal));
      const bytesWritten = byteLength(params.content);
      return textResult(
        `Successfully wrote ${bytesWritten} bytes to ${params.path}`,
        { path: params.path, bytesWritten },
      );
    },
  } satisfies AgentTool<typeof parameters>;
}
