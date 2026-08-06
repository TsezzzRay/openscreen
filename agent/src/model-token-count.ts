import type OpenAI from "openai";

const RESIZED_IMAGE_BYTES_ESTIMATE = 7_373;
const ORIGINAL_IMAGE_PATCH_SIZE = 32;
const ORIGINAL_IMAGE_MAX_PATCHES = 10_000;

export function requireValidInputTokenCount(
  value: number,
  requestBytes: number,
) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid input token count: ${String(value)}`);
  }
  if (!Number.isSafeInteger(requestBytes) || requestBytes < 0) {
    throw new Error(`Invalid model request byte count: ${String(requestBytes)}`);
  }
  if (requestBytes > 0 && value < 1) {
    throw new Error("Non-empty model request returned zero input tokens");
  }
  return value;
}

export function estimateResponseRequestTokens(
  request: OpenAI.Responses.ResponseCreateParams,
) {
  const rawBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  const adjustment = imageDataURLAdjustment(request);
  return Math.ceil((
    rawBytes - adjustment.payloadBytes + adjustment.replacementBytes
  ) / 4);
}

function base64ImagePayload(url: string) {
  const comma = url.indexOf(",");
  if (comma < 0 || url.slice(0, 5).toLowerCase() !== "data:") return undefined;
  const metadata = url.slice(5, comma).split(";");
  if (!metadata[0]?.toLowerCase().startsWith("image/") ||
      !metadata.slice(1).some((part) => part.toLowerCase() === "base64")) {
    return undefined;
  }
  return url.slice(comma + 1);
}

function pngDimensions(bytes: Buffer) {
  if (bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return undefined;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function originalImageBytes(payload: string) {
  const bytes = Buffer.from(payload, "base64");
  const dimensions = pngDimensions(bytes);
  if (!dimensions) return RESIZED_IMAGE_BYTES_ESTIMATE;
  const patches = Math.min(
    Math.ceil(dimensions.width / ORIGINAL_IMAGE_PATCH_SIZE) *
      Math.ceil(dimensions.height / ORIGINAL_IMAGE_PATCH_SIZE),
    ORIGINAL_IMAGE_MAX_PATCHES,
  );
  return patches * 4;
}

function imageDataURLAdjustment(value: unknown) {
  let payloadBytes = 0;
  let replacementBytes = 0;
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (item === null || typeof item !== "object") return;
    const object = item as Record<string, unknown>;
    if (object.type === "input_image") {
      const imageURL = object.image_url;
      const url = typeof imageURL === "string"
        ? imageURL
        : imageURL !== null && typeof imageURL === "object" &&
            typeof (imageURL as Record<string, unknown>).url === "string"
          ? String((imageURL as Record<string, unknown>).url)
          : undefined;
      const nestedDetail = imageURL !== null && typeof imageURL === "object"
        ? (imageURL as Record<string, unknown>).detail
        : undefined;
      const payload = url === undefined ? undefined : base64ImagePayload(url);
      if (payload !== undefined && payload.length > 0) {
        payloadBytes += payload.length;
        replacementBytes += (object.detail ?? nestedDetail) === "original"
          ? originalImageBytes(payload)
          : RESIZED_IMAGE_BYTES_ESTIMATE;
      }
      return;
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
  return { payloadBytes, replacementBytes };
}

function countableRequest(
  request: OpenAI.Responses.ResponseCreateParams,
): OpenAI.Responses.InputTokenCountParams {
  return {
    conversation: request.conversation,
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    parallel_tool_calls: request.parallel_tool_calls,
    previous_response_id: request.previous_response_id,
    reasoning: request.reasoning,
    text: request.text,
    tool_choice: request.tool_choice,
    tools: request.tools,
    truncation: request.truncation ?? undefined,
  };
}

export async function countResponseRequestTokens(
  client: OpenAI,
  request: OpenAI.Responses.ResponseCreateParams,
  signal?: AbortSignal,
) {
  const requestBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
  try {
    return requireValidInputTokenCount((
      await client.responses.inputTokens.count(
        countableRequest(request),
        { signal },
      )
    ).input_tokens, requestBytes);
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw error;
    }
    return estimateResponseRequestTokens(request);
  }
}
