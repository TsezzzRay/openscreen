# ObservationHelper

`ObservationHelper` is the native macOS data-collection child process.
Node communicates with it using newline-delimited JSON over stdin/stdout. The
repository README describes the overall process topology; this file covers the
helper boundary and implementation.

The helper owns:

- detecting foreground application, window, Accessibility, input-activity, and
  visual-change signals;
- resolving and validating an explicit frozen foreground-window target;
- capturing an in-memory JPEG for that exact window with ScreenCaptureKit;
- creating a bounded Accessibility snapshot for the same window;
- reporting permission and component health; and
- excluding OpenScreen processes and bundle identifiers from observation.

It does not schedule captures, deduplicate observations, persist data, call a
model, or run an Agent Loop.

## Runtime flow

1. The helper starts and writes a `ready` message.
2. For each helper launch, Node sends a `configure` command containing
   self-exclusion identities and the native observation configuration loaded
   from the project `config.json`.
3. The helper installs the available signal sources and replies with
   `configured`.
4. Native activity is emitted as `signal` messages. The helper never includes
   raw key codes or typed key values.
5. Node freezes an exact process ID and window ID, retains activity revision as
   ordering metadata, applies fusion/scheduling policy, and sends a `capture`
   command with that target.
6. The helper admits only one capture at a time. It validates the frozen target
   before capture, captures the screenshot and matching focused AX window
   concurrently, then attests that the target still exists before replying with
   `captureResult`. A concurrent native request receives `capture_busy`.
7. Node sends `shutdown`, closes stdin, or terminates the process to stop it.

Stdout is reserved for protocol messages. Diagnostics are written to stderr so
they cannot corrupt the JSON Lines stream. Node ignores an accidental non-JSON
stdout line but treats an incompatible version or malformed structured protocol
message as a fatal helper error. The wire contract and validation on the Node
side live in
`agent/src/extensions/screen-observation/protocol.ts`. Node and the helper are built and
released together, so the current wire format has no version negotiation.

## Signal sources

`Monitor` coordinates four native sources without depending on the wire
transport:

- `NSWorkspace` for application activation, Space changes, wake, and relevant
  application termination;
- `AXSource` for focused-window, focused-element, value, and title changes in
  the current foreground application;
- `InputSource`, using a listen-only `CGEventTap`, for mouse-button presses and
  non-command/control keyboard activity; and
- `VisualSource` for low-resolution ScreenCaptureKit frames.

The current foreground window is cached for high-frequency keyboard and AX
signals. Keyboard and AX-content signals are independently coalesced using the
configured interval, including one trailing signal after activity settles.
Application, focused-window, Space, and wake boundaries refresh the window
immediately and discard pending activity from the previous window. Mouse,
keyboard, focused-element, and AX-content signals use that cached identity;
a following focus boundary supersedes activity attributed to the previous
window.

`VisualSource` compares each grayscale signature with the last signature that
caused an event, not merely the preceding video frame. This allows gradual
visual changes to accumulate. It emits only `visualChanged`; it never emits or
stores video frames.

## Configuration

The helper does not read a configuration file itself. Node reads and validates
`config.json` once during agent startup, uses the scheduling and lifecycle
settings locally, and sends the native subset in the helper's `configure`
command. This keeps one configuration source and avoids separate Swift and
TypeScript defaults.

The native configuration groups are:

| Group | Controls |
| --- | --- |
| `activityMonitoring` | Swift-side coalescing interval for high-frequency keyboard and AX signals |
| `accessibility` | AX depth, node, timeout, and per-value text budgets |
| `screenshot` | maximum captured width and JPEG quality |
| `visualMonitoring` | stream width, sample interval, queue depth, change threshold, and signature dimensions |
| `windowSelection` | minimum normal-window dimensions and maximum aspect ratio |

Node-only observation settings in `config.json` control whether observation is
enabled, capture delays and caps, the one-second per-event deduplication window,
the two-second global capture gap, the five-second same-window capture gap,
business-content deduplication, the per-request capture timeout, the two-second
completed-artifact reuse window, capture diagnostics retention,
configuration/shutdown timeouts, and scheduler tick frequency. The default
capture timeout is 10 seconds and
releases only the timed-out Node request; it does not terminate or restart the
helper. Observation settings are not environment-variable overrides. The helper
executable path remains a deployment concern supplied through
`OPENSCREEN_HELPER_PATH` when needed.

The `enabled` flag disables passive capture scheduling, not request capture;
Node still starts the helper to serve chat requests.

