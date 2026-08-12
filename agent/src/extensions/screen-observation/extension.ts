import {
  NativeHelperClient,
  type HelperComponentStatus,
} from "./helper.js";
import {
  CaptureCoordinator,
  type CaptureArtifact,
  type CaptureResolution,
} from "./coordinator.js";
import {
  ObservationResolver,
  type ObservationResolution,
} from "./observation-resolver.js";
import { ScreenObservationService } from "./service.js";
import type {
  ScreenObservationConfig,
} from "../../config.js";
import type {
  NativeHelperConfiguration,
  NativeActivitySignal,
} from "./protocol.js";
import type { ScreenObservation } from "./types.js";
import type { CaptureDiagnosticsSink } from "./diagnostics.js";
import type { CaptureArtifactPersistence } from "./artifact-store.js";

export type ScreenObservationExtensionOptions = {
  config: ScreenObservationConfig;
  helperCommand: string;
  helperArguments?: string[];
  helperEnvironment?: NodeJS.ProcessEnv;
  helperCurrentDirectory: string;
  excludedProcessIdentifiers: number[];
  excludedBundleIdentifiers: string[];
  diagnostics?: CaptureDiagnosticsSink;
  onObservation?: (observation: ScreenObservation) => void | Promise<void>;
  onComponentStatus?: (status: HelperComponentStatus) => void;
  onFatalError?: (error: Error) => void;
  persistArtifact?: (
    artifact: CaptureArtifact,
  ) => Promise<CaptureArtifactPersistence>;
};

export class ScreenObservationExtension {
  private readonly helper: NativeHelperClient;
  private readonly coordinator: CaptureCoordinator;
  private readonly observationResolver: ObservationResolver;
  private readonly service: ScreenObservationService;
  private readonly tickIntervalMilliseconds: number;
  private readonly activityEnabled: boolean;
  private readonly diagnostics?: CaptureDiagnosticsSink;
  private timer?: NodeJS.Timeout;
  private readonly activeTicks = new Set<Promise<void>>();

  constructor(options: ScreenObservationExtensionOptions) {
    this.tickIntervalMilliseconds = options.config.scheduling.tickIntervalMilliseconds;
    this.activityEnabled = options.config.enabled;
    this.diagnostics = options.diagnostics;
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
      captureTimeoutMilliseconds: options.config.capture.requestTimeoutMilliseconds,
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
        this.clearTimer();
        options.onFatalError?.(error);
        process.stderr.write(`OpenScreen observation helper failed: ${error.message}\n`);
      },
    });
    this.helper = helper;
    this.coordinator = new CaptureCoordinator({
      reuseWindowMilliseconds: options.config.capture.reuseWindowMilliseconds,
      capture: (target) => helper.capture(target),
      diagnostics: options.diagnostics,
      persistArtifact: options.persistArtifact,
    });
    this.observationResolver = new ObservationResolver({
      persist: (observation) => options.onObservation?.(observation),
      diagnostics: options.diagnostics,
      visualChangeThreshold: options.config.visualMonitoring.changeThreshold,
    });
    this.service = new ScreenObservationService({
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
      diagnostics: options.diagnostics,
    });
  }

  async captureForRequest(requestId: string, signal?: AbortSignal): Promise<{
    capture: CaptureResolution;
    observation?: ObservationResolution;
  }> {
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
    this.service.cover(
      capture.artifact,
      capture.intentRevision,
      capture.intentActivityKind,
      capture.intentContentEpoch,
    );
    signal?.throwIfAborted();
    let observation: ObservationResolution | undefined;
    try {
      observation = await this.observationResolver.resolve(capture.artifact);
      this.service.recordObservationResolution(capture.artifact, observation);
    } catch (error) {
      process.stderr.write(
        `OpenScreen request observation unavailable: ${
          error instanceof Error ? error.message : "unknown error"
        }\n`,
      );
    }
    signal?.throwIfAborted();
    return { capture, observation };
  }

  async start() {
    if (this.timer !== undefined) return;
    await this.helper.start();
    if (!this.activityEnabled) return;
    this.timer = setInterval(() => {
      const tick = this.service.tick().catch((error) => {
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

  async stop() {
    this.clearTimer();
    await Promise.allSettled([...this.activeTicks]);
    await this.helper.stop();
  }

  private clearTimer() {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private push(signal: NativeActivitySignal) {
    const frozen = this.coordinator.observe(signal, {
      contentChanged: this.service.shouldAdvanceContentEpoch(signal),
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
    this.service.push(
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
  config: ScreenObservationConfig,
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
