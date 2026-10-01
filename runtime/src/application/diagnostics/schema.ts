/** Adapted from codex-rs/rollout-trace at 1fc8d548077fc72c4e3d048a78173af07385217f.
 * Keep runtime observations separate from the reader's reduced state.
 */
export type ExecutionStatus = "running" | "completed" | "failed" | "cancelled" | "aborted";
export type PayloadKind = "session_metadata" | "inference_request" | "inference_response" |
  "tool_invocation" | "tool_result" | "tool_runtime_event" | "protocol_event";
export interface RawPayloadRef {
  raw_payload_id: string;
  kind: { type: PayloadKind };
  path: string;
}
export type TracePayload =
  | { type: "rollout_started"; trace_id: string; root_thread_id: string }
  | { type: "rollout_ended"; status: "completed" | "failed" | "aborted" }
  | { type: "thread_started"; thread_id: string; agent_path: string; metadata_payload?: RawPayloadRef }
  | { type: "thread_ended"; thread_id: string; status: "completed" | "failed" | "aborted" }
  | { type: "codex_turn_started"; codex_turn_id: string; thread_id: string }
  | { type: "codex_turn_ended"; codex_turn_id: string; status: Exclude<ExecutionStatus, "running"> }
  | { type: "inference_started"; inference_call_id: string; thread_id: string; codex_turn_id: string;
      model: string; provider_name: string; request_payload?: RawPayloadRef }
  | { type: "inference_completed"; inference_call_id: string; response_id: string | null;
      upstream_request_id: string | null; response_payload?: RawPayloadRef }
  | { type: "inference_failed"; inference_call_id: string; upstream_request_id: string | null;
      error: string; partial_response_payload?: RawPayloadRef }
  | { type: "inference_cancelled"; inference_call_id: string; upstream_request_id: string | null;
      reason: string; partial_response_payload?: RawPayloadRef }
  | { type: "tool_call_started"; tool_call_id: string; model_visible_call_id: string;
      code_mode_runtime_tool_id: null; requester: { type: "model" };
      kind: { type: "exec_command" } | { type: "other"; name: string };
      summary: { type: "generic"; label: string; input_preview: null; output_preview: null };
      invocation_payload?: RawPayloadRef }
  | { type: "tool_call_runtime_started"; tool_call_id: string; runtime_payload?: RawPayloadRef }
  | { type: "tool_call_runtime_ended"; tool_call_id: string;
      status: Exclude<ExecutionStatus, "running">; runtime_payload?: RawPayloadRef }
  | { type: "tool_call_ended"; tool_call_id: string;
      status: Exclude<ExecutionStatus, "running">; result_payload?: RawPayloadRef }
  | { type: "protocol_event_observed"; event_type: string; event_payload?: RawPayloadRef }
  | { type: "other"; kind: string; summary: string; payloads: RawPayloadRef[]; metadata: Record<string, unknown> };

export interface RawTraceEvent {
  schema_version: 1;
  seq: number;
  wall_time_unix_ms: number;
  rollout_id: string;
  thread_id: string | null;
  codex_turn_id: string | null;
  payload: TracePayload;
}

export interface TraceManifest {
  schema_version: 1;
  trace_id: string;
  rollout_id: string;
  root_thread_id: string;
  started_at_unix_ms: number;
  raw_event_log: "trace.jsonl";
  payloads_dir: "payloads";
  /** Required privacy adaptation: these payloads are not replayable model bodies. */
  openscreen: { upstream_commit: string; collection: "metadata_only"; inference_boundary: "pi_provider_request";
    transport_attempts: "not_exposed" };
}

/** Payloads are allocated before their referencing event is appended. */
export interface TraceAttachment { field: string; kind: PayloadKind; value: Record<string, unknown> }
export type TraceAppend = (turnId: string | null, payload: TracePayload, attachment?: TraceAttachment) => void;

/** Reader-owned execution windows, as in the upstream reducer/model. */
export interface ExecutionWindow {
  started_at_unix_ms: number;
  started_seq: number;
  ended_at_unix_ms: number | null;
  ended_seq: number | null;
  status: ExecutionStatus;
}
export interface InferenceCall {
  inference_call_id: string;
  thread_id: string;
  codex_turn_id: string;
  model: string;
  provider_name: string;
  execution: ExecutionWindow;
  raw_request_payload_id: string;
  raw_response_payload_id: string | null;
}
export interface ToolCall {
  tool_call_id: string;
  model_visible_call_id: string;
  thread_id: string;
  started_by_codex_turn_id: string;
  execution: ExecutionWindow;
  raw_invocation_payload_id: string | null;
  raw_result_payload_id: string | null;
  raw_runtime_payload_ids: string[];
}
