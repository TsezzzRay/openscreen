# OpenScreen

OpenScreen is an early-stage, open-source macOS assistant that answers questions about the window you are currently using.

Press `Option + Space` to open a floating panel, ask a question, and OpenScreen captures the active window immediately before sending the request to a Responses API-compatible vision provider.

> OpenScreen is under active development. It can understand the current screen, but it cannot retrieve prior activity or memory, click, type, or run commands yet. Issues and pull requests are temporarily disabled while the core product is changing.

## Current capabilities

- Global `Option + Space` shortcut.
- Movable floating panel that stays above other applications.
- Active-window capture using ScreenCaptureKit.
- Event-driven foreground-window observations using a native macOS helper.
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

Set `OPENAI_API_KEY` in `.env`, then replace the `model` and `baseURL` placeholders in `config.json`. `OPENAI_MODEL` and `OPENAI_BASE_URL` are optional environment overrides. The configured provider and model must support the Responses API, image input, streaming, and `/responses/input_tokens`.

For MiniMax M3, set `model` to `MiniMax-M3` and `baseURL` to `https://api.minimax.io/v1` in `config.json`.

OpenScreen sends `reasoning.summary: "auto"` to other Responses API providers and `reasoning.effort: "minimal"` to MiniMax M3.

`config.json` contains the non-secret defaults for context, sessions, timeline
processing, long-term memory, and screen observation. Process environment
variables can override supported values, but `.env.example` intentionally lists
only the three common provider variables. Screen observation settings are read
from the `screenObservation` block at startup. The API key is never read from
JSON. See the [Agent configuration reference](agent/README.md#runtime-configuration)
for the ownership and validation rules.

On first launch, macOS will request Screen Recording and Accessibility access.
Input Monitoring is also needed for click and keyboard-activity signals. After
granting permission, press `Option + Space`, enter a question, and press `Enter`.
Use `Shift + Enter` to insert a newline. Stop OpenScreen with `Control + C` in
the launching terminal.

## Privacy

Automatic screen observation is limited to the foreground window. It does not
record raw keys or typed key values, redacts secure Accessibility fields, and
excludes OpenScreen's own processes to prevent capture loops. Observations are
currently kept in memory and are not persisted, added to long-term memory, or
sent to a model. See the
[native observation helper documentation](Sources/ObservationHelper/README.md)
for capture behavior, permission degradation, and implementation-level privacy
controls.

Conversation state is stored locally as one append-only JSONL file per session
under `~/Library/Application Support/OpenScreen/sessions/`. The first line
contains session metadata; later lines record turn starts, batched streaming
deltas, completed, failed, or cancelled turns, and context compaction.
Completed, failed, and cancelled turns are restored into model context; failed
and cancelled responses are explicitly marked as incomplete. A turn interrupted
by process exit remains visible but is excluded from future model requests. The
selected session is restored when the app starts again. The
[Agent README](agent/README.md#persistence) describes the underlying
persistence formats.

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
- No automatic retries or settings interface; Retry opens the previous prompt for editing and captures a new screenshot when resubmitted.
- Automatic screen observations are held only in memory and are not yet consumed
  by activity memory or an Agent Loop.

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
```

The macOS process owns the panel, shortcut, explicit chat capture,
selected-session UI, per-session streaming cache, and local chat screenshot
files. The Node.js process owns durable chat history, screen-observation
scheduling and deduplication, cross-process session locks, context compaction,
runtime configuration, and model requests. It starts and supervises the native
helper while OpenScreen is running. The helper owns only macOS activity signals,
foreground-window screenshots, Accessibility snapshots, and permission status;
it does not persist observations or make business decisions.

Every chat event carries both `requestId` and `sessionId`; reasoning and
final-answer text are rendered separately. Completed, failed, and cancelled
turns are retained in model context, with unsuccessful responses marked as
incomplete so they are not mistaken for finished answers. The default
configuration keeps recent turns in model context and retains the full event
history on disk. See the [Agent README](agent/README.md) for its internal
structure and data flow.

## Activity memory core

The Node Agent contains timeline and long-term-memory processing for later
integration with live screen observations and terminal turns. Live observation
wiring, memory search, automatic recall, and model-context injection are not
connected yet. Implementation boundaries and persistence behavior are
documented in the [Agent README](agent/README.md).

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
