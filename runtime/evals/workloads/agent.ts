import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PiAgentService } from "../../src/agent/pi/service.js";
import { screenFixturePath, snapshot } from "../workspace.js";
import type { WorkloadEnvironment } from "./environment.js";

/** Continue the same production Session for Agent and post-compaction prompts. */
export async function executeAgentSession(environment: WorkloadEnvironment, agent: PiAgentService, sessionId: string, compression?: unknown) {
  const { task, root, workspace, runPrompt } = environment;
  let screen: { data: Uint8Array; mimeType: "image/png" } | undefined;
  if (task.input.screenFixture) {
    screen = { data: await readFile(screenFixturePath(task.input.screenFixture)), mimeType: "image/png" };
  }
  const answer = await runPrompt(agent, sessionId, { text: task.input.prompt!, ...(screen ? { context: { images: [screen] } } : {}) });
  const initialWorkspace = task.input.agentFollowUps?.length ? await snapshot(workspace) : undefined;
  const followUps = [];
  for (const prompt of task.input.agentFollowUps ?? []) {
    followUps.push(await runPrompt(agent, sessionId, { text: prompt }));
  }
  return { answer, followUps, initialWorkspace, compression, ...environment.agentEvidence(), sessions: await snapshot(join(root, "sessions")),
    ...(environment.desktop === undefined ? {} : { desktopState: environment.desktop.snapshot() }) };
}

export async function executeAgentWorkload(environment: WorkloadEnvironment) {
  const agent = new PiAgentService(environment.options);
  const sessionId = (await agent.createSession()).session.id;
  return executeAgentSession(environment, agent, sessionId);
}
