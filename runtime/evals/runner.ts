import { fork, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRun, appendEvent, finishTrial, hash, writeJson } from "./persistence.js";
import type { ApplicationConfig } from "../src/runtime-config.js";
import type { Task } from "./dataset.js";
import { publicCalibrationCases } from "./calibration.js";
import { screenFixturePath, snapshot } from "./workloads.js";

export type FailureKind = "provider_error" | "configuration_error" | "product_error" | "timeout" | "interrupted";

const evalConcurrency = 2;
export const BASELINE_TRIALS = 1;
export const BASELINE_TIMEOUT_MS = 300_000;
const rateLimitCooldowns = [10_000, 20_000] as const;

export function createProviderCooldown(dependencies: { now?: () => number; sleep?: (milliseconds: number) => Promise<void> } = {}) {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  let cooldownUntil = 0;
  return {
    extend(milliseconds: number) {
      cooldownUntil = Math.max(cooldownUntil, now() + milliseconds);
    },
    async wait() {
      while (true) {
        const remaining = cooldownUntil - now();
        if (remaining <= 0) return;
        await sleep(remaining);
      }
    },
  };
}

export function rateLimitRetryDelay(error: string, attempt: number): number | null {
  if (!/(?:\b429\b|rate[\s_-]*limit|速率限制)/iu.test(error)) return null;
  return rateLimitCooldowns[attempt - 1] ?? null;
}

export async function runWithEvalConcurrency<T>(items: readonly T[], execute: (item: T) => Promise<void>, shouldStop: () => boolean = () => false): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined && !shouldStop()) {
      const index = next++;
      if (index >= items.length) return;
      try { await execute(items[index]); }
      catch (error) { failure = error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(evalConcurrency, items.length) }, worker));
  if (failure !== undefined) throw failure;
}

export function classifyFailure(error: string): FailureKind {
  if (/configured eval model is not available|missing .*api key|credential|unknown provider/iu.test(error)) return "configuration_error";
  const transientStatus = /(?:^(?:error:\s*)?|\b(?:http(?: status)?|status(?: code)?|provider(?: returned| error)?|upstream(?: returned| error)?)\s*[:=]?\s*)(?:408|409|425|429|5\d\d)\b/iu.test(error);
  if (transientStatus || /overload|rate.?limit|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EPIPE|UND_ERR_(?:CONNECT|HEADERS|BODY|SOCKET)|socket hang up|network error|fetch failed/iu.test(error)) return "provider_error";
  return "product_error";
}

function withAttempt(event: unknown, attempt: number): unknown {
  return event !== null && typeof event === "object" ? { ...event, attempt } : { type: "worker-event", attempt, value: event };
}

