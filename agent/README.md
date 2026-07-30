# OpenScreen Agent

The OpenScreen Agent is the local Node.js process behind the macOS app. It
owns model requests, the Agent Loop, session persistence, context compaction,
and the activity-memory core. See the [project README](../README.md) for
product setup, requirements, privacy, and current limitations.

## Source layout

```text
src/
├── process.ts                 process entry point and JSONL dispatch
├── loop.ts                    model and tool execution loop
├── types.ts                   Agent Loop types
├── config.ts                  runtime configuration loading and validation
├── protocol.ts                Swift-to-Agent protocol parsing
└── harness/
    ├── session/               session execution, context, storage, and locks
    ├── compaction/            retained-context compaction and summaries
    └── memory/
        ├── processor.ts       long-term memory processing
        ├── store.ts           long-term memory event storage
        └── timeline/          activity normalization and timeline storage
```

`process.ts` communicates with the Swift process through JSON Lines on
standard input and output. Chat requests enter `session/runner.ts`, which
builds model context and invokes `loop.ts`. Timeline and long-term memory
processing are separate harness capabilities and are not yet connected to
the production tool registry.

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

Sessions are stored as one append-only JSONL file per session. The header
contains session metadata; subsequent records represent turn lifecycle
events, streamed text, Agent Run steps, tool results, and compaction.

Timeline entries are stored by UTC day under `timeline/YYYY-MM-DD.jsonl`.
Long-term memory decisions are stored in `memory/events.jsonl`. Both stores
use append-only records and recover complete lines after an interrupted
write.

Generated timeline summaries and memories use English. User text, code,
errors, URLs, paths, and proper nouns remain verbatim. Recognizable
credentials are rejected before timeline or memory persistence.

## Tests

From the repository root:

```bash
npm run test:agent
```

The command builds the production Agent, builds the test target, and runs the
Node.js test suite.
