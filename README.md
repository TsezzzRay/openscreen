# OpenScreen

OpenScreen is an early-stage, open-source macOS assistant that can answer
questions about the window you are using and work with local files and commands.

Press `Option + Space` to open the floating panel. When a prompt is sent,
OpenScreen asks the Capture service for the most recently confirmed external
foreground window and gives the resulting screenshot and useful Accessibility
content to the local Agent as generic injected context. Capture failure does not
prevent a text-only Agent run.

The Agent runtime is built on `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai`. OpenScreen does not maintain a second Agent Loop,
Session implementation, model adapter, or compaction engine.

> OpenScreen is under active development. It has model-directed local system
> tools, but no dedicated click, type, scroll, or application-control tools.

## Current capabilities

- Global `Option + Space` shortcut and a movable floating panel.
- Native foreground-window signals and exact-window screenshot/Accessibility
  capture through `ObservationHelper`.
- Streaming answers, reasoning, and tool lifecycle updates from the pi Agent
  harness.
- Local `read`, `ls`, `grep`, `find`, `write`, `edit`, and `bash` tools.
- Persistent JSONL Sessions with create, switch, rename, and cancellation.
- Per-Session thinking-level controls; all seven local tools are always enabled.
- Automatic pi context compaction near the configured model's context limit, plus
  manual compaction from the Swift UI.
- Markdown responses, screenshot previews, and PNG/JPEG user attachments.
- Concurrent work in different Sessions; each Session accepts one prompt at a
  time.

## Requirements

- macOS 15 or later.
- Screen Recording and Accessibility permission. Input Monitoring is also
  needed for click and keyboard-activity signals.
- Swift 6.2 toolchain.
- Node.js 22.19 or later and npm.
- Credentials for the configured pi provider. The checked-in default is
  `minimax-cn/MiniMax-M3` and uses `MINIMAX_CN_API_KEY`.

## Run locally

Install dependencies and create the optional project environment file:

```bash
npm ci
cp .env.example .env
```

Set `MINIMAX_CN_API_KEY` in `.env`, or export it in the launching environment.
Existing process environment values take precedence over `.env`. Provider
credentials are never read from `config.json`.

Start OpenScreen from the repository root:

```bash
npm run dev
```

Grant the requested macOS permissions, press `Option + Space`, enter a question,
and press `Enter`. Use `Shift + Enter` for a newline and `Control + C` in the
launching terminal to stop the development process.

The `agent` group in `config.json` selects the single pi provider, model, and
thinking level. The `capture` group contains native and
Node-side Capture settings. Configuration is strict: unknown or missing fields
stop startup. See the
[Agent configuration reference](agent/README.md#runtime-configuration).

## Privacy and security

OpenScreen excludes its own processes from capture, does not record raw keys or
typed key values, and redacts secure Accessibility fields. A prompt may send the
following data to the configured provider:

- prompt text and user-selected images;
- a matching request screenshot and bounded useful Accessibility projection;
- model responses, reasoning context, and tool calls/results required by the
  continuing Agent run; and
- pi-generated compaction summaries.

When passive capture is enabled, Capture may persist local artifacts in response
to activity even without a prompt. Passive artifacts are not independently sent
to a model. There is no separate background long-term-memory extraction
pipeline.

By default, local application data is stored under
`~/Library/Application Support/OpenScreen/`:

```text
sessions/              pi JSONL Sessions, grouped by working directory
capture-artifacts/     private structured Capture artifacts
screen-captures/       private JPEGs for successful captures
diagnostics/           content-free Capture lifecycle diagnostics
user-attachments/      Swift-managed PNG copies of uploaded or pasted images
```

Session JSONL contains conversation and Agent state. pi persists message content
inline, so user and hidden injected image blocks include Base64 image data in
the Session file. Swift also decodes each uploaded or pasted image and writes a
managed PNG copy under `user-attachments/` for local preview and submission.
Removing a pending attachment deletes its copy when it is not already used by a
turn, and a failed multi-image import deletes copies created earlier in that
import. Copies retained for submitted turns currently have no retention or
deletion UI. Capture files and directories are created with private permissions.
Review the selected provider's data policy before sending sensitive content.

The seven system tools run with the operating-system permissions and environment
of the local Agent process. Relative paths and `bash` start from the repository
directory used to launch OpenScreen; absolute paths are accepted. There is no
built-in approval prompt or filesystem sandbox.

## Current limitations

- Development launch only; there is no signed app bundle or installer.
- No click, type, scroll, or other application-control tools.
- No separate long-term-memory subsystem, retrieval tool, or memory UI.
- No Session deletion, search, or cloud sync.
- No built-in provider or model selection UI. The single default is configured
  in `config.json`; an unknown provider/model pair fails at startup.
- Capture artifacts, Session files, and user-attachment copies retained for
  submitted turns do not currently have a product retention or deletion UI.

## Architecture

```text
SwiftUI / AppKit
    -> product JSONL commands and events
Transport
    -> Application API
Application Runtime
    -> Agent API   -> pi AgentHarness / JsonlSessionRepo / system tools
    -> Capture API -> Capture scheduling / fusion / persistence
                         -> helper JSONL -> ObservationHelper
```

The boundaries are intentionally one-way:

- `agent` knows pi and generic Agent inputs, but does not import Capture,
  Application, Transport, or Swift types.
- `capture` owns native observation, capture policy, artifacts, and diagnostics;
  it does not import Agent, pi, Application, or Transport.
- `application` is the only place that maps a `CapturedContext` into generic
  `AgentInjectedContext`.
- `transport` depends only on the Application API.
- `agent/src/main.ts` is the sole concrete composition root.

Component references:

- [OpenScreen Agent](agent/README.md) — boundaries, pi runtime, tools, Sessions,
  configuration, Capture integration, and product protocol.
- [ObservationHelper](Sources/ObservationHelper/README.md) — native signals,
  exact-window capture, permissions, privacy, and failure behavior.
- [Development rules](AGENTS.md) — repository commands, testing, Git/worktree,
  and documentation policy.

## Development

Run the Agent and Swift test suites from the repository root:

```bash
npm run test:agent
swift test
```

Read [AGENTS.md](AGENTS.md) before making changes.

## License

OpenScreen is available under the [MIT License](LICENSE).
