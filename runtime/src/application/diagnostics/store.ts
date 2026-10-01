import { randomUUID } from "node:crypto";
import { TurnTrace } from "./turn-trace.js";
import { TraceWriter } from "./writer.js";
export { readDiagnosticTurns, type DiagnosticTurn } from "./reader.js";

/** A loaded Session owns one writer shared by its turns. Reopening in another
 * process creates a new bundle, not an append to a closed activation.
 */
class ThreadTraceContext {
  readonly writer: TraceWriter;
  private readonly turns = new Set<TurnTrace>();

  constructor(root: string, readonly threadId: string, onUnavailable?: (message: string) => void) {
    this.writer = new TraceWriter(root, threadId, onUnavailable);
    this.writer.append(null, { type: "rollout_started", trace_id: this.writer.manifest.trace_id, root_thread_id: threadId });
    this.writer.append(null, { type: "thread_started", thread_id: threadId, agent_path: "root" },
      { field: "metadata_payload", kind: "session_metadata", value: { session_id: threadId, collection: "metadata_only",
        approval_policy: "on_request", sandbox_policy: "openscreen_output_write" } });
  }

  start(requestId: string): TurnTrace {
    const turn = new TurnTrace({ threadId: this.threadId, turnId: randomUUID(), requestId }, this.writer.append, undefined,
      () => { this.turns.delete(turn); });
    this.turns.add(turn);
    return turn;
  }

  close(): void {
    for (const turn of this.turns) turn.finish("aborted", "runtime_shutdown");
    this.turns.clear();
    this.writer.append(null, { type: "thread_ended", thread_id: this.threadId, status: "completed" });
    this.writer.append(null, { type: "rollout_ended", status: "completed" });
  }
}

export class DiagnosticStore {
  private readonly threads = new Map<string, ThreadTraceContext>();
  private closed = false;
  constructor(readonly root: string, private readonly onUnavailable?: (message: string) => void) {}

  start(ids: { sessionId: string; requestId: string }): TurnTrace {
    if (this.closed) throw new Error("Trace store is closed");
    let thread = this.threads.get(ids.sessionId);
    if (!thread) {
      thread = new ThreadTraceContext(this.root, ids.sessionId, this.onUnavailable);
      this.threads.set(ids.sessionId, thread);
    }
    return thread.start(ids.requestId);
  }
  async flush(): Promise<void> {
    await Promise.allSettled([...this.threads.values()].map(thread => thread.writer.flush()));
  }
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const thread of this.threads.values()) thread.close();
    }
    await this.flush();
  }
}
