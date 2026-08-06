# OpenScreen Agent

The OpenScreen Agent is the local Node.js process behind the macOS app. It
owns model requests, the Agent Loop, session persistence, context compaction,
and the background memory pipeline. See the [project README](../README.md) for
product setup, requirements, privacy, and current limitations.

## Source layout

```text
src/
├── process.ts                 JSONL transport, dispatch, and concurrency
├── loop.ts                    model and tool execution loop
├── types.ts                   shared Agent Loop and stream types
├── config.ts                  runtime configuration loading and validation
├── protocol.ts                wire request parsing and response serialization
├── extensions/
│   └── screen-observation/    hosted macOS observation capability
├── tools/
│   └── retrieve-memory/       model-facing retrieval contract
└── harness/
    ├── session/
    │   ├── runner.ts          one chat command lifecycle
    │   ├── context.ts         model context construction
    │   ├── events.ts          persisted events, validation, and replay
    │   ├── store.ts           session file operations
    │   ├── lock.ts            per-session concurrency lock
    │   └── types.ts           session domain types
    ├── compaction/            retained-context compaction and summaries
    └── memory/
        ├── db/                SQLite connection, schema, attempts, helpers
        ├── evidence.ts        structured/JPEG Observation evidence and cleanup
        ├── chronicle/         passive screen activity organization
        ├── turn-memory/       terminal Turn extraction and Session scan progress
        ├── read/              bounded chat-facing Memory summary loading
        ├── shared/            request, job, budget, and source-snapshot contracts
        ├── consolidate/       global merge, publication, Git baseline
        ├── worker/            independent role-specific Worker orchestration
        └── types.ts           current long-term-memory contract
```

`process.ts` communicates with the Swift process through JSON Lines on
standard input and output. `protocol.ts` owns that wire format; harness code
does not depend on it. Chat requests are mapped to session commands before
entering `session/runner.ts`, which builds model context and invokes
`loop.ts`. Chronicle, Turn Memory, and Global Memory Consolidation each run in
their own background Worker Thread and are not connected to the production tool
registry. A slow Chronicle request therefore cannot delay Turn Memory work.

## Domain boundaries

The Agent is the composition center, but each capability owns its domain:

- A `Turn` is one user interaction and its user-visible outcome.
- An `AgentRun` is one execution attempt for a Turn. It has an independent ID,
  refers to its Turn through `turnId`, and owns model steps and tool results. A
  Turn may have zero or more Agent Runs.
- A conversation summary belongs only to retained model context. It is not an
  activity record or long-term memory.
- `ScreenObservationExtension` is a hosted background extension. It owns native
  observation lifecycle and emits canonical `ScreenObservation` values. It is
  not callable by the model and is not an `AgentTool`.
- A Chronicle activity is a factual description derived only from passive
  Observation source IDs. Chronicle cannot create a raw Memory candidate.
- A Turn Memory extraction belongs only to a closed batch of terminal Turns and
  contains exactly `raw_memory`, `turn_summary`, and `turn_slug`.
- `LongTermMemory` is current synthesized knowledge supported by immutable
  Chronicle or Turn Memory source snapshots. Conflicting or removed evidence
  rewrites the current block; the pipeline does not retain Memory versions.
- Model-initiated retrieval is an Agent Tool boundary under
  `tools/retrieve-memory`. Memory owns the data being queried; the Tool owns
  the model-facing arguments and results.

Runtime status remains local to its owner: session owns Turn and Run status,
the observation extension owns helper health, memory owns processing outcomes,
and `process.ts` keeps request queues and abort controllers private. There is
no shared runtime snapshot or centralized contracts directory.

## Runtime configuration

Non-secret defaults live in the repository-level
[`config.json`](../config.json). `OPENAI_API_KEY` is required from the process
environment or `.env`. `OPENAI_MODEL` and `OPENAI_BASE_URL` can override the
provider fields. Context, Session, and Memory model-token settings support
explicit environment-variable overrides, while [`.env.example`](../.env.example)
intentionally shows only the three common provider variables. Scheduling,
retry, and retention policy is configured in JSON so there is one visible
source of truth.

