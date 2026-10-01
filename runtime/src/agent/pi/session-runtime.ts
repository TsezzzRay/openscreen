import {
  AgentHarness,
  JsonlSessionRepo,
  SessionError,
  type AgentTool,
  Session,
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
  private readonly promptSystemContexts = new WeakMap<Session, string>();
  private readonly compactionSignals = new WeakMap<Session, AbortSignal>();
  private readonly compactionCompletions = new WeakMap<Session, Models["completeSimple"]>();

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
    const models: Models = Object.create(this.options.models);
    models.completeSimple = (model, context, options) => {
      const completion = this.compactionCompletions.get(session);
      return completion
        ? completion(model, context, options)
        : this.options.models.completeSimple(model, context, options);
    };
    return new AgentHarness({
      env: this.env,
      session,
      models,
      model: this.options.model,
      thinkingLevel: state.thinkingLevel,
      tools: this.options.tools ?? [],
      activeToolNames: this.availableToolNames(),
      systemPrompt: () => {
        const base = this.options.systemPrompt ?? "You are a helpful assistant.";
        const current = this.promptSystemContexts.get(session);
        return current === undefined ? base : `${base}\n\n${current}`;
      },
    });
  }

  async withPromptSystemContext<T>(
    session: Session,
    context: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (context) this.promptSystemContexts.set(session, context);
    try {
      return await operation();
    } finally {
      this.promptSystemContexts.delete(session);
    }
  }

  async createEntry(): Promise<{ id: string; entry: HarnessEntry }> {
    const session = this.guardCompactionWrites(await this.repo.create({ cwd: this.options.cwd }));
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
    const session = this.guardCompactionWrites(await this.repo.open(metadata));
    return { session, harness: await this.createHarness(session) };
  }

  private guardCompactionWrites(original: Session): Session {
    // Guard the last synchronous dispatch to storage, not merely the model result.
    // Pi awaits entry IDs and hook handlers before appending a checkpoint.
    let session: Session;
    const storage = new Proxy(original.getStorage(), {
      get: (target, property) => {
        if (property === "appendEntry") return (entry: SessionTreeEntry) => {
          if (entry.type === "compaction" && this.compactionSignals.get(session)?.aborted) {
            throw new AgentServiceError("aborted", "Compaction was aborted");
          }
          return target.appendEntry(entry);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // JsonlSessionRepo creates Sessions with the default context transforms.
    session = new Session(storage);
    return session;
  }

  async withCompactionSignal<T>(session: Session, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    this.compactionSignals.set(session, signal);
    try { return await operation(); }
    finally { this.compactionSignals.delete(session); }
  }

  async withCompactionCompletion<T>(
    session: Session,
    wrap: (complete: Models["completeSimple"]) => Models["completeSimple"],
    operation: () => Promise<T>,
  ): Promise<T> {
    this.compactionCompletions.set(session, wrap((model, context, options) => this.options.models.completeSimple(model, context, options)));
    try { return await operation(); }
    finally { this.compactionCompletions.delete(session); }
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

  async mutate<T>(
    sessionId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.mutationTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.mutationTails.set(sessionId, tail);
    let abort: (() => void) | undefined;
    try {
      if (signal?.aborted) throw new AgentServiceError("aborted", "Request was aborted");
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          abort = () => reject(new AgentServiceError("aborted", "Request was aborted"));
          signal.addEventListener("abort", abort, { once: true });
          previous.then(resolve, reject);
        });
        signal.removeEventListener("abort", abort!);
      } else {
        await previous;
      }
      if (signal?.aborted) throw new AgentServiceError("aborted", "Request was aborted");
      return await operation();
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      release();
      // A cancelled waiter can finish before its predecessor. Keep the tail
      // until that predecessor settles so later mutations cannot bypass it.
      void tail.then(() => {
        if (this.mutationTails.get(sessionId) === tail) this.mutationTails.delete(sessionId);
      });
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
