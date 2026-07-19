# OpenScreen

OpenScreen is an early-stage, open-source macOS assistant that answers questions about the window you are currently using.

Press `Option + Space` to open a floating panel, ask a question, and OpenScreen captures the active window immediately before sending the request to a Responses API-compatible vision provider.

> OpenScreen is under active development. It can understand the current screen, but it cannot click, type, run commands, or complete multi-step tasks yet. Issues and pull requests are temporarily disabled while the core product is changing.

## Current capabilities

- Global `Option + Space` shortcut.
- Movable floating panel that stays above other applications.
- Active-window capture using ScreenCaptureKit.
- Persistent multi-session chat history with create, switch, and rename controls.
- Per-turn capture, request, generation, and completion status with cancellation and editable retries.
- Automatic text-and-screenshot context compaction at 90% of the model context window.
- Streaming Responses API providers with image input.

## Requirements

- macOS 15 or later.
- Swift 6.2 toolchain.
- Node.js 20.12 or later and npm.
- An API key and reasoning-capable model from a Responses API-compatible provider that supports image input, streaming, and `/responses/input_tokens`. OpenAI-compatible models and MiniMax M3 are supported.

## Run locally

Install the Node.js dependencies:

```bash
npm ci
```

Start OpenScreen from the repository root:

```bash
cp .env.example .env
npm run dev
```

Set `OPENAI_API_KEY` in `.env`, then replace the `model` and `baseURL` placeholders in `config.json`. The configured provider and model must support the Responses API, image input, streaming, and `/responses/input_tokens`.

For MiniMax M3, set `model` to `MiniMax-M3` and `baseURL` to `https://api.minimax.io/v1` in `config.json`.

OpenScreen sends `reasoning.summary: "auto"` to other Responses API providers and `reasoning.effort: "minimal"` to MiniMax M3.

The JSON values can be overridden with `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENSCREEN_CONTEXT_WINDOW_TOKENS`, `OPENSCREEN_COMPACT_AT_TOKENS`, `OPENSCREEN_KEEP_RECENT_TOKENS`, `OPENSCREEN_MAX_OUTPUT_TOKENS`, and `OPENSCREEN_SUMMARY_MAX_OUTPUT_TOKENS`. Existing process environment variables override `.env`, and `.env` overrides `config.json`. The API key is never read from JSON.

On first launch, macOS will request Screen Recording permission. After granting permission, press `Option + Space`, enter a question, and press `Enter`. Use `Shift + Enter` to insert a newline. Stop OpenScreen with `Control + C` in the launching terminal.

## Privacy

OpenScreen does not capture the screen continuously. It captures the active window only after a question is submitted.

Conversation state is stored locally as one append-only JSONL file per session under `~/Library/Application Support/OpenScreen/sessions/`. The first line contains session metadata; later lines record turn starts, batched streaming deltas, completed, failed, or cancelled turns, and context compaction. Completed, failed, and cancelled turns are restored into model context; failed and cancelled responses are explicitly marked as incomplete. A turn interrupted by process exit remains visible but is excluded from future model requests. The selected session is restored when the app starts again.

Each screenshot is:

1. saved locally under `~/Library/Application Support/OpenScreen/screenshots/`;
2. encoded as a Base64 PNG;
3. sent with its turn to the configured model provider until that turn is compacted;
4. sent during compaction when the model summarizes older turns as plain text facts.

Screenshots are not deleted automatically in the current version. Review your provider's data policy before sending sensitive content.

## Current limitations

- Development launch only; there is no signed app bundle or installer.
- No session deletion, search, or cloud sync.
- Only one request per session can run at a time; different sessions can stream concurrently.
- No click, type, scroll, application control, Bash, or tool execution.
- No automatic retries or settings interface; Retry opens the previous prompt for editing and captures a new screenshot when resubmitted.

## Architecture

```text
macOS app (Swift, AppKit, SwiftUI, ScreenCaptureKit)
    -> JSON Lines over stdin/stdout
local agent (Node.js, TypeScript, OpenAI SDK)
    -> streaming Responses API with retained text and Base64 PNG screenshots
configured Responses API-compatible provider
```

The macOS process owns the panel, shortcut, capture, selected-session UI, per-session streaming cache, and local screenshot files. The Node.js process owns durable per-session turn history, cross-process session locks, screenshot paths, context compaction, runtime configuration, and model requests. Every chat event carries both `requestId` and `sessionId`; reasoning and final-answer text are rendered separately. Completed, failed, and cancelled turns are retained in model context, with unsuccessful responses marked as incomplete so they are not mistaken for finished answers. The default configuration compacts at 244,800 of 272,000 multimodal tokens, keeps about 20,000 tokens of recent turns in model context, and retains the full event history on disk.

## Development

Run the Agent tests:

```bash
npm run test:agent
```

Run the macOS tests and build:

```bash
swift test
swift build
```

## License

OpenScreen is available under the [MIT License](LICENSE).
