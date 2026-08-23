// Must stay the first import in this file — see the module comment in
// telemetry-guard.ts for why ordering matters here.
import "./memory/mastra/telemetry-guard.js";

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { PiAgentService } from "./agent/pi/service.js";
import { createAgentTools } from "./agent/pi/tools/create-agent-tools.js";
import { ApplicationRuntime } from "./application/runtime.js";
import type { CaptureService } from "./capture/api.js";
import { NativeCaptureService } from "./capture/native/service.js";
import { ScreenpipeRuntime } from "./capture/screenpipe/runtime.js";
import { RetryingMemoryLifecycle } from "./memory/lifecycle.js";
import { MemoryRuntime } from "./memory/runtime.js";
import { createMemoryReadPath } from "./memory/mastra/read-path.js";
import {
  loadApplicationConfig,
  loadProjectEnvironment,
} from "./runtime-config.js";
import { serveJsonl } from "./transport/jsonl-server.js";

/**
 * The assistant's own windows are cut out of every capture, so it can never be
 * asked about a screen that is mostly its own interface — and never reads its
 * own last answer back as if it were the user's work.
 */
const OWN_BUNDLE_IDS = ["com.openscreen.app", "com.github.Electron"] as const;

/**
 * The capture helper lives beside the runtime it is built with. A development
 * launch runs from the checkout; a packaged launch keeps the same relative
 * layout under the unpacked resources.
 */
function nativeHelperPath(): string {
  const configured = process.env.OPENSCREEN_CAPTURE_HELPER;
  if (configured !== undefined && configured.length > 0) return configured;
  // Resolved against this module, not the working directory, which a packaged
  // launch moves to the user's home.
  return fileURLToPath(
    new URL("../../native/bin/openscreen-capture", import.meta.url),
  );
}

