# OpenScreen

OpenScreen is an early-stage, open-source macOS assistant that can answer
questions about the window you are using and work with local files and commands.

Press `Option + Space` to open a floating panel and ask a question. OpenScreen
captures the most recently confirmed external foreground window, combines a
matching screenshot with useful Accessibility content when available, and
sends the request to a Responses API-compatible vision provider.

> OpenScreen is under active development. It has model-directed local system
> tools, but no dedicated click, type, scroll, or application-control tools.
> Issues and pull requests are temporarily disabled while the core product is
> changing.

## Current capabilities

- Global `Option + Space` shortcut and a movable floating panel.
- Strictly fused request and passive-activity capture using one exact-window
  ScreenCaptureKit result.
- Event-driven foreground-window observation through a native macOS helper.
- A streaming Agent Loop with durable model steps and tool results.
- Local `read`, `ls`, `grep`, `find`, `write`, `edit`, and `bash` tools.
- Persistent multi-session chat with create, switch, rename, cancel, and editable
  retry behavior.
- Markdown responses, streaming status, screenshot previews, and user image
  attachments.
- Automatic context compaction near the configured model limit.
- Background Chronicle and Turn Memory processing, durable local long-term
  memory, and English-only internal context retrieval.

## Requirements

- macOS 15 or later.
- Screen Recording and Accessibility permission. Input Monitoring is also
  needed for click and keyboard-activity signals.
- Swift 6.2 toolchain.
- Node.js 22.13 or later and npm. The Agent uses the built-in `node:sqlite`
  module.
- An API key and a reasoning-capable Responses API-compatible model that
  supports streaming, image input, function calling, and
  `/responses/input_tokens`.

## Run locally

Install dependencies and create the local environment file:

```bash
npm ci
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`, then review `model` and `baseURL` in
`config.json`. `OPENAI_MODEL` and `OPENAI_BASE_URL` can override those provider
values. The API key is read only from the environment; non-secret runtime
defaults remain in `config.json`.

Start OpenScreen from the repository root:

```bash
npm run dev
```

Grant the requested macOS permissions, press `Option + Space`, enter a question,
and press `Enter`. Use `Shift + Enter` for a newline and `Control + C` in the
launching terminal to stop the development process.

See the [Agent configuration reference](agent/README.md#runtime-configuration)
for configuration groups, overrides, and validation behavior.

## Privacy and security

OpenScreen observes only the foreground window and excludes its own processes
to prevent capture loops. It does not record raw keys or typed key values, and
secure Accessibility fields are redacted. Chat requests may send the user
prompt, a matching request JPEG, a bounded useful Accessibility projection,
and user-selected images to the configured provider. Background Memory requests
send compact semantic projections of Observations or closed Turns; they do not
include raw Observation screenshots, full Accessibility trees, or reasoning.

Sessions, captures, diagnostics, activity evidence, generated summaries, and
long-term memory are stored locally under
`~/Library/Application Support/OpenScreen/` by default. Retention and recovery
details are defined in the
[Agent persistence reference](agent/README.md#persistence) and
[memory reference](agent/README.md#chronicle-and-memory-persistence). Native
permission, redaction, and capture-failure behavior are defined in the
[ObservationHelper README](Sources/ObservationHelper/README.md).

The seven system tools run with the operating-system permissions of the local
Agent process. They accept absolute paths, and `bash` executes shell commands
from the directory where OpenScreen was launched. There is currently no
built-in approval prompt or sandbox. Tool calls and their visible results are
returned to the configured provider as the Agent Loop continues and are stored
in Session history. Complete truncated Bash output is stored locally under the
`tool-output/` data directory, while only its visible bounded tail is returned
to the model. Run OpenScreen only in an environment where that access is
acceptable.

Review the configured provider's data policy before sending sensitive content.

## Current limitations

- Development launch only; there is no signed app bundle or installer.
- No click, type, scroll, or other application-control tools.
- Memory retrieval exists as an internal read API but is not registered as a
  model-facing tool.
- No session deletion, search, or cloud sync.
- Only one request per session can run at a time; different sessions can stream
  concurrently.
- No automatic chat retries or settings interface. Retry restores the previous
  prompt for editing and resolves the current screen context again when
  resubmitted.
- Chat automatically receives only the bounded `memory_summary.md`; targeted
  memory retrieval and Memory UI controls are not exposed in the app.

## Architecture

```text
macOS app (Swift, AppKit, SwiftUI)
    -> JSON Lines over stdin/stdout
local Agent (Node.js, TypeScript, OpenAI SDK)
    -> JSON Lines over stdin/stdout
ObservationHelper (Swift, AXObserver, CGEventTap, ScreenCaptureKit)

local Agent
    -> capture coordinator (Join / Reuse / New)
    -> retained text, bounded AX JSON, matching JPEG, and user images
    -> streaming Agent Loop + local system tools
    -> configured Responses API-compatible provider

local Agent
    -> Chronicle / Turn Memory / Consolidation Worker Threads
    -> SQLite WAL + private evidence files
    -> current long-term memory + bounded chat summary
    -> SQLite FTS5 context index
```

The macOS app owns the user interface and user attachments. The Node Agent owns
capture coordination, model and tool execution, Sessions, and durable
application state. ObservationHelper owns native activity signals and
exact-window capture.

Component references:

- [OpenScreen Agent](agent/README.md) — Agent Loop, tools, configuration,
  Sessions, capture fusion, and Memory.
- [ObservationHelper](Sources/ObservationHelper/README.md) — native signals,
  capture, permissions, privacy, and failure behavior.
- [Development rules](AGENTS.md) — repository commands, testing, Git/worktree,
  and documentation policy.

## Development

Run the Agent and Swift test suites:

```bash
npm run test:agent
swift test
```

Read [AGENTS.md](AGENTS.md) before making changes.

## License

OpenScreen is available under the [MIT License](LICENSE).
