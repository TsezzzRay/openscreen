import { Type } from "@earendil-works/pi-ai";
import {
  executeShellWithCapture,
  type AgentTool,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";

import { textResult } from "./tool-support.js";

export function createBashTool(env: ExecutionEnv) {
  const parameters = Type.Object({
    command: Type.String({ minLength: 1, description: "Shell command to execute" }),
    timeout: Type.Optional(Type.Number({
      exclusiveMinimum: 0,
      description: "Timeout in seconds",
    })),
  }, { additionalProperties: false });
  return {
    name: "bash",
    label: "Bash",
    description:
      "Execute a shell command. stdout/stderr are merged and bounded using pi capture utilities.",
    parameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const captured = await executeShellWithCapture(env, params.command, {
        abortSignal: signal,
        timeout: params.timeout,
      });
      if (!captured.ok) {
        if (captured.error.code === "timeout") {
          throw new Error(`Command timed out after ${params.timeout} seconds`);
        }
        if (captured.error.code === "aborted") throw new Error("Command aborted");
        throw captured.error;
      }
      if (captured.value.cancelled) throw new Error("Command aborted");
      const output = captured.value.output || "(no output)";
      const details: Record<string, unknown> = {
        exitCode: captured.value.exitCode,
        cancelled: captured.value.cancelled,
        truncated: captured.value.truncated,
      };
      if (captured.value.fullOutputPath) {
        details.fullOutputPath = captured.value.fullOutputPath;
      }
      if (captured.value.exitCode !== 0) {
        throw new Error(
          `${output}\n\nCommand exited with code ${captured.value.exitCode}`,
        );
      }
      return textResult(output, details);
    },
  } satisfies AgentTool<typeof parameters>;
}
