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
│   ├── api.ts                    Agent-neutral Capture contract and frame shape
│   ├── native/
│   │   ├── main.swift            ScreenCaptureKit and accessibility capture helper
│   │   ├── service.ts            prompt-time screen read and guarded JPEG loading
│   │   └── helper.ts             helper invocation and strict report parsing
│   └── screenpipe/
│       ├── runtime.ts            recorder generation lifecycle and atomic reads
│       ├── generation-store.ts   private rotation and retention ownership
│       ├── database.ts           read-only incremental frame queries
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
│   ├── runtime.ts                thin Agent/Capture use-case composition
│   └── diagnostics/
│       ├── schema.ts             adapted Codex raw events and reduced execution windows
│       ├── writer.ts             append-only thread bundles and payload references
│       ├── turn-trace.ts         prompt, inference, tool, and approval observations
│       ├── reader.ts             validated read-only reduction by Turn
│       ├── store.ts              loaded Session ownership and shutdown barriers
│       └── cli.ts                local trace list and timeline viewer
├── desktop/
│   ├── api.ts                    driver, observation, and authorization callback contracts
│   ├── cua-driver.ts             same-process SDK adapter and driver shutdown
│   ├── tools.ts                  desktop tool schemas and registration
│   ├── observation.ts            window binding, freshness, and serialized observation
│   ├── actions.ts                guarded click, scroll, and segmented typing
│   ├── native-focus-guard.ts     native AX helper lifecycle and field verification
│   ├── native/
│   │   ├── main.swift            bound input observation and focus notifications
│   │   └── focus-policy.swift    focus and native input validation
│   └── action-result.ts          Cua action receipt validation
├── security/
│   ├── approval-coordinator.ts   one-time pending approval state
│   ├── tool-security.ts          per-prompt tool scope and authorization
│   ├── desktop-app-permissions.ts conversation-scoped application grants and denials
│   ├── sandboxed-shell.ts        macOS Bash execution profile
│   ├── sandboxed-file-writer.ts  isolated file-change worker ownership
│   └── file-worker.ts            sandboxed write and append implementation
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
Security -> Agent tool API + macOS sandboxed subprocesses
Security -> Desktop tools + authorization callbacks
Desktop -> Cua Driver / native focus helper + Agent tool result API
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
- `desktop/` owns observation, input delivery, and SDK adaptation. It invokes
  authorization and audit callbacks supplied by `security/`; it does not own
  approval state or depend on security implementations. `ToolSecurity` still
  wraps every registered tool with the same per-prompt and per-call scopes.
- `main.ts` is the only module allowed to construct concrete Agent, Capture,
  Memory, Application, and Transport implementations together.

There is no Capture adapter inside the Agent and no Agent orchestrator inside
Capture.

## Request flow

1. The desktop application sends one strict product command with a non-empty
   `requestId`.
2. Transport validates the complete JSON shape and dispatches commands without
   imposing global serialization.
3. For a prompt, Application asks Capture to read the screen. The native
   backend spawns the macOS helper, which photographs every display through
   ScreenCaptureKit and reads the focused window's accessibility text, both at
   that instant. Capture failure is reported to stderr and the prompt continues
   without screen context.
4. Application maps ordered frame metadata and aligned in-memory JPEG bytes to
   hidden generic context. It does not expose Capture concepts through the Agent
   API.
5. At each prompt start, `PiAgentService` dynamically loads the current
   `MEMORY.md`, `ACTIVITY.md`, and Memory read policy. The per-Session harness
   reuses that prompt-only system context for every model request after tool
   calls and clears it when the prompt settles. Missing or invalid optional
   Memory context does not fail the prompt or enter the Session.
6. `PiAgentService` loads user and injected images, runs `AgentHarness.prompt`,
   maps pi stream events to the product event stream, strips the model-authored
   hidden Memory citation block, and persists a citation custom entry only when
   its files and line ranges were actually read in that Turn.
   The production tool scope creates a private per-prompt output directory.
   A tool requiring approval pauses until a matching one-time decision; user
   decision time is not counted as an ordinary tool execution timeout.
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
queue, while abort remains able to interrupt the owning prompt or manual
compaction directly. Cancellation uses each request's own signal; cancelling a
prompt queued behind another request does not cancel its predecessor. A cancelled
queue waiter settles without waiting for its predecessor, while later mutations
remain serialized behind that predecessor. Shutdown still aborts all active
owners in each Session. The prompt's cancellation scope lasts through automatic
compaction, not just through answer generation. If abort arrives before the provider request, including while prompt
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

The `screen-activity` thread contains only screen-derived content. Chronicle
phrases on-screen dialogue as displayed messages, without identifying the
real-world speaker. Its Mastra message includes a code-owned screen-capture
warning and each activity's capture time, application, and source frame IDs;
the message timestamp is normally the latest capture time in the window. If
that time is at or before Mastra's observed-time cursor, the transport timestamp
is advanced by one millisecond past the cursor so a late window is not skipped;
the envelope and rollout still retain the actual capture times. The observer
and reflector receive source-attribution instructions and a format-only
placeholder template. For screen memory, both are instructed to take capture
dates and times only from each source's `captured_at`, preserving its ISO value,
time-zone suffix, and frame attribution. Message-title times and other transport
or bookkeeping timestamps are not capture evidence; a missing `captured_at`
must not be inferred from them. Dialogue memory does not use this capture-time rule.
These are model instructions, not deterministic validation of generated times.
Mastra still labels this transport message `User`, so these safeguards reduce
but cannot eliminate mistaken user attribution or timestamp substitution.

