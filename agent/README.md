# OpenScreen Agent

The OpenScreen Agent is the local Node.js process behind the macOS app. It uses
`@earendil-works/pi-agent-core` for Agent execution, JSONL Sessions,
compaction, thinking state, and tool execution.
`@earendil-works/pi-ai` supplies the provider and model registry.

OpenScreen adds only product boundaries, local tools, Capture, and a thin
Application Runtime. See the [project README](../README.md) for setup, privacy,
and current product limitations, and [AGENTS.md](../AGENTS.md) for development
rules.

## Source layout

```text
agent/src/
├── agent/
│   ├── api.ts                    Capture-neutral Agent contract
│   └── pi/
│       ├── service.ts            AgentService facade and commands
│       ├── session-runtime.ts    pi harness and JSONL Session ownership
│       ├── prompt-runner.ts      prompt events, images, and cancellation
│       ├── session-projection.ts linear active-branch transcript projection
│       └── tools/                seven focused tools plus shared support
├── capture/
│   ├── api.ts                    Agent-neutral Capture contract
│   ├── service.ts                native lifecycle and Capture composition
│   ├── native/                    ObservationHelper client and wire contract
│   ├── background-capture.ts     passive scheduling and coverage
│   ├── coordinator.ts            Join / Reuse / New capture fusion
│   ├── observation.ts            observation DTO and normalization
│   ├── observation-resolver.ts   observation identity and persistence
│   ├── accessibility-projector.ts bounded useful AX projection
│   ├── context-projector.ts      neutral CapturedContext assembly
│   ├── artifact.ts               Capture Artifact DTO ownership
│   ├── artifact-store.ts         private local Capture persistence
│   ├── diagnostics.ts            content-free operational events
│   └── config.ts                 Capture configuration validation
├── application/
│   ├── api.ts                    product commands, events, and DTOs
│   └── runtime.ts                thin Agent/Capture use-case composition
├── transport/
│   ├── jsonl-codec.ts            strict command/event JSON shapes
│   └── jsonl-server.ts           correlated stdin/stdout lifecycle
├── runtime-config.ts             strict config and optional `.env` loading
└── main.ts                       sole concrete composition root
```

## Boundary rules

The dependency direction is enforced by tests:

```text
Transport -> Application API
Application Runtime -> Agent API + Capture API
Agent pi adapter -> pi-agent-core + pi-ai
Capture service -> ObservationHelper protocol
main.ts -> all concrete implementations
```

- `agent/` has no dependency on Capture, Application, Transport, or Swift. A
  prompt accepts only text, user images, and optional generic injected context.
- `capture/` has no dependency on Agent, pi, Application, Transport, or Swift.
  It owns helper lifecycle, scheduling, fusion, deduplication, projection,
  persistence, and diagnostics.
- `application/` imports only the public Agent and Capture APIs. It converts a
  `CapturedContext` into generic `AgentInjectedContext`; neither lower-level
  module knows about that mapping.
- `transport/` imports only the Application API.
- `main.ts` is the only module allowed to construct concrete Agent, Capture,
  Application, and Transport implementations together.

There is no Capture adapter inside the Agent and no Agent orchestrator inside
Capture.

## Request flow

1. Swift sends one strict product command with a non-empty `requestId`.
2. Transport validates the complete JSON shape and dispatches commands without
   imposing global serialization.
3. For a prompt, Application first requests Capture. Capture failure is reported
   to stderr and the prompt continues without screen context. Cancellation while
   Capture is running prevents the Agent call.
4. Application maps a successful capture to hidden generic context. It does not
   expose Capture concepts through the Agent API.
5. `PiAgentService` loads user and injected images, runs `AgentHarness.prompt`,
   and maps pi stream events to the product event stream.
6. After a successful answer, Application asks pi whether the current context
   needs automatic compaction.
7. Each request emits exactly one terminal `completed` or `failed` event. An
   output-stream failure stops the transport even while stdin remains open.

One prompt may run per Session. Different Sessions and non-conflicting product
commands can proceed concurrently. Prompt preparation and execution, compaction,
Session rename, and thinking mutations for the same Session use one mutation
queue, while abort remains able to interrupt a prompt
directly. If abort arrives before the provider request, including while prompt
images or pi turn state are being prepared, guards at pi's agent-start and
provider-request hooks end the prompt without calling the provider. After the
provider-request hook, pi's run controller propagates cancellation to the active
provider stream. A UI listener failure cannot change Agent execution or
persistence.

