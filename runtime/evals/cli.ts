import "../src/memory/mastra/telemetry-guard.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { tasks } from "./dataset.js";
import { loadApplicationConfig, loadProjectEnvironment } from "../src/runtime-config.js";
import { runDataset } from "./runner.js";
import { BASELINE_TIMEOUT_MS, BASELINE_TRIALS } from "./runner.js";
import { gradeRun } from "./report.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  timeout: { type: "string" }, root: { type: "string" }, run: { type: "string" }, scores: { type: "string" },
} });
function positive(value: string | undefined, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("Expected positive integer");
  return result;
}
const command = positionals[0] ?? "list";
if (command === "list") {
  for (const task of tasks) console.log(`${task.id}\t${task.workload}\t${task.title}`);
} else if (command === "run" || command === "smoke") {
  loadProjectEnvironment();
  const config = loadApplicationConfig();
  const selected = command === "smoke" ? tasks.filter((task, index) => tasks.findIndex(other => other.workload === task.workload) === index) : tasks;
  const run = await runDataset(selected, config, { root: resolve(values.root ?? "eval-results"), trials: BASELINE_TRIALS, timeoutMs: positive(values.timeout, BASELINE_TIMEOUT_MS) });
  const report = await gradeRun(run);
  console.log(JSON.stringify({ run, ...report }, null, 2));
} else if (command === "score") {
  if (!values.run) throw new Error("--run is required");
  const submission = values.scores ? JSON.parse(await readFile(values.scores, "utf8")) : undefined;
  console.log(JSON.stringify(await gradeRun(resolve(values.run), submission), null, 2));
} else throw new Error(`Unknown command: ${command}`);
