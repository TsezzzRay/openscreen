# OpenScreen

OpenScreen is an early-stage, open-source macOS assistant that can answer
questions about the window you are using and work with local files and commands.

Press `Option + Space` to open the floating panel. When a prompt is sent,
OpenScreen reads the latest valid Screenpipe frame for every display and gives
the screenshots plus bounded frame metadata and visible text to the local Agent
as generic injected context. Capture failure does not prevent a text-only Agent
run.

The Agent runtime is built on `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai`. OpenScreen does not maintain a second Agent Loop,
Session implementation, model adapter, or compaction engine.

> OpenScreen is under active development. It has model-directed local system
> tools, but no dedicated click, type, scroll, or application-control tools.

## Current capabilities

- Global `Option + Space` shortcut and a movable floating panel.
- Continuous event-driven Screenpipe capture across all displays, with one
  latest frame per display attached when a prompt is submitted.
- Streaming answers, reasoning, and tool lifecycle updates from the pi Agent
  harness.
- Local `read`, `ls`, `grep`, `find`, `write`, `edit`, and `bash` tools.
- Persistent JSONL Sessions with create, switch, rename, and cancellation.
- Per-Session thinking-level controls; all seven local tools are always enabled.
- Automatic pi context compaction near the configured model's context limit, plus
  manual compaction from the Swift UI.
- Background Turn Memory extraction from completed pi Session branches into
  locally searchable rollout summaries.
- Background Chronicle extraction from Screenpipe frame streams into locally
  searchable activity rollouts with exact source-frame provenance.