## pi Agent capabilities

`PiAgentService` delegates these behaviors to pi:

- configured-model lookup and streaming;
- the Agent Loop and model-directed tool calls;
- reasoning levels from `off` through `max`, subject to model support;
- append-only JSONL Session persistence and reopening;
- current-branch context and thinking-state restoration; and
- context accounting and compaction summaries.

OpenScreen projects pi state into product DTOs for Swift. The transcript contains
user, assistant, and tool messages; a custom message is included as context only
when pi marks it for display. Only the current pi branch is projected; raw leaf
bookkeeping and other internal Session entries are not exposed through the
product protocol. The product has no tree navigation, historical-prompt editing,
or persisted historical-image replay.

Thinking changes are appended to the Session and restored when it is reopened.
An explicit `off` thinking change therefore remains
`off` after reopening even when configuration has a non-`off` initial level.
The configured provider/model is the only model authority; historical model
changes are ignored and the product protocol has no model enumeration or switch.
All seven registered tools are always active; historical active-tool entries are
ignored and the product has no tool-switching command or UI.

Automatic compaction uses pi's `DEFAULT_COMPACTION_SETTINGS` and the configured
model's context window. It checks the last valid assistant usage after each
successful prompt. Manual compaction accepts optional instructions and is
available independently of that threshold.

## System tools

The production tool set contains seven pi `AgentTool` implementations:

| Tool | Implemented behavior |
| --- | --- |
| `read` | Reads UTF-8 text with a 1-indexed offset, optional line limit, and continuation notice. |
| `ls` | Lists a directory alphabetically, including dotfiles and directory suffixes. |
| `grep` | Searches file content with the packaged ripgrep binary and ignore-file semantics. |
| `find` | Finds sorted paths with ripgrep glob and ignore-file semantics. |
| `write` | Creates or completely replaces a UTF-8 file and parent directories. |
| `edit` | Applies unique, non-overlapping exact-text replacements to one file. |
| `bash` | Executes a shell command with merged, bounded stdout/stderr and an optional timeout. |

Relative paths resolve from the directory where the Agent was launched and
absolute paths are accepted. The tools have no OpenScreen approval gate or
filesystem sandbox; they run with the Agent process permissions and environment.
`write`, `edit`, and `bash` declare sequential execution. pi schedules tools
according to their execution mode.

General visible output uses pi's 2,000-line / 50 KiB bound. `grep` and `find`
also bound captured search records to 40 KiB before product formatting and
report when the result count or byte cap was reached. If pi truncates shell
output, it may return a temporary full-output path in tool details.

## Capture integration

Capture owns a single `NativeCaptureService`. It starts `ObservationHelper`,
tracks the latest confirmed external foreground target, schedules optional
passive observations, and shares one coordinator between passive and explicit
request capture:

1. **Join** an in-flight physical capture for the same process/window target.
2. **Reuse** a completed artifact while the configured reuse window remains
   valid and the same target is current.
3. **New** otherwise, with physical native captures serialized by the
   coordinator.

Capture writes accepted structured artifacts under `capture-artifacts/`, JPEGs
under `screen-captures/`, and UTC-daily operational events under `diagnostics/`.
Artifact directories use mode `0700` and files use mode `0600`. Diagnostics may
contain identifiers, statuses, decisions, sizes, counts, and timings, but their
sanitizer drops content fields such as prompts, titles, URLs, screenshot bytes,
or Accessibility text.

`accessibility-projector.ts` bounds useful Accessibility content to 10,000 JSON
characters; `context-projector.ts` assembles only a neutral `CapturedContext`.
Application then
serializes capture identity, time, status, application/window metadata, and the
Accessibility projection into at most 12,000 text characters, with the JPEG as
a generic injected image. The context is persisted by pi as a hidden custom
message and omitted from the visible transcript; it remains present in the
pi Session context and provider context.

`capture.enabled` controls passive scheduling only. The helper still starts and
explicit prompt capture remains available when it is `false`. Native details,
permission behavior, and failure reasons are owned by the
[ObservationHelper README](../Sources/ObservationHelper/README.md).

## Product protocol

