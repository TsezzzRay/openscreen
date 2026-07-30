import { join } from "node:path";

import {
  NativeHelperClient,
  type HelperComponentStatus,
} from "./native-helper.js";
import { ScreenObservationService } from "./service.js";
import type {
  NativeHelperConfiguration,
  ScreenObservation,
  ScreenObservationConfig,
} from "./types.js";

type ScreenObservationRuntimeOptions = {
  config: ScreenObservationConfig;
  helperCommand?: string;
  helperArguments?: string[];
  helperEnvironment?: NodeJS.ProcessEnv;
  onObservation?: (observation: ScreenObservation) => void;
  onComponentStatus?: (status: HelperComponentStatus) => void;
  onFatalError?: (error: Error) => void;
};

export class ScreenObservationRuntime {
  private readonly helper: NativeHelperClient;
  private readonly service: ScreenObservationService;
  private readonly tickIntervalMilliseconds: number;
  private timer?: NodeJS.Timeout;

  latestObservation?: ScreenObservation;

  constructor(options: ScreenObservationRuntimeOptions) {
    this.tickIntervalMilliseconds = options.config.scheduling.tickIntervalMilliseconds;
    let helper!: NativeHelperClient;
    this.service = new ScreenObservationService({
      config: options.config,
      capture: (signal) => helper.capture(signal),
      onObservation: (observation) => {
        this.latestObservation = observation;
        options.onObservation?.(observation);
      },
    });
    const bundleIdentifier = process.env.OPENSCREEN_BUNDLE_ID;
    helper = new NativeHelperClient({
      command: options.helperCommand ?? (
        process.env.OPENSCREEN_OBSERVATION_HELPER_PATH ??
        join(process.cwd(), ".build", "debug", "OpenScreenObservationHelper")
      ),
      arguments: options.helperArguments,
      environment: options.helperEnvironment,
      currentDirectory: process.cwd(),
      excludedProcessIdentifiers: [process.pid, process.ppid],
      excludedBundleIdentifiers: bundleIdentifier === undefined ? [] : [bundleIdentifier],
      configuration: nativeConfiguration(options.config),
      configurationTimeoutMilliseconds:
        options.config.helperLifecycle.configurationTimeoutMilliseconds,
      captureTimeoutMilliseconds: options.config.capture.requestTimeoutMilliseconds,
      shutdownTimeoutMilliseconds: options.config.helperLifecycle.shutdownTimeoutMilliseconds,
      onSignal: (signal) => this.service.push(signal),
      onComponentStatus: (status) => {
        options.onComponentStatus?.(status);
        if (status.status === "degraded") {
          process.stderr.write(
            `OpenScreen observation ${status.component} is degraded${
              status.message === undefined ? "" : `: ${status.message}`
            }\n`,
          );
        }
      },
      onFatalError: (error) => {
        this.clearTimer();
        options.onFatalError?.(error);
        process.stderr.write(`OpenScreen observation helper failed: ${error.message}\n`);
      },
    });
    this.helper = helper;
  }

  async start() {
    if (this.timer !== undefined) return;
    await this.helper.start();
    this.timer = setInterval(() => {
      void this.service.tick().catch((error) => {
        process.stderr.write(
          `OpenScreen observation capture failed: ${
            error instanceof Error ? error.message : "unknown error"
          }\n`,
        );
      });
    }, this.tickIntervalMilliseconds);
  }

  async stop() {
    this.clearTimer();
    await this.helper.stop();
  }

  private clearTimer() {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

function nativeConfiguration(
  config: ScreenObservationConfig,
): NativeHelperConfiguration {
  return {
    activityMonitoring: config.activityMonitoring,
    accessibility: config.accessibility,
    screenshot: config.screenshot,
    visualMonitoring: config.visualMonitoring,
    windowSelection: config.windowSelection,
  };
}
