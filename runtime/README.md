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
runtime/src/
├── agent/
│   ├── api.ts                    Capture-neutral Agent contract
│   └── pi/
│       ├── service.ts            AgentService facade and commands
│       ├── session-runtime.ts    pi harness and JSONL Session ownership
│       ├── prompt-runner.ts      prompt events, images, and cancellation
│       ├── session-projection.ts linear active-branch transcript projection
│       ├── memory-citation.ts    hidden citation filtering and access validation
│       └── tools/                seven focused tools plus shared support
├── capture/
│   ├── api.ts                    Agent-neutral Capture contract
│   └── screenpipe/
│       ├── runtime.ts            recorder generation lifecycle and atomic reads
│       ├── generation-store.ts   private rotation and retention ownership
│       ├── database.ts           read-only latest/incremental frame queries
│       ├── service.ts            request capture and guarded JPEG loading
│       ├── frame-source.ts       strict neutral frame projection
│       ├── recorder.ts           pinned SDK safety options
│       └── config.ts             strict Capture configuration
├── memory/
│   ├── config.ts                 strict worker, Chronicle, observation, retention policy
│   ├── cursors.ts                private SQLite scan, generation, and window cursors
│   ├── lifecycle.ts              retrying start/stop wrapper
│   ├── runtime.ts                Chronicle, Turn scan, projection, and retention loop
│   ├── mastra/
│   │   ├── store.ts              LibSQL store and the two ObservationalMemory instances
│   │   ├── thread-ids.ts         fixed resource and thread identifiers
│   │   ├── write-path.ts         thread creation, message save, and observation trigger
│   │   ├── projector.ts          observation-log projection and rollout archive
│   │   ├── read-path.ts          injected Memory block and read policy
│   │   ├── model-adapter.ts      resolves the pi model into a Mastra model
│   │   └── telemetry-guard.ts    disables Mastra telemetry before any @mastra import
│   ├── chronicle/
│   │   ├── window-scheduler.ts   UTC activity windows and grace boundary
│   │   ├── model-projection.ts   bounded code-owned frame projection
│   │   ├── summarizer.ts         bounded request context and token estimation
│   │   ├── processor.ts          window summarization and observation write
│   │   ├── summary-schema.ts     strict output and exact source coverage
│   │   ├── types.ts              Chronicle frame, window, and activity shapes
│   │   └── rollout.ts            searchable Chronicle rendering and observation text
│   └── turn-memory/
│       ├── session-scanner.ts    active-branch terminal Turn scanning
│       ├── session-projection.ts active-branch terminal Turn projection
│       ├── rollout.ts            Turn rollout and observation text rendering
│       └── types.ts              terminal Turn status and source shapes
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
Capture service -> Screenpipe runtime / SDK recorder / read-only SQLite
Memory -> Screenpipe-neutral frame feed + pi Session/model APIs + private Mastra store/cursors/artifacts
main.ts -> all concrete implementations
```

- `agent/` has no dependency on Capture, Application, Transport, or the desktop
  frontend. A
  prompt accepts only text, user images, and optional generic injected context.
- `capture/` has no dependency on Agent, pi, Application, Transport, or the
  desktop frontend. It owns the Screenpipe recorder, generations, frame projection, request JPEG
  reads, and retention.
- `memory/` has no dependency on Capture, Application, or Transport modules. It
  receives a neutral incremental frame feed at the composition root and uses
  pi's Session API, model registry, and local token estimator directly. Session
  JSONL is never reparsed by a Memory-specific protocol reader. The pi Agent
  accepts only a generic dynamic system-context loader and Memory root for
  access tracking and citation validation.
- `application/` imports only the public Agent and Capture APIs. It converts a
  `CapturedContext` into generic `AgentInjectedContext`; neither lower-level
  module knows about that mapping.
- `transport/` imports only the Application API.
- `main.ts` is the only module allowed to construct concrete Agent, Capture,
  Memory, Application, and Transport implementations together.

There is no Capture adapter inside the Agent and no Agent orchestrator inside
Capture.

## Request flow

1. The desktop application sends one strict product command with a non-empty
   `requestId`.
2. Transport validates the complete JSON shape and dispatches commands without
   imposing global serialization.
3. For a prompt, Application first asks Screenpipe Capture for one atomic
   generation snapshot. Capture selects the latest valid row independently for
   every monitor and reads each guarded JPEG from that generation. It does not
   wait for a new frame or fabricate a cross-display group. Capture failure is
   reported to stderr and the prompt continues without screen context.
4. Application maps ordered frame metadata and aligned in-memory JPEG bytes to
   hidden generic context. It does not expose Capture concepts through the Agent
   API.
5. Before every Agent start, `PiAgentService` dynamically loads the current
   `MEMORY.md`, `ACTIVITY.md`, and Memory read policy into the system prompt.
   Missing or invalid optional Memory context does not fail the prompt and is
   not appended to the Session.
6. `PiAgentService` loads user and injected images, runs `AgentHarness.prompt`,
   maps pi stream events to the product event stream, strips the model-authored
   hidden Memory citation block, and persists a citation custom entry only when
   its files and line ranges were actually read in that Turn.
7. After a successful persisted answer, Pi asynchronously notifies the Memory
   runtime, which scans that Session for newly terminal Turns. Turn projection
   copies neither hidden screen text nor images. Notification and
   background-worker failures cannot alter the prompt result.
8. Application asks pi whether the current context needs automatic compaction.
9. Each request emits exactly one terminal `completed` or `failed` event. An
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

## Observational Memory

Memory does not run its own extraction, job queue, lease, or consolidation
model. Compression is owned by Mastra's standalone `ObservationalMemory`
processor, driven manually from the write path. Two instances share one
`Memory` and one LibSQL store under a single resource, `openscreen`, with two
long-lived thread IDs:

| Thread | Fed by | Configured budgets |
| --- | --- | --- |
| `interactive` | one completed pi Turn | `observationalMemory.interactive` |
| `screen-activity` | one summarized Chronicle window | `observationalMemory.screenActivity` |

The threads persist for the life of the installation and are deliberately
decoupled from pi Session IDs, so cross-Session Memory does not reset when a
Session is created. They are a separate re-derived copy; the pi Session JSONL
remains the only authority for what a live Agent Turn actually sees.

Each write saves one message to its thread and then calls `observe()`
unconditionally, which is cheap when the configured `messageTokens` threshold is
not reached. Mastra decides on its own when to observe and when to reflect;
OpenScreen configures only the two token budgets. `messageTokens` may not exceed
`observationTokens`. No vector store and no embedder are configured, so semantic
recall stays off. Observation and reflection do not stream through pi: the
resolved pi model is translated into a Mastra model by `model-adapter.ts`.

## Turn Memory

Turn scanning uses pi's `JsonlSessionRepo` and `Session` API and feeds the
`interactive` thread. A source begins at the first user message and closes only
at a terminal assistant message. `stop`, `error`, `aborted`, and `length` map to
completed, failed, cancelled, and interrupted outcomes. An unfinished Turn does
not advance the durable per-Session terminal-entry cursor.

A Session is rescanned only when its file size or mtime changes. A deterministic
projection failure, such as a malformed Session, is recorded against the current
file version so the same content is not retried until the file changes. A write
failure records nothing, which leaves the cursor at its last successful position
and retries the whole unprocessed range on the next tick. That retry may re-send
an already-written source: the rollout overwrite is idempotent and a duplicate
observation is simply seen twice.

Code, not a model, owns the rendered Turn. The rollout carries thread, Session,
working directory, Git branch, JSONL rollout path, rollout ID, status, user
text, final assistant text, an optional prior compaction summary, an optional
terminal error, and bounded tool names/results. The observation text sent to
Mastra is a plainer form of the same content. Neither contains reasoning,
intermediate assistant text, stream deltas, image or Base64 blocks, or pi
bookkeeping. `source_frame_ids` is intentionally omitted from Turn rollouts; it
is kept only in Chronicle rollouts, where it is load-bearing.

Each accepted Turn writes one UTF-8 `rollout_summaries/turn-*.md` file
alongside the Mastra write. These files are immediately searchable with the
existing `grep`, `read`, `find`, and `bash` tools.

## Chronicle Memory

The Memory runtime lists active and retired Screenpipe generations, then drains
the oldest incomplete generation by monotonically increasing SQLite frame ID.
The cursor is durable and scoped by generation. After a final batch confirms
that no rows remain, Memory marks a retired generation complete; Capture
retention cannot delete it before that mark. A rotation therefore leaves the old
generation readable and starts the new generation without losing an unconsumed
tail. Invalid SDK rows
can advance the scan cursor, but the durable cursor advances only after every
valid frame in the batch is idempotently ingested, so a crash can replay sources
but cannot skip them.

Chronicle groups frames into fixed UTC windows and waits for the configured
grace boundary before a window becomes due. Late sources bump the window
generation and make it due again. Model input is a bounded code-owned projection of
source ID, generation/frame/monitor identity, capture time, trigger,
application, window title, URL, and visible text. It never contains JPEG bytes,
Base64, or image paths. Requests are split at ten sources and the configured
input-token budget.

Each request exposes only `submit_chronicle_summary`, whose parameters are the
strict Chronicle schema. The response must end in tool use with exactly one call
to that tool. Adjacent ordinary text is ignored; text-only, missing or
additional calls, and other tool names fail the window. If the provider reaches
its output limit, OpenScreen recursively splits the current multi-frame request
and retries; a single-frame request that still reaches the limit fails normally.
OpenScreen validates the call arguments locally and requires every claimed
source ID exactly once without omissions, duplicates, or invented IDs.

A worker cycle summarizes at most `worker.maxChronicleWindowsPerTick` due
windows. A successful window writes its observation text to the
`screen-activity` thread and one UTF-8 `rollout_summaries/chronicle-*.md`
containing source metadata, activities, and exact `source_frame_ids`, and is
then marked summarized in the cursor database. A failed window is reported as a
diagnostic and stays due, so the next cycle retries it.

## Memory projection and retention

Every worker cycle rewrites two whole-log projections of the current
observations: `MEMORY.md` from the `interactive` thread and `ACTIVITY.md` from
the `screen-activity` thread. Both are written atomically through a temporary
file, are never filtered or partially updated, and are empty until the
corresponding thread has been observed at least once. On a fresh installation
the underlying tables do not exist yet; that specific condition is treated as
"no observations", while any other failure is reported as a diagnostic.

`rollout_summaries/*.md` is the only place pre-compression detail survives,
because the observation processor discards raw messages once observed. Mastra
never prunes that directory, so the projector applies its own age-based prune to
`chronicle-*.md` files using `retention.chronicleRolloutMaxAgeMilliseconds`.
Turn rollouts follow pi Session lifecycle and are not pruned by this product.
Retention is age-based only; nothing tracks which rollouts a Memory answer used.

## Memory read path

For each Turn, `before_agent_start` receives an optional system-context suffix
containing the absolute Memory root, fixed trust and search rules, and the
complete current `MEMORY.md` and `ACTIVITY.md`. Because both files are injected
in full, the Agent is told not to re-open them for content, and to grep or read
a specific line only when it needs a citation range. For detail beyond the
injected blocks — exact wording, tool output, code, or a time-bounded activity —
the Agent searches `rollout_summaries/` with the existing `grep`, `read`,
`find`, `ls`, and read-only `rg`/`sed` through `bash`. There is no dedicated
Memory tool and no direct access to the Mastra database.

Memory artifacts are untrusted historical data. Current user, system, and
project rules and verifiable current state take precedence; conflicting
observations are resolved by their own timestamps rather than file order, and
potentially stale facts must be verified or disclosed as historical. When Memory
content supports an answer, the model appends one `<oai-mem-citation>` JSON
block. Streaming and final user text remove the block. Validation accepts only
`MEMORY.md`, `ACTIVITY.md`, or one-level rollout files, actual `grep`/`read`
line ranges from the current Turn, and rollout IDs present in cited rollout
contents. Valid provenance is appended to the pi Session as an
`openscreen.memory-citation` custom entry; invalid provenance is discarded
without changing the answer. Citations do not pin retention.

## pi Agent capabilities

`PiAgentService` delegates these behaviors to pi:

- configured-model lookup and streaming;
- the Agent Loop and model-directed tool calls;
- reasoning levels from `off` through `max`, subject to model support;
- append-only JSONL Session persistence and reopening;
- current-branch context and thinking-state restoration; and
- context accounting and compaction summaries.

OpenScreen projects pi state into product DTOs for the desktop frontend. The
transcript contains
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

Capture owns one `ScreenpipeRuntime` using pinned `@screenpipe/sdk@0.4.3`.
Recorder options disable telemetry, microphone, system audio, MP4 output,
keystrokes, clipboard capture, scroll capture, and mouse-move capture. The
checked-in exclusions omit the OpenScreen window title. `pairedMonitors` is left
undefined so the SDK records all displays as independent frame streams.

Each recorder generation has a private `0700` directory under
`screenpipe/generations/` and its own SDK SQLite/JPEG data. The runtime opens
SQLite read-only, serializes lifecycle and reads through one queue, and rotates
at the earlier of the next UTC day or configured age deadline. Retention never
deletes the active generation, ignores symlink candidates, removes expired
inactive generations, and then evicts the oldest inactive generations until the
configured byte cap is met. Cleanup diagnostics contain no paths or content.

At prompt submission, `captureSnapshot()` selects the latest valid row for each
monitor by that monitor's timestamp and frame ID. There is no request watermark,
freshness threshold, cross-monitor skew rule, or synthetic group. Capture
validates the private canonical generation root, confines each JPEG path to that
root, opens the leaf with `O_NOFOLLOW`, validates its JPEG signature, and passes
aligned in-memory bytes to Application. Invalid or missing images are omitted.

Application emits ordered metadata and images only when `sourceId` alignment is
exact. It preserves source, generation, frame, monitor, and capture-time
provenance within one 12,000-character JSON budget; optional application,
window, URL, trigger, and visible text are added while space remains. The hidden
context is omitted from the visible transcript but pi persists it inline in the
Session, including Base64 image blocks.

`capture.screenpipe.enabled` disables both the recorder and screen context when
false. `@screenpipe/sdk` is pinned to an exact version because the reader
depends on its SQLite `frames` schema; verify the upstream schema by hand before
upgrading.

## Product protocol

The Electron main process starts this runtime as a child and exchanges
newline-delimited JSON on stdin/stdout. Every line carries `requestId` for
correlation. The frontend rejects requests when the child is not running, drains
its final stdout before reporting process exit, and closes stdin for a bounded
graceful shutdown before terminating a child that does not exit.

`application/api.ts` is the only definition of this protocol. The frontend
re-exports those types instead of restating them, so the two ends cannot drift;
see [Development rules](../AGENTS.md#testing).

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
[`config.json`](../config.json). The root must contain exactly `agent`,
`capture`, and `memory`; each nested object is also validated with an exact
schema.

`agent` contains:

| Field | Meaning |
| --- | --- |
| `provider` | The single pi provider identifier. |
| `model` | The single default model identifier within that provider. |
| `thinking` | Initial thinking level for a new Session with no explicit thinking change. |

The checked-in selection is `minimax-cn/MiniMax-M3` with thinking `medium`.
Unknown provider/model pairs fail startup.

`capture` contains:

- `screenpipe.enabled` for the recorder, Chronicle feed, and request context;
- `screenpipe.ignoredWindows` and `ignoredUrls` for SDK-side exclusions; and
- `screenpipe.retention.maxAgeMilliseconds` and `maxBytes` for inactive
  generation cleanup. The checked-in values are seven days and 10 GiB.

`memory` contains:

- `enabled` for Chronicle summarization, Turn scanning, observation, projection,
  retention, and prompt Memory context;
- `worker.intervalMilliseconds` and `maxChronicleWindowsPerTick` for the cycle
  period and the per-cycle Chronicle request budget;
- `chronicle.windowMilliseconds`, `graceMilliseconds`, `maxSourcesPerRequest`,
  and input/output token limits for activity summarization;
- `observationalMemory.interactive` and `observationalMemory.screenActivity`,
  each with `messageTokens` and `observationTokens`, for the two observation
  processors; and
- `retention.chronicleRolloutMaxAgeMilliseconds` for the Chronicle rollout age
  boundary. The checked-in value is 90 days.

`maxSourcesPerRequest` may not exceed ten, `chronicle.maxOutputTokens` must stay
below `maxInputTokens`, and each observation policy's `messageTokens` may not
exceed its `observationTokens`. The checked-in policy cycles every five seconds,
summarizes at most two Chronicle windows per cycle, and uses one-minute Chronicle
windows with 15 seconds grace and at most ten frames per request.

Chronicle summarization uses the same configured pi model as the interactive
Agent. Observation and reflection use the same model too, but not through pi:
`model-adapter.ts` translates the model pi resolved from `agent.provider` and
`agent.model` into a form Mastra accepts, selected by that model's pi wire API.

| pi wire API | Mastra model | Notes |
| --- | --- | --- |
| `anthropic-messages` | `@ai-sdk/anthropic` client | pi stores these base URLs without the API version segment, so `/v1` is appended. |
| `openai-completions` | OpenAI-compatible config | No client is constructed; the base URL is passed through unchanged. |
| anything else | rejected at startup | Needs its own verified client. |

26 of pi's 35 built-in providers expose at least one usable model. The nine
that expose none are `amazon-bedrock`, `azure-openai-responses`, `google`,
`google-vertex`, `mistral`, `openai` and `openai-codex`, whose models use
unsupported wire APIs, plus `cloudflare-ai-gateway` and `cloudflare-workers-ai`,
whose base URLs are templated. Note that this excludes OpenAI itself, whose
models use `openai-responses`. `github-copilot` and `opencode` carry a mix and
are usable only with a model on a supported wire API. Selecting an unusable
model starts the interactive Agent normally and fails Memory startup.

A templated base URL, which pi substitutes inside its own providers, is also
rejected. These calls bypass pi and therefore receive none of its per-provider
compatibility overrides.

At startup, `main.ts` first loads an optional `.env` from `process.cwd()` using
Node's environment-file parser. Values already present in the process environment
are not overwritten. Secrets belong only in the environment or `.env`, never in
`config.json`. The credential for the configured provider is read from the
environment under pi's own credential names, so Memory and the interactive Agent
always authenticate with the same variable. The default pi `minimax-cn` provider
uses `MINIMAX_CN_API_KEY` and its built-in `https://api.minimaxi.com/anthropic`
endpoint. `main.ts` also sets `MASTRA_TELEMETRY_DISABLED` before
any `@mastra` module is evaluated, unless the environment already defines it.

Supported OpenScreen process variables:

| Variable | Meaning |
| --- | --- |
| `OPENSCREEN_CONFIG_PATH` | Override the application config file path. |
| `OPENSCREEN_DATA_DIR` | Override the complete Node data root. |

## Persistence and failure behavior

The default data root is
`~/Library/Application Support/OpenScreen/`. `OPENSCREEN_DATA_DIR` replaces that
entire Node data root. The Electron main process keeps managed PNG copies of
uploaded or pasted images under `user-attachments/` inside that same data root,
so `OPENSCREEN_DATA_DIR` relocates them along with everything else.

pi stores Sessions below `sessions/`, grouped by an encoded launch working
directory. Each Session is one append-only JSONL file containing its header,
messages, tool results, thinking changes, compaction summaries, labels, and pi
bookkeeping.
pi serializes message content inline, so user and hidden injected images
are stored as Base64 blocks in the Session JSONL. There is no legacy Session
migration or compatibility reader. The frontend removes an unused pending
attachment copy when the user removes it and cleans up copies already written by
a failed multi-image import. Startup validates the configured provider/model, and every
new or reopened Session uses that default instead of restoring historical model
selection.

Capture storage is independent of Session storage. Application passes only a
neutral projected value between the two services; neither service reads the
other's files.

Screenpipe stores each recorder generation below
`screenpipe/generations/<generation-id>/`. Request Capture reads JPEG bytes from
the active generation and pi persists those injected bytes again as Base64 in
the Session JSONL. Memory stores no image data of its own: it keeps only the
generation-scoped cursor and the bounded text projection.

Memory stores two SQLite databases below `memory/`. `mastra.db` is owned by
LibSQL and holds threads, messages, and observations. `cursors.sqlite3` is owned
by OpenScreen and holds only the per-Session Turn scan cursor, the Chronicle
generation cursor, pending Chronicle frames, and window state. Alongside them it
keeps private `MEMORY.md`, `ACTIVITY.md`, `rollout_summaries/turn-*.md`, and
`rollout_summaries/chronicle-*.md`. The root and artifact directories use mode
`0700`; projected files use mode `0600`. The Markdown files are projections, not
truth, so a lost projection is regenerated on the next cycle rather than
recovered.

Memory starts before Capture and transport so it can open both databases and
project the current observation logs without making model requests. Resolving the
observation model happens before any file is opened, so a missing API key fails
without leaving a LibSQL handle behind while the lifecycle retries. Capture then
starts its recorder and transport begins accepting commands immediately. The
first Chronicle and Turn cycle runs in the background, so model latency cannot
block Session restoration or editor interaction. Startup failure is reported, a
background retry is scheduled at the worker interval, and text-only Agent
execution continues. Until Memory recovers, generation completion remains false
so Capture retention cannot delete unread Chronicle data. On shutdown,
Application aborts active Agent runs, waits for executions, and stops Capture;
pending Memory retry is cancelled and the Memory queue is drained before the
LibSQL store and cursor database are closed and the pi execution environment is
cleaned up.

Capture and Memory startup, background, or shutdown failures are diagnostics
rather than Application-wide Agent failures. A prompt uses text and user images
when Capture is unavailable, and a completed prompt is not rolled back when a
Memory notification fails. A missing or invalid summary also degrades to the
normal Session context. Provider, Session, validation, busy, not-found, and
cancellation failures are mapped to stable product error codes. The JSONL
transport treats output failure as fatal and waits for already-dispatched work
at clean EOF.

## Tests

From the repository root:

```bash
npm run test:runtime
```

The command builds the production Agent, builds the test target, and runs all
Node tests recursively. Changes to the product protocol also require the
frontend suites:

```bash
npm run typecheck:app
npm run test:app
```
