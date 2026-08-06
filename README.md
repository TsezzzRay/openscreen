# OpenScreen

OpenScreen is an early-stage, open-source macOS assistant that answers questions about the window you are currently using.

Press `Option + Space` to open a floating panel, ask a question, and OpenScreen captures the active window immediately before sending the request to a Responses API-compatible vision provider.

> OpenScreen is under active development. It can understand the current screen, but it cannot retrieve prior activity or memory, click, type, or run commands yet. Issues and pull requests are temporarily disabled while the core product is changing.

## Current capabilities

- Global `Option + Space` shortcut.
- Movable floating panel that stays above other applications.
- Active-window capture using ScreenCaptureKit.
- Event-driven foreground-window observations using a native macOS helper.
- Background activity summarization and durable local memory derived from closed
  observation windows and terminal chat Turns.
- Persistent multi-session chat history with create, switch, and rename controls.
- Per-turn capture, request, generation, and completion status with cancellation and editable retries.
- A streaming Agent Loop for every request, with durable model-step and tool-result records.
- Markdown messages with smart follow-to-latest scrolling during streaming.
- Automatic text-and-screenshot context compaction at 90% of the model context window.
- Streaming Responses API providers with image input.

## Requirements

- macOS 15 or later with Screen Recording, Accessibility, and Input Monitoring
  permission for native screen observation.
- Swift 6.2 toolchain.
- Node.js 22.13 or later and npm. The Agent uses the built-in `node:sqlite`
  module.
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

Set `OPENAI_API_KEY` in `.env`, then replace the `model` and `baseURL` placeholders in `config.json`. `OPENAI_MODEL` and `OPENAI_BASE_URL` are optional environment overrides. The configured provider and model must support the Responses API, image input, streaming, and `/responses/input_tokens`.

For MiniMax M3, set `model` to `MiniMax-M3` and `baseURL` to `https://api.minimax.io/v1` in `config.json`.

OpenScreen sends `reasoning.summary: "auto"` to other Responses API providers and `reasoning.effort: "minimal"` to MiniMax M3.

`config.json` contains non-secret runtime defaults. The API key is read only
from the environment. See the
[Agent configuration reference](agent/README.md#runtime-configuration) for all
configuration groups, overrides, and validation rules.

On first launch, macOS will request Screen Recording and Accessibility access.
Input Monitoring is also needed for click and keyboard-activity signals. After
granting permission, press `Option + Space`, enter a question, and press `Enter`.
Use `Shift + Enter` to insert a newline. Stop OpenScreen with `Control + C` in
the launching terminal.

## Privacy

Automatic screen observation is limited to the foreground window. It does not
record raw keys or typed key values, redacts secure Accessibility fields, and
excludes OpenScreen's own processes to prevent capture loops. Captured
observations are stored as private local evidence and model requests use a
compact projection rather than the screenshot, full Accessibility tree, or
original Observation JSON. Evidence retention and storage are documented in
the [Agent persistence reference](agent/README.md#chronicle-and-memory-persistence);
native capture and permission behavior are documented in the
[ObservationHelper README](Sources/ObservationHelper/README.md).

Conversation state is stored locally as one append-only JSONL file per session
under `~/Library/Application Support/OpenScreen/sessions/`. Interrupted work
remains visible but is excluded from future model requests. See
[Agent persistence](agent/README.md#persistence) for the event format and replay
rules.

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
- The production tool registry is empty: activity and memory retrieval, click, type, scroll, application control, and Bash are not connected yet.
- No automatic chat retries or settings interface; Retry opens the previous
  prompt for editing and captures a new screenshot when resubmitted. Background
  memory jobs use their own persisted retry policy.
- Long-term memory is generated and persisted locally. Chat requests
  automatically receive only the bounded `memory_summary.md`; targeted
  retrieval, Memory Agent Tools, Capture fusion, and Memory UI controls are not
  part of this implementation.

## Architecture

```text
macOS app (Swift, AppKit, SwiftUI, ScreenCaptureKit)
    -> JSON Lines over stdin/stdout
local agent (Node.js, TypeScript, OpenAI SDK)
    -> JSON Lines over stdin/stdout
native observation helper (Swift, AXObserver, CGEventTap, ScreenCaptureKit)

local agent
    -> streaming Agent Loop with retained text and Base64 PNG screenshots
configured Responses API-compatible provider

local agent
    -> independent Chronicle / Turn Memory / Consolidation Worker Threads
    -> SQLite WAL + private evidence files
    -> Chronicle summaries + Turn Memory extractions
    -> global Memory consolidation with a Git baseline
    -> bounded memory_summary.md developer context for chat requests
```

The macOS app owns UI and explicit chat capture, the Node.js Agent owns model
requests and durable application state, and ObservationHelper owns native signal
collection and foreground-window capture. See the [Agent README](agent/README.md)
and [ObservationHelper README](Sources/ObservationHelper/README.md) for their
internal boundaries. The
[Agent memory reference](agent/README.md#chronicle-and-memory-persistence) is the
single source for Chronicle, Turn Memory, consolidation, evidence, and recovery
details.

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
