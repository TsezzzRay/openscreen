import { createAnthropic } from "@ai-sdk/anthropic";

// Confirmed against the real MiniMax endpoint (Stage A spike, see the memory
// migration plan): @ai-sdk/anthropic builds requests as `${baseURL}/messages`
// and expects the API version segment already present in baseURL (its own
// default is https://api.anthropic.com/v1). pi-ai's documented bare MiniMax
// baseUrl ("https://api.minimaxi.com/anthropic", see runtime/README.md) 404s
// against this client — the /v1 segment must be appended here. This is a
// separate, unrelated client from pi-ai's own Anthropic-messages
// implementation: Observer/Reflector calls get none of pi-ai's tuned
// MiniMax compat overrides (adaptive thinking, tool-streaming quirks). Stage A
// ran ~10 real Observer/Reflector cycles through this exact path with no
// reliability issues, but this remains the first thing to check if
// Observer/Reflector output ever drifts out of format.
const MINIMAX_CN_ANTHROPIC_BASE_URL = "https://api.minimaxi.com/anthropic/v1";

/**
 * Builds the LanguageModel used for both the Observer and Reflector agents.
 * Only the minimax-cn provider is supported: this project's Mastra
 * integration is a plain @ai-sdk/anthropic client tuned specifically for
 * MiniMax's endpoint, not a general pi-ai bridge. Configuring a different
 * provider needs its own verified baseURL/compat check before use here.
 */
export function buildObservationalMemoryModel({
  provider,
  model,
}: {
  provider: string;
  model: string;
}) {
  if (provider !== "minimax-cn") {
    throw new Error(
      `Observational Memory model adapter only supports the minimax-cn provider (configured: ${provider}).`,
    );
  }
  const apiKey = process.env.MINIMAX_CN_API_KEY;
  if (!apiKey) {
    throw new Error(
      "MINIMAX_CN_API_KEY is required for Observational Memory (Observer/Reflector) model calls.",
    );
  }
  const anthropic = createAnthropic({ baseURL: MINIMAX_CN_ANTHROPIC_BASE_URL, apiKey });
  return anthropic(model);
}
