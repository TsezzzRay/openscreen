// The product protocol has exactly one definition: the Node runtime's
// application API. The desktop frontend re-exports those types instead of
// keeping a translated copy, so the two ends cannot drift.
//
// This is a type-only import. `runtime/src/application/api.ts` declares no
// imports and no runtime values, so nothing from `runtime/` is linked into the
// frontend bundle and the dependency direction stays one-way.
export type {
  ApplicationCommand,
  ApplicationEvent,
  ProductCompactionResult,
  ProductErrorCode,
  ProductFailure,
  ProductImageAttachment,
  ProductImageMimeType,
  ProductSessionState,
  ProductSessionSummary,
  ProductSessionView,
  ProductThinkingLevel,
  ProductTranscriptMessage,
} from "../../../runtime/src/application/api.ts";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export function sessionDisplayName(session: { name?: string }): string {
  return session.name ?? "New Chat";
}
