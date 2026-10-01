# OpenScreen

OpenScreen is an early-stage, open-source macOS assistant that can answer
questions about the window you are using and work with local files and commands.

OpenScreen has two surfaces. Press `Option + Space` anywhere for the overlay: a
command bar that answers questions about the screen in front of you without
taking focus from the application you are in. The main window holds the full
interface — chats, history, transcripts, and Agent settings. Both show the same
chats, and a run started in one is visible and stoppable from the other.

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
  capture, including OpenScreen's own recorder. It scrolls back through the open
  chat and can switch chats or start one; with the main window already in front
  the shortcut focuses that window's composer instead of opening a second one.
- A full application window for chats, history, transcripts, and Agent settings.
- Prompts in flight are shared between the two surfaces, so either one shows a
  running answer and can stop it. The two keep independent chat selections.
- Every display photographed at full readable resolution when a prompt is
  submitted, with the focused window's accessibility text attached to the
  display it sits on. OpenScreen's own windows are excluded from the capture.
- Continuous event-driven Screenpipe recording across all displays, which feeds
  the background activity history rather than the prompt.
- Streaming answers, reasoning, and tool lifecycle updates from the pi Agent
  harness.
- Local `read`, `ls`, `grep`, `find`, `write`, `edit`, and `bash` tools.
- Read-only visible-window discovery and per-window accessibility and screenshot
  inspection through the Cua Driver SDK, with window IDs preserved as strings.
- Single-click and bounded-scroll desktop actions through the Cua Driver SDK.
  The first action in an application asks for approval covering that app for
  the current chat; denial blocks further requests for that app. OpenScreen's
  own windows are excluded. Actions still require fresh window observation.
- Text input into an observed accessibility text field of an approved app. The
  approval shows the app identity and captured window, not the text; an audit
  entry records only the text length and SHA-256 digest. A native guard
  verifies the focused field and each entered text segment. A focus or value
  mismatch stops further input, but earlier input cannot be rolled back.
- Tool sandbox with broad local reads, Bash writes confined to a per-prompt
  output directory, and no sandboxed network access. File changes outside that
  directory and explicitly requested host Bash runs require one-time approval.
- Pending approvals appear in both windows. Host commands and file changes
  display their exact content; desktop cards show the application and window.
  Either window can decide without ending the run.
- Persistent JSONL Sessions with create, switch, rename, and cancellation.
- Per-Session thinking-level controls; all registered tools are always enabled.
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
- Local developer diagnostics by prompt execution: ordered events, model/tool
  timing, failure codes, and approval history through a command-line query.
  See [Developer diagnostics](runtime/README.md#developer-diagnostics).

## Requirements

- macOS 15 or later.
- Screen Recording and Accessibility permission. Input Monitoring is also
  needed for click and keyboard-activity signals.
- Node.js 22.19 or later and npm.
- Xcode command line tools, for the Swift compiler that builds the capture
  helper (`xcode-select --install`).
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

By default, Agent data can leave the machine in model requests. An explicitly
approved host Bash command may also access the network. OpenScreen excludes
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
task-outputs/          per-prompt directories writable without approval
diagnostics/traces/    metadata-only thread bundles with per-prompt Turn timelines
```

Sessions embed every screenshot and user image as inline Base64, and Screenpipe
keeps writing frame rows and JPEGs even when no prompt is sent. Because the
observation processors discard raw messages once compressed, `rollout_summaries/`
holds the only local copy of the pre-compression text. Files and directories are
created with private permissions. OpenScreen does not upload these storage
files as files, but screenshots, attachments, and retrieved file contents can
be included in model requests.

The desktop approval audit stores only the length and SHA-256 digest of typed
text, but the pi Session also retains tool-call arguments, including the text
passed to `desktop_type`. Screen captures may show that text as well. Do not
send secrets through desktop typing unless you accept this local retention.

Rotation, retention, and crash behavior for each of these directories are
documented in
[Persistence and failure behavior](runtime/README.md#persistence-and-failure-behavior).

The default Bash sandbox can read broadly under the current user's file
permissions. It has no secret-path blacklist: files such as local `.env` files
may be read by the Agent and their contents may enter a model request. It cannot
use the network or write outside its per-prompt output directory. Explicitly
approved host Bash runs with the user's filesystem and network permissions;
it may change the desktop multiple times and start background tasks that keep
running after the command returns. Each later Agent host command needs a new
approval. Review the exact command before approving. See
[System tools](runtime/README.md#system-tools). Memory is treated as untrusted,
possibly stale evidence and cannot override current instructions or verified
state. Review the selected provider's data policy before sending sensitive
content.

## Current limitations

- Development launch only; there is no packaged application, installer,
  application icon, notarisation, or distribution workflow.
- The overlay carries no renaming, compaction, attachment, or thinking-level
  controls; those stay in the main window.
- No dragging or application-control tools beyond approved click, scroll, and
  text input. The Cua Driver and native focus helper have been exercised in an
  isolated macOS test window from both Node and Electron's Node mode. A
  background Electron test host has also exercised the production AgentClient
  to runtime-child path with a real model, app approval, and guarded typing.
  This does not verify the full `npm run dev` desktop UI flow or arbitrary apps.
- No dedicated Memory retrieval tool, Memory UI, or automatic access to
  historical screenshots. Memory lookup uses the existing file tools.
- `@screenpipe/sdk@0.4.3` is pinned for background recording; each display is an
  independent historical frame stream rather than a synchronized group. Live
  prompt capture uses the separate native helper.
- No Session deletion, search, or cloud sync.
- No built-in provider or model selection UI. The single default is configured
  in `config.json`; an unknown provider/model pair fails at startup.
- Session files and user-attachment copies retained for submitted turns do not
  currently have a product retention or deletion UI.
- Per-prompt output directories have no automatic retention or deletion UI.
  Approved actions have no rollback; cancelling a later step does not undo an
  earlier completed write or host command.

## Architecture

```text
Electron main process (TypeScript)
    -> overlay + main window renderers
    -> product JSONL commands and events over the runtime child's stdio
Transport
    -> Application API
Application Runtime
    -> Agent API   -> pi AgentHarness / JsonlSessionRepo / secured system tools
    -> Capture API -> Native capture helper (screen and window text at submit)
Composition Root
    -> Screenpipe recorder -> SDK Recorder / generation store / read-only SQLite
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

## Evaluation

The repository has a general Agent Eval, a separate five-scenario
file/Bash Security Eval, and an eight-scenario desktop Security Eval. The latter
covers desktop observation, click, and guarded text input under approval and
focus-change conditions, including application-grant reuse across Turns.
All use the configured model and production runtime
paths; they do not launch the desktop UI. Reports separate deterministic checks of artifacts
and authorization from offline, evidence-linked semantic judgments. Results
are written to private, git-ignored `eval-results/` directories rather than
presented as general safety claims. See [Model evaluations](runtime/evals/README.md)
for commands, frozen evidence, scoring, and limitations.

## Development

Read [AGENTS.md](AGENTS.md) before making changes. It owns the build, test, and
Git commands for this repository.

## License

OpenScreen is available under the [MIT License](LICENSE).
Dependencies retain their own terms. Production use or redistribution of the
pinned `@screenpipe/sdk` must comply with the applicable Screenpipe commercial
license.
