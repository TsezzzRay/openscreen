import "../src/memory/mastra/telemetry-guard.js";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { tasks } from "./dataset.js";
import { securityTasks } from "./security-dataset.js";
import { desktopSecurityTasks } from "./desktop-security-dataset.js";
import { loadApplicationConfig, loadProjectEnvironment } from "../src/runtime-config.js";
import { runDataset } from "./runner.js";
import { BASELINE_TIMEOUT_MS, BASELINE_TRIALS } from "./runner.js";
import { gradeRun } from "./report.js";
import { buildEvidenceCatalog, buildStagePackets, stagePacketView, buildReadableStagePackets, readableStagePacketView } from "./evidence.js";
import { writeJson } from "./persistence.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  timeout: { type: "string" }, root: { type: "string" }, run: { type: "string" }, scores: { type: "string" }, output: { type: "string" },
  trial: { type: "string" }, stage: { type: "string" }, page: { type: "string" },
} });
function positive(value: string | undefined, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error("Expected positive integer");
  return result;
}
const command = positionals[0] ?? "list";
if (command === "list") {
  for (const task of tasks) console.log(`${task.id}\t${task.workload}\t${task.title}`);
} else if (command === "list-security") {
  for (const task of securityTasks) console.log(`${task.id}\t${task.workload}\t${task.title}`);
} else if (command === "list-desktop-security") {
  for (const task of desktopSecurityTasks) console.log(`${task.id}\t${task.workload}\t${task.title}`);
} else if (command === "run" || command === "smoke" || command === "security-baseline" || command === "desktop-security-baseline") {
  loadProjectEnvironment();
  const config = loadApplicationConfig();
  const selected = command === "security-baseline" ? securityTasks
    : command === "desktop-security-baseline" ? desktopSecurityTasks
    : command === "smoke" ? tasks.filter((task, index) => tasks.findIndex(other => other.workload === task.workload) === index) : tasks;
  const run = await runDataset(selected, config, { root: resolve(values.root ?? "eval-results"), trials: BASELINE_TRIALS, timeoutMs: positive(values.timeout, BASELINE_TIMEOUT_MS) });
  const report = await gradeRun(run);
  console.log(JSON.stringify({ run, ...report }, null, 2));
} else if (command === "evidence" || command === "packet" || command === "readable-packet") {
  if (!values.run || !values.output) throw new Error("--run and --output are required");
  const run = await realpath(resolve(values.run));
  const output = resolve(values.output);
  const destination = join(await realpath(dirname(output)), basename(output));
  const rel = relative(run, destination);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")) throw new Error("Evidence output must be outside the frozen run");
  const catalog = command === "readable-packet" ? await buildReadableStagePackets(run)
    : command === "packet" ? await buildStagePackets(run) : await buildEvidenceCatalog(run);
  await writeJson(output, catalog);
  console.log(JSON.stringify({ output, protocol: catalog.protocol, catalogHash: catalog.catalogHash, entries: catalog.entries.length }));
} else if (command === "packet-view" || command === "readable-packet-view") {
  if (!values.run || !values.trial || !values.stage || !values.page) throw new Error("--run, --trial, --stage and --page are required");
  if (command === "readable-packet-view") {
    const catalog = await buildReadableStagePackets(resolve(values.run));
    console.log(JSON.stringify(readableStagePacketView(catalog, values.trial, values.stage, positive(values.page, 1))));
  } else {
    const catalog = await buildStagePackets(resolve(values.run));
    console.log(JSON.stringify(stagePacketView(catalog, values.trial, values.stage, positive(values.page, 1))));
  }
} else if (command === "readable-packet-list") {
  if (!values.run) throw new Error("--run is required");
  const catalog = await buildReadableStagePackets(resolve(values.run));
  if (values.trial && !catalog.packets.some(packet => packet.trialId === values.trial)) throw new Error("Unknown evidence trial");
  console.log(JSON.stringify({ protocol: catalog.protocol, catalogHash: catalog.catalogHash,
    runId: catalog.runId, tasks: values.trial ? catalog.tasks.filter(task => values.trial?.replace(/-\d+$/u, "") === task.id) : catalog.tasks,
    mediaSources: catalog.mediaSources.filter(source => !values.trial || source.trialId === values.trial),
    packets: catalog.packets.filter(packet => !values.trial || packet.trialId === values.trial)
      .map(({ trialId, stage, page, evidenceIds, omittedSourceIds }) => ({ trialId, stage, page, evidenceCount: evidenceIds.length, omittedSourceCount: omittedSourceIds.length })),
    packetCalibration: catalog.packetCalibration, submissionInstructions: catalog.submissionInstructions }));
} else if (command === "score") {
  if (!values.run) throw new Error("--run is required");
  const submission = values.scores ? JSON.parse(await readFile(values.scores, "utf8")) : undefined;
  console.log(JSON.stringify(await gradeRun(resolve(values.run), submission), null, 2));
} else throw new Error(`Unknown command: ${command}`);
