# OpenScreen desktop application

The Electron frontend. It owns the two windows, the global shortcut, image
attachments, and the child process running the Node Agent. It contains no Agent,
Capture, or Memory logic; see [OpenScreen Agent](../runtime/README.md) for those.

## Source layout

```text
app/
  src/
    main/                Electron main process
      index.ts           lifecycle, IPC registration, shutdown
      agent-client.ts    the runtime child and its newline-delimited JSON stdio
      attachments.ts     PNG normalisation and the osfile:// scheme
      hotkey.ts          the Option+Space accelerator
      session-hub.ts     prompts in flight and chat-list staleness, by observation
      permissions.ts     Screen Recording and Accessibility preflight
      renderer-entry.ts  development-server document resolution
      windows/           overlay panel and main window factories
    preload/index.ts     the contextBridge surface, the only renderer capability
    shared/
      protocol.ts        type-only re-export of the runtime's application API
      ipc.ts             channel names and payload shapes
    renderer/
      store/             transport correlation and the interface state machine
      components/        pieces shared by both windows
      overlay/           the command bar and its chat picker
      main/              the full interface
  tests/                 Vitest suites for the store, transport, and main process
```

## Process model

The main process spawns `runtime/dist/main.js` from the current checkout with
Electron's own binary in Node mode (`ELECTRON_RUN_AS_NODE`). The repository root
is both the runtime/config location and the Agent working directory.
It passes its PID to the child so desktop tools can reject OpenScreen's own
windows before requesting approval.
The runtime child creates the Cua Driver SDK in its own process on the first
desktop observation or action request. Approved clicks, scrolls, and text input use this driver;
the native Accessibility focus helper runs in that child for guarded text input.
The windows never execute desktop input themselves.
`AgentClient` frames the protocol and does not interpret payloads beyond
`requestId`.

Renderers never reach the child directly. Every decoded runtime event is
broadcast to all windows with its `requestId` intact, and each renderer's
`AgentTransport` demultiplexes it back into per-request streams. Both windows
therefore hold independent projections of the same event stream; the
authoritative state is the runtime's Session JSONL, not either renderer.

Events for a request a window did not issue are not discarded. Session-bearing
events identify their chat; terminal failures are correlated by the existing
request ID retained in that window's cached Turn, even after the shared run set
closes. A window showing that session folds them into its own
transcript and a run started in the overlay streams into the main window as it
happens.

`SessionHub` completes that picture. The main process sits between every window
and the child, so it derives the set of prompts in flight by observation alone: a
`prompt` command opens a run and that request's terminal event closes it. The set
is broadcast to both windows, carrying each run's question because the event
stream never repeats it. That is what lets either surface label an adopted turn,
show a run as in progress, and abort it. The runtime needs no new protocol, and
neither window has to report what it is doing.

Approval requests are product events from the active prompt, broadcast to both
windows. Each surface can retrieve pending requests through `list_approvals`
when opened mid-run. `decide_approval` carries the approval ID, Session ID,
and a one-time Boolean decision. The runtime owns the decision; windows never
execute tools. Waiting for the user is a paused state, not an execution
timeout. Cancel or runtime exit invalidates a pending request. A window replays
approval events received during a pending-list refresh so an older list
response cannot hide a new request or restore a decided one.
Snapshots from a stopped runtime are discarded, including when a new runtime
starts before an older pending-list response arrives.
The runtime emits a separate commit event after an approved file change is
published, an approved host command executes, or an approved desktop action
returns without refusal. The Turn displays pending,
approved-but-unconfirmed, denied, and committed/executed states independently
of the model's answer. Desktop actions reusing one app grant remain separate
entries keyed by approval and tool-call ID. Live approval activity survives that window's immediate
post-run Session refresh, but it is not persisted in the Session projection and
is unavailable after restarting the application.

Because the streamed increments cannot reproduce the stored projection — hidden
context messages and image counts among them — a window that only observed a run
re-reads the session once the run ends.
The live cancelled status and failure reason survive that refresh and reopening
the chat in the same window. This remains local display state: the Session
projection does not distinguish cancellation from other assistant errors after
an application restart. A cancelled prompt with no persisted user message stays
visible in the live cache.
If the runtime stops before a run settles, both windows mark an in-flight Turn
as failed; an unresolved approval is shown as unknown rather than still pending.
A Session read started by the old runtime cannot overwrite that state after it
stops or restarts.
The transport observes IPC acknowledgement and terminal settlement concurrently,
so a runtime exit before the IPC reply rejects the request immediately without
leaving an unhandled rejection.

The chat list is kept level the same way. `create_session`, `rename_session`,
and `prompt` are the commands that change what the list shows — a chat with no
explicit name takes its name from its first question — so when one of them
settles, both windows are told to re-read the list. Chat *selection* is
deliberately not shared: the two surfaces are used for different things at the
same moment, so each remembers its own.

```text
renderer -> preload contextBridge -> ipcRenderer.invoke("agent:send")
         -> main AgentClient -> child stdin
         <- broadcast "agent:event" <- child stdout
         <- broadcast "session:runs" <- SessionHub
```

## Windows

The overlay is a `type: "panel"` window. On macOS that lets it become the key
window and receive real keystrokes while the application itself stays inactive,
so the foreground application the agent is being asked about does not change
when the overlay is summoned. It calls `setContentProtection(true)`, which keeps
it out of every screen capture including the runtime's own ScreenCaptureKit
recorder.

The overlay's height is driven from its rendered content, growing downward from
a fixed top edge between `OVERLAY_COLLAPSED_HEIGHT` and `OVERLAY_MAX_HEIGHT`.

