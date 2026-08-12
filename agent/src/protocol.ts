import type {
  AgentStreamEvent,
  ChatImage,
} from "./types.js";

export type InputEnvelope = {
  requestId: string;
  type: "chat";
  sessionId: string;
  input: { text: string; images: ChatImage[] };
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
  input: { text: string; images: ChatImage[] };
  status: "failed" | "cancelled";
};

export type SessionSummaryPayload = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionSnapshotPayload = SessionSummaryPayload & {
  turns: Array<{
    id: string;
    user: string;
    assistant: string;
    reasoning?: string;
    status: "completed" | "failed" | "cancelled" | "interrupted";
    images?: ChatImage[];
    error?: string;
  }>;
};

export type OutputEnvelope = {
  requestId: string;
  sessionId?: string;
} & (
  AgentStreamEvent
  | { type: "started" | "cancelled" }
  | { type: "sessions"; sessions: SessionSummaryPayload[] }
  | { type: "session"; session: SessionSnapshotPayload }
);

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

function chatImages(value: unknown): ChatImage[] {
  if (!Array.isArray(value)) invalid();
  return value.map((item) => {
    const image = record(item);
    const source = text(image.source);
    if (source !== "user_upload") invalid();
    return {
      id: text(image.id),
      source,
      path: text(image.path),
    };
  });
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
    const images = chatImages(input.images);
    return {
      requestId,
      type,
      sessionId,
      input: { text: text(input.text), images },
    };
  }
  if (type === "record_attempt" && (value.status === "failed" || value.status === "cancelled")) {
    const images = chatImages(input.images);
    if (images.some((image) => image.source !== "user_upload")) invalid();
    return {
      requestId,
      type,
      sessionId,
      input: { text: text(input.text), images },
      status: value.status,
    };
  }
  return invalid();
}

export function serializeOutputEnvelope(envelope: OutputEnvelope) {
  return JSON.stringify(envelope);
}
