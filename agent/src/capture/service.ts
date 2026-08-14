import { join } from "node:path";

import type {
  CapturedContext,
  CaptureService,
} from "./api.js";
import {
  NativeHelperClient,
  type HelperComponentStatus,
} from "./native/helper-client.js";
import {
  CaptureCoordinator,
} from "./coordinator.js";
import { ObservationResolver } from "./observation-resolver.js";
import { BackgroundCapture } from "./background-capture.js";
import type { CaptureConfig } from "./config.js";
import type {
  NativeHelperConfiguration,
  NativeActivitySignal,
} from "./native/protocol.js";
import {
  CaptureDiagnostics,
  type CaptureDiagnosticsSink,
} from "./diagnostics.js";
import { CaptureArtifactStore } from "./artifact-store.js";
import { projectCapturedContext } from "./context-projector.js";

export type NativeCaptureServiceOptions = {
  config: CaptureConfig;
  dataRoot: string;
  helperCommand: string;
  helperArguments?: string[];
  helperEnvironment?: NodeJS.ProcessEnv;
  helperCurrentDirectory: string;
  excludedProcessIdentifiers: number[];
  excludedBundleIdentifiers: string[];
  diagnostics?: CaptureDiagnosticsSink;
  onComponentStatus?: (status: HelperComponentStatus) => void;
  onFatalError?: (error: Error) => void;
};

export class NativeCaptureService implements CaptureService {
  private readonly helper: NativeHelperClient;
  private readonly coordinator: CaptureCoordinator;
  private readonly observationResolver: ObservationResolver;
  private readonly background: BackgroundCapture;
  private readonly tickIntervalMilliseconds: number;
  private readonly activityEnabled: boolean;
  private readonly diagnostics: CaptureDiagnosticsSink;
  private readonly flushDiagnostics?: () => Promise<void>;
  private timer?: NodeJS.Timeout;
  private readonly activeTicks = new Set<Promise<void>>();
  private lifecycleQueue = Promise.resolve();
  private helperStarted = false;
  private desiredRunning = false;

  constructor(options: NativeCaptureServiceOptions) {
    this.tickIntervalMilliseconds = options.config.scheduling.tickIntervalMilliseconds;
    this.activityEnabled = options.config.enabled;
    if (options.diagnostics === undefined) {
      const diagnostics = new CaptureDiagnostics({
        directory: join(options.dataRoot, "diagnostics"),
        retentionMilliseconds:
          options.config.diagnostics.retentionMilliseconds,
      });
      this.diagnostics = diagnostics;
      this.flushDiagnostics = () => diagnostics.flush();
    } else {
      this.diagnostics = options.diagnostics;
    }
    const artifactStore = new CaptureArtifactStore(options.dataRoot);
    const helper = new NativeHelperClient({
      command: options.helperCommand,
      arguments: options.helperArguments,
      environment: options.helperEnvironment,
      currentDirectory: options.helperCurrentDirectory,
      excludedProcessIdentifiers: options.excludedProcessIdentifiers,
      excludedBundleIdentifiers: options.excludedBundleIdentifiers,
      configuration: nativeConfiguration(options.config),
      configurationTimeoutMilliseconds:
        options.config.helperLifecycle.configurationTimeoutMilliseconds,
      captureTimeoutMilliseconds: options.config.requests.requestTimeoutMilliseconds,
      shutdownTimeoutMilliseconds: options.config.helperLifecycle.shutdownTimeoutMilliseconds,
      onSignal: (signal) => this.push(signal),
      onComponentStatus: (status) => {
        options.onComponentStatus?.(status);
        this.diagnostics?.emit({
          event: "helper.component_status",
          component: status.component,
          componentStatus: status.status,
        });
        if (status.status === "degraded") {
          process.stderr.write(
            `OpenScreen observation ${status.component} is degraded${
              status.message === undefined ? "" : `: ${status.message}`
            }\n`,
          );
        }
      },
      onDiagnostic: (diagnostic) => {
        this.diagnostics?.emit({
          event: diagnostic.event,
          ...(diagnostic.reason === undefined
            ? {}
            : { reason: diagnostic.reason }),
          ...(diagnostic.generation === undefined
            ? {}
            : { generation: diagnostic.generation }),
          ...(diagnostic.windowIdentifier === undefined
            ? {}
            : { rootWindowIdentifier: diagnostic.windowIdentifier }),
          ...(diagnostic.delayMilliseconds === undefined
            ? {}
            : { restartDelayMs: diagnostic.delayMilliseconds }),
        });
      },
      onFatalError: (error) => {
        this.desiredRunning = false;
        this.helperStarted = false;
        this.clearTimer();
        options.onFatalError?.(error);
        process.stderr.write(`OpenScreen observation helper failed: ${error.message}\n`);
      },
    });
    this.helper = helper;
    this.coordinator = new CaptureCoordinator({
      reuseWindowMilliseconds: options.config.requests.reuseWindowMilliseconds,
      capture: (target) => helper.capture(target),
      diagnostics: this.diagnostics,
      persistArtifact: (artifact) => artifactStore.persist(artifact),
    });
    this.observationResolver = new ObservationResolver({
      persist: () => undefined,
      diagnostics: this.diagnostics,
      visualChangeThreshold: options.config.visualMonitoring.changeThreshold,
    });
    this.background = new BackgroundCapture({
      config: options.config,
      capture: async (signal) => {
        const frozen = this.coordinator.frozenFor(signal);
        if (frozen === undefined) {
          throw new Error("Activity signal has no frozen capture target");
        }
        return (await this.coordinator.capture(
          "activity",
          frozen,
          `activity:${frozen.activityRevision}`,
        )).artifact;
      },
      resolveObservation: (artifact) => this.observationResolver.resolve(artifact),
      diagnostics: this.diagnostics,
    });
  }

