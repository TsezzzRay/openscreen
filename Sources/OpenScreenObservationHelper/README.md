# OpenScreenObservationHelper

`OpenScreenObservationHelper` is the native macOS data-collection process for
screen observation. The Node agent starts it as a child process and communicates
with it using newline-delimited JSON over stdin/stdout.

The helper owns macOS-specific work:

- detecting foreground application, window, Accessibility, input-activity, and
  visual-change signals;
- resolving the current foreground window;
- capturing an in-memory foreground-window JPEG with ScreenCaptureKit;
- creating a bounded Accessibility snapshot;
- reporting permission and component health; and
- excluding OpenScreen processes and bundle identifiers from observation.

It does not schedule captures, deduplicate observations, persist data, build
long-term memory, call a model, or run an Agent Loop. Those are Node or later
integration responsibilities.

## Runtime flow

1. The helper starts and writes a `ready` message.
2. For each helper launch or restart, Node sends a `configure` command containing
   self-exclusion identities and the native observation configuration loaded
   from the project `config.json`.
3. The helper installs the available signal sources and replies with
   `configured`.
4. Native activity is emitted as `signal` messages. The helper never includes
   raw key codes or typed key values.
5. Node applies scheduling and deduplication policy. When a capture is due, it
   sends a `capture` command with the triggering signal.
6. The helper resolves the foreground window again, captures the screenshot and
   Accessibility snapshot concurrently, and replies with `captureResult`.
7. Node sends `shutdown`, closes stdin, or terminates the process to stop it.

Stdout is reserved for protocol messages. Diagnostics are written to stderr so
they cannot corrupt the JSON Lines stream. The wire contract and validation on
the Node side live in
`agent/src/screen-observation/helper-protocol.ts`. Configuration delivery is
part of helper protocol version 2; mismatched binaries fail explicitly instead
of running with a different set of capture defaults.

## Signal sources

`ActivityMonitor` combines three native sources:

- `NSWorkspace` for application activation, Space changes, wake, and relevant
  application termination;
- `AXObserver` for focused-window, focused-element, value, and title changes in
  the current foreground application; and
- a listen-only `CGEventTap` for mouse-button presses and non-command/control
  keyboard activity.

`VisualStreamMonitor` runs a low-resolution ScreenCaptureKit stream for the
current foreground window. It emits only a `visualChanged` signal when the
configured grayscale signature distance is large enough. It does not emit or
store video frames.

## Configuration

The helper does not read a configuration file itself. Node reads and validates
`config.json` once during agent startup, uses the scheduling and lifecycle
settings locally, and sends the native subset in the helper's `configure`
command. This keeps one configuration source and avoids separate Swift and
TypeScript defaults.

The native configuration groups are:

| Group | Controls |
| --- | --- |
| `accessibility` | AX depth, node, timeout, and per-value text budgets |
| `screenshot` | maximum captured width and JPEG quality |
| `visualMonitoring` | stream width, sample interval, queue depth, change threshold, and signature dimensions |
| `windowSelection` | minimum normal-window dimensions and maximum aspect ratio |

Node-only observation settings in `config.json` control whether observation is
enabled, capture delays and caps, the ordinary capture gap, content
deduplication, helper restart policy, configuration/shutdown timeouts, and
scheduler tick frequency. Observation settings are not environment-variable
overrides. The helper executable path remains a deployment concern supplied through
`OPENSCREEN_OBSERVATION_HELPER_PATH` when needed.

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
  `permissionDenied` or `failed`.
- Accessibility failures produce `permissionDenied`, `timedOut`, or `failed`.
- Input Monitoring or visual-stream failures are reported with degraded
  component status while the remaining sources continue to run.

Artifacts remain in the `captureResult` message as in-memory data. This target
does not write screenshots, snapshots, observations, or logs to application
storage.

## File map

| File | Responsibility |
| --- | --- |
| `main.swift` | process lifecycle, stdin reader, command dispatch, and shutdown |
| `HelperProtocol.swift` | Swift protocol messages and serialized stdout writer |
| `NativeModels.swift` | shared native configuration, signal, window, and capture models |
| `ActivityMonitor.swift` | workspace, Accessibility, and input-activity monitoring |
| `VisualStreamMonitor.swift` | low-resolution visual-change stream |
| `WindowResolver.swift` | filtered foreground-window resolution |
| `ObservationCaptureEngine.swift` | concurrent screenshot and AX capture |
| `AccessibilitySnapshotter.swift` | bounded and redacted AX tree creation |
| `SnapshotBudget.swift` | AX traversal depth, node, and deadline budget |
| `VisualSignature.swift` | grayscale downsampling and visual distance |
| `ObservationPrivacy.swift` | self-capture filtering and secure-value redaction |

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
