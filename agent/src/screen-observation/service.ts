import {
  Dedupe,
  windowKey,
} from "./dedupe.js";
import { buildObservation } from "./observation.js";
import {
  CapturePlanner,
  isBoundaryKind,
} from "./scheduler.js";
import type {
  ScreenObservationConfig,
} from "../config.js";
import type {
  NativeActivitySignal,
  NativeCaptureResult,
} from "./protocol.js";
import type {
  ScreenObservation,
} from "./types.js";

type ScreenObservationServiceOptions = {
  config: ScreenObservationConfig;
  capture: (signal: NativeActivitySignal) => Promise<NativeCaptureResult>;
  onObservation: (observation: ScreenObservation) => void;
};

export class ScreenObservationService {
  private readonly planner: CapturePlanner;
  private readonly dedupe: Dedupe;
  private deferredSignal?: NativeActivitySignal;
  private lastCaptureAtMilliseconds = Number.NEGATIVE_INFINITY;
  private capturing = false;

  constructor(private readonly options: ScreenObservationServiceOptions) {
    this.planner = new CapturePlanner(options.config.scheduling);
    this.dedupe = new Dedupe(
      options.config.deduplication.visualDifferenceThreshold,
    );
  }

  push(signal: NativeActivitySignal, nowMilliseconds = Date.now()) {
    if (isBoundaryKind(signal.kind)) this.deferredSignal = undefined;
    this.planner.push(signal, nowMilliseconds);
  }

  async tick(nowMilliseconds = Date.now()) {
    if (this.capturing) return;
    const due = this.planner.takeDue(nowMilliseconds);
    if (due.length > 0) {
      this.deferredSignal = due
        .map((capture) => capture.signal)
        .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))
        .at(-1);
    }
    const signal = this.deferredSignal;
    if (signal === undefined) return;

    const boundaryRequested = isBoundaryKind(signal.kind) &&
      this.dedupe.isNewWindow(signal.window);
    if (
      !boundaryRequested &&
      nowMilliseconds - this.lastCaptureAtMilliseconds <
        this.options.config.scheduling.ordinaryCaptureGapMilliseconds
    ) return;

    this.deferredSignal = undefined;
    this.capturing = true;
    this.lastCaptureAtMilliseconds = nowMilliseconds;
    try {
      const result = await this.options.capture(signal);
      if (windowKey(result.window) !== windowKey(signal.window)) return;
      if (!this.dedupe.accept(result, boundaryRequested)) return;
      await this.options.onObservation(buildObservation(signal, result));
    } finally {
      this.capturing = false;
    }
  }
}
