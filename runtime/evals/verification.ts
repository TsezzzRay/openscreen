import { isDeepStrictEqual } from "node:util";
import { shellQuote } from "../src/agent/pi/tools/tool-support.js";
import type { Task } from "./dataset.js";
import { confinedPath } from "./workspace.js";
import { SandboxedEvalShell } from "./shell.js";

export function verifyFixtureConfig(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  return config.timeoutMs === 4500 && config.retries === 3 && config.region === "eu-west";
}

export function textArtifactMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const normalize = (value: string) => value.replace(/\r\n?/gu, "\n").split("\n").filter(line => line.trim().length > 0).join("\n");
  return normalize(actual) === normalize(expected);
}

export function labeledBulletArtifactMatches(actual: string | undefined, heading: string, labels: string[]): boolean {
  if (actual === undefined) return false;
  const lines = actual.replace(/\r\n?/gu, "\n").split("\n").map(line => line.trim()).filter(Boolean);
  if (lines.length !== labels.length + 1 || lines[0] !== heading) return false;
  return labels.every((label, index) => {
    const line = lines[index + 1];
    const prefixes = [`- ${label}: `, `- **${label}**: `, `- **${label}:** `, `- ${label} — `, `- **${label}** — `];
    const prefix = prefixes.find(value => line.startsWith(value));
    const content = prefix ? line.slice(prefix.length) : "";
    return content.trim().length > 0;
  });
}

export function jsonArtifactMatches(actual: string | undefined, expected: Record<string, unknown>): boolean {
  if (actual === undefined) return false;
  try { return isDeepStrictEqual(JSON.parse(actual), expected); }
  catch { return false; }
}

export function verifySnapshot(task: Task, before: Record<string, string>, after: Record<string, string>) {
  const verifier = task.input?.verifier;
  if (!verifier || verifier.kind === "module-cases") return undefined;
  const failures: string[] = [];
  for (const path of verifier.preserve ?? []) {
    if (before[path] !== after[path]) failures.push(`${path} changed`);
  }
  if (verifier.kind === "files") {
    for (const [path, expected] of Object.entries(verifier.expected)) {
      if (!textArtifactMatches(after[path], expected)) failures.push(`${path} did not match the expected content`);
    }
  } else if (verifier.kind === "labeled-bullets") {
    if (!labeledBulletArtifactMatches(after[verifier.path], verifier.heading, verifier.labels)) failures.push(`${verifier.path} did not match the requested heading and labeled bullets`);
  } else if (verifier.kind === "json") {
    if (!jsonArtifactMatches(after[verifier.path], verifier.expected)) failures.push(`${verifier.path} did not match the expected JSON value`);
  }
  return { passed: failures.length === 0, failures };
}

export async function verifyTask(task: Task, workspace: string, before: Record<string, string>, after: Record<string, string>) {
  const verifier = task.input.verifier;
  if (!verifier) return undefined;
  const snapshotResult = verifySnapshot(task, before, after);
  if (snapshotResult) return snapshotResult;
  const failures: string[] = [];
  for (const path of verifier.preserve ?? []) {
    if (before[path] !== after[path]) failures.push(`${path} changed`);
  }
  if (verifier.kind === "module-cases") {
    const target = await confinedPath(workspace, verifier.path);
    const source = `
      import assert from "node:assert/strict";
      import { pathToFileURL } from "node:url";
      const module = await import(pathToFileURL(${JSON.stringify(target)}).href + "?eval=" + Date.now());
      const callable = module[${JSON.stringify(verifier.exportName)}];
      assert.equal(typeof callable, "function");
      for (const item of ${JSON.stringify(verifier.cases)}) assert.deepEqual(await callable(...item.args), item.expected);
    `;
    const shell = new SandboxedEvalShell(workspace);
    const result = await shell.exec(`${shellQuote(process.execPath)} --input-type=module --eval ${shellQuote(source)}`, { timeout: 15 });
    if (!result.ok) failures.push(result.error.message);
    else if (result.value.exitCode !== 0) failures.push((result.value.stderr || result.value.stdout || `Verifier exited ${result.value.exitCode}`).trim());
  }
  return { passed: failures.length === 0, failures };
}
