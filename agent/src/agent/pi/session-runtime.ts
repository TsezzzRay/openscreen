import {
  AgentHarness,
  JsonlSessionRepo,
  SessionError,
  type AgentTool,
  type Session,
  type SessionContext,
  type SessionTreeEntry,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model, Models } from "@earendil-works/pi-ai";

import {
  AgentServiceError,
  type AgentSessionSummary,
  type AgentSessionView,
} from "../api.js";
import {
  projectSessionName,
  projectSession,
  type SessionProjectionDefaults,
} from "./session-projection.js";

export interface PiSessionRuntimeOptions {
  cwd: string;
  sessionsRoot: string;
  models: Models;
  model: Model<string>;
  tools?: AgentTool[];
  systemPrompt?: string;
  thinking?: ThinkingLevel;
}

export interface HarnessEntry {
  session: Session;
  harness: AgentHarness;
}

export interface ResolvedContextState {
  thinkingLevel: ThinkingLevel;
}

export class PiSessionRuntime {
  readonly env: NodeExecutionEnv;
  private readonly repo: JsonlSessionRepo;
  private readonly entries = new Map<string, Promise<HarnessEntry>>();
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(private readonly options: PiSessionRuntimeOptions) {
    this.env = new NodeExecutionEnv({ cwd: options.cwd });
    this.repo = new JsonlSessionRepo({
      fs: this.env,
      sessionsRoot: options.sessionsRoot,
    });
  }

  findModel(provider: string, id: string) {
    return this.options.models.getModel(provider, id);
  }

  private availableToolNames(): string[] {
    return (this.options.tools ?? []).map((tool) => tool.name);
  }

  private projectionDefaults(harness: AgentHarness): SessionProjectionDefaults {
    return { thinking: harness.getThinkingLevel() };
  }

  resolveContextState(
    context: SessionContext,
    branch: SessionTreeEntry[],
  ): ResolvedContextState {
    return {
      thinkingLevel:
        branch.some((entry) => entry.type === "thinking_level_change") &&
          this.isThinkingLevel(context.thinkingLevel)
        ? context.thinkingLevel
        : (this.options.thinking ?? "off"),
    };
  }

  async createHarness(session: Session): Promise<AgentHarness> {
    const branch = await session.getBranch();
    const state = this.resolveContextState(await session.buildContext(), branch);
    return this.createHarnessFromState(session, state);
  }

  createHarnessFromState(
    session: Session,
    state: ResolvedContextState,
  ): AgentHarness {
    return new AgentHarness({
      env: this.env,
      session,
      models: this.options.models,
      model: this.options.model,
      thinkingLevel: state.thinkingLevel,
      tools: this.options.tools ?? [],
      activeToolNames: this.availableToolNames(),
      systemPrompt: this.options.systemPrompt,
    });
  }

  async createEntry(): Promise<{ id: string; entry: HarnessEntry }> {
    const session = await this.repo.create({ cwd: this.options.cwd });
    const metadata = await session.getMetadata();
    const entry = { session, harness: await this.createHarness(session) };
    this.setEntry(metadata.id, entry);
    return { id: metadata.id, entry };
  }

  async listSessions(): Promise<AgentSessionSummary[]> {
    const metadata = await this.repo.list({ cwd: this.options.cwd });
    const summaries: AgentSessionSummary[] = [];
    for (const item of metadata) {
      try {
        const session = await this.repo.open(item);
        const [name, entries] = await Promise.all([
          session.getSessionName(),
          session.getEntries(),
        ]);
        summaries.push({
          id: item.id,
          createdAt: item.createdAt,
          name: projectSessionName(name, entries),
        });
      } catch (error) {
        if (error instanceof SessionError && error.code === "invalid_entry") {
          continue;
        }
        throw error;
      }
    }
    return summaries;
  }

  private async openEntry(sessionId: string): Promise<HarnessEntry> {
    const metadata = (await this.repo.list({ cwd: this.options.cwd })).find(
      (candidate) => candidate.id === sessionId,
    );
    if (!metadata) {
      throw new AgentServiceError("not-found", `Session not found: ${sessionId}`);
    }
    const session = await this.repo.open(metadata);
    return { session, harness: await this.createHarness(session) };
  }

  getEntry(sessionId: string): Promise<HarnessEntry> {
    const existing = this.entries.get(sessionId);
    if (existing) return existing;
    let opening: Promise<HarnessEntry>;
    opening = this.openEntry(sessionId).catch((error: unknown) => {
      if (this.entries.get(sessionId) === opening) {
        this.entries.delete(sessionId);
      }
      throw error;
    });
    this.entries.set(sessionId, opening);
    return opening;
  }

  view(entry: HarnessEntry): Promise<AgentSessionView> {
    return projectSession(
      entry.session,
      this.projectionDefaults(entry.harness),
    );
  }

  setEntry(sessionId: string, entry: HarnessEntry): void {
    this.entries.set(sessionId, Promise.resolve(entry));
  }

  deleteEntry(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  async mutate<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.mutationTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.mutationTails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.mutationTails.get(sessionId) === tail) {
        this.mutationTails.delete(sessionId);
      }
    }
  }

  private isThinkingLevel(value: string): value is ThinkingLevel {
    return [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ].includes(value);
  }
}
