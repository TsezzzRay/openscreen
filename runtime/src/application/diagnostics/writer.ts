import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { RawPayloadRef, RawTraceEvent, TraceAppend, TraceManifest, TracePayload } from "./schema.js";

/** One append-only writer per thread activation. No reduced graph is persisted. */
export class TraceWriter {
  readonly manifest: TraceManifest;
  readonly bundle: string;
  private sequence = 0;
  private ordinal = 0;
  private tail = Promise.resolve();
  private handle?: FileHandle;
  private initialized = false;
  private unavailable = false;
  private closed = false;

  constructor(readonly root: string, threadId: string, private readonly onUnavailable?: (message: string) => void,
    private readonly clock: () => number = Date.now) {
    const traceId = randomUUID();
    this.bundle = `trace-${traceId}-${createHash("sha256").update(threadId).digest("hex").slice(0, 12)}`;
    this.manifest = { schema_version: 1, trace_id: traceId, rollout_id: threadId, root_thread_id: threadId,
      started_at_unix_ms: clock(), raw_event_log: "trace.jsonl", payloads_dir: "payloads",
      openscreen: { upstream_commit: "1fc8d548077fc72c4e3d048a78173af07385217f", collection: "metadata_only",
        inference_boundary: "pi_provider_request", transport_attempts: "not_exposed" } };
  }

  readonly append: TraceAppend = (turnId, payload, attachment) => {
    if (this.closed || this.unavailable) return;
    let ref: RawPayloadRef | undefined;
    if (attachment) {
      const ordinal = ++this.ordinal;
      ref = { raw_payload_id: `raw_payload:${ordinal}`, kind: { type: attachment.kind }, path: `payloads/${ordinal}.json` };
    }
    const event: RawTraceEvent = { schema_version: 1, seq: ++this.sequence, wall_time_unix_ms: this.clock(),
      rollout_id: this.manifest.rollout_id, thread_id: this.manifest.root_thread_id, codex_turn_id: turnId,
      payload: ref && attachment ? { ...payload, [attachment.field]: ref } as TracePayload : payload };
    const line = `${JSON.stringify(event)}\n`;
    const detail = attachment ? `${JSON.stringify(attachment.value, null, 2)}\n` : undefined;
    this.tail = this.tail.then(async () => {
      if (this.unavailable) return;
      const directory = join(this.root, this.bundle);
      if (!this.initialized) {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await mkdir(directory, { mode: 0o700 });
        await mkdir(join(directory, "payloads"), { mode: 0o700 });
        await writeFile(join(directory, "manifest.json"), `${JSON.stringify(this.manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        this.handle = await open(join(directory, "trace.jsonl"), "wx", 0o600);
        this.initialized = true;
      }
      // Never append a reference before its payload file exists.
      if (ref && detail) await writeFile(join(directory, ref.path), detail, { flag: "wx", mode: 0o600 });
      await this.handle!.writeFile(line);
      if (payload.type === "rollout_ended") { await this.handle!.close(); this.handle = undefined; }
    }).catch(async () => {
      if (!this.unavailable) {
        this.unavailable = true;
        try { this.onUnavailable?.("OpenScreen rollout trace unavailable"); } catch { /* Optional local warning. */ }
      }
      try { await this.handle?.close(); } catch { /* Never affect the agent. */ }
      this.handle = undefined;
    });
    if (payload.type === "rollout_ended") this.closed = true;
  };

  async flush(): Promise<void> { await this.tail; }
}
