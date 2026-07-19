# OpenScreen

OpenScreen is an early-stage, open-source macOS assistant that answers questions about the window you are currently using.

Press `Option + Space` to open a floating panel, ask a question, and OpenScreen captures the active window immediately before sending the request to a Responses API-compatible vision provider.

> OpenScreen is under active development. It can understand the current screen, but it cannot click, type, run commands, or complete multi-step tasks yet. Issues and pull requests are temporarily disabled while the core product is changing.

## Current capabilities

- Global `Option + Space` shortcut.
- Movable floating panel that stays above other applications.
- Active-window capture using ScreenCaptureKit.
- One in-memory multi-turn conversation per app launch.
- Automatic text-and-screenshot context compaction at 90% of the model context window.
- Streaming Responses API providers with image input.

## Requirements

- macOS 15 or later.
- Swift 6.2 toolchain.
- Node.js and npm.
- An API key and reasoning-capable model from a Responses API-compatible provider that supports image input, streaming, and `/responses/input_tokens`. OpenAI-compatible models and MiniMax M3 are supported.

## Run locally

Install the Node.js dependencies:

```bash
npm ci
```

Start OpenScreen from the repository root:

```bash
OPENAI_API_KEY="your-api-key" \
OPENAI_BASE_URL="https://provider.example/v1" \
OPENAI_MODEL="responses-vision-model" \
npm run dev
```

`OPENAI_BASE_URL` can be omitted when using the OpenAI API directly. The configured provider and model must support the Responses API, image input, and streaming.

For MiniMax M3, use:

```bash
OPENAI_API_KEY="your-minimax-api-key" \
OPENAI_BASE_URL="https://api.minimax.io/v1" \
OPENAI_MODEL="MiniMax-M3" \
npm run dev
```

OpenScreen sends `reasoning.summary: "auto"` to other Responses API providers and `reasoning.effort: "minimal"` to MiniMax M3.

On first launch, macOS will request Screen Recording permission. After granting permission, press `Option + Space`, enter a question, and press `Enter`. Use `Shift + Enter` to insert a newline. Stop OpenScreen with `Control + C` in the launching terminal.

## Privacy

OpenScreen does not capture the screen continuously. It captures the active window only after a question is submitted.

Each screenshot is:

1. saved locally under `~/Library/Application Support/OpenScreen/screenshots/`;
2. encoded as a Base64 PNG;
3. sent with its turn to the configured model provider until that turn is compacted;
4. sent during compaction when the model summarizes older turns as plain text facts.

Screenshots are not deleted automatically in the current version. Review your provider's data policy before sending sensitive content.

## Current limitations

- Development launch only; there is no signed app bundle or installer.
- One active request at a time.
- Conversation history is not persisted across app launches.
- No request cancellation or parallel requests.
- No click, type, scroll, application control, Bash, or tool execution.
- Limited error recovery and no settings interface.

## Architecture

```text
macOS app (Swift, AppKit, SwiftUI, ScreenCaptureKit)
    -> JSON Lines over stdin/stdout
local agent (Node.js, TypeScript, OpenAI SDK)
    -> streaming Responses API with retained text and Base64 PNG screenshots
configured Responses API-compatible provider
```

The macOS process owns the panel, shortcut, capture, and local screenshot files. The Node.js process owns the in-memory turn history, screenshot paths, context compaction, and model request. Streaming events are correlated by `requestId`; reasoning and final-answer text are rendered separately, while the question, screenshot path, and final answer are retained as conversation context. The agent compacts at 244,800 of 272,000 multimodal tokens, keeps about 20,000 tokens of recent complete turns, and retains the full raw turn history in memory.

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
