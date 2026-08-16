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
│   ├── config.ts                 strict worker, Turn, consolidation, retention policy
│   ├── database.ts               private WAL SQLite ownership
│   ├── schema.ts                 Memory persistence schema
│   ├── runtime.ts                Chronicle, Turn, consolidation, and retention loop
│   ├── artifact-projector.ts     atomic searchable-file projection
│   ├── workspace-coordinator.ts  producer/consolidation writer fencing
│   ├── read-context.ts           bounded per-Turn summary and search policy
│   ├── retention.ts              reference-aware rollout collection
│   ├── chronicle/
│   │   ├── repository.ts         source/window/cursor/job/artifact truth
│   │   ├── window-scheduler.ts   UTC activity windows and grace boundary
│   │   ├── model-projection.ts   bounded code-owned frame projection
│   │   ├── processor.ts          leased extraction and immediate projection
│   │   ├── summary-schema.ts     strict output and exact source coverage
│   │   └── rollout.ts            searchable Chronicle rendering
│   ├── consolidate/
│   │   ├── source-repository.ts  monotonic source registry and removal tombstones
│   │   ├── repository.ts         snapshots, leases, evidence, publication journal
│   │   ├── model-projection.ts   Task Group and v1 summary contract
│   │   ├── processor.ts          frozen publication and crash recovery
│   │   └── workspace.ts          dedicated one-commit Git baseline
│   └── turn-memory/
│       ├── runtime.ts            Session scanning and worker lifecycle
│       ├── session-projection.ts active-branch terminal Turn projection
│       ├── repository.ts         cursor, source, batch, lease, and artifact truth
│       ├── processor.ts          pi model extraction and artifact publication
│       ├── extractor.ts          strict model context and output validation
│       ├── model-projection.ts   code-owned provenance projection
│       ├── rollout.ts            Turn rollout and raw-memory rendering
│       └── scan-cursor.ts        durable per-Session scan cursor
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
Memory -> Screenpipe-neutral frame feed + pi Session/model APIs + private SQLite/artifacts/Git workspace
main.ts -> all concrete implementations
```

- `agent/` has no dependency on Capture, Application, Transport, or Swift. A
  prompt accepts only text, user images, and optional generic injected context.
- `capture/` has no dependency on Agent, pi, Application, Transport, or Swift.
  It owns the Screenpipe recorder, generations, frame projection, request JPEG
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

1. Swift sends one strict product command with a non-empty `requestId`.
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
5. Before every Agent start, `PiAgentService` dynamically loads the bounded
   `memory_summary.md` and Memory search policy into the system prompt. Missing,
   invalid, or oversized optional Memory context does not fail the prompt and is
   not appended to the Session.
6. `PiAgentService` loads user and injected images, runs `AgentHarness.prompt`,
   maps pi stream events to the product event stream, strips the model-authored
   hidden Memory citation block, and persists a citation custom entry only when
   its files and line ranges were actually read in that Turn.
7. After a successful persisted answer, Pi asynchronously notifies the Memory
   runtime. Turn projection extracts the exact injected `sourceFrameIds` without
   copying hidden screen text or images. Notification and background-worker
   failures cannot alter the prompt result.
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

## Turn Memory

Turn Memory scans the active branch exposed by pi's `JsonlSessionRepo` and
`Session` API. A source begins at the first user message and closes only at a
terminal assistant message. `stop`, `error`, `aborted`, and `length` map to
completed, failed, cancelled, and interrupted outcomes. An unfinished Turn does
not advance the durable per-Session terminal-entry cursor. If the active branch
rewinds behind that cursor, the scanner rescans the branch and marks abandoned
sources inactive.

The model projection contains user text, final assistant text, bounded tool
names/results, authoritative status, exact `sourceFrameIds`, and a bounded
relevant compaction summary. It omits reasoning, intermediate assistant text,
stream deltas, image/Base64 blocks, hidden screen text, and pi bookkeeping.
Code, not the model, owns Session/thread IDs, working directory, Git branch,
JSONL rollout path, timestamps, and source IDs.

Terminal Turns from one Session are sealed after 30 minutes idle, a two-hour
hard cap, or the configured input-token limit. Jobs use durable leases, retries,
generation fencing, and strict local validation. Each request exposes only
`submit_turn_memory`; Anthropic-compatible models are forced to choose it. The
response must contain exactly one call to that tool. Adjacent ordinary text is
ignored, while text-only, missing, additional, or differently named calls fail
the job. Structured tasks preserve outcome, preference signals, reusable
knowledge, failure lessons, references, and English plus original-language
keywords. A failed-only batch cannot claim a successful outcome.

SQLite is committed before files are projected. A successful extraction creates
one UTF-8 `rollout_summaries/turn-*.md` file and regenerates
`raw_memories.md`; pending files are replayed after restart. These files are
immediately searchable with the existing `grep`, `read`, `find`, and `bash`
tools, including before global consolidation. A branch rewind or deleted pi
Session deactivates its Turn sources, queues consolidation, and removes inactive
Turn content from the next `raw_memories.md` projection. An unreferenced inactive
Turn rollout is eligible for collection; a current consolidated evidence
reference protects it.

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
grace boundary before claiming a window. Late sources bump the window generation
and queue another extraction. Model input is a bounded code-owned projection of
source ID, generation/frame/monitor identity, capture time, trigger,
application, window title, URL, and visible text. It never contains JPEG bytes,
Base64, or image paths. Requests are split at ten sources and the configured
input-token budget.

Each request exposes only `submit_chronicle_summary`, whose parameters are the
strict Chronicle schema. The response must end in tool use with exactly one call
to that tool. Adjacent ordinary text is ignored; text-only, missing or
additional calls, and other tool names fail the job. If the provider reaches
its output limit, OpenScreen recursively splits the current multi-frame request
and retries; a single-frame request that still reaches the limit fails normally.
OpenScreen validates the call arguments locally and requires every claimed
source ID exactly once without omissions, duplicates, or invented IDs. SQLite
completion and worker ownership are fenced transactionally. A successful
extraction immediately projects one UTF-8
`rollout_summaries/chronicle-*.md` containing source metadata, activities, and
exact `source_frame_ids`; pending projections are replayed at the start of every
worker cycle.

## Global Memory consolidation

Each successful Turn or Chronicle extraction registers a monotonic source in
SQLite and queues one global consolidation job. A claim freezes a source watermark and
builds a complete `added`, `retained`, and `removed` snapshot. The configured
`maxChangedSourcesPerRun` limits only changed sources; retained sources and the
active evidence manifest are not silently converted to removals. New source
writes during a model request remain pending for the next run.

The request exposes only `submit_memory_consolidation`; Anthropic-compatible
models are forced to choose it. OpenScreen uses the arguments from exactly one
correct call, ignores adjacent ordinary text, and rejects text-only, missing,
additional, or differently named calls before local schema and evidence
validation. Each Task Group carries scope, outcome, original-language and
English keywords, user preferences, reusable knowledge, failure lessons, and
one or more real rollout paths. A success claim requires successful Turn
evidence. Passive Chronicle evidence cannot establish a durable fact without at least two
independent source IDs. The same response provides a `v1` navigation summary
whose complete generated size must fit `summaryMaxTokens`; read-time truncation
is not used.

The Memory root is a dedicated OpenScreen-owned Git repository with an ownership
marker, local `openscreen.memoryRoot=true`, and no remote. Only the root marker,
`.gitignore`, `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, and one-level
rollout Markdown files may be tracked. SQLite, WAL, evidence, Screenpipe data,
and publication staging are ignored. Producers leave the workspace dirty;
consolidation computes the complete diff and publishes both generated files
under a writer fence and SQLite publication journal. A successful publication
creates a new parentless baseline by compare-and-swap, resets to it, expires the
reflog, and prunes the previous commit. Startup either finalizes a complete
publication or rolls an incomplete one back and reprojects SQLite truth.