The `interactive` observer and reflector share a separate source-attribution
instruction. Its outer `User` role wraps a rendered conversation record; only
content identified as the original user message establishes user statements.
Tool outputs, assistant replies, and prior summaries remain attributed evidence,
not new user instructions or grants. Repetition by an assistant or reflection
does not verify a claimed approval. Runtime approval receipts preserve their
recorded scope and lifetime, including conversation-scoped application grants;
neither may be broadened. Historical approval claims need current runtime
verification before being treated as active grants. Unknown
attribution stays unknown. These are model instructions, not deterministic
validation of generated memory; they do not rewrite existing observations.

The interactive reflector additionally preserves key facts not explicitly
superseded by a newer record; updating one field does not erase unrelated
facts. Historical states retain their original dates; a newer value stays with
its update date rather than replacing the old value in an earlier dated record. Without subsequent
outcome evidence, their outcome remains unknown rather than becoming a current
pending task or an invented past result. These remain model instructions, not
a deterministic guarantee of reflection fidelity.

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
Base64, or image paths. Before any request is split, code groups adjacent
frames per monitor when application, window title, URL, and nonempty projected
visible text match exactly. An intervening changed frame on that monitor starts
a new group; interleaved frames from other monitors do not. This is text and
metadata deduplication, not a claim that screenshot pixels are identical.
Only each group's representative frame enters the model input. Requests are
split at ten representative sources and the configured input-token budget; an
output-limit retry also splits representatives, never a duplicate group. The
model is not told the original capture count and is instructed not to state
frame counts or narrate frame order. If the model puts an unsupported capture
count or ordinal frame reference in the overall source summary, code rebuilds
that summary from the validated activity texts; the same claim in an activity
is rejected and retried as invalid output.
After strict validation of representative IDs,
code expands each cited ID to its original group and requires every captured ID
exactly once.
The rollout retains every original frame's ID and metadata, including capture
time. Empty-text frames are never grouped.
The model is instructed to ground page identity and status in each frame's own
text and metadata, not carry them forward from a prior frame. Empty text does
not prove a blank screenshot or identify the prior page. Application names are
not window titles; active, foreground, or focused state requires explicit frame
metadata. Path-like text alone does not establish source-code or open-file
roles. These are prompt rules, not deterministic semantic validation.
Cross-application activities remain allowed when the sources share visible
evidence.

Each request exposes only `submit_chronicle_summary`, whose parameters are the
strict Chronicle schema. The prompt explicitly requires `window_title: null`
when title metadata is absent; omitting a required field remains invalid. The
response must end in tool use with exactly one call to that tool. Adjacent
ordinary text is ignored; text-only, missing or
additional calls, and other tool names fail the window. If the provider reaches
its output limit, OpenScreen recursively splits the current multi-frame request
and retries; a single-frame request that still reaches the limit fails normally.
OpenScreen validates the call arguments locally and requires every supplied
representative ID exactly once without omissions, duplicates, or invented IDs.
Activity application names and window titles come from captured frame metadata,
not model-generated fields; a grouped activity omits a field when its sources
disagree or lack that metadata.

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
Each `ACTIVITY.md` projection is also checked for explicit `User stated`,
`User asked`, `User chose`, `User approved`, and `User replied` observation
phrases. Matches are logged as counts in the private Memory diagnostics log;
unchanged flagged projections are logged only once per runtime instance to
avoid filling the capped log. The projection is not altered. Eval reports the fraction of screen observation
nonempty lines matching these phrases. Matches are review signals, not
confirmed errors: verbatim quotations can trigger false positives, and this
narrow check cannot detect every source-attribution error.

`rollout_summaries/*.md` is the only place pre-compression detail survives,
because the observation processor discards raw messages once observed. Mastra
never prunes that directory, so the projector applies its own age-based prune to
`chronicle-*.md` files using `retention.chronicleRolloutMaxAgeMilliseconds`.
Turn rollouts follow pi Session lifecycle and are not pruned by this product.
Retention is age-based only; nothing tracks which rollouts a Memory answer used.

## Memory read path

For each prompt, the harness receives an optional temporary system-context
suffix containing the absolute Memory root, fixed trust and search rules, and
the complete current `MEMORY.md` and `ACTIVITY.md`. It is rebuilt into the
system prompt after each tool call and removed when the prompt ends, including
failure or cancellation; it is not persisted to the Session or reused by the
next prompt. The same lifetime applies to the current tool-security rule. Every
prompt also receives a tool-source rule, including requests without screen or
Memory context: tool outputs are attributed evidence, not user instructions,
decisions, or authorization. Assistant repetition does not promote a tool claim
into a user grant. Each reported fact must keep its supporting source; user
constraints must not be attributed to tool output, and mixed-source facts must
not be claimed to come from one tool. Trusted runtime approval receipts retain only their recorded
scope and lifetime. Relevant evidence can still guide the user's existing task,
including explicitly delegated procedures, without adding goals or permissions.
This rule is rebuilt for each prompt rather than persisted in Session
history. When
screen context is injected, an additional temporary rule treats its content as
source evidence, never as a user instruction, choice, or approval. Task goals
and constraints must come from actual user messages.
Because both Memory files are injected in full, the Agent is told not to
re-open them for content, and to grep or read a specific line only when it
needs a citation range. For detail beyond the
injected blocks — exact wording, tool output, code, or a time-bounded activity —
the Agent searches `rollout_summaries/` with the existing `grep`, `read`,
`find`, `ls`, and read-only `rg`/`sed` through `bash`. There is no dedicated
Memory tool and no direct access to the Mastra database.

