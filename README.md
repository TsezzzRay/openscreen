# OpenScreen

OpenScreen is an early-stage, open-source macOS assistant that answers questions about the window you are currently using.

Press `Option + Space` to open a floating panel, ask a question, and OpenScreen captures the active window immediately before sending the request to an OpenAI-compatible vision provider.

> OpenScreen is under active development. It can understand the current screen, but it cannot click, type, run commands, or complete multi-step tasks yet. Issues and pull requests are temporarily disabled while the core product is changing.

## Current capabilities

- Global `Option + Space` shortcut.
- Movable floating panel that stays above other applications.
- Active-window capture using ScreenCaptureKit.
- Single-turn questions about the captured window.
- OpenAI-compatible Chat Completions providers with image input.

## Requirements

- macOS 15 or later.
- Swift 6.2 toolchain.
- Node.js and npm.
- An API key and model from an OpenAI-compatible provider that supports image input.

## Run locally

Install the Node.js dependencies:

```bash
npm ci
```

Start OpenScreen from the repository root:

```bash
OPENAI_API_KEY="your-api-key" \
OPENAI_BASE_URL="https://provider.example/v1" \
OPENAI_MODEL="vision-model" \
npm run dev
```

`OPENAI_BASE_URL` can be omitted when using the OpenAI API directly.

On first launch, macOS will request Screen Recording permission. After granting permission, press `Option + Space`, enter a question, and press `Enter`. Use `Shift + Enter` to insert a newline. Stop OpenScreen with `Control + C` in the launching terminal.

## Privacy

OpenScreen does not capture the screen continuously. It captures the active window only after a question is submitted.

Each screenshot is:

1. saved locally under `~/Library/Application Support/OpenScreen/screenshots/`;
2. encoded as a Base64 PNG;
3. sent with the question to the configured model provider.

Screenshots are not deleted automatically in the current version. Review your provider's data policy before sending sensitive content.

## Current limitations

- Development launch only; there is no signed app bundle or installer.
- One question and one answer at a time.
- No conversation history or persisted chat text.
- No streaming responses.
- No click, type, scroll, application control, Bash, or tool execution.
- Limited error recovery and no settings interface.

## Architecture

```text
macOS app (Swift, AppKit, SwiftUI, ScreenCaptureKit)
    -> JSON Lines over stdin/stdout
local agent (Node.js, TypeScript, OpenAI SDK)
    -> Chat Completions with text and a Base64 PNG
configured OpenAI-compatible provider
```

The macOS process owns the panel, shortcut, capture, and local screenshot files. The Node.js process owns the model request.

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
