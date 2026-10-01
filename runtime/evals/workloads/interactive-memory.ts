import { stat } from "node:fs/promises";
import { join } from "node:path";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { PiAgentService } from "../../src/agent/pi/service.js";
import { recordInteractiveTurn } from "../../src/memory/mastra/write-path.js";
import { openMemoryCursors } from "../../src/memory/cursors.js";
import { scanTurnMemorySession } from "../../src/memory/turn-memory/session-scanner.js";
import { renderTurnRollout } from "../../src/memory/turn-memory/rollout.js";
import { snapshot } from "../workspace.js";
import type { WorkloadEnvironment } from "./environment.js";
import { withMemoryEnvironment } from "./memory.js";

export async function executeInteractiveMemoryWorkload(environment: WorkloadEnvironment) {
  const { task, root, workspace, env, options, runPrompt, emit, memoryRoot } = environment;
  return withMemoryEnvironment(environment, async ({ store, projector, observations }) => {
    if (task.input.turnPipeline) {
      const agent = new PiAgentService(options);
      const sessionId = (await agent.createSession()).session.id;
      const initial = await runPrompt(agent, sessionId, { text: task.input.prompt! });
      const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: join(root, "sessions") });
      const metadata = (await repo.list({ cwd: workspace })).find(item => item.id === sessionId);
      if (!metadata) throw new Error("Turn pipeline session was not persisted");
      const info = await stat(metadata.path);
      const cursors = openMemoryCursors(join(root, "cursors"));
      try {
        const scan = await scanTurnMemorySession({
          session: await repo.open(metadata), fileVersion: `${info.size}:${info.mtimeMs}`, gitBranch: "eval", cursors,
          onTerminalSource: async source => {
            const rollout = renderTurnRollout(source, Date.parse("2026-09-01T09:01:00Z"));
            await recordInteractiveTurn({ store, projector }, rollout.observationText, { relativePath: rollout.relativePath, content: rollout.content });
          },
        });
        if (scan.status !== "scanned" || scan.processed < 1) throw new Error("Turn pipeline did not produce a completed Turn");
        return { observations, initial, scan };
      } finally { cursors.close(); }
    }
    for (const [index, message] of task.input.messages!.entries()) {
      if (typeof message !== "string") throw new Error("Capture timestamps require screen-activity memory");
      const artifact = { relativePath: `rollout_summaries/${task.id}-${index}.md`, content: message };
      await recordInteractiveTurn({ store, projector }, message, artifact);
      await projector.projectObservationLogs();
      emit({ type: "memory-snapshot", files: await snapshot(memoryRoot) });
    }
    return { observations };
  });
}
