import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readDiagnosticTurns, type DiagnosticTurn } from "./store.js";
import type { RawPayloadRef } from "./schema.js";

/** Local viewer adapter, not an alternative execution or persistence model. */
function summary(turn: DiagnosticTurn) {
  const terminal = turn.records.find(record => record.payload.type === "protocol_event_observed" &&
    ["turn_complete", "turn_aborted"].includes(record.payload.event_type));
  const timing = terminal?.payload.type === "protocol_event_observed"
    ? turn.payloads[terminal.payload.event_payload!.raw_payload_id] : undefined;
  return { turnId: turn.turnId, threadId: turn.threadId, requestId: turn.requestId, traceId: turn.traceId,
    startedAt: new Date(turn.startedAt).toISOString(), status: turn.status, traceComplete: turn.complete,
    durationMs: timing?.duration_ms ?? null, approvalWaitMs: timing?.approval_wait_ms ?? null,
    activeMs: timing?.active_ms ?? null, timeToFirstTokenMs: timing?.time_to_first_token_ms ?? null,
    modelInvocations: turn.records.filter(record => record.payload.type === "inference_started").length,
    toolCalls: turn.records.filter(record => record.payload.type === "tool_call_started").length,
    commandAttempts: turn.records.filter(record => record.payload.type === "tool_call_runtime_started").length,
    approvalRequests: turn.records.filter(record => record.payload.type === "protocol_event_observed" && record.payload.event_type.endsWith("approval_request")).length,
    errorCode: timing?.error_code ?? null, failurePhase: timing?.phase ?? null };
}

function formatTurn(turn: DiagnosticTurn): string {
  const info = summary(turn);
  const lines = [`Turn ${turn.turnId} | Thread/Session ${turn.threadId} | Request ${turn.requestId}`,
    `${turn.status} | total ${info.durationMs ?? "unknown"}ms | approval wait ${info.approvalWaitMs ?? "unknown"}ms | active ${info.activeMs ?? "unknown"}ms`,
    `Inferences ${info.modelInvocations} | tools ${info.toolCalls} | command attempts ${info.commandAttempts} | approvals ${info.approvalRequests}`];
  for (const record of turn.records) {
    const payload = record.payload as unknown as Record<string, unknown>;
    const details: Record<string, unknown> = { ...payload };
    for (const [key, value] of Object.entries(payload)) {
      if (!key.endsWith("_payload") || !value) continue;
      const ref = value as RawPayloadRef;
      details[key] = turn.payloads[ref.raw_payload_id];
    }
    lines.push(`${String(record.seq).padStart(4)} ${new Date(record.wall_time_unix_ms).toISOString()} ${record.payload.type} ${JSON.stringify(details)}`);
  }
  if (!turn.complete) lines.push("Trace unfinished: no completion is inferred; the task or writer may still be running or stopped.");
  return lines.join("\n");
}

const HELP = `Usage: npm run diagnostics -- list [--session <id>] [--json] [--root <directory>]
       npm run diagnostics -- show <turn-id> [--json] [--root <directory>]
Default root: $OPENSCREEN_DATA_DIR/diagnostics/traces, or the OpenScreen application data directory.
This is a read-only viewer for thread trace bundles. Content remains in Session history.`;

export async function diagnosticsCommand(args: string[]): Promise<string> {
  if (args.length === 0 || args.includes("--help")) return HELP;
  const command = args.shift();
  const turnId = command === "show" ? args.shift() : undefined;
  if (command !== "list" && command !== "show") throw new Error("Expected list or show; use --help");
  if (command === "show" && (!turnId || turnId.startsWith("--"))) throw new Error("show requires a Turn ID");
  let root = join(process.env.OPENSCREEN_DATA_DIR ?? join(homedir(), "Library", "Application Support", "OpenScreen"), "diagnostics", "traces");
  let sessionId: string | undefined;
  let json = false;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--json") { json = true; continue; }
    if (flag !== "--root" && flag !== "--session") throw new Error("Unknown option; use --help");
    const value = args.shift();
    if (!value || value.startsWith("--")) throw new Error("Option requires a value; use --help");
    if (flag === "--root") root = value;
    else sessionId = value;
  }
  const turns = await readDiagnosticTurns(root, { turnId, sessionId });
  if (command === "show") {
    if (turns.length !== 1) throw new Error("Turn not found");
    return json ? JSON.stringify({ summary: summary(turns[0]), ...turns[0] }, null, 2) : formatTurn(turns[0]);
  }
  if (json) return JSON.stringify(turns.map(summary), null, 2);
  if (turns.length === 0) return "No recorded turns.";
  return ["Turn ID\tThread/Session ID\tStatus\tTotal ms\tWait ms\tInferences\tTools\tStarted at",
    ...turns.map(turn => {
      const info = summary(turn);
      return [info.turnId, info.threadId, info.status, info.durationMs ?? "unknown", info.approvalWaitMs ?? "unknown", info.modelInvocations, info.toolCalls, info.startedAt].join("\t");
    })].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${await diagnosticsCommand(process.argv.slice(2))}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Diagnostics query failed"}\n`); process.exitCode = 1; }
}
