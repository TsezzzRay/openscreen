# OpenScreen

OpenScreen is an early-stage, open-source macOS assistant that answers questions about the window you are currently using.

Press `Option + Space` to open a floating panel and ask a question. The local
Agent freezes the most recently confirmed external foreground window, obtains
one matching screenshot and Accessibility snapshot, and sends the available
screen context to a Responses API-compatible vision provider.

> OpenScreen is under active development. It can understand the current screen,
> but the model cannot yet invoke the internal prior-activity and memory
> retrieval layer, click, type, or run commands. Issues and pull requests are
> temporarily disabled while the core product is changing.

## Current capabilities

- Global `Option + Space` shortcut.
- Movable floating panel that stays above other applications.
- Strictly fused request and activity capture using one ScreenCaptureKit result.
- Event-driven foreground-window observations using a native macOS helper.
- Background activity summarization and durable local memory derived from closed
  observation windows and terminal chat Turns.
- English-only local context retrieval over raw screen observations, Chronicle
  activities, producer summaries, and current long-term memory.
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
observations are stored as private local evidence. Memory-generation requests
use a compact projection rather than the screenshot, full Accessibility tree,
or original Observation JSON. Chat requests use the request capture's JPEG plus
a bounded JSON projection of the matching Accessibility snapshot. Evidence
retention and storage are documented in
the [Agent persistence reference](agent/README.md#chronicle-and-memory-persistence);
native capture and permission behavior are documented in the
[ObservationHelper README](Sources/ObservationHelper/README.md).

Conversation state is stored locally as one append-only JSONL file per session
under `~/Library/Application Support/OpenScreen/sessions/`. Interrupted work
remains visible but is excluded from future model requests. See
[Agent persistence](agent/README.md#persistence) for the event format and replay
rules.

For each chat request, the Agent freezes the latest confirmed external window
identity. Activity revisions remain ordering and diagnostic metadata, but a
small same-window activity change does not invalidate capture. An in-flight
capture for the same process/window is joined; a completed result may be reused
for at most two seconds while that target remains current; otherwise one new native
capture is queued. Screenshot and AX must attest to that same process and
window. Either modality may succeed alone, and chat continues without screen
context when capture is unavailable. A completed request capture also covers
pending passive activity for the same window through its frozen activity
revision; newer activity remains scheduled.

Request JPEGs are stored with mode `0600` under
`~/Library/Application Support/OpenScreen/screen-captures/`. A bounded useful
AX JSON projection is persisted inline with the Turn in Session JSONL; menu,
toolbar, status, scrollbar, and other shell-only subtrees are omitted. Web and
document content roots are selected before browser chrome, and a single
oversized AX value cannot consume the entire projection budget. If no useful
AX content remains, only the screenshot is sent. Both are retained with
model context until compaction removes the image-bearing turn. User attachments
remain separate and retain their original MIME type.
Review your provider's data policy before sending sensitive content.

Capture/fusion decisions and timings are written without screen or prompt
content to private daily JSONL files under
`~/Library/Application Support/OpenScreen/diagnostics/`; the default retention
is seven days. These events include the safe activity kind, planner decision,
request coverage counts, semantic/visual change decisions, native AX
truncation, and model-projection truncation.

## Current limitations

- Development launch only; there is no signed app bundle or installer.
- No session deletion, search, or cloud sync.
- Only one request per session can run at a time; different sessions can stream concurrently.
- The production tool registry is empty: the internal activity and memory
  retrieval API, click, type, scroll, application control, and Bash are not
  connected to the model yet.
- No automatic chat retries or settings interface; Retry opens the previous
  prompt for editing and captures a new screenshot when resubmitted. Background
  memory jobs use their own persisted retry policy.
- Long-term memory is generated and persisted locally. Chat requests
  automatically receive only the bounded `memory_summary.md`; targeted
  retrieval is available only as an internal Memory read API. Memory Agent
  Tools and Memory UI controls are not part of this implementation.

## Architecture

```text
macOS app (Swift, AppKit, SwiftUI)
    -> JSON Lines over stdin/stdout
local agent (Node.js, TypeScript, OpenAI SDK)
    -> JSON Lines over stdin/stdout
native observation helper (Swift, AXObserver, CGEventTap, ScreenCaptureKit)

local agent
    -> capture coordinator (Join / Reuse / New)
    -> retained text, bounded AX JSON, matching JPEG, and user uploads
    -> streaming Agent Loop
configured Responses API-compatible provider

local agent
    -> independent Chronicle / Turn Memory / Consolidation Worker Threads
    -> SQLite WAL + private evidence files
    -> Chronicle summaries + Turn Memory extractions
    -> global Memory consolidation with a Git baseline
    -> SQLite FTS5 context index + current MEMORY.md synchronization
    -> bounded memory_summary.md developer context for chat requests
```

The macOS app owns UI and user attachments. The Node.js Agent owns capture
coordination, chat screen-context persistence, model requests, and durable
application state. ObservationHelper owns native signals and exact-window
capture. See the [Agent README](agent/README.md)
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
