import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AgentApprovalTarget, AgentExecutionDiagnostic, AgentRunEvent } from "../../agent/api.js";
import type { ExecutionStatus, TraceAppend, TraceAttachment, TracePayload } from "./schema.js";

type Phase = "capture" | "agent" | "compaction";
type ToolSpan = { id: string; start: number; name: string; argumentBytes: number; inferenceId?: string; failure?: string; declined?: boolean; cancelled?: boolean };
type ApprovalSpan = { start: number; callId: string; end?: number };
let toolResultSequence = 0; // Process-wide result order, independent of each writer's seq.
export type TurnDiagnosticSink = Pick<TurnTrace, "stage" | "agentEvent" | "agentDiagnostic" | "finish">;

function unionDuration(intervals: { start: number; end: number }[]): number {
  let total = 0;
  let until = 0;
  for (const interval of intervals.sort((a, b) => a.start - b.start)) {
    total += Math.max(0, interval.end - Math.max(until, interval.start));
    until = Math.max(until, interval.end);
  }
  return total;
}

function targetMetadata(target: AgentApprovalTarget): Record<string, unknown> {
  const text = typeof target === "string" ? target : JSON.stringify(target);
  const metadata: Record<string, unknown> = { target_sha256: createHash("sha256").update(text).digest("hex") };
  if (typeof target !== "string") {
    if (target.bundleId !== null) metadata.bundle_id = target.bundleId;
    if (Number.isSafeInteger(target.pid) && target.pid > 0) metadata.pid = target.pid;
    if (/^[0-9]+$/.test(target.windowId)) metadata.window_id = target.windowId;
  }
  return metadata;
}

/** One user prompt within a thread activation, not one model sampling iteration. */
export class TurnTrace {
  readonly turnId: string;
  private readonly origin: number;
  private elapsed = 0;
  private finished = false;
  private readonly phases = new Map<Phase, number>();
  private readonly tools = new Map<string, ToolSpan>();
  private readonly origins = new Map<string, string>();
  private readonly approvals = new Map<string, ApprovalSpan>();
  private readonly models = new Map<string, { start: number; firstToken?: number; upstreamRequestId?: string }>();
  private firstToken?: number;

  constructor(
    private readonly ids: { threadId: string; turnId: string; requestId: string },
    private readonly append: TraceAppend,
    private readonly clock = { now: () => performance.now() },
    private readonly onSettled?: () => void,
  ) {
    this.turnId = ids.turnId;
    this.origin = clock.now();
    this.record({ type: "codex_turn_started", codex_turn_id: ids.turnId, thread_id: ids.threadId });
    this.protocol("turn_started", { id: ids.requestId, turn_id: ids.turnId });
  }

  private now(): number {
    this.elapsed = Math.max(this.elapsed, this.clock.now() - this.origin, 0);
    return this.elapsed;
  }

  private record(payload: TracePayload, attachment?: TraceAttachment): void {
    if (this.finished) return;
    try { this.append(this.turnId, payload, attachment); }
    catch { /* Trace observers must never change execution or authorization. */ }
  }

  private protocol(type: string, metadata: Record<string, unknown>): void {
    this.record({ type: "protocol_event_observed", event_type: type },
      { field: "event_payload", kind: "protocol_event", value: { type, turn_id: this.turnId, ...metadata } });
  }

  private other(kind: string, metadata: Record<string, unknown>): void {
    this.record({ type: "other", kind, summary: kind, payloads: [], metadata });
  }

  stage(phase: Phase, boundary: "start" | "end", status: "completed" | "failed" | "cancelled" | "degraded" = "completed", errorCode?: string): void {
    if (this.finished) return;
    const now = this.now();
    if (boundary === "start") {
      if (this.phases.has(phase)) return;
      this.phases.set(phase, now);
      this.other("openscreen.phase", { phase, boundary });
    } else {
      const start = this.phases.get(phase);
      if (start === undefined) return;
      this.phases.delete(phase);
      this.other("openscreen.phase", { phase, boundary, status, duration_ms: now - start,
        ...(errorCode ? { error_code: errorCode } : {}) });
    }
  }

