import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";

export type RuntimeConfig = {
  apiKey: string;
  model: string;
  baseURL: string;
  context: {
    windowTokens: number;
    compactAtTokens: number;
    keepRecentTokens: number;
    maxOutputTokens: number;
    summaryMaxOutputTokens: number;
  };
};

const overrides = {
  windowTokens: "OPENSCREEN_CONTEXT_WINDOW_TOKENS",
  compactAtTokens: "OPENSCREEN_COMPACT_AT_TOKENS",
  keepRecentTokens: "OPENSCREEN_KEEP_RECENT_TOKENS",
  maxOutputTokens: "OPENSCREEN_MAX_OUTPUT_TOKENS",
  summaryMaxOutputTokens: "OPENSCREEN_SUMMARY_MAX_OUTPUT_TOKENS",
} as const;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, name: string) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

export function loadRuntimeConfig(
  configPath = resolve("config.json"),
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfig {
  const envPath = resolve(".env");
  if (env === process.env && existsSync(envPath)) loadEnvFile(envPath);

  const file = object(JSON.parse(readFileSync(configPath, "utf8")), "config");
  const fileContext = object(file.context, "context");
  const model = string(env.OPENAI_MODEL ?? file.model, "model");
  const baseURL = string(env.OPENAI_BASE_URL ?? file.baseURL, "baseURL");
  const apiKey = string(env.OPENAI_API_KEY, "OPENAI_API_KEY");
  if (/^<.*>$/.test(model)) throw new Error("model must be configured");
  if (/^<.*>$/.test(baseURL)) throw new Error("baseURL must be configured");

  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error("baseURL must be an HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseURL must be an HTTP or HTTPS URL");
  }

  const context = Object.fromEntries(
    Object.entries(overrides).map(([name, envName]) => [
      name,
      positiveInteger(env[envName] ?? fileContext[name], `context.${name}`),
    ]),
  ) as RuntimeConfig["context"];

  if (context.compactAtTokens >= context.windowTokens) {
    throw new Error("context.compactAtTokens must be less than windowTokens");
  }
  if (context.keepRecentTokens >= context.compactAtTokens) {
    throw new Error("context.keepRecentTokens must be less than compactAtTokens");
  }
  if (context.maxOutputTokens > context.windowTokens - context.compactAtTokens) {
    throw new Error("context.maxOutputTokens exceeds the available output budget");
  }

  return { apiKey, model, baseURL, context };
}