export async function run(): Promise<void> {
  loadProjectEnvironment();
  const config = loadApplicationConfig();
  const models = builtinModels();
  if (models.getProvider(config.agent.provider) === undefined) {
    throw new Error(`Unknown pi provider: ${config.agent.provider}`);
  }
  const model = models.getModel(config.agent.provider, config.agent.model);
  if (model === undefined) {
    throw new Error(
      `Unknown pi model: ${config.agent.provider}/${config.agent.model}`,
    );
  }

  const cwd = process.cwd();
  const dataRoot = process.env.OPENSCREEN_DATA_DIR ??
    join(homedir(), "Library", "Application Support", "OpenScreen");
  const env = new NodeExecutionEnv({ cwd });
  const tools = createAgentTools(env);
  const memoryRoot = join(dataRoot, "memory");
  const screenpipeConfig = config.capture.screenpipe;
  let canDeleteGeneration = (_generationId: string) => !config.memory.enabled;
  const screenpipeRuntime = new ScreenpipeRuntime({
    dataRoot,
    ignoredWindows: screenpipeConfig.ignoredWindows,
    ignoredUrls: screenpipeConfig.ignoredUrls,
    generationPolicy: screenpipeConfig.retention,
    canDeleteGeneration: (generationId) => canDeleteGeneration(generationId),
    onDiagnostic: (diagnostic) => {
      process.stderr.write(
        `OpenScreen capture ${diagnostic.phase} unavailable\n`,
      );
    },
  });
  const memory = new MemoryRuntime({
    cwd,
    sessionsRoot: join(dataRoot, "sessions"),
    memoryRoot,
    env,
    models,
    model,
    config: config.memory,
    ...(screenpipeConfig.enabled
      ? {
          chronicleFrameFeed: {
            listGenerations: () => screenpipeRuntime.listGenerations(),
            readFramesAfter: async (
              generationId: string,
              cursor: number,
              limit: number,
            ) => {
              const read = await screenpipeRuntime.readGenerationFramesAfter(
                generationId,
                cursor,
                limit,
              );
              return {
                generationId: read.generation.generationId,
                frames: read.frames.map((frame) => ({
                  sourceId: frame.sourceId,
                  generationId: frame.generationId,
                  frameId: frame.frameId,
                  monitorKey: frame.monitorKey,
                  deviceName: frame.deviceName,
                  capturedAt: frame.capturedAt,
                  trigger: frame.trigger,
                  ...(frame.application === undefined
                    ? {}
                    : { application: frame.application }),
                  ...(frame.windowTitle === undefined
                    ? {}
                    : { windowTitle: frame.windowTitle }),
                  ...(frame.url === undefined ? {} : { url: frame.url }),
                  ...(frame.visibleText === undefined
                    ? {}
                    : { visibleText: frame.visibleText }),
                })),
                cursor: read.cursor,
                hasMore: read.hasMore,
              };
            },
          },
        }
      : {}),
    onDiagnostic: (diagnostic) => {
      // Static hint only — the cause is written to the private
      // memory/diagnostics.log, keeping stderr free of paths and content.
      process.stderr.write(
        `OpenScreen memory ${diagnostic.phase} unavailable (cause in memory/diagnostics.log)\n`,
      );
    },
  });
  const memoryLifecycle = new RetryingMemoryLifecycle({
    service: memory,
    retryMilliseconds: config.memory.worker.intervalMilliseconds,
  });
  canDeleteGeneration = (generationId) =>
    !config.memory.enabled || memory.chronicleGenerationComplete(generationId);
  const memoryReadPath = createMemoryReadPath(memoryRoot, {
    enabled: config.memory.enabled,
  });
  const agent = new PiAgentService({
    cwd,
    sessionsRoot: join(dataRoot, "sessions"),
    models,
    model,
    tools,
    thinking: config.agent.thinking,
    onPromptSettled: (sessionId) => memory.notifySession(sessionId),
    loadPromptSystemContext: memoryReadPath?.loadPromptContext,
    memoryCitationRoot: memoryReadPath?.root,
  });
  // The prompt path reads the screen live. The recorder keeps running for the
  // background activity history, but its stored frames trail the question by
  // seconds and can name a window the user has already left, so they are no
  // longer what a prompt is answered against.
  const capture: CaptureService = config.capture.native.enabled
    ? new NativeCaptureService({
        helperPath: nativeHelperPath(),
        excludeBundleIds: OWN_BUNDLE_IDS,
      })
    : {
        start: async () => {},
        stop: async () => {},
        capture: async () => ({ type: "frames", frames: [], images: [] }),
      };
  const runtime = new ApplicationRuntime({
    agent,
    capture,
    onDiagnostic: (diagnostic) => {
      process.stderr.write(
        `OpenScreen ${diagnostic.area} ${diagnostic.phase} unavailable\n`,
      );
    },
  });

  // The recorder no longer sits behind the Capture service, because prompts are
  // answered from a live read now. It belongs to the background activity
  // history, so it is started here and its failure is not fatal: the Chronicle
  // stalls, the Agent still answers.
  let recorderStarted = false;
  if (screenpipeConfig.enabled) {
    try {
      await screenpipeRuntime.start();
      recorderStarted = true;
    } catch {
      process.stderr.write("OpenScreen capture start unavailable\n");
    }
  }

  let runtimeStartAttempted = false;
  try {
    await memoryLifecycle.start();
    runtimeStartAttempted = true;
    await runtime.start();
    void memory.runOnce().catch(() => {
      process.stderr.write("OpenScreen memory initial cycle unavailable\n");
    });
    await serveJsonl({
      handler: runtime,
      input: process.stdin,
      output: process.stdout,
      stderr: process.stderr,
    });
  } finally {
    try {
      if (runtimeStartAttempted) await runtime.stop();
    } finally {
      try {
        await memoryLifecycle.stop();
      } finally {
        try {
          if (recorderStarted) await screenpipeRuntime.stop();
        } finally {
          await env.cleanup();
        }
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