export async function runDataset(selected: Task[], config: ApplicationConfig, options: { root: string; trials: number; timeoutMs: number }) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  const runId = `${new Date().toISOString().replace(/[^0-9T]/g, "")}-${randomUUID().slice(0, 8)}`;
  const instructions = await readFile("runtime/evals/scoring-instructions.md", "utf8");
  const evalSource = await snapshot("runtime/evals");
  for (const path of Object.keys(evalSource)) if (path.endsWith(".png") || path === "calibration.ts") delete evalSource[path];
  const fixtureHashes = Object.fromEntries(await Promise.all([...new Set(selected.map(task => task.input.screenFixture).filter((name): name is string => !!name))].map(async name => [name, hash((await readFile(screenFixturePath(name))).toString("base64"))])));
  const source = { runtime: await snapshot("runtime/src"), eval: evalSource };
  const run = await createRun(options.root, {
    runId, tasks: selected, trials: options.trials, concurrency: evalConcurrency, commit, dirty, config,
    scorer: { model: "gpt-6-luna", reasoningEffort: "low" },
    datasetHash: hash(selected), instructionHash: hash(instructions), createdAt: new Date().toISOString(),
    nodeVersion: process.version, timeoutMs: options.timeoutMs, sourceHash: hash(source), fixtureHashes,
    lockfileHash: hash(await readFile("package-lock.json", "utf8")),
    executionBoundary: "File tools are confined to fixture paths. Ordinary tasks use sandboxed read-only Bash by default; tasks may declare an exact-command allowlist or model-chosen sandboxed Bash with writes confined to the fixture workspace. Both Bash modes allow output redirection to /dev/null. The macOS sandbox scrubs inherited environment values and denies network access. Up to two isolated scenarios run concurrently. HTTP 429/rate-limit failures receive shared 10s and 20s dispatch cooldowns and are retried at most twice in fresh workspaces; other failures are not retried. Fixed synthetic UI PNGs are checked into the repository and sent without OCR text. Observation threshold=1 (standalone Chronicle and non-observing Turn pipelines=1000000); reflection threshold=1000000 with explicit manual reflection for reflect fixtures.",
  });
  await writeJson(join(run, "dataset.json"), selected);
  await writeJson(join(run, "source.json"), source);
  await writeJson(join(run, "judge-calibration.json"), publicCalibrationCases);
  await writeFile(join(run, "scoring-instructions.md"), instructions, { flag: "wx", mode: 0o600 });

  let interrupted = false;
  const providerCooldown = createProviderCooldown();
  const jobs = selected.flatMap(task => Array.from({ length: options.trials }, (_, index) => ({ task, index: index + 1 })));
  await runWithEvalConcurrency(jobs, async ({ task, index }) => {
    const trialId = `${task.id}-${index}`;
    const started = Date.now();
    let writes = Promise.resolve();
    const emit = (event: unknown) => { writes = writes.then(() => appendEvent(run, trialId, event)); };
    if (task.input.screenFixture) await copyFile(screenFixturePath(task.input.screenFixture), join(run, "artifacts", trialId, "screen.png"));
    console.log(`${trialId}: starting`);
    const attempts: Array<{ attempt: number; status: string; failureKind: FailureKind | null; error?: string; durationMs: number }> = [];
    let finalResult: Record<string, unknown> = { status: "failed", error: "Trial did not start", failureKind: "product_error" };
    let finalWorkspace: Record<string, string> | null = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      await providerCooldown.wait();
      const root = await mkdtemp(join(tmpdir(), "openscreen-eval-trial-"));
      const attemptStarted = Date.now();
      emit({ type: "attempt-start", attempt });
      try {
        const result = await new Promise<Record<string, unknown>>(resolve => {
          const child = fork(fileURLToPath(new URL("./worker.js", import.meta.url)), [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
          let completed: Record<string, unknown> | undefined;
          const cancel = () => { interrupted = true; completed = { status: "failed", error: "Evaluation interrupted", failureKind: "interrupted" }; child.kill("SIGKILL"); };
          process.once("SIGINT", cancel);
          process.once("SIGTERM", cancel);
          const timer = setTimeout(() => { completed = { status: "timeout", error: "Trial deadline exceeded", failureKind: "timeout" }; child.kill("SIGKILL"); }, options.timeoutMs);
          child.stdout?.on("data", chunk => emit({ type: "worker-stdout", attempt, text: String(chunk) }));
          child.stderr?.on("data", chunk => emit({ type: "worker-stderr", attempt, text: String(chunk) }));
          child.on("message", (message: { type: string; event?: unknown; result?: Record<string, unknown>; error?: string }) => {
            if (message.type === "event") emit(withAttempt(message.event, attempt));
            if (message.type === "result") completed = { ...message.result, status: "completed" };
            if (message.type === "error") completed = { status: "failed", error: message.error, failureKind: classifyFailure(message.error ?? "") };
          });
          child.once("error", error => { completed = { status: "failed", error: error.message, failureKind: "product_error" }; });
          child.once("close", code => {
            clearTimeout(timer);
            process.removeListener("SIGINT", cancel);
            process.removeListener("SIGTERM", cancel);
            resolve(completed ?? { status: "failed", error: `Worker exited ${code}`, failureKind: "product_error" });
          });
          child.send({ task: { id: task.id, workload: task.workload, input: task.input }, root, config });
        });
        try { finalWorkspace = await snapshot(join(root, "workspace")); }
        catch { finalWorkspace = null; }
        const failureKind = result.status === "completed" ? null : (result.failureKind as FailureKind | undefined) ?? classifyFailure(String(result.error ?? ""));
        const attemptResult = { attempt, status: String(result.status), failureKind, ...(result.error ? { error: String(result.error) } : {}), durationMs: Date.now() - attemptStarted };
        attempts.push(attemptResult);
        emit({ type: "attempt-finished", ...attemptResult });
        finalResult = { ...result, ...(failureKind ? { failureKind } : {}) };
        const retryDelay = failureKind === "provider_error" ? rateLimitRetryDelay(String(result.error ?? ""), attempt) : null;
        if (retryDelay === null || interrupted) break;
        providerCooldown.extend(retryDelay);
        emit({ type: "provider-cooldown", attempt, delayMs: retryDelay });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
    await writes;
    await finishTrial(run, trialId, { ...finalResult, attempts, partialWorkspace: finalWorkspace, durationMs: Date.now() - started });
    console.log(`${trialId}: ${finalResult.status}`);
  }, () => interrupted);
  return run;
}