Reference-aware retention runs after worker cycles. An unreferenced Chronicle
source is eligible at the configured age boundary (90 days by default), while
inactive Turn rollouts follow pi Session lifecycle. Any current
`memory_evidence` reference protects either kind until a later consolidation
removes that reference.

## Memory read path

For each Turn, `before_agent_start` receives an optional system-context suffix
containing the absolute Memory root, fixed trust/search rules, and the complete
bounded `memory_summary.md`. The summary is a query-expansion hint, not an
allowlist. Prior-context and activity questions must first search `MEMORY.md`
and may independently search time-bounded rollout files even when the summary
does not mention the topic. The Agent uses the existing `grep`, `read`, `find`,
`ls`, and read-only `rg`/`sed` through `bash`; there is no dedicated Memory tool
or SQLite access. The quick pass is limited to 4–6 lookups and at most one or two
rollouts, with a single named pi JSONL file used only for exact evidence.

Memory artifacts are untrusted historical data. Current user/system/project
rules and verifiable current state take precedence, and potentially stale facts
must be verified or disclosed as historical. When Memory files support an
answer, the model adds an `<oai-mem-citation>` JSON block. Streaming and final
user text remove the block. Validation accepts only `MEMORY.md` or one-level
rollout files, actual `grep`/`read` line ranges from the current Turn, and rollout
IDs present in cited rollout contents. Valid provenance is appended to the pi
Session as an `openscreen.memory-citation` custom entry; invalid provenance is
discarded without changing the answer. Citations do not pin retention.

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