Swift starts `node agent/dist/main.js` and exchanges newline-delimited JSON on
stdin/stdout. Every line carries `requestId` for correlation.
Swift rejects requests when the child is not running, drains its final stdout
before reporting process exit, and closes stdin for a bounded graceful shutdown
before terminating a child that does not exit.

Commands:

- `list_sessions`, `create_session`, `get_session`, `rename_session`;
- `prompt` (text and optional new images) and `abort`;
- `compact`; and
- `set_thinking`.

Events cover Session responses, streaming answer and reasoning deltas,
tool start/update/finish, final answer and context usage, compaction,
state updates, abort acknowledgement, and one terminal result. Unknown commands,
unknown fields, and malformed values are rejected instead of being ignored.

Transport contains no pi or Capture logic. Application contains no JSON parser
or stream framing logic.

## Runtime configuration

Non-secret startup configuration is read once from repository-level
[`config.json`](../config.json). The root must contain exactly `agent` and
`capture`; each nested object is also validated with an exact schema.

`agent` contains:

| Field | Meaning |
| --- | --- |
| `provider` | The single pi provider identifier. |
| `model` | The single default model identifier within that provider. |
| `thinking` | Initial thinking level for a new Session with no explicit thinking change. |

The checked-in selection is `minimax-cn/MiniMax-M3` with thinking `medium`.
Unknown provider/model pairs fail startup.

`capture` contains:

- `enabled` for passive scheduling;
- `scheduling` delays, gaps, caps, deduplication, and tick interval;
- `requests` timeout and completed-artifact reuse window;
- `diagnostics` retention;
- `helperLifecycle` configure/shutdown timeouts; and
- the native `activityMonitoring`, `accessibility`, `screenshot`,
  `visualMonitoring`, and `windowSelection` groups sent to the helper.

At startup, `main.ts` first loads an optional `.env` from `process.cwd()` using
Node's environment-file parser. Values already present in the process environment
are not overwritten. Secrets belong only in the environment or `.env`, never in
`config.json`. The default pi `minimax-cn` provider uses
`MINIMAX_CN_API_KEY` and its built-in `https://api.minimaxi.com/anthropic`
endpoint.

Supported OpenScreen process variables:

| Variable | Meaning |
| --- | --- |
| `OPENSCREEN_CONFIG_PATH` | Override the application config file path. |
| `OPENSCREEN_DATA_DIR` | Override the complete Node data root. |
| `OPENSCREEN_HELPER_PATH` | Override the ObservationHelper executable. |
| `OPENSCREEN_BUNDLE_ID` | Add a bundle identifier to Capture self-exclusion. |

## Persistence and failure behavior

The default data root is
`~/Library/Application Support/OpenScreen/`. `OPENSCREEN_DATA_DIR` replaces that
entire Node data root. Swift independently keeps managed PNG copies of uploaded
or pasted images under the default
`~/Library/Application Support/OpenScreen/user-attachments/` directory;
`OPENSCREEN_DATA_DIR` does not relocate that Swift-owned directory.

pi stores Sessions below `sessions/`, grouped by an encoded launch working
directory. Each Session is one append-only JSONL file containing its header,
messages, tool results, thinking changes, compaction summaries, labels, and pi
bookkeeping.
pi serializes message content inline, so user and hidden injected images
are stored as Base64 blocks in the Session JSONL. There is no legacy Session
migration or compatibility reader. Swift removes an unused pending attachment
copy when the user removes it and cleans up copies already written by a failed
multi-image import. There is currently no product retention or deletion UI for
Session files or attachment copies retained for submitted turns. Startup
validates the configured provider/model, and every new or reopened Session uses
that default instead of restoring historical model selection.

Capture storage is independent of Session storage. Application passes only a
neutral projected value between the two services; neither service reads the
other's files.

Capture startup, request, or shutdown failures are diagnostics rather than
Application-wide Agent failures. A prompt uses text and user images when Capture
is unavailable. Provider, Session, validation, busy, not-found, and cancellation
failures are mapped to stable product error codes. The JSONL transport treats
output failure as fatal and waits for already-dispatched work at clean EOF.
Application shutdown also waits for aborted executions to finish before Capture
and the pi execution environment are cleaned up.

## Tests

From the repository root:

```bash
npm run test:agent
```

The command builds the production Agent, builds the test target, and runs all
Node tests recursively. Changes to the Swift product protocol also require:

```bash
swift test
```
