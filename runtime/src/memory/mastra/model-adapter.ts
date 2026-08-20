import { createAnthropic } from "@ai-sdk/anthropic";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";

// The Observer/Reflector agents are driven by Mastra, which cannot consume a
// pi-ai model directly. Rather than re-declaring endpoints here, this adapter
// takes the model pi has already resolved from `config.agent` and translates
// it into whatever Mastra accepts for that model's wire API. Memory therefore
// always talks to the same provider and model as the interactive Agent, and
// adding a provider is a pi-ai concern, not an OpenScreen one.
//
// Two of pi-ai's wire APIs are supported. 26 of its 35 built-in providers
// expose at least one model through them. The nine that expose none are
// amazon-bedrock, azure-openai-responses, google, google-vertex, mistral,
// openai and openai-codex (unsupported wire APIs), plus cloudflare-ai-gateway
// and cloudflare-workers-ai (templated base URLs, see below). Note that this
// excludes OpenAI itself, whose models use openai-responses.
//
//   anthropic-messages (10 providers) -> an @ai-sdk/anthropic LanguageModel.
//     pi-ai stores these base URLs without the API version segment
//     (anthropic -> https://api.anthropic.com, minimax-cn ->
//     https://api.minimaxi.com/anthropic) because it appends `/v1/messages`
//     itself. @ai-sdk/anthropic instead requests `${baseURL}/messages`, so the
//     `/v1` segment has to be appended here. Confirmed against the real
//     MiniMax endpoint: the bare URL 404s through this client.
//
//   openai-completions (23 providers) -> a plain OpenAICompatibleConfig
//     object, which Mastra resolves internally. No client is constructed here;
//     `MastraModelConfig` accepts the config as-is. The base URL is passed
//     through unchanged because pi-ai and Mastra use the same convention of
//     appending the operation path to it.
//
// Anything else (Bedrock, Google, Vertex, Mistral, the Responses APIs) needs
// its own verified client and is rejected rather than guessed at.
//
// Note that these calls do not go through pi-ai and therefore get none of its
// per-provider compat overrides (adaptive thinking, tool-streaming quirks).
// This is the first thing to check if Observer/Reflector output ever drifts
// out of format.

/**
 * The fields this adapter needs from a resolved pi-ai model. `Model<Api>`
 * satisfies this structurally; it is declared locally so tests and callers do
 * not have to build a whole pi-ai model.
 */
export interface ObservationalMemoryModelSource {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
}

/** An OpenAI-compatible endpoint description accepted by Mastra as a model. */
export interface OpenAICompatibleModelConfig {
  providerId: string;
  modelId: string;
  url: string;
  apiKey: string;
}

const ANTHROPIC_MESSAGES_API = "anthropic-messages";
const OPENAI_COMPLETIONS_API = "openai-completions";

/**
 * Builds the model used for both the Observer and Reflector agents from the
 * model pi-ai resolved for `config.agent`.
 */
export function buildObservationalMemoryModel(
  source: ObservationalMemoryModelSource,
) {
  const { provider, id, api, baseUrl } = source;
  if (api !== ANTHROPIC_MESSAGES_API && api !== OPENAI_COMPLETIONS_API) {
    throw new Error(
      `Observational Memory does not support the ${api} API used by ${provider}/${id}. Supported APIs: ${ANTHROPIC_MESSAGES_API}, ${OPENAI_COMPLETIONS_API}.`,
    );
  }
  if (!baseUrl.trim()) {
    throw new Error(
      `Observational Memory requires a base URL for ${provider}/${id}.`,
    );
  }
  // pi-ai substitutes {PLACEHOLDER} segments (Cloudflare account and gateway
  // IDs) inside its own providers. This adapter has no such substitution, so a
  // templated URL must not be sent anywhere.
  if (baseUrl.includes("{")) {
    throw new Error(
      `Observational Memory cannot resolve the templated base URL for ${provider}/${id}.`,
    );
  }
  const apiKey = getEnvApiKey(provider);
  if (!apiKey) {
    throw new Error(
      `Observational Memory (Observer/Reflector) model calls require an API key for the ${provider} provider. Set its API key environment variable.`,
    );
  }
  if (api === OPENAI_COMPLETIONS_API) {
    return {
      providerId: provider,
      modelId: id,
      url: baseUrl,
      apiKey,
    } satisfies OpenAICompatibleModelConfig;
  }
  const anthropic = createAnthropic({ baseURL: `${baseUrl}/v1`, apiKey });
  return anthropic(id);
}
