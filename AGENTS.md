# Development Rules

## Conversational Style

- Keep answers short, direct, and technical.
- Do not use emojis in commits, issues, pull requests, code, or technical
  documentation.
- Answer a question before making edits or running implementation commands.
- When responding to feedback or an analysis, state whether you agree or
  disagree before describing changes.
- Avoid filler, praise, and motivational language.

## Code Quality

- Read files in full before broad changes and before editing a file you have not
  fully inspected.
- Follow the existing Swift and TypeScript structure instead of introducing a
  parallel abstraction for the same responsibility.
- Inspect installed dependency types and source when using an external API; do
  not guess its interface.
- Keep helpers local when they have one call site and no independent contract.
- Do not remove intentional behavior or weaken validation merely to make a test
  pass. Ask before removing functionality.
- Keep secrets out of `config.json`, source files, fixtures, logs, and
  documentation. Provider API keys come from the environment or `.env` only.

## Commands

Run commands from the repository or current worktree root.

```bash
npm ci                    # Install Node.js dependencies
npm run build:agent       # Build the production Node Agent
npm run build:agent-tests # Build the Node Agent test target
npm run build:helper      # Build ObservationHelper
swift build               # Build all Swift targets
npm run dev               # Build and launch the development application
```

`npm run dev` launches the application and may contact the configured model
provider. Run it only when the user requests a live launch or when manual
verification requires it.

## Testing

- After TypeScript Agent changes, run `npm run test:agent`.
- After Swift application or ObservationHelper changes, run `swift test`.
- After a Swift/Node protocol change, run both full suites.
- If a test file changes, run the affected test while iterating and then its
  full relevant suite before completion.
- For a focused native-helper check, use
  `swift test --filter ObservationHelperTests`.
- Documentation-only changes do not require code tests, but all documented
  commands, paths, anchors, and behavior must be checked against the current
  branch.
- Do not claim a build or test passes without fresh command output.

## Git and Worktrees

Multiple worktrees or Agent sessions may share this repository.

- Modify only files required for the current task and preserve unrelated user
  changes.
- Check `git status` before editing and before reporting completion.
- Stage explicit paths only. Never use `git add .` or `git add -A`.
- Do not use `git reset --hard`, `git clean`, `git stash`, or another operation
  that can discard work from a different session.
- Resolve conflicts only in files changed for the current task. Stop and ask if
  a conflict involves unrelated work.
- Do not force-push.
- Do not create commits, branches, tags, or pull requests unless the user asks.

## Documentation

- Write all repository documentation in English.
- Document only behavior implemented on the current branch. Do not add roadmaps,
  draft specifications, ADRs, or descriptions of planned capabilities.
- Update documentation in the same change when behavior, boundaries,
  configuration, persistence, development commands, or user-visible capability
  changes.
- Do not update documentation for an internal refactor that leaves documented
  behavior unchanged.
- Define a detailed fact in one place. Other documents should summarize it and
  link to the owner instead of copying it.
- Read the owning README in full before changing the associated component.
- If documentation conflicts with code, configuration, or tests, verify the
  implemented behavior and correct the documentation.

Documentation ownership:

| Change | Documentation owner |
| --- | --- |
| Product capability, requirements, startup, privacy summary, or top-level process relationship | `README.md` |
| Development commands, testing, Git/worktree practice, or documentation policy | `AGENTS.md` |
| Node Agent, Agent Loop, tools, Session, Memory, configuration, or persistence behavior | `agent/README.md` |
| Native signals, exact-window capture, permissions, Helper protocol, or native failure behavior | `Sources/ObservationHelper/README.md` |

Documentation consistency is enforced through review and these Agent rules, not
through a documentation CI job.

## User Override

If a user instruction conflicts with a rule in this file, explain the conflict
and ask for explicit confirmation before overriding the project rule.
