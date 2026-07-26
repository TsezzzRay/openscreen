import { join } from "node:path";

import { NativeHelperClient } from "./native-helper.js";
import { ScreenObservationService } from "./service.js";
import type { ScreenObservation } from "./types.js";

type ScreenObservationRuntimeOptions = {
  helperCommand?: string;
  helperArguments?: string[];
  helperEnvironment?: NodeJS.ProcessEnv;
  tickIntervalMilliseconds?: number;
  onObservation?: (observation: ScreenObservation) => void;
};

export class ScreenObservationRuntime {
  private readonly helper: NativeHelperClient;
  private readonly service: ScreenObservationService;
  private readonly tickIntervalMilliseconds: number;
  private timer?: NodeJS.Timeout;

  latestObservation?: ScreenObservation;

  constructor(options: ScreenObservationRuntimeOptions = {}) {
    this.tickIntervalMilliseconds = options.tickIntervalMilliseconds ?? 100;
    let helper!: NativeHelperClient;
    this.service = new ScreenObservationService({
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
      onSignal: (signal) => this.service.push(signal),
      onLifecycle: (state) => {
        if (state === "degraded") {
          process.stderr.write("OpenScreen observation helper is unavailable\n");
        }
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
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.helper.stop();
  }
}
