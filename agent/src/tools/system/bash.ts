import { spawn, type ChildProcess } from "node:child_process";

import type { AgentTool } from "../../types.js";
import { ToolExecutionError } from "../errors.js";
import {
  optionalPositiveNumber,
  requiredString,
  validateKeys,
} from "../shared/arguments.js";
import { OutputAccumulator } from "../shared/output-accumulator.js";
import { DEFAULT_MAX_BYTES, formatSize } from "../shared/truncate.js";

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1_000;

type ProcessOutcome = {
  exitCode: number | null;
  timedOut: boolean;
  error?: Error;
};

function terminate(child: ChildProcess, force = false) {
  if (!child.pid) return;
  const signal = force ? "SIGKILL" : "SIGTERM";
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number | undefined,
  signal: AbortSignal,
  onData: (data: Buffer) => void,
): Promise<ProcessOutcome> {
  return new Promise((resolveRun) => {
    signal.throwIfAborted();
    const shell = process.env.SHELL || "/bin/bash";
    const child = spawn(shell, ["-lc", command], {
      cwd,
      detached: process.platform !== "win32",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let outputError: Error | undefined;
    const stop = () => {
      terminate(child);
      forceKill ??= setTimeout(() => terminate(child, true), 500);
      forceKill.unref();
    };
    const settle = (outcome: ProcessOutcome) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal.removeEventListener("abort", onAbort);
      resolveRun(outcome);
    };
    const onAbort = stop;
    const onOutput = (data: Buffer) => {
      if (settled || outputError) return;
      try {
        onData(data);
      } catch (error) {
        outputError = error instanceof Error ? error : new Error("Failed to capture command output");
        stop();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutSeconds !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutSeconds * 1_000);
    }
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.once("error", (error) => settle({
      exitCode: null,
      timedOut,
      error: outputError ?? error,
    }));
    child.once("close", (exitCode) => settle({
      exitCode,
      timedOut,
      ...(outputError ? { error: outputError } : {}),
    }));
  });
}

function formatOutput(
  content: string,
  truncation: ReturnType<OutputAccumulator["snapshot"]>["truncation"],
  fullOutputPath: string | undefined,
) {
  let output = content || "(no output)";
  if (!truncation.truncated) return output;
  const start = truncation.totalLines - truncation.outputLines + 1;
  const end = truncation.totalLines;
  if (truncation.lastLinePartial) {
    output += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${end}. Full output: ${fullOutputPath}]`;
  } else if (truncation.truncatedBy === "lines") {
    output += `\n\n[Showing lines ${start}-${end} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
  } else {
    output += `\n\n[Showing lines ${start}-${end} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
  }
  return output;
}

export function createBashTool(cwd: string, outputDirectory: string): AgentTool {
  return {
    definition: {
      type: "function",
      name: "bash",
      description: "Execute a shell command in the current working directory. stdout and stderr are merged; the visible result keeps the last 2000 lines or 50KB and stores complete truncated output in a durable sidecar.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: { type: "number", exclusiveMinimum: 0, description: "Optional timeout in seconds" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      strict: false,
    },
    source: "system",
    guidelines: ["Inspect the exit code and output before claiming that a command succeeded."],
    execute: async (argumentsValue, signal) => {
      validateKeys(argumentsValue, ["command", "timeout"]);
      const command = requiredString(argumentsValue, "command");
      const timeout = optionalPositiveNumber(argumentsValue, "timeout");
      if (timeout !== undefined && timeout > MAX_TIMEOUT_SECONDS) {
        throw new Error(`timeout must be <= ${MAX_TIMEOUT_SECONDS} seconds`);
      }
      const output = new OutputAccumulator({
        outputDirectory,
        filePrefix: "bash",
      });
      const outcome = await runCommand(command, cwd, timeout, signal, (data) => output.append(data));
      output.finish();
      const snapshot = output.snapshot({ persistIfTruncated: true });
      await output.close();
      signal.throwIfAborted();
      const content = formatOutput(
        snapshot.content,
        snapshot.truncation,
        snapshot.fullOutputPath,
      );
      const details = {
        exitCode: outcome.exitCode,
        ...(outcome.timedOut ? { timeoutSeconds: timeout } : {}),
        ...(snapshot.truncation.truncated
          ? {
              truncation: snapshot.truncation,
              fullOutputPath: snapshot.fullOutputPath,
            }
          : {}),
      };
      if (outcome.error) {
        throw new ToolExecutionError(outcome.error.message, outcome.error.message, details);
      }
      if (outcome.timedOut) {
        throw new ToolExecutionError(
          `Command timed out after ${timeout} seconds`,
          `${content}\n\nCommand timed out after ${timeout} seconds`,
          details,
        );
      }
      if (outcome.exitCode !== 0) {
        throw new ToolExecutionError(
          `Command exited with code ${outcome.exitCode}`,
          `${content}\n\nCommand exited with code ${outcome.exitCode}`,
          details,
        );
      }
      return { content, details };
    },
  };
}
