export type InputEnvelope = {
  requestId: string;
  type: "chat";
  sessionId: string;
  input: { text: string; image: string };
} | {
  requestId: string;
  type: "list_sessions";
} | {
  requestId: string;
  type: "create_session";
} | {
  requestId: string;
  type: "load_session";
  sessionId: string;
} | {
  requestId: string;
  type: "rename_session";
  sessionId: string;
  title: string;
} | {
  requestId: string;
  type: "cancel";
  sessionId: string;
  targetRequestId: string;
} | {
  requestId: string;
  type: "record_attempt";
  sessionId: string;
  input: { text: string };
  status: "failed" | "cancelled";
};

export type OutputEnvelope = {
  requestId: string;
  type: "started" | "reasoning_delta" | "answer_delta" | "completed" | "failed" | "cancelled";
  delta?: string;
  message?: string;
};

function invalid(): never {
  throw new Error("Invalid agent request");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown) {
  if (typeof value !== "string" || !value) invalid();
  return value;
}

export function parseInputEnvelope(line: string): InputEnvelope {
  let value: Record<string, unknown>;
  try {
    value = record(JSON.parse(line));
  } catch {
    return invalid();
  }

  const requestId = text(value.requestId);
  const type = text(value.type);
  if (type === "list_sessions" || type === "create_session") return { requestId, type };

  const sessionId = text(value.sessionId).toLowerCase();
  if (type === "load_session") return { requestId, type, sessionId };
  if (type === "rename_session") {
    return { requestId, type, sessionId, title: text(value.title) };
  }
  if (type === "cancel") {
    return { requestId, type, sessionId, targetRequestId: text(value.targetRequestId) };
  }

  const input = record(value.input);
  if (type === "chat") {
    return {
      requestId,
      type,
      sessionId,
      input: { text: text(input.text), image: text(input.image) },
    };
  }
  if (type === "record_attempt" && (value.status === "failed" || value.status === "cancelled")) {
    return {
      requestId,
      type,
      sessionId,
      input: { text: text(input.text) },
      status: value.status,
    };
  }
  return invalid();
}