Configuration is grouped by responsibility:

- `context`: model window, compaction threshold, retained context, output
  budgets, and minimum recent turns.
- `session`: streaming event flush size and interval.
- `memory.worker`: background interval, per-tick work limit, lease, heartbeat,
  retry delay, attempt limit, and expired-lease limit.
- `memory.chronicle`: Chronicle model budgets, Observation windows, grace, and
  sources per request.
- `memory.turnMemory`: Turn extraction budgets and idle/hard-cap boundaries.
- `memory.consolidation`: model budgets, selected-source cap, and success cooldown.
- `memory.evidence`: structured/JPEG retention, abandoned-file grace, and disk cap.

Configuration is loaded once when the Agent process starts. Invalid,
incomplete, or internally inconsistent values stop startup with an explicit
error.

## Persistence

Sessions are stored as one append-only JSONL file per session. `store.ts`
owns file I/O, while `events.ts` owns event validation and replay. The header
contains session metadata; subsequent records represent turn lifecycle
events, streamed text, Agent Run steps, tool results, and compaction.

The Session JSONL remains the fact source for Turns. Replay exposes a separate
recorded-Turn view containing completed, failed, cancelled, and interrupted
Turns; interrupted Turns stay outside future chat context but are still valid
Turn Memory evidence. The Memory Worker stores each Session file version and
scan outcome in SQLite. Unchanged valid files are not reparsed every minute;
unchanged invalid files are reported once and skipped across restarts. Startup
still performs the one-time interrupted-Turn recovery pass.

## Chronicle and memory persistence

The single memory root is
`~/Library/Application Support/OpenScreen/memory/` by default:

```text
memory/
├── memory.sqlite3
├── evidence/
│   ├── structured/
│   └── screenshots/
├── MEMORY.md
├── memory_summary.md
├── raw_memories.md
├── rollout_summaries/
└── .git/
```

`OPENSCREEN_DATA_DIR` keeps its existing meaning as the Session directory; its
parent becomes the data root for memory. `OPENSCREEN_MEMORY_DIR` can override
only the memory root. That override must point to a dedicated directory.
OpenScreen marks the directory and creates its own nested Git repository; it
refuses to adopt an enclosing repository or an existing user-owned repository.

At the start of each chat Turn, the Agent reads only `memory_summary.md` and
adds it before the conversation summary as developer context. The summary is
limited to 2,500 locally estimated tokens and the complete request still passes
through normal token budgeting. Missing or unreadable Memory does not block
chat. `MEMORY.md`, `raw_memories.md`, rollout summaries, Observation evidence,
screenshots, and AX content are never automatically loaded into chat context.

SQLite is the structured truth for Chronicle sources/windows/activities, Turn
sources/batches/extractions, producer jobs, durable Session scan progress,
model-attempt audits, Consolidation job
state, ownership tokens, watermarks, publication recovery, and evidence links.
Connections enable foreign keys, WAL, a five-second busy timeout, and immediate
write transactions. The directory is mode `0700` and the database is mode
`0600`. The coordinator initializes the database before spawning the Chronicle,
Turn Memory, and Consolidation Worker Threads; runtime processing is confined
to those role-specific Workers.

Observation evidence is atomically written before the source row: a mode-`0600`
JSON file without Base64 and a separate mode-`0600` JPEG. Chronicle requests use
only the compact SQLite projection and never load either sidecar. JPEGs expire
after 24 hours; structured evidence expires after 24 hours on success or seven
days on failure. Cleanup also removes abandoned files after one hour and evicts
the oldest Observation groups when the default 2 GiB cap is exceeded. Turn
evidence remains in Session JSONL instead of being duplicated.

Producer timing and input rules are deterministic:

- Observations use closed UTC one-minute windows, become eligible 15 seconds
  after the window ends, and send no more than ten sources per request. A late
  Observation increments the processing generation, fences any old worker, and
  replaces the current result after a successful retry.