`visualMonitoring.changeThreshold` is the single perceptual threshold used by
Swift visual-change candidates, Node's pre-capture gate, and Node's post-capture
Observation comparison. The Node gate compares against the last successfully
persisted Observation, so smaller visual candidates do not consume a physical
Capture and failed or reused observations do not advance the baseline. Explicit
input and window-boundary captures are not blocked by the visual-only gate.
After capture, Node compares the application, window title, focused role and
value, visible text, and URL, plus the downsampled visual signature. A material
change in either channel persists a new Observation; timestamps, raw AX
structure, coordinates, and JPEG encoding bytes do not participate in Evidence
identity.

Protocol versions, activity/status enums, secure-field redaction, foreground
window semantics, and self-capture exclusion are compatibility or privacy
invariants rather than tuning options.

## Privacy and failure behavior

Node excludes its own PID, its parent Swift process, and the configured
OpenScreen bundle identifier. The helper also excludes its own PID and bundle
identifier when one is available. Window resolution applies these identities
before starting native observation or capture, preventing the OpenScreen panel
and helper lifecycle from creating a capture loop.

Secure Accessibility fields are replaced with `[REDACTED]`. A missing permission
does not fabricate a successful artifact:

- Screen Recording failures produce a screenshot status such as
  `permissionDenied` or `failed`, plus a stable reason such as
  `permission_denied`, `no_window`, `no_display`, `target_resolution_failed`,
  `capture_failed`, or `jpeg_encoding_failed`.
- Accessibility failures produce `permissionDenied`, `timedOut`, or `failed`
  plus a safe reason such as `focused_window_unavailable`, `target_mismatch`,
  `traversal_timed_out`, or `snapshot_unavailable`.
- Input Monitoring or visual-stream failures are reported with degraded
  component status while the remaining sources continue to run.

Capture failures, malformed capture results, `capture_busy`, and capture
timeouts fail only the affected request. They do not stop or restart the helper,
so native activity monitoring remains available. A helper launch/configuration
failure, incompatible protocol message, or process exit is reported as fatal
and is not retried automatically.

If the exact target is absent during preflight, the helper returns
`target_unavailable` and performs no screenshot or AX capture. If it disappears
during capture, the helper returns `target_changed_during_capture`; Node records
an attestation failure and discards the artifacts. Successful results include
the overall start/completion timestamps, separate screenshot and AX completion
timestamps, and preflight, screenshot, AX, and attestation durations.

AX traversal reads each node's attributes with one
`AXUIElementCopyMultipleAttributeValues` call. If that batch operation fails or
returns a misaligned value list, traversal falls back to individual attribute
reads. This changes IPC cost only; target validation, traversal budgets, secure
field redaction, and partial-success behavior remain unchanged.

The first AX capture for a process that exposes an `AXWebArea` or `AXDocument`
still performs renderer accessibility activation even when navigation or
sidebar controls already make the tree look useful. Activation stops early
only after material node, semantic-element, or visible-text growth. Successful
and unsupported activation methods are cached per process launch; failed
attribute writes are not cached.

An unexpected current-generation visual-stream stop is serialized with cleanup
of the failed stream before replacement. The first recovery is immediate;
additional failures within ten seconds use bounded 250, 500, 1000, and 2000 ms
delays. Recovery diagnostics include the stream generation, exact window ID,
and scheduled delay without screen content.

The helper returns artifacts in-memory in `captureResult`; it does not write
application storage itself. Node persists each accepted Capture Artifact once,
with one private metadata JSON file and at most one private JPEG, and reuses that
JPEG for the matching chat turn. Node also writes content-free fusion and timing
diagnostics. Artifact-persistence failure does not discard a successful
in-memory screenshot or AX result.

## Source layout

| Path | Responsibility |
| --- | --- |
| `main.swift` | minimal process bootstrap |
| `Protocol/` | wire DTOs and JSON Lines framing |
| `Runtime/` | command coordination and single-capture admission |
| `Monitoring/` | workspace, AX, input, and visual signal sources |
| `Capture/` | window selection, ScreenCaptureKit target, screenshot, AX snapshot, budget, and signature |
| `Models/` | native configuration, signal, window, and capture models |

## Build and test

Run these commands from the repository/worktree root:

```bash
npm run build:helper
swift test --filter ObservationHelperTests
```

For the cross-process protocol and runtime tests:

```bash
npm run build:agent-tests
node --test agent/dist-test/tests/config.test.js \
  agent/dist-test/tests/screen-observation/*.test.js
```

Normal development startup builds both Node and the helper and supplies the
helper executable path:

```bash
npm run dev
```
