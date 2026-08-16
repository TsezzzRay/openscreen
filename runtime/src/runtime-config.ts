import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

import {
  parseScreenpipeCaptureConfig,
  type ScreenpipeCaptureConfig,
} from "./capture/screenpipe/config.js";
import {
  parseMemoryConfig,
  type MemoryConfig,
} from "./memory/config.js";

export type ApplicationConfig = {
  agent: {
    provider: string;
    model: string;
    thinking:
      | "off"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh"
      | "max";
  };
  capture: {
    screenpipe: ScreenpipeCaptureConfig;
  };
  memory: MemoryConfig;
};

export function loadProjectEnvironment(
  environmentPath = resolve(".env"),
): void {
  if (existsSync(environmentPath)) loadEnvFile(environmentPath);
}

function invalid(cause?: unknown): never {
  throw new Error("Invalid OpenScreen application config", { cause });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return invalid();
  return value.trim();
}

export function loadApplicationConfig(
  configPath = process.env.OPENSCREEN_CONFIG_PATH ?? resolve("config.json"),
): ApplicationConfig {
  try {
    const root = record(JSON.parse(readFileSync(configPath, "utf8")));
    exact(root, ["agent", "capture", "memory"]);
    const agent = record(root.agent);
    exact(agent, ["provider", "model", "thinking"]);
    const thinking = text(agent.thinking);
    if (
      !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        thinking,
      )
    ) {
      invalid();
    }
    return {
      agent: {
        provider: text(agent.provider),
        model: text(agent.model),
        thinking: thinking as ApplicationConfig["agent"]["thinking"],
      },
      capture: (() => {
        const capture = record(root.capture);
        exact(capture, ["screenpipe"]);
        return {
          screenpipe: parseScreenpipeCaptureConfig(capture.screenpipe),
        };
      })(),
      memory: parseMemoryConfig(root.memory),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Invalid OpenScreen application config"
    ) {
      throw error;
    }
    return invalid(error);
  }
}
