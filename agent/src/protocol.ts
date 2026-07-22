import type { ChatImage, ChatStreamEvent } from "./chat/types.js";

export type { ChatImage } from "./chat/types.js";

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

export type OutputEnvelope = {
  requestId: string;
} & (ChatStreamEvent | { type: "started" | "cancelled" });

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
    if (source !== "system_capture" && source !== "user_upload") invalid();
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
    const images = "images" in input
      ? chatImages(input.images)
      : [{ id: "legacy-system", source: "system_capture" as const, path: text(input.image) }];
    if (
      images.length === 0 || images[0]?.source !== "system_capture" ||
      images.filter((image) => image.source === "system_capture").length !== 1
    ) invalid();
    return {
      requestId,
      type,
      sessionId,
      input: { text: text(input.text), images },
    };
  }
  if (type === "record_attempt" && (value.status === "failed" || value.status === "cancelled")) {
    const images = "images" in input ? chatImages(input.images) : [];
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