  agentDiagnostic(event: AgentExecutionDiagnostic): void {
    if (this.finished) return;
    const now = this.now();
    switch (event.type) {
      case "model-start":
        this.models.set(event.invocationId, { start: now });
        this.record({ type: "inference_started", inference_call_id: event.invocationId,
          thread_id: this.ids.threadId, codex_turn_id: this.turnId, model: event.model, provider_name: event.provider },
          { field: "request_payload", kind: "inference_request", value: { model: event.model, provider_name: event.provider, collection: "metadata_only" } });
        break;
      case "model-first-token": {
        const model = this.models.get(event.invocationId);
        if (!model || model.firstToken !== undefined) break;
        model.firstToken = now;
        this.firstToken ??= now;
        this.other("codex.inference_ttft", { inference_call_id: event.invocationId, duration_ms: now - model.start });
        break;
      }
      case "model-response": {
        const model = this.models.get(event.invocationId);
        if (model && event.upstreamRequestId) model.upstreamRequestId = event.upstreamRequestId;
        this.other("openscreen.provider_response", { inference_call_id: event.invocationId, http_status: event.status,
          ...(event.upstreamRequestId ? { upstream_request_id: event.upstreamRequestId } : {}) });
        break;
      }
      case "model-end":
        this.endModel(event.invocationId, event.stopReason === "error" ? "failed" : event.stopReason === "aborted" ? "cancelled" : "completed", event);
        break;
      case "tool-call-origin": this.origins.set(event.callId, event.invocationId); break;
      case "tool-cancelled": {
        const tool = this.tools.get(event.callId);
        if (tool) { tool.cancelled = true; tool.failure = "aborted"; }
        break;
      }
      case "command-start": {
        const tool = this.tools.get(event.callId);
        if (!tool) break;
        this.record({ type: "tool_call_runtime_started", tool_call_id: tool.id },
          { field: "runtime_payload", kind: "tool_runtime_event", value: {
            type: "exec_command_begin", call_id: event.callId, turn_id: this.turnId, attempt_id: event.attemptId,
            sandbox_type: event.host ? "none" : "macos_seatbelt", approval_policy: "on_request",
            approval_id: event.approvalId ?? null,
          } });
        break;
      }
      case "command-end": {
        const tool = this.tools.get(event.callId);
        if (!tool) break;
        tool.failure = event.errorCode ?? (event.exitCode === 0 ? undefined : "nonzero_exit");
        tool.cancelled = event.status === "cancelled";
        this.record({ type: "tool_call_runtime_ended", tool_call_id: tool.id, status: event.status },
          { field: "runtime_payload", kind: "tool_runtime_event", value: {
            type: "exec_command_end", call_id: event.callId, turn_id: this.turnId, attempt_id: event.attemptId,
            sandbox_type: event.host ? "none" : "macos_seatbelt", duration_ms: event.durationMs,
            exit_code: event.exitCode ?? null, error_code: event.errorCode ?? null, status: event.status,
          } });
        break;
      }
      case "approval-outcome": {
        const approval = this.approvals.get(event.approvalId);
        if (!approval || approval.end !== undefined) break;
        approval.end = now;
        if (event.reason === "denied") {
          const tool = this.tools.get(approval.callId);
          if (tool) tool.declined = true;
        } else if (event.reason === "cancelled") {
          const tool = this.tools.get(approval.callId);
          if (tool) { tool.cancelled = true; tool.failure = "aborted"; }
        }
        this.protocol("approval_decision", { approval_id: event.approvalId, call_id: approval.callId,
          decision: event.reason === "approved" ? "approved" : event.reason === "denied" ? "denied" : "abort",
          source: event.reason === "cancelled" ? "runtime" : "user", duration_ms: now - approval.start });
        break;
      }
      case "execution-uncertain":
        this.other("openscreen.execution_uncertain", { approval_id: event.approvalId, call_id: event.callId, tool_name: event.name });
        break;
      case "memory-context-unavailable": this.other("openscreen.memory_context_unavailable", { error_code: "memory-context-unavailable" }); break;
    }
  }

  private endModel(id: string, status: "completed" | "failed" | "cancelled", details?: Extract<AgentExecutionDiagnostic, { type: "model-end" }>): void {
    const model = this.models.get(id);
    if (!model) return;
    this.models.delete(id);
    const value = { duration_ms: this.now() - model.start,
      ...(model.firstToken === undefined ? {} : { time_to_first_token_ms: model.firstToken - model.start }),
      ...(details === undefined ? {} : { stop_reason: details.stopReason, usage: {
        input: details.inputTokens, output: details.outputTokens, cache_read: details.cacheReadTokens, cache_write: details.cacheWriteTokens,
      } }) };
    if (status === "completed") this.record({ type: "inference_completed", inference_call_id: id,
      response_id: null, upstream_request_id: model.upstreamRequestId ?? null },
      { field: "response_payload", kind: "inference_response", value });
    else if (status === "failed") this.record({ type: "inference_failed", inference_call_id: id,
      upstream_request_id: model.upstreamRequestId ?? null, error: "provider_error" },
      { field: "partial_response_payload", kind: "inference_response", value });
    else this.record({ type: "inference_cancelled", inference_call_id: id,
      upstream_request_id: model.upstreamRequestId ?? null, reason: "turn_interrupted" },
      { field: "partial_response_payload", kind: "inference_response", value });
  }

