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

`config.json` contains the non-secret defaults for context, sessions, activity
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
excludes OpenScreen's own processes to prevent capture loops. Captured
observations are persisted as private local evidence, then summarized in
closed one-minute windows. The summary request contains only identifiers,
times, application and window names, URL, focused-element facts, and visible
text. It does not contain the screenshot, full Accessibility tree, capture
diagnostics, or the original Observation JSON. See the
[native observation helper documentation](Sources/ObservationHelper/README.md)
for capture behavior, permission degradation, and implementation-level privacy
controls.

By default, raw observation evidence is removed 24 hours after successful Activity
processing. Evidence for a failed Activity job is retained for seven days to
allow safe retry and diagnosis. Compact projections, hashes, source IDs,
summaries, and processing state remain in the local SQLite database. These
retention values are configured under `memory.evidence`; they apply to automatic
observations, while chat screenshots keep their existing lifecycle below.

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
- No automatic chat retries or settings interface; Retry opens the previous
  prompt for editing and captures a new screenshot when resubmitted. Background
  memory jobs use their own persisted retry policy.
- Long-term memory is generated and persisted locally, but retrieval,
  model-context injection, Memory Agent Tools, Capture fusion, and Memory UI
  controls are not part of this implementation.

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
    -> independent Memory Worker Thread
    -> SQLite WAL + private evidence files
    -> Activity summaries
    -> global Memory consolidation with a Git baseline
```

The macOS process owns the panel, shortcut, explicit chat capture,
selected-session UI, per-session streaming cache, and local chat screenshot
files. The Node.js process owns durable chat history, screen-observation
scheduling and deduplication, cross-process session locks, context compaction,
runtime configuration, and foreground chat model requests. It starts an
independent Memory Worker Thread and supervises the native helper while
OpenScreen is running. The helper owns only macOS activity signals,
foreground-window screenshots, Accessibility snapshots, and permission status;
it does not persist observations or make business decisions.

Every chat event carries both `requestId` and `sessionId`; reasoning and
final-answer text are rendered separately. A Turn owns the user-visible
interaction, while each Agent Run has an independent ID and links back through
`turnId`. Completed, failed, and cancelled turns are retained in model context,
with unsuccessful responses marked as incomplete so they are not mistaken for
finished answers. The default
configuration keeps recent turns in model context and retains the full event
history on disk. See the [Agent README](agent/README.md) for its internal
structure and data flow.

## Activity and long-term memory

The Memory Worker persists each automatic observation immediately and restores
completed, failed, cancelled, and process-interrupted Turns from the append-only
Session log. Observation Activity runs after a UTC one-minute window closes plus
a 15-second grace period, with at most 30 observations per model request. Turns
from one Session accumulate until 30 minutes of inactivity, a two-hour hard
cap, or the 70% Activity input threshold, measured exactly through
`/responses/input_tokens`. When a new Turn would exceed the threshold, the
previous batch is sealed first and the Turn is measured again by itself. A
terminal Turn is never split across requests, and an oversized Turn cannot
block adjacent Turns.

Activity writes factual Activity records, a source summary, and optional durable
memory candidates to SQLite. Consolidation is one global leased job. Its first run is
immediate; later successful runs have a six-hour cooldown. It synchronizes
`raw_memories.md` and `source_summaries/`, uses a disposable Git baseline to
find real changes, and updates the current `MEMORY.md` and
`memory_summary.md`. The logical memory scopes are global, application, web
domain, document, project, workflow, person, organization, and topic; they do
not create separate physical directories. The memory root is a dedicated,
marked directory and never adopts an enclosing or user-owned Git repository.

The process is retryable and fenced by ownership tokens. A crashed worker can
be replaced after its lease expires, while an old worker cannot commit or
publish. Three consecutive expired leases cause a one-hour backoff without
using up the separate model-failure retry budget. Consolidation works from a
materialized Activity snapshot, sends a complete
Git diff without silent truncation, and publishes under a short cross-process
lock. Its disposable baseline prunes old reflog entries and unreachable Git
objects. A partially published Markdown update is recovered from the previous
Git baseline before retry. Detailed storage and business rules are documented
in the [Agent README](agent/README.md#activity-and-memory-persistence).

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
