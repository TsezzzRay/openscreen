import {
  AgentHarnessError,
  calculateContextTokens,
  DEFAULT_COMPACTION_SETTINGS,
  getLastAssistantUsage,
  SessionError,
  shouldCompact,
} from "@earendil-works/pi-agent-core";

import {
  AgentServiceError,
  type AgentCompactionResult,
  type AgentError,
  type AgentEventListener,
  type AgentPrompt,
  type AgentRunResult,
  type AgentService,
  type AgentSessionState,
  type AgentSessionSummary,
  type AgentSessionView,
  type AgentThinkingLevel,
} from "../api.js";
import { PiPromptRunner } from "./prompt-runner.js";
import {
  PiSessionRuntime,
  type PiSessionRuntimeOptions,
} from "./session-runtime.js";

export type PiAgentServiceOptions = PiSessionRuntimeOptions;

function normalizeError(error: unknown): AgentServiceError {
  if (error instanceof AgentServiceError) return error;
  if (error instanceof AgentHarnessError) {
    const code: AgentError["code"] = error.code === "busy"
      ? "busy"
      : error.code === "invalid_argument"
        ? "invalid-argument"
        : error.code === "session"
          ? "session"
          : error.code === "auth" ||
              error.code === "branch_summary" ||
              error.code === "compaction"
            ? "provider"
            : "unknown";
    return new AgentServiceError(code, error.message, { cause: error });
  }
  if (error instanceof SessionError) {
    const code: AgentError["code"] = error.code === "not_found"
      ? "not-found"
      : error.code === "invalid_entry" || error.code === "invalid_fork_target"
        ? "invalid-argument"
        : "session";
    return new AgentServiceError(code, error.message, { cause: error });
  }
  const cause = error instanceof Error ? error : new Error(String(error));
  return new AgentServiceError("unknown", cause.message, { cause });
}

export class PiAgentService implements AgentService {
  private readonly runtime: PiSessionRuntime;
  private readonly promptRunner: PiPromptRunner;

  constructor(options: PiAgentServiceOptions) {
    this.runtime = new PiSessionRuntime(options);
    this.promptRunner = new PiPromptRunner({
      runtime: this.runtime,
      normalizeError,
    });
  }

  async createSession(): Promise<AgentSessionView> {
    try {
      return await this.runtime.view((await this.runtime.createEntry()).entry);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async listSessions(): Promise<AgentSessionSummary[]> {
    try {
      return await this.runtime.listSessions();
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async getSession(sessionId: string): Promise<AgentSessionView> {
    try {
      return await this.runtime.view(await this.runtime.getEntry(sessionId));
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async renameSession(
    sessionId: string,
    name: string,
  ): Promise<AgentSessionSummary> {
    if (!name.trim()) {
      throw new AgentServiceError(
        "invalid-argument",
        "Session name must not be empty",
      );
    }
    return this.runtime.mutate(sessionId, async () => {
      const entry = await this.runtime.getEntry(sessionId);
      try {
        await entry.session.appendSessionName(name);
        return (await this.runtime.view(entry)).session;
      } catch (error) {
        throw normalizeError(error);
      }
    });
  }

  prompt(
    sessionId: string,
    prompt: AgentPrompt,
    onEvent?: AgentEventListener,
  ): Promise<AgentRunResult> {
    return this.promptRunner.run(sessionId, prompt, onEvent);
  }

  async abort(sessionId: string): Promise<void> {
    try {
      await this.promptRunner.abort(sessionId);
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async compact(
    sessionId: string,
    instructions?: string,
  ): Promise<AgentCompactionResult> {
    return this.runtime.mutate(sessionId, async () =>
      this.compactEntry(await this.runtime.getEntry(sessionId), instructions)
    );
  }

  private async compactEntry(
    entry: Awaited<ReturnType<PiSessionRuntime["getEntry"]>>,
    instructions?: string,
  ): Promise<AgentCompactionResult> {
    try {
      const result = await entry.harness.compact(instructions);
      return {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
      };
    } catch (error) {
      throw normalizeError(error);
    }
  }

  async compactIfNeeded(
    sessionId: string,
  ): Promise<AgentCompactionResult | undefined> {
    return this.runtime.mutate(sessionId, async () => {
      const entry = await this.runtime.getEntry(sessionId);
      try {
        const usage = getLastAssistantUsage(await entry.session.getBranch());
        if (usage === undefined) return undefined;
        const contextTokens = calculateContextTokens(usage);
        if (!shouldCompact(
          contextTokens,
          entry.harness.getModel().contextWindow,
          DEFAULT_COMPACTION_SETTINGS,
        )) {
          return undefined;
        }
        return await this.compactEntry(entry);
      } catch (error) {
        throw normalizeError(error);
      }
    });
  }

  async setThinking(
    sessionId: string,
    thinking: AgentThinkingLevel,
  ): Promise<AgentSessionState> {
    return this.runtime.mutate(sessionId, async () => {
      const entry = await this.runtime.getEntry(sessionId);
      try {
        await entry.harness.setThinkingLevel(thinking);
        return (await this.runtime.view(entry)).state;
      } catch (error) {
        throw normalizeError(error);
      }
    });
  }

}
