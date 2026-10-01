import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionStatus, ExecutionWindow, InferenceCall, ToolCall, RawPayloadRef, RawTraceEvent, TraceManifest } from "./schema.js";

const BUNDLE = /^trace-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-[0-9a-f]{12}$/;
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PAYLOAD_FIELDS = ["metadata_payload", "request_payload", "response_payload", "partial_response_payload", "invocation_payload", "runtime_payload", "result_payload", "event_payload"];
const EVENT_TYPES = new Set(["rollout_started", "rollout_ended", "thread_started", "thread_ended", "codex_turn_started", "codex_turn_ended",
  "inference_started", "inference_completed", "inference_failed", "inference_cancelled", "tool_call_started", "tool_call_runtime_started",
  "tool_call_runtime_ended", "tool_call_ended", "protocol_event_observed", "other"]);

export interface DiagnosticTurn {
  turnId: string;
  threadId: string;
  requestId: string;
  traceId: string;
  bundle: string;
  startedAt: number;
  status: ExecutionStatus;
  complete: boolean;
  incompleteTail: boolean;
  records: RawTraceEvent[];
  payloads: Record<string, Record<string, unknown>>;
  inferenceCalls: Record<string, InferenceCall>;
  toolCalls: Record<string, ToolCall>;
}

function executionWindow(record: RawTraceEvent): ExecutionWindow {
  return { started_at_unix_ms: record.wall_time_unix_ms, started_seq: record.seq,
    ended_at_unix_ms: null, ended_seq: null, status: "running" };
}
function endWindow(window: ExecutionWindow, record: RawTraceEvent, status: ExecutionStatus): void {
  if (window.status !== "running") return; // Late evidence never overwrites owner-end status.
  window.ended_at_unix_ms = record.wall_time_unix_ms;
  window.ended_seq = record.seq;
  window.status = status;
}

async function readPrivateFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Trace path is not a regular file");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