- Codex-style consolidated `MEMORY.md` and bounded `memory_summary.md`, with
  progressive retrieval through the existing file tools and audited hidden
  citations.
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
thinking level. The `capture` group contains Screenpipe enablement, exclusions,
and retention. The `memory` group controls Chronicle windows, Turn extraction,
global consolidation, leases, retries, token limits, cooldown, and rollout
retention. Configuration is strict: unknown or missing fields stop startup. See
the
[Agent configuration reference](runtime/README.md#runtime-configuration).

## Privacy and security

OpenScreen excludes its own window title and does not configure Screenpipe to
record keystrokes or clipboard content. A prompt may send the following data to
the configured provider:

- prompt text and user-selected images;
- the latest valid screenshot from each display and bounded Screenpipe frame
  metadata or visible text;
- model responses, reasoning context, and tool calls/results required by the
  continuing Agent run;
- pi-generated compaction summaries;
- background Turn Memory requests containing terminal user text, final
  assistant text, bounded tool results, terminal status, exact source frame IDs,
  and the latest relevant compaction summary;
- background Chronicle requests containing bounded frame metadata and visible
  text, but no screenshot bytes, Base64, or image path; and
- background global Memory requests containing current Memory artifacts, their
  Git diff, and active or changed Turn rollout evidence in the consolidation
  snapshot.

When Screenpipe is enabled, it persists event-driven frame rows and JPEGs even
without a prompt. Chronicle sends bounded text projections of those frames to
the configured model; it never sends the JPEG bytes. Turn Memory does not
include reasoning blocks, image Base64, streaming deltas, or raw hidden screen
text. Memory generation uses the
configured Agent model and is enabled by default; set `memory.enabled` to
`false` to disable its scans, consolidation, prompt injection, and model
requests.

By default, local application data is stored under
`~/Library/Application Support/OpenScreen/`:

```text
sessions/              pi JSONL Sessions, grouped by working directory
memory/                SQLite truth, Turn rollouts, current Memory, and private Git baseline
screenpipe/generations/ private SDK SQLite/JPEG generations
user-attachments/      Swift-managed PNG copies of uploaded or pasted images
```

Session JSONL contains conversation and Agent state. pi persists message content
inline, so user and hidden injected image blocks include Base64 image data in
the Session file. Swift also decodes each uploaded or pasted image and writes a
managed PNG copy under `user-attachments/` for local preview and submission.
Removing a pending attachment deletes its copy when it is not already used by a
turn, and a failed multi-image import deletes copies created earlier in that
import. Copies retained for submitted turns currently have no retention or
deletion UI. Screenpipe generations rotate at the UTC day or configured age
boundary. The checked-in policy removes inactive generations after seven days
and also evicts the oldest inactive generations when total usage exceeds 10
GiB, but only after Chronicle has durably completed that generation. Capture
files and directories are created with private permissions. Review the selected
provider's data policy before sending sensitive content.

The Memory directory is an OpenScreen-owned Git repository with no remote. It
keeps one parentless baseline commit for diff, publication recovery, and
rollback. Successful consolidation replaces that commit and prunes the previous
commit, reflog, and unreachable objects; it is not a Memory history or backup.
`memory_summary.md` is loaded dynamically for each Agent Turn and is not
appended to the pi Session. Detailed lookup uses the existing file tools over
`MEMORY.md` and a bounded number of rollout files. Memory is treated as
untrusted, possibly stale evidence and cannot override current instructions or
verified state.

The seven system tools run with the operating-system permissions and environment
of the local Agent process. Relative paths and `bash` start from the repository
directory used to launch OpenScreen; absolute paths are accepted. There is no
built-in approval prompt or filesystem sandbox.

## Current limitations

- Development launch only; there is no signed app bundle or installer.
- No click, type, scroll, or other application-control tools.
- No dedicated Memory retrieval tool, Memory UI, or automatic access to
  historical screenshots. Memory lookup uses the existing file tools.
- `@screenpipe/sdk@0.4.3` is pinned as the production Capture backend. Display
  frames are independent streams; OpenScreen does not synthesize a cross-display
  capture group or apply freshness, skew, or request watermark rules.
- No Session deletion, search, or cloud sync.
- No built-in provider or model selection UI. The single default is configured
  in `config.json`; an unknown provider/model pair fails at startup.
- Session files and user-attachment copies retained for submitted turns do not
  currently have a product retention or deletion UI.

## Architecture

```text
SwiftUI / AppKit
    -> product JSONL commands and events
Transport
    -> Application API
Application Runtime
    -> Agent API   -> pi AgentHarness / JsonlSessionRepo / system tools
    -> Capture API -> Screenpipe Capture Service
                         -> SDK Recorder / generation store / read-only SQLite
Composition Root
    -> Memory Runtime -> Chronicle frame cursor / activity rollouts
                      -> pi Session branch scan / Turn rollouts
                      -> global consolidation / one-commit Git workspace
                      -> per-Turn summary context / file retrieval / citation
```

The boundaries are intentionally one-way:

- `agent` knows pi and generic Agent inputs, but does not import Capture,
  Application, Transport, or Swift types.
- `capture` owns the Screenpipe recorder, private generations, strict frame
  projection, latest-per-display request reads, and retention; it does not
  import Agent, pi, Application, or Transport.
- `memory` owns background Session scanning, extraction and consolidation jobs,
  SQLite truth, rollout projection, the dedicated Git workspace, retention, and
  the dynamic read context. It uses pi Session/model APIs but does not import
  Capture, Application, or Transport modules.
- `application` is the only place that maps a `CapturedContext` into generic
  `AgentInjectedContext`.
- `transport` depends only on the Application API.
- `runtime/src/main.ts` is the sole concrete composition root.

Component references:

- [OpenScreen Agent](runtime/README.md) — boundaries, pi runtime, tools, Sessions,
  configuration, Capture integration, and product protocol.
- [Development rules](AGENTS.md) — repository commands, testing, Git/worktree,
  and documentation policy.

## Development

Run the Agent and Swift test suites from the repository root:

```bash
npm run test:runtime
swift test
```

Read [AGENTS.md](AGENTS.md) before making changes.

## License

OpenScreen is available under the [MIT License](LICENSE).
Dependencies retain their own terms. Production use or redistribution of the
pinned `@screenpipe/sdk` must comply with the applicable Screenpipe commercial
license.
