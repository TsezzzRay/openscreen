import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { PiAgentService } from "./agent/pi/service.js";
import { createAgentTools } from "./agent/pi/tools/create-agent-tools.js";
import { ApplicationRuntime } from "./application/runtime.js";
import { NativeCaptureService } from "./capture/service.js";
import {
  loadApplicationConfig,
  loadProjectEnvironment,
} from "./runtime-config.js";
import { serveJsonl } from "./transport/jsonl-server.js";

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
  const agent = new PiAgentService({
    cwd,
    sessionsRoot: join(dataRoot, "sessions"),
    models,
    model,
    tools,
    thinking: config.agent.thinking,
  });
  const bundleIdentifier = process.env.OPENSCREEN_BUNDLE_ID;
  const capture = new NativeCaptureService({
    config: config.capture,
    dataRoot,
    helperCommand: process.env.OPENSCREEN_HELPER_PATH ??
      join(cwd, ".build", "debug", "ObservationHelper"),
    helperCurrentDirectory: cwd,
    excludedProcessIdentifiers: [process.pid, process.ppid],
    excludedBundleIdentifiers:
      bundleIdentifier === undefined ? [] : [bundleIdentifier],
  });
  const runtime = new ApplicationRuntime({
    agent,
    capture,
    onDiagnostic: (diagnostic) => {
      process.stderr.write(
        `OpenScreen ${diagnostic.area} ${diagnostic.phase} unavailable: ${diagnostic.message}\n`,
      );
    },
  });

  await runtime.start();
  try {
    await serveJsonl({
      handler: runtime,
      input: process.stdin,
      output: process.stdout,
      stderr: process.stderr,
    });
  } finally {
    await runtime.stop();
    await env.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