/** Read-only reduction. Missing terminal events remain running/unknown. */
export async function readDiagnosticTurns(root: string, filter: { turnId?: string; sessionId?: string } = {}): Promise<DiagnosticTurn[]> {
  if (filter.turnId !== undefined && !ID.test(filter.turnId)) throw new Error("Invalid Turn ID");
  let entries: string[];
  try { entries = await readdir(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const turns: DiagnosticTurn[] = [];
  for (const bundle of entries.filter(entry => BUNDLE.test(entry))) {
    const directory = join(root, bundle);
    if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid trace bundle directory");
    const manifest: TraceManifest = JSON.parse(await readPrivateFile(join(directory, "manifest.json")));
    if (manifest.schema_version !== 1 || !ID.test(manifest.trace_id) || typeof manifest.root_thread_id !== "string" ||
      manifest.rollout_id !== manifest.root_thread_id || manifest.raw_event_log !== "trace.jsonl" || manifest.payloads_dir !== "payloads") throw new Error("Invalid trace manifest");
    if (!(await lstat(join(directory, "payloads"))).isDirectory()) throw new Error("Invalid payload directory");
    const lines = (await readPrivateFile(join(directory, "trace.jsonl"))).split("\n");
    const incompleteTail = lines.at(-1) !== "";
    lines.pop(); // Never interpret a partially appended final line.
    let sequence = 0;
    const payloads: Record<string, Record<string, unknown>> = Object.create(null);
    const own = new Map<string, DiagnosticTurn>();
    const inferences = new Map<string, InferenceCall>();
    const tools = new Map<string, ToolCall>();
    const toolCallsByModelId = new Map<string, string>();
    const runtimeAttempts = new Map<string, { toolId: string; turnId: string }>();
    const approvals = new Map<string, { turnId: string; callId: string; decision?: string }>();
    for (const line of lines) {
      const record: RawTraceEvent = JSON.parse(line);
      if (record.schema_version !== 1 || record.seq !== ++sequence || !Number.isSafeInteger(record.wall_time_unix_ms) ||
        record.rollout_id !== manifest.rollout_id || record.thread_id !== manifest.root_thread_id ||
        (record.codex_turn_id !== null && !ID.test(record.codex_turn_id)) || !record.payload || !EVENT_TYPES.has(record.payload.type)) throw new Error(`Invalid trace event: ${bundle}`);
      const payload = record.payload as unknown as Record<string, unknown>;
      const refs = PAYLOAD_FIELDS.filter(field => payload[field] !== undefined && payload[field] !== null).map(field => payload[field] as RawPayloadRef);
      if (record.payload.type === "other") refs.push(...record.payload.payloads);
      for (const ref of refs) {
        const match = /^payloads\/([1-9][0-9]*)\.json$/.exec(ref.path);
        if (!match || ref.raw_payload_id !== `raw_payload:${match[1]}` || typeof ref.kind?.type !== "string") throw new Error("Invalid trace payload reference");
        if (!payloads[ref.raw_payload_id]) {
          try {
            const value = JSON.parse(await readPrivateFile(join(directory, ref.path)));
            if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid payload object");
            payloads[ref.raw_payload_id] = value;
          } catch (error) { throw new Error(`Missing or invalid trace payload: ${ref.path}`, { cause: error }); }
        }
      }
      for (const [type, field] of [["inference_started", "request_payload"], ["inference_completed", "response_payload"],
        ["protocol_event_observed", "event_payload"], ["tool_call_runtime_started", "runtime_payload"], ["tool_call_runtime_ended", "runtime_payload"]]) {
        if (record.payload.type === type && payload[field] === undefined) throw new Error("Missing trace payload reference");
      }
      if (record.payload.type === "codex_turn_started") {
        if (record.codex_turn_id !== record.payload.codex_turn_id || record.payload.thread_id !== record.thread_id || own.has(record.codex_turn_id)) throw new Error("Invalid turn start");
        own.set(record.codex_turn_id, { turnId: record.codex_turn_id, threadId: manifest.root_thread_id, requestId: "",
          traceId: manifest.trace_id, bundle, startedAt: record.wall_time_unix_ms, status: "running", complete: false,
          incompleteTail, records: [], payloads, inferenceCalls: Object.create(null), toolCalls: Object.create(null) });
      }
      if (record.codex_turn_id === null) continue;
      const turn = own.get(record.codex_turn_id);
      const lateInference = ["inference_completed", "inference_failed", "inference_cancelled"].includes(record.payload.type);
      if (!turn || (turn.status !== "running" && !lateInference)) throw new Error("Event outside active turn");
      turn.records.push(record);
      const event = record.payload;
      if (event.type === "inference_started") {
        if (inferences.has(event.inference_call_id) || event.thread_id !== turn.threadId || event.codex_turn_id !== turn.turnId) throw new Error("Invalid inference start");
        const inference: InferenceCall = { inference_call_id: event.inference_call_id, thread_id: turn.threadId,
          codex_turn_id: turn.turnId, model: event.model, provider_name: event.provider_name, execution: executionWindow(record),
          raw_request_payload_id: event.request_payload!.raw_payload_id, raw_response_payload_id: null };
        inferences.set(event.inference_call_id, inference);
        turn.inferenceCalls[event.inference_call_id] = inference;
      } else if (event.type === "inference_completed" || event.type === "inference_failed" || event.type === "inference_cancelled") {
        const inference = inferences.get(event.inference_call_id);
        if (!inference || inference.codex_turn_id !== turn.turnId) throw new Error("Unmatched inference end");
        const ref = event.type === "inference_completed" ? event.response_payload : event.partial_response_payload;
        inference.raw_response_payload_id = ref?.raw_payload_id ?? inference.raw_response_payload_id;
        endWindow(inference.execution, record, event.type === "inference_completed" ? "completed" : event.type === "inference_failed" ? "failed" : "cancelled");
      } else if (event.type === "tool_call_started") {
        const modelKey = `${turn.turnId}:${event.model_visible_call_id}`;
        if (tools.has(event.tool_call_id) || toolCallsByModelId.has(modelKey)) throw new Error("Duplicate tool call start");
        const tool: ToolCall = { tool_call_id: event.tool_call_id, model_visible_call_id: event.model_visible_call_id,
          thread_id: turn.threadId, started_by_codex_turn_id: turn.turnId, execution: executionWindow(record),
          raw_invocation_payload_id: event.invocation_payload?.raw_payload_id ?? null, raw_result_payload_id: null, raw_runtime_payload_ids: [] };
        tools.set(event.tool_call_id, tool);
        toolCallsByModelId.set(modelKey, event.tool_call_id);
        turn.toolCalls[event.tool_call_id] = tool;
        const origin = event.invocation_payload ? payloads[event.invocation_payload.raw_payload_id].inference_call_id : undefined;
        if (origin !== undefined && (typeof origin !== "string" || inferences.get(origin)?.codex_turn_id !== turn.turnId)) throw new Error("Unknown tool inference parent");
      } else if (event.type === "tool_call_ended" || event.type === "tool_call_runtime_started" || event.type === "tool_call_runtime_ended") {
        const tool = tools.get(event.tool_call_id);
        if (!tool || tool.started_by_codex_turn_id !== turn.turnId || tool.execution.status !== "running") throw new Error("Unmatched tool event");
        if ((event.type === "tool_call_ended" || event.type === "tool_call_runtime_ended") &&
          !["completed", "failed", "cancelled", "aborted"].includes(event.status)) throw new Error("Invalid tool end status");
        if (event.type === "tool_call_ended") {
          tool.raw_result_payload_id = event.result_payload?.raw_payload_id ?? null;
          endWindow(tool.execution, record, event.status);
        } else {
          const value = payloads[event.runtime_payload!.raw_payload_id];
          if (value.call_id !== tool.model_visible_call_id || value.turn_id !== turn.turnId || typeof value.attempt_id !== "string") throw new Error("Invalid command attempt correlation");
          const attempt = runtimeAttempts.get(value.attempt_id);
          if (event.type === "tool_call_runtime_started") {
            if (attempt) throw new Error("Duplicate command attempt start");
            runtimeAttempts.set(value.attempt_id, { toolId: tool.tool_call_id, turnId: turn.turnId });
          } else {
            if (!attempt || attempt.toolId !== tool.tool_call_id || attempt.turnId !== turn.turnId) throw new Error("Unmatched command attempt end");
            runtimeAttempts.delete(value.attempt_id);
          }
          tool.raw_runtime_payload_ids.push(event.runtime_payload!.raw_payload_id);
        }
      }
      if (record.payload.type === "protocol_event_observed" && record.payload.event_type === "turn_started") {
        const value = payloads[record.payload.event_payload!.raw_payload_id];
        if (value.turn_id !== turn.turnId || typeof value.id !== "string") throw new Error("Invalid turn request correlation");
        turn.requestId = value.id;
      }
      if (event.type === "protocol_event_observed") {
        const value = payloads[event.event_payload!.raw_payload_id];
        if (value.turn_id !== turn.turnId || value.type !== event.event_type) throw new Error("Invalid protocol event correlation");
        if (event.event_type.endsWith("approval_request")) {
          if (typeof value.approval_id !== "string" || typeof value.call_id !== "string" || approvals.has(value.approval_id) ||
            !toolCallsByModelId.has(`${turn.turnId}:${value.call_id}`)) throw new Error("Invalid approval request correlation");
          approvals.set(value.approval_id, { turnId: turn.turnId, callId: value.call_id });
        } else if (["approval_decision", "approval_wait_ended", "approval_committed"].includes(event.event_type)) {
          const approval = typeof value.approval_id === "string" ? approvals.get(value.approval_id) : undefined;
          if (!approval) throw new Error("Unmatched approval event");
          if (event.event_type === "approval_committed") {
            if (approval.decision !== "approved" || typeof value.call_id !== "string" ||
              !toolCallsByModelId.has(`${turn.turnId}:${value.call_id}`) ||
              (value.source !== "session" && (approval.turnId !== turn.turnId || approval.callId !== value.call_id))) throw new Error("Commit without matching approved call");
          } else {
            if (approval.turnId !== turn.turnId || approval.callId !== value.call_id || approval.decision !== undefined) throw new Error("Unmatched approval decision");
            if (event.event_type === "approval_decision" && !["approved", "denied", "abort"].includes(String(value.decision))) throw new Error("Invalid approval decision");
            approval.decision = event.event_type === "approval_decision" ? String(value.decision) : "abort";
          }
        }
      }
      if (record.payload.type === "codex_turn_ended") {
        if (record.payload.codex_turn_id !== turn.turnId || !["completed", "failed", "cancelled", "aborted"].includes(record.payload.status)) throw new Error("Invalid turn end");
        turn.status = record.payload.status;
        for (const inference of Object.values(turn.inferenceCalls)) {
          endWindow(inference.execution, record, turn.status === "completed" || turn.status === "cancelled" ? "cancelled" : turn.status);
        }
        turn.complete = Object.values(turn.toolCalls).every(tool => tool.execution.status !== "running") &&
          ![...runtimeAttempts.values()].some(attempt => attempt.turnId === turn.turnId);
      }
    }
    for (const turn of own.values()) {
      if ((filter.turnId === undefined || filter.turnId === turn.turnId) && (filter.sessionId === undefined || filter.sessionId === turn.threadId)) {
        const ownPayloads: DiagnosticTurn["payloads"] = Object.create(null);
        for (const record of turn.records) {
          const value = record.payload as unknown as Record<string, unknown>;
          for (const field of PAYLOAD_FIELDS) {
            const ref = value[field] as RawPayloadRef | undefined;
            if (ref) ownPayloads[ref.raw_payload_id] = payloads[ref.raw_payload_id];
          }
        }
        turns.push({ ...turn, payloads: ownPayloads });
      }
    }
  }
  return turns.sort((a, b) => b.startedAt - a.startedAt || a.turnId.localeCompare(b.turnId));
}
