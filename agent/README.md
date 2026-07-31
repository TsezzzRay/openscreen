# OpenScreen Agent

The OpenScreen Agent is the local Node.js process behind the macOS app. It
owns model requests, the Agent Loop, session persistence, context compaction,
and the activity-memory core. See the [project README](../README.md) for
product setup, requirements, privacy, and current limitations.

## Source layout

```text
src/
├── process.ts                 JSONL transport, dispatch, and concurrency
├── loop.ts                    model and tool execution loop
├── types.ts                   shared Agent Loop and stream types
├── config.ts                  runtime configuration loading and validation
├── protocol.ts                wire request parsing and response serialization
├── plugins/
│   └── screen-observation/    background macOS observation capability
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
        ├── processor.ts       long-term memory processing
        ├── store.ts           long-term memory event storage
        ├── lock.ts            shared activity-memory lock
        ├── types.ts           long-term memory types
        └── activity/          activity normalization and storage
```

`process.ts` communicates with the Swift process through JSON Lines on
standard input and output. `protocol.ts` owns that wire format; harness code
does not depend on it. Chat requests are mapped to session commands before
entering `session/runner.ts`, which builds model context and invokes
`loop.ts`. Activity and long-term memory are separate layers of the same
memory capability and are not yet connected to the production tool registry.

## Domain boundaries

The Agent is the composition center, but each capability owns its domain:

- A `Turn` is one user interaction and its user-visible outcome.
- An `AgentRun` is one execution attempt for a Turn. It has an independent ID,
  refers to its Turn through `turnId`, and owns model steps and tool results. A
  Turn may have zero or more Agent Runs.
- A conversation summary belongs only to retained model context. It is not an
  activity record or long-term memory.
- `ScreenObservationPlugin` is a hosted background plugin. It owns native
  observation lifecycle and emits canonical `ScreenObservation` values. It is
  not callable by the model and is not an `AgentTool`.
- An `ActivityRecord` is normalized evidence derived from screen observations
  or a terminal Turn and its Runs. Activity belongs to the memory capability;
  there is no separate activity-summary entity.
- `LongTermMemory` is synthesized knowledge supported by Activity Record IDs.
- Model-initiated retrieval is an Agent Tool boundary under
  `tools/retrieve-memory`. Memory owns the data being queried; the Tool owns
  the model-facing arguments and results.

The background evidence flow is
`ScreenObservation | terminal Turn + AgentRun[] -> ActivityRecord -> LongTermMemory`.
The model-initiated flow is
`Agent -> retrieve-memory Tool -> memory query -> bounded results`.

Runtime status remains local to its owner: session owns Turn and Run status,
the observation plugin owns helper health, memory owns processing outcomes,
and `process.ts` keeps request queues and abort controllers private. There is
no shared runtime snapshot or centralized contracts directory.

## Runtime configuration

Non-secret defaults live in the repository-level
[`config.json`](../config.json). `OPENAI_API_KEY` is required from the process
environment or `.env`. `OPENAI_MODEL` and `OPENAI_BASE_URL` can override the
provider fields. Every numeric setting also supports its corresponding
environment-variable override, while [`.env.example`](../.env.example)
intentionally shows only the three common provider variables.

Configuration is grouped by responsibility:

- `context`: model window, compaction threshold, retained context, output
  budgets, and minimum recent turns.
- `session`: streaming event flush size and interval.
- `activity`: model input and output budgets for one Activity Record.
- `memory`: processing interval and model input and output budgets.

Configuration is loaded once when the Agent process starts. Invalid,
incomplete, or internally inconsistent values stop startup with an explicit
error.

## Persistence

Sessions are stored as one append-only JSONL file per session. `store.ts`
owns file I/O, while `events.ts` owns event validation and replay. The header
contains session metadata; subsequent records represent turn lifecycle
events, streamed text, Agent Run steps, tool results, and compaction.

Activity records are currently stored by UTC day under
`timeline/YYYY-MM-DD.jsonl`; changing that persistence layout belongs to the
memory-persistence work. Long-term memory decisions are stored in
`memory/events.jsonl`. Both stores
use append-only records and recover complete lines after an interrupted
write.

Generated activity summaries and memories use English. User text, code,
errors, URLs, paths, and proper nouns remain verbatim.

## Tests

From the repository root:

```bash
npm run test:agent
```

The command builds the production Agent, builds the test target, and runs the
Node.js test suite.