- Terminal Turns from the same Session accumulate until 30 minutes of idle
  time, a two-hour hard cap, or the effective Turn Memory context budget.
  The prospective complete batch is measured before each Turn is added. The
  Provider `/responses/input_tokens` result is used when valid; an unsupported,
  failed, or impossible zero count falls back to the Codex-compatible local
  estimate `ceil(UTF-8 request bytes / 4)`. If the new Turn would exceed the
  budget, the existing batch is sealed without it and the Turn is measured
  again in a new batch. Splits occur only between complete Turns. New Turns
  arriving after a batch is sealed belong to the next batch.
- Observation requests include only IDs, times, application/bundle/window,
  URL, focused-element facts, and visible text. Turn requests include IDs,
  times, code-owned status, user text, final assistant text, and compact tool
  names/results. Neither request includes reasoning, streaming deltas, response
  protocol fields, screenshots, full AX trees, or duplicate output items.
- Every model generation is budgeted before it starts. Turn Memory uses at most
  70% of the model window and also reserves the configured output budget. An
  oversized single source becomes a persisted retryable error; it is not
  discarded and does not produce a heuristic content fallback.

Chronicle output must cover every input source exactly once and may not invent a
source. Generated summaries are English; quoted evidence retains its source
language. Chronicle describes what happened and cannot emit `raw_memory`.
Durable memory is limited to
explicit, stable user facts, preferences, long-term goals, project decisions,
or lasting state. Greetings, model-capability questions, concept explanations,
temporary errors, assistant-only suggestions, ordinary browsing, and one-off
actions are skipped. A single
passive screen observation cannot establish a preference, and an unsuccessful
Turn cannot prove success.

Consolidation follows the Codex global-consolidation pattern. SQLite contains
one global job. A worker claims a one-hour lease and
heartbeats every 90 seconds. Failures wait one hour and have three attempts.
Lease expiry is tracked separately from model failure: after three consecutive
abandoned leases the job waits one hour before another owner may try, without
consuming the model-failure attempts. These are the defaults under
`memory.worker`, and both producers use the same job settings. Worker startup and
timer failures are written to stderr. After success, new input waits for the
default six-hour cooldown from `memory.consolidation`. The claim snapshots an
input watermark and copies the corresponding generic source rows and evidence links,
so replacements arriving during a run remain pending for the next run without
changing the active request.

Before consolidation, Chronicle and Turn summaries are synchronized to
`rollout_summaries/`; only Turn extractions with non-empty `raw_memory` are
eligible for consolidation and only those values enter `raw_memories.md`.
SQLite retains the previous successful selection, so the next immutable
snapshot explicitly marks sources as added, retained, or removed. A one-commit disposable Git repository
provides the real change set; SQLite, WAL, evidence, and publication staging
are ignored. No Git change with valid artifacts completes without a model call.
Otherwise Consolidation sends the complete diff plus current memory and applies exact
token counting; an oversized request becomes a retryable error instead of
silently truncating evidence. It validates a structured full-memory result and
stages both output files. Final file replacement, Git baseline recreation, and
SQLite completion run under one short cross-process write lock, preventing an
expired worker from publishing after a replacement takes ownership. The summary
always begins with `v1`. A publication journal and Git baseline recover a crash
between the file and database updates. The baseline is a diff mechanism rather
than memory history; after replacement, its reflog and unreachable objects are
pruned so superseded memory is not retained as hidden Git history.

Memory uses one physical root. Scopes are logical values: global, application,
web domain, document, project, workflow, person, organization, and topic.
Screen evidence can therefore produce application, site, document, person, or
workflow memory without pretending everything is a coding project. Project
scope requires explicit project evidence. Memory records learned context and
does not replace fixed project rules in files such as `AGENTS.md` or `README.md`.

Retrieval, Agent Tools, chat Capture fusion, UI controls, additional secret
redaction, heuristic fallback, and memory-version history are outside this
pipeline.

## Tests

From the repository root:

```bash
npm run test:agent
```

The command builds the production Agent, builds the test target, and runs the
Node.js test suite.