  agentEvent(event: AgentRunEvent): void {
    if (this.finished) return;
    const now = this.now();
    switch (event.type) {
      case "tool-start": {
        if (this.tools.has(event.callId)) break;
        const id = randomUUID();
        const inferenceId = this.origins.get(event.callId);
        this.tools.set(event.callId, { id, start: now, name: event.name,
          argumentBytes: Buffer.byteLength(JSON.stringify(event.input)), inferenceId });
        this.record({ type: "tool_call_started", tool_call_id: id, model_visible_call_id: event.callId,
          code_mode_runtime_tool_id: null, requester: { type: "model" },
          kind: event.name === "bash" ? { type: "exec_command" } : { type: "other", name: event.name },
          summary: { type: "generic", label: event.name, input_preview: null, output_preview: null } },
          { field: "invocation_payload", kind: "tool_invocation", value: { tool_name: event.name, call_id: event.callId,
            ...(inferenceId ? { inference_call_id: inferenceId } : {}) } });
        break;
      }
      case "tool-end": this.endTool(event.callId, event.isError ? "failed" : "completed", event.text); break;
      case "approval-requested": {
        const request = event.request;
        this.approvals.set(request.id, { start: now, callId: request.callId });
        this.protocol(request.tool === "bash" ? "exec_approval_request" : request.tool.startsWith("desktop_") ? "desktop_approval_request" : "apply_patch_approval_request", {
          call_id: request.callId, approval_id: request.id, tool_call_id: this.tools.get(request.callId)?.id ?? null,
          tool_name: request.tool, ...targetMetadata(request.target),
        });
        break;
      }
      // Product booleans cannot distinguish denial from cancellation. The security
      // callback emits approval-outcome before the UI event; never infer it here.
      case "approval-decided": break;
      case "approval-committed":
        this.protocol("approval_committed", { approval_id: event.id, call_id: event.callId,
          tool_name: event.tool, source: this.approvals.get(event.id)?.callId === event.callId ? "user" : "session",
          ...targetMetadata(event.target) });
        break;
      case "failure": this.protocol("error", { error_code: event.error.code }); break;
      default: break;
    }
  }

  private endTool(callId: string, status: Exclude<ExecutionStatus, "running">, output: string): void {
    const tool = this.tools.get(callId);
    if (!tool) return;
    if (tool.cancelled) status = "cancelled";
    this.tools.delete(callId);
    const now = this.now();
    const approvalWait = unionDuration([...this.approvals.values()].filter(approval => approval.callId === callId)
      .map(approval => ({ start: Math.max(tool.start, approval.start), end: approval.end ?? now })));
    this.record({ type: "tool_call_ended", tool_call_id: tool.id, status },
      { field: "result_payload", kind: "tool_result", value: { call_id: callId, tool_name: tool.name,
        duration_ms: now - tool.start, approval_wait_ms: approvalWait,
        dispatch_active_ms: now - tool.start - approvalWait,
        status: tool.declined ? "declined" : status,
        ...(status === "failed" || status === "cancelled" ? { error_code: tool.declined ? "approval_denied" : tool.failure ?? "tool_error" } : {}) } });
    this.other("codex.tool_result", { tool_result_seq: ++toolResultSequence,
      call_id: callId, tool_name: tool.name, duration_ms: now - tool.start, success: status === "completed",
      arguments_length: tool.argumentBytes, output_length: Buffer.byteLength(output),
      output_line_count: output.length === 0 ? 0 : output.split("\n").length - Number(output.endsWith("\n")),
      tool_origin: "builtin", mcp_tool: false });
  }

  finish(status: "completed" | "failed" | "cancelled" | "aborted", errorCode?: string): void {
    if (this.finished) return;
    const now = this.now();
    const phase = [...this.phases.keys()].at(-1);
    for (const [id, approval] of this.approvals) {
      if (approval.end !== undefined) continue;
      approval.end = now;
      this.protocol("approval_wait_ended", { approval_id: id, call_id: approval.callId,
        status: "aborted", duration_ms: now - approval.start });
    }
    // A turn end is not a tool result or a provider terminal response. Preserve
    // raw evidence; the reader closes running inference windows at owner end.
    for (const [phase, start] of this.phases) this.other("openscreen.phase", {
      phase, boundary: "end", status: "aborted", duration_ms: now - start,
    });
    this.phases.clear();
    const wait = unionDuration([...this.approvals.values()].map(approval => ({ start: approval.start, end: approval.end! })));
    this.protocol(status === "cancelled" || status === "aborted" ? "turn_aborted" : "turn_complete", {
      status, ...(status === "cancelled" || status === "aborted" ? { reason: "interrupted" } : {}),
      duration_ms: now, approval_wait_ms: wait, active_ms: now - wait,
      ...(this.firstToken === undefined ? {} : { time_to_first_token_ms: this.firstToken }),
      ...(errorCode ? { error_code: errorCode, phase } : {}),
    });
    this.record({ type: "codex_turn_ended", codex_turn_id: this.turnId, status });
    this.finished = true;
    this.tools.clear();
    this.models.clear();
    this.origins.clear();
    try { this.onSettled?.(); } catch { /* Optional writer ownership cleanup. */ }
  }
}
