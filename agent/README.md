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
        └── timeline/          activity normalization and timeline storage
```

`process.ts` communicates with the Swift process through JSON Lines on
standard input and output. `protocol.ts` owns that wire format; harness code
does not depend on it. Chat requests are mapped to session commands before
entering `session/runner.ts`, which builds model context and invokes
`loop.ts`. Timeline and long-term memory processing are separate harness
capabilities and are not yet connected to the production tool registry.

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
- `timeline`: model input and output budgets for one activity.
- `memory`: processing interval and model input and output budgets.

Configuration is loaded once when the Agent process starts. Invalid,
incomplete, or internally inconsistent values stop startup with an explicit
error.

## Persistence

Sessions are stored as one append-only JSONL file per session. `store.ts`
owns file I/O, while `events.ts` owns event validation and replay. The header
contains session metadata; subsequent records represent turn lifecycle
events, streamed text, Agent Run steps, tool results, and compaction.

Timeline entries are stored by UTC day under `timeline/YYYY-MM-DD.jsonl`.
Long-term memory decisions are stored in `memory/events.jsonl`. Both stores
use append-only records and recover complete lines after an interrupted
write.

Generated timeline summaries and memories use English. User text, code,
errors, URLs, paths, and proper nouns remain verbatim.

## Tests

From the repository root:

```bash
npm run test:agent
```

The command builds the production Agent, builds the test target, and runs the
Node.js test suite.
