import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function identifier(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) throw new Error("Invalid identifier");
  return value;
}
export interface Trial {
  trialId: string;
  taskId: string;
  status: "incomplete" | "completed" | "failed" | "timeout";
  [key: string]: unknown;
}
export interface Manifest {
  runId: string;
  tasks: { id: string; workload: string }[];
  trials: number;
  [key: string]: unknown;
}
export async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
export async function createRun(root: string, manifest: Manifest): Promise<string> {
  identifier(manifest.runId);
  if (!Number.isSafeInteger(manifest.trials) || manifest.trials < 1) throw new Error("Invalid trials");
  const ids = manifest.tasks.map(task => identifier(task.id));
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate task");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const run = join(root, manifest.runId);
  await mkdir(run, { mode: 0o700 });
  await mkdir(join(run, "traces"), { mode: 0o700 });
  await mkdir(join(run, "artifacts"), { mode: 0o700 });
  await writeJson(join(run, "manifest.json"), manifest);
  for (const task of manifest.tasks) {
    for (let index = 1; index <= manifest.trials; index++) {
      const trialId = `${task.id}-${index}`;
      await mkdir(join(run, "artifacts", trialId), { mode: 0o700 });
      await appendEvent(run, trialId, { type: "planned", taskId: task.id });
    }
  }
  return run;
}
export async function appendEvent(run: string, trialId: string, event: unknown): Promise<void> {
  await appendFile(join(run, "traces", `${identifier(trialId)}.jsonl`), JSON.stringify({ timestamp: new Date().toISOString(), event }) + "\n", { mode: 0o600 });
}
export async function finishTrial(run: string, trialId: string, result: Record<string, unknown>): Promise<void> {
  await writeJson(join(run, "artifacts", identifier(trialId), "result.json"), result);
  await appendEvent(run, trialId, { type: "finished", status: result.status });
}
export async function readRun(run: string): Promise<{ manifest: Manifest; trials: Trial[] }> {
  const manifest = JSON.parse(await readFile(join(run, "manifest.json"), "utf8")) as Manifest;
  const trials: Trial[] = [];
  for (const task of manifest.tasks) {
    for (let index = 1; index <= manifest.trials; index++) {
      const trialId = identifier(`${task.id}-${index}`);
      let result: Record<string, unknown> = { status: "incomplete" };
      try { result = JSON.parse(await readFile(join(run, "artifacts", trialId, "result.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      trials.push({ ...result, taskId: task.id, trialId, status: result.status as Trial["status"] });
    }
  }
  return { manifest, trials };
}
