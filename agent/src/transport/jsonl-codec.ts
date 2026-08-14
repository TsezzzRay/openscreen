import type {
  ApplicationCommand,
  ApplicationEvent,
  ProductImageAttachment,
  ProductThinkingLevel,
} from "../application/api.js";

function invalid(): never {
  throw new Error("Invalid agent request");
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function exact(record: Record<string, unknown>, keys: string[]): void {
  const expected = [...keys].sort();
  const actual = Object.keys(record).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid();
  }
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return invalid();
  return value;
}

function optionalText(value: unknown): string | undefined {
  return value === undefined ? undefined : text(value);
}

function images(value: unknown): ProductImageAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalid();
  return value.map((item) => {
    const image = object(item);
    exact(image, ["path", "mimeType"]);
    const mimeType = text(image.mimeType);
    if (mimeType !== "image/png" && mimeType !== "image/jpeg") invalid();
    return { path: text(image.path), mimeType };
  });
}

function thinking(value: unknown): ProductThinkingLevel {
  const level = text(value);
  if (
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      level,
    )
  ) {
    return invalid();
  }
  return level as ProductThinkingLevel;
}

export function parseJsonlCommand(line: string): ApplicationCommand {
  let value: Record<string, unknown>;
  try {
    value = object(JSON.parse(line));
  } catch {
    return invalid();
  }
  const requestId = text(value.requestId);
  const type = text(value.type);
  switch (type) {
    case "list_sessions":
    case "create_session":
      exact(value, ["requestId", "type"]);
      return { requestId, type };
    case "get_session":
      exact(value, ["requestId", "type", "sessionId"]);
      return { requestId, type, sessionId: text(value.sessionId) };
    case "rename_session":
      exact(value, ["requestId", "type", "sessionId", "name"]);
      return {
        requestId,
        type,
        sessionId: text(value.sessionId),
        name: text(value.name),
      };
    case "prompt": {
      exact(value, ["requestId", "type", "sessionId", "input"]);
      const input = object(value.input);
      const parsedImages = images(input.images);
      exact(input, [
        "text",
        ...(parsedImages === undefined ? [] : ["images"]),
      ]);
      return {
        requestId,
        type,
        sessionId: text(value.sessionId),
        input: {
          text: text(input.text),
          ...(parsedImages === undefined ? {} : { images: parsedImages }),
        },
      };
    }
    case "abort":
      exact(value, ["requestId", "type", "sessionId", "targetRequestId"]);
      return {
        requestId,
        type,
        sessionId: text(value.sessionId),
        targetRequestId: text(value.targetRequestId),
      };
    case "compact": {
      const instructions = optionalText(value.instructions);
      exact(
        value,
        instructions === undefined
          ? ["requestId", "type", "sessionId"]
          : ["requestId", "type", "sessionId", "instructions"],
      );
      return {
        requestId,
        type,
        sessionId: text(value.sessionId),
        ...(instructions === undefined ? {} : { instructions }),
      };
    }
    case "set_thinking":
      exact(value, ["requestId", "type", "sessionId", "thinking"]);
      return {
        requestId,
        type,
        sessionId: text(value.sessionId),
        thinking: thinking(value.thinking),
      };
    default:
      return invalid();
  }
}

export function serializeJsonlEvent(
  requestId: string,
  event: ApplicationEvent,
): string {
  return JSON.stringify({ requestId, ...event });
}

export function recoverJsonlRequestId(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).requestId === "string" &&
      ((value as Record<string, unknown>).requestId as string).trim().length > 0
    ) {
      return (value as Record<string, string>).requestId;
    }
  } catch {
    // A non-JSON line has no usable request correlation.
  }
  return undefined;
}