Swift starts `node runtime/dist/main.js` and exchanges newline-delimited JSON on
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

- `enabled` for Chronicle and Turn extraction, consolidation, retention, and
  prompt Memory context;
- `worker.intervalMilliseconds` and `maxJobsPerTick` for scans and extraction;
- `worker.leaseMilliseconds`, `retryDelayMilliseconds`, and `maxAttempts` for
  durable extraction and consolidation recovery;
- `turnMemory.maxInputTokens`, `maxOutputTokens`, `idleMilliseconds`, and
  `hardCapMilliseconds` for batching and extraction model requests;
- `chronicle.windowMilliseconds`, `graceMilliseconds`,
  `maxSourcesPerRequest`, and input/output token limits for activity extraction;
- `consolidation.maxChangedSourcesPerRun`, input/output and summary token limits,
  and `cooldownMilliseconds` for global replacement; and
- `retention.chronicleUnreferencedMilliseconds` for the unreferenced Chronicle
  boundary. The checked-in value is 90 days.

Chronicle extraction, Turn extraction, and global consolidation use the same
configured pi model as the interactive Agent. The checked-in policy scans every
five seconds, processes at most two jobs of each producer type per tick, uses
one-minute Chronicle windows with 15 seconds grace and at most ten frames per
request, closes Turn batches after 30 minutes idle or two hours total, allows up
to 128 changed sources per consolidation, limits the generated summary to 2,500
tokens, and applies a six-hour successful-run cooldown. A worker cycle that
processes either producer defers consolidation to a later cycle.

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

Screenpipe stores each recorder generation below
`screenpipe/generations/<generation-id>/`. Request Capture reads JPEG bytes from
the active generation and pi persists those injected bytes again as Base64 in
the Session JSONL. Chronicle stores only the generation-scoped cursor and
bounded text projection in Memory; it does not copy SDK JPEGs or paths.

Memory stores `memory.sqlite3` and its WAL files below `memory/`, together with
private `rollout_summaries/turn-*.md`,
`rollout_summaries/chronicle-*.md`, `raw_memories.md`, `MEMORY.md`, and
`memory_summary.md` projections. The root and artifact directories use mode
`0700`; the database and projected files use mode `0600`. SQLite is the source,
job, evidence, and publication recovery truth. The files are searchable
projections, while the nested no-remote Git repository keeps only the current
parentless publication baseline. Producer projections are replayed from SQLite
after a crash; Git is used for complete diff, rollback, and fenced publication,
not history.

Memory starts before Capture and transport so it can migrate SQLite, recover a
publication, validate or initialize its Git workspace, and project pending
artifacts without making model requests. Capture then starts its recorder and
transport begins accepting commands immediately. The initial Chronicle, Turn,
and consolidation cycle runs in the background, so model latency cannot block
Session restoration or editor interaction. Startup failure is reported, a
background retry is scheduled at the worker interval, and text-only Agent
execution continues. Until Memory recovers, generation completion remains false
so Capture retention cannot delete unread Chronicle data. On shutdown,
Application aborts active Agent runs, waits for executions, and stops Capture;
pending Memory retry is cancelled and the Memory queue is drained before the pi
execution environment is cleaned up.

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
Node tests recursively. Changes to the Swift product protocol also require:

```bash
swift test
```