Memory artifacts are untrusted historical data. Current user, system, and
project rules and verifiable current state take precedence; conflicting
observations are resolved by their own timestamps rather than file order, and
potentially stale facts must be verified or disclosed as historical. A plan whose
date has passed without recorded outcome evidence has an unknown outcome, not
an assumed completion or an invented pending task. When its outcome matters,
check current state or historical records; if verification is unavailable, state
that it is unknown rather than asking the user to resolve it. When Memory
content supports an answer, the model appends one `<oai-mem-citation>` JSON
block. Streaming and final user text remove the block. Validation accepts only
`MEMORY.md`, `ACTIVITY.md`, or one-level rollout files, actual `grep`/`read`
tool line ranges from the current Turn, and rollout IDs present in cited rollout
contents. Valid provenance is appended to the pi Session as an
`openscreen.memory-citation` custom entry; invalid provenance is discarded
without changing the answer. Bash output, including `grep -n`, is not tracked
as citation evidence. If the block is absent, an explicit inline
`MEMORY.md:line` or `ACTIVITY.md:line` reference in the final answer can create
the same entry only after the referenced line passes the same current-Turn read
and file validation. Citations do not pin retention.

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
All registered tools are always active; historical active-tool entries are
ignored and the product has no tool-switching command or UI.

Automatic compaction uses pi's `DEFAULT_COMPACTION_SETTINGS` and the configured
model's context window. It checks the last valid assistant usage after each
successful prompt. Manual compaction accepts optional instructions and is
available independently of that threshold. Both paths pass pi an additional
provenance instruction: user messages define task goals and constraints, while
tool output is source-attributed evidence and must not supply an unspecified
task target or imply task progress. When the target is unspecified, background
tool output must not supply its input format, schema, or implementation rules.
Manual instructions are appended after this rule. The Session-local completion
wrapper also appends it to every compaction request's system prompt, including
pi's split-turn prefix summary. A fragment without a new user task must not be
treated as evidence that the whole conversation has no task. Pi's built-in
summary prompts and compactor remain in use. When an original task is absent
from a fragment, the rule calls it not visible in that fragment rather than
globally unspecified. Summaries must preserve each fact's stated role and must
not add restrictions or conditions to the user's permitted actions.
This reduces, but does not
eliminate, the risk of model inference errors.

Compaction is awaited inside its owning Application execution: automatic
compaction belongs to the prompt, while a manual `compact` request has its own
cancellable execution. Cancel or shutdown propagates that owner's signal to
both pi history-summary and split-turn-prefix requests. A cancelled queued
compaction makes no model request. The adapter uses a Session-local model facade
to wrap `completeSimple` only during compaction, without mutating the shared
model registry. Pi's default `AgentHarness.compact` still owns preparation,
history and split-turn summaries, checkpoint metadata, and persistence.
Normal checkpoints are not marked `fromHook`, so Pi carries cumulative read and
modified file lists into subsequent compactions, including after reopening.
A `session_before_compact` guard checks cancellation without supplying a custom
summary. A storage dispatch guard checks cancellation
after pi's asynchronous hook and entry-ID preparation, before appending a
checkpoint. Pi's filesystem append has no cancellation signal: once a checkpoint
has been dispatched to storage, it can still persist after cancellation and is
not rolled back. A cancelled request therefore does not guarantee that the
Session contains no new checkpoint when cancellation raced an in-flight append.
Cancelled owners report `failed` with code `aborted` and a cancelled Turn trace,
never a subsequent successful compaction or request completion. An answer
already delivered before cancellation remains visible.