  async capture(
    requestId: string,
    signal?: AbortSignal,
  ): Promise<CapturedContext> {
    const frozen = this.coordinator.freezeLatest();
    if (frozen === undefined) {
      this.emitUnavailableRequest(requestId);
      throw new Error("No confirmed external window is available");
    }
    const capture = await this.coordinator.capture(
      "request",
      frozen,
      requestId,
      signal,
    );
    this.background.cover(
      capture.artifact,
      capture.intentRevision,
      capture.intentActivityKind,
      capture.intentContentEpoch,
    );
    signal?.throwIfAborted();
    try {
      const observation = await this.observationResolver.resolve(capture.artifact);
      this.background.recordObservationResolution(capture.artifact, observation);
    } catch (error) {
      process.stderr.write(
        `OpenScreen request observation unavailable: ${
          error instanceof Error ? error.message : "unknown error"
        }\n`,
      );
    }
    signal?.throwIfAborted();
    const context = await projectCapturedContext(
      capture.artifact,
      requestId,
      undefined,
      {
        intentRevision: capture.intentRevision,
        intentContentEpoch: capture.intentContentEpoch,
      },
    );
    return context;
  }

  start() {
    this.desiredRunning = true;
    return this.enqueueLifecycle(async () => {
      if (!this.helperStarted) {
        await this.helper.start();
        this.helperStarted = true;
      }
      if (!this.desiredRunning || !this.activityEnabled) return;
      this.startTimer();
    });
  }

  stop() {
    this.desiredRunning = false;
    return this.enqueueLifecycle(async () => {
      this.clearTimer();
      await Promise.allSettled([...this.activeTicks]);
      if (this.helperStarted) {
        await this.helper.stop();
        this.helperStarted = false;
      }
      await this.flushDiagnostics?.();
    });
  }

  private startTimer() {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      const tick = this.background.tick().catch((error) => {
        process.stderr.write(
          `OpenScreen observation capture failed: ${
            error instanceof Error ? error.message : "unknown error"
          }\n`,
        );
      });
      this.activeTicks.add(tick);
      void tick.finally(() => this.activeTicks.delete(tick));
    }, this.tickIntervalMilliseconds);
  }

  private enqueueLifecycle(operation: () => Promise<void>) {
    const result = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private clearTimer() {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private push(signal: NativeActivitySignal) {
    const frozen = this.coordinator.observe(signal, {
      contentChanged: this.background.shouldAdvanceContentEpoch(signal),
    });
    if (signal.window.windowIdentifier === undefined) {
      this.diagnostics?.emit({
        event: "activity.capture_skipped",
        consumer: "activity",
        activityRevision: frozen.activityRevision,
        contentEpoch: frozen.contentEpoch,
        activityKind: signal.kind,
        reason: "missing_window_identifier",
      });
      return;
    }
    this.background.push(
      signal,
      undefined,
      frozen.activityRevision,
      frozen.contentEpoch,
    );
  }

  private emitUnavailableRequest(requestId: string) {
    const event = {
      intentId: requestId,
      requestId,
      consumer: "request" as const,
    };
    this.diagnostics?.emit({
      event: "capture.intent_received",
      ...event,
    });
    this.diagnostics?.emit({
      event: "capture.decision",
      ...event,
      decision: "unavailable",
      reason: "no_confirmed_target",
    });
  }
}

function nativeConfiguration(
  config: CaptureConfig,
): NativeHelperConfiguration {
  return {
    activityMonitoring: config.activityMonitoring,
    accessibility: config.accessibility,
    screenshot: config.screenshot,
    visualMonitoring: {
      maxWidth: config.visualMonitoring.maxWidth,
      sampleIntervalMilliseconds:
        config.visualMonitoring.sampleIntervalMilliseconds,
      queueDepth: config.visualMonitoring.queueDepth,
      changeThreshold: config.visualMonitoring.changeThreshold,
      signatureWidth: config.visualMonitoring.signatureWidth,
      signatureHeight: config.visualMonitoring.signatureHeight,
    },
    windowSelection: config.windowSelection,
  };
}