The main window is an ordinary opaque window and is deliberately **not**
content-protected, so the user can screenshot it. It stays out of the recorder
through the `capture.screenpipe.ignoredWindows` title filter in `config.json`
instead.

`Option + Space` means "let me ask something", and where that lands depends on
what is in front. With the main window focused there is already a composer on
screen, so the shortcut focuses it rather than summoning a second input inside
the same application; otherwise it toggles the overlay. Opening the main window
hides the overlay, which would otherwise float above it.

The application starts with a hidden Dock icon. Opening the main window is the
one action that activates OpenScreen and shows the icon.

## Interface state

`AgentStore` holds one snapshot exposed through `useSyncExternalStore`. Session
transcripts, drafts, and pending attachments are cached per session id, so
switching chats is instant and a run continues accumulating into its own
transcript while another chat is on screen. A session with a run in flight is
never re-read from disk.

Each store is constructed for one surface, `overlay` or `main`, which scopes the
remembered chat selection. The two renderers share an origin, so a single key
would make each window drag the other to whatever chat it opened last; they keep
independent selections instead, while the chat list itself stays shared. `activeSessionIds` is the union of this window's
own runs and the runs `SessionHub` reports, so the composer offers to stop a run
started in the other surface rather than starting a second one on a session the
runtime would reject as busy.

Both windows render the same approval panel. For Bash it shows the exact host
command and warns that the host has filesystem and network access, may change
the desktop multiple times, and may start background tasks that continue after
the command returns. Approval applies to this command, not later Agent host
commands. For `write`/`edit` it shows the canonical target and complete proposed
content, plus the observed original content or absence. For desktop actions it
shows the application name, Bundle ID when available, current window,
screenshot, and the app-wide scope of the grant for this chat. It offers Deny
and Allow for this chat; a denial prevents another approval request for that
app in the chat. It does not show or persist typed plaintext in the approval
record. The panel explains that desktop tools request window-targeted background
input without foreground retries; a target application may still activate itself.
The underlying driver boundaries are documented in
[System tools](../runtime/README.md#system-tools).
Line breaks may submit forms, and partial input may remain if focus
changes. Decision buttons are disabled while
a decision command is in flight. A stale or duplicate decision is rejected and
the pending list is refreshed. The affected Turn is labeled as paused for
approval, not as failed or timed out.

`projectTranscript` folds the runtime's flat transcript into turns: assistant and
tool messages attach to the preceding question, and `context` messages stay
hidden. A reloaded transcript reports only how many images a turn carried.
`restoreLiveTurnState` restores local attachments, approval activity, and live
terminal failure status together in one matching pass. It first uses persisted
user-message IDs and renderer-local request bindings, reserving stable IDs before
falling back to newest-first, one-to-one question matching for unbound live Turns.
Unpersisted
cancelled Turns keep their relative order rather than taking over a later
completed answer to the same question. These bindings are not new protocol or
Session-persistence fields.
A remote reconciliation response is discarded when a newer request entered
that chat while the read was pending, so an older snapshot cannot bind the
new request to a repeated question's persisted message.
During a run, streamed answer text remains visible when the completion event
contains only the final assistant segment or an empty segment. Session refresh
then replaces the live approximation with the persisted transcript.

## Attachments

Every uploaded or pasted image is normalised to PNG under `user-attachments/` in
the Node data root, described in
[Persistence and failure behavior](../runtime/README.md#persistence-and-failure-behavior).
Renderers read them through the registered `osfile://` scheme, which serves only
paths inside that directory rather than enabling `file://` access.

## Design

Two type roles carry one rule: sans is what was *said* — the question and the
model's prose — and mono is what was *recorded* — timestamps, tool names, token
counts, key caps, and image counts. Colour is cold neutral glass with a single
amber accent, which is also the capture indicator: it breathes while the runtime
that records the screen is alive and greys when it stops. Tokens are defined once
in `src/renderer/styles.css`.

## Development launch

`npm run dev` builds the runtime, starts the Electron Vite development server,
and launches both windows. Its `predev` hook signs the Electron application in
`node_modules` with the identity configured through
`OPENSCREEN_SIGNING_IDENTITY` or `.signing-identity`. A stable signature lets
macOS remember Screen Recording permission across ordinary launches; replacing
Electron may require the permission to be granted again.

The desktop application intentionally has no packaging or distribution path.

## Tests

From the repository root:

```bash
npm run typecheck:app
npm run test:app
```

The suites cover the development-only architecture, transcript projection,
per-request correlation and failure mapping in the transport, the store's
session and prompt lifecycles, adoption of runs started in the other window,
per-surface chat selection, `SessionHub` run bookkeeping, the attachment path
guard, overlay height clamping, and the stdio framing in `AgentClient` against a
real child process.

The opt-in [desktop host smoke](../runtime/evals/README.md) also
reuses production `AgentClient` to launch the actual runtime from a background
Electron host and operate a temporary test window with the configured real model.
It is separate from these deterministic suites and does not launch the product UI.

Separate local acceptance checks have exercised the production main and overlay
renderers, preload, SessionHub, AgentClient, and runtime in a hidden background
host. They cover cross-window approval decisions, denial without effects,
cancellation, immediate history refresh, runtime-exit display, and application
grant reuse across prompts with separate committed action entries. The live
application-grant check uses a temporary AppKit window; when the SDK does not
expose its Bundle ID it verifies the documented process-scoped fallback, not a
bundle-scoped grant. These bounded checks do not cover development startup,
hotkeys, permission dialogs, visual layout, or arbitrary applications.