This follows Codex's
[Task-owned cancellation](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/tasks/mod.rs#L911)
and [awaited compaction](https://github.com/openai/codex/blob/67727e7cf114cf3e1b71db368d74b24e32f6cb12/codex-rs/core/src/tasks/compact.rs).
Codex can abort its Tokio Task after a 100 ms grace period. Node.js Promises
cannot be forcibly dropped in the same way: this adapter aborts the model
request signal and rejects its local await, fencing late transport results so
they cannot start a prefix request or write a checkpoint. It does not guarantee
that an uncooperative transport, arbitrary hook, or remote inference has stopped,
and does not emulate a 100 ms hard Task abort by killing the shared runtime.

## System tools

The production tool set contains twelve pi `AgentTool` implementations:

| Tool | Implemented behavior |
| --- | --- |
| `read` | Reads UTF-8 text with a 1-indexed offset, optional line limit, and continuation notice. |
| `ls` | Lists a directory alphabetically, including dotfiles and directory suffixes. |
| `grep` | Searches file content with the packaged ripgrep binary and ignore-file semantics. |
| `find` | Finds sorted paths with ripgrep glob and ignore-file semantics. |
| `write` | Creates or completely replaces a UTF-8 file and parent directories. |
| `edit` | Applies unique, non-overlapping exact-text replacements to one file. |
| `bash` | Executes a shell command with merged, bounded stdout/stderr and an optional timeout; `host: true` requests a one-time approved host run. |
| `desktop_windows` | Lists up to 100 visible desktop windows through the in-process Cua Driver SDK; window IDs are returned as strings, app names and titles are capped at 200 characters, and no approval is required for this read-only call. |
| `desktop_window_state` | Reads a specific PID and window ID through the same driver, without approval or a desktop change. The accessibility walk is limited to 100 elements, depth 8, and one second; returned tree text is capped at 20,000 characters and elements at 100. A fresh window screenshot is requested at up to 1,200 pixels on the long edge and returned when valid and within an 8 MB encoded limit. Degraded accessibility is reported explicitly. |
| `desktop_click` | Clicks in the last observed exact window using background delivery. The first action in an application requests chat-scoped approval with its identity and a window screenshot. Coordinates use screenshot pixels or a refreshed accessibility element token. The runtime rechecks window and app identity before dispatch and observes the window afterward. An explicitly unsupported AXPress element click can fall back to a freshly checked window-local coordinate click. |
| `desktop_scroll` | Scrolls in the last observed exact window under the same app grant. Coordinates are window-local; direction, line/page unit, and amount (1–20) are bounded. It uses the same window recheck and post-action observation as a click. |
| `desktop_type` | Types into an observed accessibility text element under the same app grant. The approval does not show the proposed text. It establishes background focus through the guarded routes below, types in bounded segments through Cua Driver, and checks the field value and selection after each segment. |

The desktop driver is created lazily in the runtime child on the first window
observation and shut down with the runtime. If the driver or macOS permission is
unavailable, these tools fail without granting host Bash or changing the desktop.
The app-granted background typing path and native focus helper have been
exercised from local Node and Electron Node-mode processes against a temporary
AppKit test window on the real desktop, without a foreground change in those
checks. A separate background Electron test host has also exercised the
production `AgentClient` -> `runtime/dist/main.js` path with the configured real
model, application approval, native focus guard, and persisted Session audit.
This verifies that launch chain on the tested machine, not support for every
application or a fresh machine's permission setup.

An observation ID is usable only in its prompt and for the latest window state;
it expires 30 seconds after capture and is consumed by a desktop action attempt.
An action cannot proceed without a valid screenshot, and coordinates must fit
inside it.
After approval, a changed window identity or application, invalid screenshot,
or missing unique accessibility element stops dispatch and requires a new
observation. A grant applies to the selected application for the current
runtime Session; denial blocks another request for that app in that Session.
OpenScreen's own process is excluded before approval. Grants are in memory and
are lost when the runtime exits; there is currently no Session deletion or
explicit chat-end command.
These are application-level grants only: they never change macOS Screen
Recording or Accessibility permissions, and there is no persistent Always-allow
grant. Switching chats, finishing an answer, or cancelling a Turn does not
clear the existing Session's application decision.
Click uses `background` delivery only; scroll and
type use the driver's window-targeted route, which does not expose a delivery
mode in the pinned SDK. These routes do not automatically retry in foreground
mode, but foreground noninterference is not guaranteed for arbitrary applications.
For an element click, only the driver's explicit unsupported-AXPress refusal
permits one background coordinate retry. Before retrying, the runtime reobserves
the same window and application, requires one unchanged matching element and a
valid screenshot, and converts that element's current global frame into
window-local screenshot pixels. Cancellation, changed or ambiguous targets,
invalid bounds, and all other driver errors stop the retry. Coordinate clicks
requested directly do not take this fallback path.
All three SDK action adapters reject a receipt that explicitly reports foreground
delivery or the global-input route. The security layer records that post-dispatch exception as uncertain,
not a successful commit. This check cannot undo input or a foreground change
that already occurred. Missing, unknown, or not-applicable delivery metadata
retains the existing action-effect handling and is not proof of background delivery.
A driver exception after dispatch is
recorded as uncertain rather than claiming the click failed harmlessly. A
successful driver return records the action as executed, not proof that the
intended UI outcome occurred. The post-action observation helps the Agent
verify that outcome. Each approval target records the SHA-256 digest of the
preview screenshot bytes without embedding the screenshot in the audit entry.
Every committed desktop action has its own audit event with app and window
identity, action details, and, for typing, only text length and SHA-256 digest.

Text input is restricted to observed, enabled text roles with a frame. Focus
first uses an AXPress-based element-token click. Only an explicit unsupported
AXPress error permits a fresh target recheck followed by the native helper
setting `AXFocused`, when that attribute is settable. If that route is explicitly
unsupported, another recheck permits a background coordinate click at the
input's center, converted from current global bounds into screenshot pixels.
That recheck also verifies the bound native element and unchanged native value
before dispatch; it does not require the element to be focused yet.
Missing or ambiguous bounds, changed targets, cancellation, unknown driver
errors, and unverifiable native focus stop the action instead of advancing to
another route. There is no foreground retry. The
native helper first binds the exact input element to its PID, window ID, role,
label, and global frame, retaining a native value baseline before focus changes.
It checks that same element and native value when arming observation; Cua's
displayed value is not used as the native baseline because it can be a placeholder.
It then requires a readable value and selection during input. Secure fields are
not categorically blocked, but fields without readable values fail closed.
A focus-change notification, element mismatch, or value/selection
mismatch stops further text segments and records the action as uncertain.
Before each segment, the runtime rechecks cancellation and requires the value
and selection to match the previous verified state; user edits are not adopted
as a new typing baseline. This
does not make input atomic: text already entered, form submissions caused by
line breaks, or a very brief focus change between checks cannot be undone or
completely excluded. If Accessibility does not expose the necessary field
attributes, the action fails instead of typing without verification.

Relative paths resolve from the directory where the Agent was launched and
absolute paths are accepted. In production, each prompt receives a private
`task-outputs/<id>/` directory. Read tools can inspect files broadly under the
current user account. Default Bash uses macOS `sandbox-exec` with broad local
reads, writes restricted to that output directory and `/dev/null`, and network
denied. The profile does not grant unrestricted Mach service lookup. On a local
macOS host, opt-in probes confirmed that sandboxed Cua Driver and direct
CoreGraphics pointer movement were blocked; this does not prove every desktop
IPC route is isolated. These global-pointer diagnostics include host actions
that move and restore the real cursor. After building the runtime tests, run
them only on an isolated macOS GUI desktop that does not share the user's
input session, with
`OPENSCREEN_DESKTOP_SECURITY_PROBE=1 OPENSCREEN_ISOLATED_DESKTOP=1 node --test runtime/dist-test/tests/security/sandboxed-shell.test.js`.
Both flags are required; the isolation flag is an operator declaration, not
automatic isolation detection or provisioning. A separate terminal, process,
or temporary directory does not isolate a desktop. The background fixture
tests described below remain separate and do not require these flags.
The Bash child does not inherit provider credential values from the runtime
environment. There is no secret-path blacklist: local secrets remain
readable under the current user's permissions and could enter tool output or
later model requests.

Before each default Bash command, the runtime inspects the output tree and
rejects execution if a file has hard links outside that tree; links wholly
inside the tree remain usable. The file worker opens the destination without
following a leaf symlink and rejects a file with multiple hard links before
writing. These checks cover pre-existing hard-link aliases, but a different
process running as the same user could race the Bash preflight or create a new
hard link after the worker's check. This is not isolation from hostile
concurrent processes under the same macOS account.

`write` and `edit` run their filesystem change in a separate sandboxed Node
worker, not directly from the Agent process. Changes under the output
directory need no approval. The runtime resolves file and parent symlinks before
deciding whether a change is inside that directory; a dangling symlink is
rejected. For another path, it pauses and asks for
one approval bound to the tool call, resolved destination path, complete
proposed content, and observed source state. If a parent symlink changes after
approval, the request remains bound to the displayed destination; if its
canonical parent becomes a symlink, the worker rejects the write. If source
content changes while approval is pending, the worker also rejects it. Approved
changes are written to a sibling staging file before publication, so a failed
or cancelled stage write does not partially replace the original. For an
approved new file, publication fails atomically if another process creates the
target first. Existing-file replacements recheck the approved source immediately
before rename, but cannot exclude a same-user writer racing that final check.
An approved file change allows only that path;
missing parent directories outside the output root are not created implicitly.
The Agent must call `write` or `edit` to start this approval flow; asking for
permission only in chat creates no pending request. After a committed approved
file change, the tool result includes a runtime-generated approval statement so
the Agent can report the authorization accurately. If the Agent mentions
authorization in its final answer, the prompt-only tool rule requires it to
explicitly attribute the action to the user's one-time approval (for example,
"your one-time approval"), not actor-less approval wording or automatic runtime
authorization. An answer that does not mention authorization is not required
to restate approval. The same conditional attribution rule applies to
intermediate user-visible messages; approval does not have to be mentioned.

`bash` may request a host run with `host: true` before any sandboxed attempt.
That pauses for approval of the exact command and then executes it once with
the user's normal filesystem and network access. Host shell environment values
are scrubbed, but this does not protect credential files from being read.
An approved command can perform multiple desktop actions and start background
tasks that continue after the command returns. The approval covers the displayed
command and work it initiates, not another Agent host command; OpenScreen does
not track or terminate every descendant or launchd task it starts.
There are no standing grants, command-prefix allowlists, risk scores, or
task-inferred permissions. Rejected requests do not execute; cancellation and
runtime shutdown invalidate pending approvals. Prior completed side effects
are not rolled back. On systems without the macOS sandbox, tool changes and
default Bash fail closed instead of falling back to unrestricted execution.
After a host command executes, its tool result includes a runtime-generated
one-time approval receipt. A nonzero exit is still reported as a failed command;
the receipt says it ran, not that it succeeded. If host execution times out or
is aborted, its effects may be unknown. The runtime records an uncertain
execution event instead of a commit and the tool error warns the Agent to check
side effects before retrying.

`write`, `edit`, `bash`, and the desktop tools declare sequential execution. pi schedules tools
according to their execution mode.

General visible output uses pi's 2,000-line / 50 KiB bound. `grep` and `find`
also bound captured search records to 40 KiB before product formatting and
report when the result count or byte cap was reached. If pi truncates shell
output, the full-output log is written by the sandboxed file worker under that
prompt's task-output directory, and its path may appear in tool details.

## Capture integration

Capture has two backends with two jobs. The native backend answers prompts by
reading the screen live; the Screenpipe recorder keeps the background activity
history the Chronicle feeds on. They share the neutral `CapturedFrame` shape in
`capture/api.ts` and know nothing of each other.

### Native capture

`runtime/src/capture/native/main.swift` builds to
`runtime/bin/openscreen-capture` through `npm run build:native`, which
`npm run dev` runs first. The shared script is `runtime/scripts/build-native.mjs`;
it also builds the Desktop helper from `runtime/src/desktop/native/` to
`runtime/bin/openscreen-ax-focus`. Both binaries are Git-ignored. The capture
helper is a plain executable rather than a Node addon, so it needs no toolchain beyond the Swift compiler in
the Xcode command line tools and no rebuild when Electron's ABI moves.

One run photographs every display through ScreenCaptureKit at the display's
logical size and JPEG quality 0.6 -- about 200 KB and 120 ms for a 1470x956
display, legible enough to read interface text -- and walks the focused window's
accessibility tree, bounded at 400 nodes and 8,000 characters. The window's
identity and text are attached to the display that window sits on and to no
other, because a frame that carried one window's text while showing a different
screen is exactly the failure this backend removes. OpenScreen's own windows are
cut out of the capture by bundle identifier, so the assistant can never be asked
about a screen that is mostly its own interface.

It needs Screen Recording and Accessibility permission. Without Accessibility
the screenshots still arrive and the text is omitted; a display that cannot be
photographed is dropped rather than sent empty. `capture.native.enabled`
disables the whole prompt-time read, and `OPENSCREEN_CAPTURE_HELPER` overrides
where the helper is found.

The Node service accepts a helper JPEG only at the exact
`display-<displayId>.jpg` path directly under that capture's scratch directory.
It rejects aliases and out-of-directory paths, opens the leaf with
`O_NOFOLLOW`, checks the JPEG signature, and discards invalid frames.

### Screenpipe recorder

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

The recorder no longer answers prompts. Its frames are written on its own
triggers -- a click, a typing pause, an idle heartbeat -- so the newest stored
row trails the moment the user asked by a median of about 2.5 seconds and can
name a window they have already left, and the only on-demand frame the SDK
offers is a 480x312 thumbnail with no text in it. The recorder now serves the
background activity history alone, through the incremental frame feed, which
still carries every row. Capture
validates the private canonical generation root, confines each JPEG path to that
root, opens the leaf with `O_NOFOLLOW`, validates its JPEG signature, and passes
aligned in-memory bytes to Application. Invalid or missing images are omitted.

Application emits ordered metadata and images only when `sourceId` alignment is
exact. It preserves source, generation, frame, monitor, and capture-time
provenance within one 12,000-character JSON budget; optional application,
window, URL, trigger, and visible text are added while space remains. The hidden
context is omitted from the visible transcript but pi persists it inline in the
Session, including Base64 image blocks.

`capture.screenpipe.enabled` controls only the recorder and Chronicle frame
feed. Prompt-time screen context is controlled independently by
`capture.native.enabled`. `@screenpipe/sdk` is pinned to an exact version because the reader
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
- `list_approvals` and `decide_approval`;
- `prompt` (text and optional new images) and `abort`;
- `compact`; and
- `set_thinking`.

Events cover Session responses, streaming answer and reasoning deltas,
tool start/update/finish, final answer and context usage, compaction,
approval request/decision/commit, state updates, abort acknowledgement, and one terminal result. A commit event carries the approval and tool-call IDs, tool name, and approved target; it follows the one-time decision only after a file change is published or an approved host command returns an execution result. For host Bash, commit means the command ran, not that its exit code was zero. Unknown commands,
unknown fields, and malformed values are rejected instead of being ignored.

Transport contains no pi or Capture logic. Application contains no JSON parser
or stream framing logic.

Desktop approval targets are typed objects in the product protocol and internal
events, including application identity and action-specific fields. File paths
and host commands remain string targets. Session approval custom entries and
Eval security archives serialize desktop targets as JSON strings at their write
boundaries, retaining their existing stored format.

## Developer diagnostics

The hierarchy is Session/Thread -> Turn -> Inference and Tool Call, with approvals
bound to tool calls. A prompt Turn starts before Capture
and ends after Agent execution and automatic compaction checks; a manual
`compact` request also gets its own Turn trace and compaction phase. Multiple model
requests belong to the same Turn. There is no independent Run execution model.
Session IDs remain the product's thread identity; each Turn has its own UUID and
records the product request ID. No frontend page or product event schema is added.

This adapts the actual source at Codex commit
[`1fc8d548077fc72c4e3d048a78173af07385217f`](https://github.com/openai/codex/tree/1fc8d548077fc72c4e3d048a78173af07385217f),
not the older Task/Turn terminology in its protocol overview. The compared
structures and execution boundaries are:

| Area | Codex source | OpenScreen implementation and necessary differences |
| --- | --- | --- |
| Thread, Turn, Item | [Protocol](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/protocol/src/protocol.rs) and [raw trace events](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/rollout-trace/src/raw_event.rs) | One loaded Session owns a thread trace; each prompt starts a Turn. pi messages and tool results remain the existing history items rather than creating a duplicate Item store. |
| Inference | [Inference reducer](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/rollout-trace/src/reducer/inference.rs) | A UUID identifies each observed pi provider request, with token usage, stop reason, and observed transport request ID. Hidden SDK transport attempts and Responses API response IDs are not invented. |
| Tool dispatch and command execution | [Raw events](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/rollout-trace/src/raw_event.rs) | Tool dispatch has its own start/end; Bash execution emits separate runtime start/end for each observed attempt. The trace tool UUID is distinct from the model-visible call ID, and its originating inference is recorded when exposed by pi. |
| Approval | [Session state](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/core/src/session/mod.rs) | Requests, decisions, and commits bind approval ID to call ID and Turn. Cancellation is `abort`, not denial; reused application approval is marked `session` without a new request. Existing Session approval custom entries remain authoritative history. |
| Sandbox, host, retry, escalation | [Tool orchestrator](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/core/src/tools/orchestrator.rs) | OpenScreen retains its on-request policy: ordinary Bash uses macOS Seatbelt; explicit `host: true` requires approval. No automatic host escalation is added. Further model-requested calls receive distinct tool/attempt IDs; unobserved retries are not reconstructed. |
| Wait and execution duration | [Turn timing](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/core/src/turn_timing.rs) | Durations use a monotonic clock. Approval wait is measured separately; overlapping waits are unioned for Turn totals. Command duration measures the actual backend attempt after approval, including sandbox preflight, not subprocess CPU time. |
| Cancel, timeout, failure, interruption | [Inference reducer](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/rollout-trace/src/reducer/inference.rs) | Observed cancellations differ from failure and denial. The reader closes running inference windows at owner end without forging raw provider completions. Tools with no terminal result remain unfinished. Bash timeouts and typed execution errors retain their codes; the execution dependency does not expose exact signals or process IDs. |
| Concurrency and identity | [Trace writer](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/rollout-trace/src/writer.rs) | One writer orders all Turns in a thread activation. Parallel tools correlate by call/attempt IDs, not their most recent global model event. Production still accepts one active prompt per Session and independent prompts across Sessions. |
| JSONL history vs tracing and telemetry | [Rollout persistence policy](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/rollout/src/policy.rs), [trace writer](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/rollout-trace/src/writer.rs), and [tool-result telemetry](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/otel/src/tool_result.rs) | Contentful pi Session history stays separate. Local trace bundles retain the raw-event/ref structure but only metadata. Safe tool-result metadata includes process-wide result order and argument/output byte counts; no remote OTel exporter is introduced. |
| Local diagnostics CLI | [Raw trace format](https://github.com/openai/codex/blob/1fc8d548077fc72c4e3d048a78173af07385217f/codex-rs/rollout-trace/src/raw_event.rs) | `diagnostics` is an OpenScreen read-only viewer/reducer, not a copied Codex command or a second persistence layer. |

Each thread activation produces `manifest.json`, an append-only `trace.jsonl`, and
referenced `payloads/N.json` files. Payloads are written before the event that
references them. Events use the source's schema-version, writer-global sequence,
wall-time, rollout/thread/Turn envelope, and typed lifecycle payloads. The reader
validates sequence, payload paths and references, Turn ownership, tool IDs,
inference parents, and approval/command correlations before reducing them.
Per-Turn sequences can have gaps because other Turns share the writer.

Capture, Agent, and compaction checks use explicit `other` phase observations.
The compaction adapter records a distinct inference ID and duration for each
history-summary and split-turn-prefix request under the owning Turn, with usage
and stop reason only when a response is observed. Cancelled local awaits do not
invent provider completions; the reader closes their running inference windows
at owner end. Compaction's non-streaming API does not expose first-token timing
or transport response IDs. First-token timing for the prompt starts at the first text/reasoning delta or
completed tool-call event, not streamed tool argument fragments. A provider stop
reason of `length` means a completed but truncated response, not interruption.
Tool dispatch duration includes approval wait; `dispatch_active_ms` subtracts
that wait but still includes validation and scheduling. Turn `active_ms` is total
time minus the union of approval waits. Neither field is actual Bash execution
time; use `exec_command_end.duration_ms` for that.

The trace stores IDs, tool/provider/model names, token and byte counts, timing,
statuses, stable error codes, and necessary approval identity metadata. Approval
targets are hashed; desktop targets additionally retain Bundle ID, PID, and
numeric window ID. It does not copy prompts, model content, arguments, outputs,
screenshots, typed text, complete Bash commands, or raw exception messages.
Generic tool failures use `tool_error`; actual refusals use `approval_denied`,
and command failures retain nonzero exit codes or typed execution errors.
Inspect the existing Session using thread and call IDs for detailed error text.
This content boundary does not redact Session history.

These are deliberately metadata-only, always-enabled local bundles, unlike
Codex's opt-in raw payload capture. The manifest records this difference. They
are not full Codex replay artifacts or a complete implementation of its graph,
multi-agent, code-mode, MCP, PTY, or remote compaction tracing. Existing product
and security boundaries are unchanged.

Bundles live under `diagnostics/traces/trace-<uuid>-<thread-hash>/` in the Node data
root. Reopening a Session in a new process produces a new activation bundle.
New directories use `0700`; files use exclusive creation and `0600`. Each thread
writer queues I/O without blocking execution. A write failure disables that
writer and emits one content-free warning, without failing the task. Normal
shutdown aborts unfinished Turn owners, ends the thread/rollout, and waits for
queued writes. A partial final JSONL line is ignored and marked at the bundle
level without making earlier, fully ended Turns incomplete. Cancellation observed
after approval but before Bash dispatch records a cancelled tool, without inventing
a command attempt or an uncertain execution. Missing terminal evidence
or unresolved tool attempts means an unfinished trace, never inferred completion.
Old `diagnostics/runs/` files are untouched and are not read by the new viewer.
Bundles currently have no automatic retention or deletion UI.

Build once, then query from the repository root:

```bash
npm run build:runtime
npm run diagnostics -- list
npm run diagnostics -- list --session SESSION_ID
npm run diagnostics -- show TURN_ID
npm run diagnostics -- show TURN_ID --json
npm run diagnostics -- --help
```

The command uses `OPENSCREEN_DATA_DIR/diagnostics/traces`, or the default
OpenScreen data root. `--root DIRECTORY` selects the bundle parent directory.
`list --json` emits summaries; `show --json` includes ordered raw records,
referenced metadata payloads, reduced inference/tool windows, and completion
metadata. Invalid Turn IDs and malformed complete records fail the query rather
than silently changing diagnostic evidence.

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

- `native.enabled` for live prompt-time screen context;
- `screenpipe.enabled` for the recorder and Chronicle feed;
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
windows with 15 seconds grace and at most ten representative frames per request.

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
| `OPENSCREEN_APP_PID` | Electron's own process ID, passed to its runtime child so Computer Use refuses OpenScreen windows. |

## Persistence and failure behavior

The default data root is
`~/Library/Application Support/OpenScreen/`. `OPENSCREEN_DATA_DIR` replaces that
entire Node data root. The Electron main process keeps managed PNG copies of
uploaded or pasted images under `user-attachments/` inside that same data root,
so `OPENSCREEN_DATA_DIR` relocates them along with everything else.

Per-prompt output directories live under `task-outputs/` in the same data
root. They remain after a prompt completes and currently have no automatic
pruning or deletion UI.

Thread operational trace bundles live under `diagnostics/traces/`; see
[Developer diagnostics](#developer-diagnostics) for their content boundary,
timing semantics, commands, and incomplete-file handling.

pi stores Sessions below `sessions/`, grouped by an encoded launch working
directory. Each Session is one append-only JSONL file containing its header,
messages, tool results, thinking changes, compaction summaries, labels, and pi
bookkeeping. Security approval request, decision, and commit events are also
appended as custom entries before their corresponding UI events. Requests record
the approval and tool-call IDs, target, and hashes of proposed or expected file
content rather than duplicating that content in the audit entry. A commit entry
records that the side effect occurred; a committed host command may still exit
nonzero. A failure to persist a request or decision prevents the corresponding
tool action from starting. A commit-persistence failure occurs after the side
effect and cannot undo it; the tool reports the completed action together with
an audit warning instead of calling the action itself a failure. Timed-out or
aborted host execution is recorded separately as uncertain when the command
may have started.
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
`screenpipe/generations/<generation-id>/`. Request Capture instead reads new
native-helper JPEGs from a private temporary directory, removes those scratch
files after loading, and pi persists the injected bytes as Base64 in the Session
JSONL. Memory stores no image data of its own: it keeps only the
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

The composition root first attempts to start the independent Screenpipe
recorder. Memory then opens its cursor database, resolves the observation model
before constructing the LibSQL store, and projects existing observation logs
without making model requests. Failed initialization closes already opened
Memory handles; a missing API key does not leave a LibSQL handle behind while
the lifecycle retries. Application starts its prompt Capture service and
transport begins accepting commands. The
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

### Model evaluations

The general Agent, file/Bash Security, and desktop Security suites run the
configured model through production services. Deterministic checks and offline
semantic judgments remain separate; the refactor does not change their rubrics.
See [Model evaluations](evals/README.md) for datasets, execution boundaries,
commands, evidence preparation, scoring, and opt-in desktop integration checks.

The execution flows live in `evals/workloads/`; snapshots and path confinement
live in `evals/workspace.ts`, and artifact checks in `evals/verification.ts`.
Cross-component desktop smoke harnesses live in
`tests/integration/desktop/` at the repository root.
Native-only AX and focus-policy tests live under `runtime/tests/desktop/native/`.
After building the helpers, run them from the repository root:

```bash
npm run build:native
node --test runtime/tests/desktop/native/*.test.mjs
```

### Runtime tests

From the repository root:

```bash
npm run test:runtime
```

The command builds the production Agent, builds the test target, and runs all
compiled TypeScript tests recursively. Changes to the product protocol also require the
frontend suites:

```bash
npm run typecheck:app
npm run test:app
```
