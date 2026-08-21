# OpenScreen

OpenScreen is an early-stage, open-source macOS assistant that can answer
questions about the window you are using and work with local files and commands.

OpenScreen has two surfaces. Press `Option + Space` anywhere for the overlay: a
command bar that answers one question about the screen in front of you without
taking focus from the application you are in. The main window holds the full
interface — chats, history, transcripts, and Agent settings.

Each prompt is answered with the current screen attached, and a capture failure
still leaves a working text-only Agent run.

The Agent runtime is built on `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai`. OpenScreen does not maintain a second Agent Loop,
Session implementation, model adapter, or compaction engine.

> OpenScreen is under active development. See
> [Current limitations](#current-limitations) before relying on it.

## Current capabilities

- Global `Option + Space` overlay: a movable, always-on-top command bar that
  takes keyboard input without activating OpenScreen, so the application being
  asked about stays in the foreground. The overlay is excluded from screen
  capture, including OpenScreen's own recorder.
- A full application window for chats, history, transcripts, and Agent settings.
- Continuous event-driven Screenpipe capture across all displays, with one
  latest frame per display attached when a prompt is submitted.
- Streaming answers, reasoning, and tool lifecycle updates from the pi Agent
  harness.
- Local `read`, `ls`, `grep`, `find`, `write`, `edit`, and `bash` tools.
- Persistent JSONL Sessions with create, switch, rename, and cancellation.
- Per-Session thinking-level controls; all seven local tools are always enabled.
- Automatic pi context compaction near the configured model's context limit, plus
  manual compaction from the main window.
- Background Turn recording from completed pi Session branches into locally
  searchable rollout summaries.
- Background Chronicle extraction from Screenpipe frame streams into locally
  searchable activity rollouts with exact source-frame provenance.
- Continuously compressed `MEMORY.md` and `ACTIVITY.md` observation logs, both
  injected each Turn, with detail retrieval through the existing file tools and
  audited hidden citations.
- Markdown responses, screenshot previews, and PNG/JPEG user attachments.
- Concurrent work in different Sessions; each Session accepts one prompt at a
  time.

## Requirements

- macOS 15 or later.
- Screen Recording and Accessibility permission. Input Monitoring is also
  needed for click and keyboard-activity signals.
- Node.js 22.19 or later and npm.
- An Apple code-signing identity for stable development Screen Recording
  permission.
- Credentials for the configured pi provider. The checked-in default is
  `minimax-cn/MiniMax-M3` and uses `MINIMAX_CN_API_KEY`.

## Run locally

Install dependencies and create the optional project environment file:

```bash
npm ci
cp .env.example .env
```

Set `MINIMAX_CN_API_KEY` in `.env`, or export it in the launching environment.
To use a different provider, change `agent.provider` and `agent.model` in
`config.json` and set that provider's credential instead; background Memory
follows the same selection. Existing process environment values take precedence
over `.env`. Provider credentials are never read from `config.json`.

Set `OPENSCREEN_SIGNING_IDENTITY` to the exact name of a code-signing
certificate, or put that name in the git-ignored `.signing-identity` file. The
`predev` script signs the development Electron bundle once and leaves the stable
signature intact on later launches. Without an identity, the interface and
text-only Agent still run, but Screen Recording cannot be granted reliably to
the development Electron bundle.

Start OpenScreen from the repository root:

```bash
npm run dev
```

Grant the requested macOS permissions, press `Option + Space`, enter a question,
and press `Enter`.

Use `Shift + Enter` for a newline and `Control + C` in the launching terminal to
stop the development process.

macOS attributes Screen Recording to the running application bundle. A
development launch runs from `node_modules/electron/dist/Electron.app` under
Electron's bundle identifier. Grant Screen Recording, Accessibility, and Input
Monitoring when macOS requests them. Reinstalling or upgrading Electron replaces
that bundle, so `predev` signs the replacement before the next launch and macOS
may request permission again.

Startup behavior is configured in `config.json`, which is strict: unknown or
missing fields stop startup. Every field is documented in the
[Agent configuration reference](runtime/README.md#runtime-configuration).

## Privacy and security

Everything except model requests stays on the local machine. OpenScreen excludes
its own window title and does not configure Screenpipe to record keystrokes or
clipboard content.

A prompt sends its text and images, the latest screenshot from each display,
bounded frame metadata and visible text, and the responses, reasoning, and tool
results the continuing run needs. Background Memory adds bounded *text* requests
only — Chronicle summarization and the observation processors never send
screenshot bytes, Base64, or image paths. Memory is enabled by default; set
`memory.enabled` to `false` to stop every background scan, observation, prompt
injection, and model request. The exact payloads are documented in
[Chronicle Memory](runtime/README.md#chronicle-memory) and
[Observational Memory](runtime/README.md#observational-memory).

By default, local application data is stored under
`~/Library/Application Support/OpenScreen/`:

```text
sessions/              pi JSONL Sessions, grouped by working directory
memory/                Mastra observation store, cursors, rollouts, and projected Memory files
screenpipe/generations/ private SDK SQLite/JPEG generations
user-attachments/      PNG copies of uploaded or pasted images
```

Sessions embed every screenshot and user image as inline Base64, and Screenpipe
keeps writing frame rows and JPEGs even when no prompt is sent. Because the
observation processors discard raw messages once compressed, `rollout_summaries/`
holds the only local copy of the pre-compression text. Files and directories are
created with private permissions and are never uploaded anywhere by OpenScreen.
Rotation, retention, and crash behavior for each of these directories are
documented in
[Persistence and failure behavior](runtime/README.md#persistence-and-failure-behavior).

The local tools run with the Agent process's own permissions and environment,
with no approval gate and no filesystem sandbox; see
[System tools](runtime/README.md#system-tools). Memory is treated as untrusted,
possibly stale evidence and cannot override current instructions or verified
state. Review the selected provider's data policy before sending sensitive
content.

## Current limitations

- Development launch only; there is no packaged application, installer,
  application icon, notarisation, or distribution workflow.
- The overlay shows one exchange at a time; earlier questions in the session are
  recalled with the up arrow, and full scrollback lives in the main window.
- No click, type, scroll, or other application-control tools.
- No dedicated Memory retrieval tool, Memory UI, or automatic access to
  historical screenshots. Memory lookup uses the existing file tools.
- `@screenpipe/sdk@0.4.3` is pinned as the production Capture backend, and each
  display is an independent frame stream rather than a synchronized group.
- No Session deletion, search, or cloud sync.
- No built-in provider or model selection UI. The single default is configured
  in `config.json`; an unknown provider/model pair fails at startup.
- Session files and user-attachment copies retained for submitted turns do not
  currently have a product retention or deletion UI.

## Architecture

```text
Electron main process (TypeScript)
    -> overlay + main window renderers
    -> product JSONL commands and events over the runtime child's stdio
Transport
    -> Application API
Application Runtime
    -> Agent API   -> pi AgentHarness / JsonlSessionRepo / system tools
    -> Capture API -> Screenpipe Capture Service
                         -> SDK Recorder / generation store / read-only SQLite
Composition Root
    -> Memory Runtime -> Chronicle frame cursor / activity rollouts
                      -> pi Session branch scan / Turn rollouts
                      -> Mastra observation threads / LibSQL store
                      -> MEMORY.md + ACTIVITY.md / file retrieval / citation
```

Every dependency runs one way down that list, and `runtime/src/main.ts` is the
sole concrete composition root. The per-module import rules are enforced by
tests and documented in
[Boundary rules](runtime/README.md#boundary-rules).

Component references:

- [OpenScreen Agent](runtime/README.md) — boundaries, pi runtime, tools, Sessions,
  configuration, Capture integration, and product protocol.
- [Development rules](AGENTS.md) — repository commands, testing, Git/worktree,
  and documentation policy.

## Development

Read [AGENTS.md](AGENTS.md) before making changes. It owns the build, test, and
Git commands for this repository.

## License

OpenScreen is available under the [MIT License](LICENSE).
Dependencies retain their own terms. Production use or redistribution of the
pinned `@screenpipe/sdk` must comply with the applicable Screenpipe commercial
license.
