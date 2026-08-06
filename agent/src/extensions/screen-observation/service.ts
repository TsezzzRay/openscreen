import {
  Dedupe,
  type ObservationContentSignature,
  windowKey,
} from "./dedupe.js";
import { buildObservation } from "./observation.js";
import {
  CapturePlanner,
  isBoundaryKind,
} from "./scheduler.js";
import type {
  ScreenObservationConfig,
} from "../../config.js";
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
  onObservation: (observation: ScreenObservation) => void | Promise<void>;
};

export class ScreenObservationService {
  private readonly planner: CapturePlanner;
  private readonly dedupe: Dedupe;
  private deferredSignal?: NativeActivitySignal;
  private pendingDelivery?: {
    observation: ScreenObservation;
    signature: ObservationContentSignature;
    retryAtMilliseconds: number;
  };
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
    const pendingDelivery = this.pendingDelivery;
    if (pendingDelivery !== undefined) {
      if (pendingDelivery.retryAtMilliseconds > nowMilliseconds) return;
      this.capturing = true;
      try {
        await this.options.onObservation(pendingDelivery.observation);
        this.dedupe.commit(pendingDelivery.signature);
        this.pendingDelivery = undefined;
      } catch (error) {
        pendingDelivery.retryAtMilliseconds = nowMilliseconds +
          this.options.config.scheduling.ordinaryCaptureGapMilliseconds;
        throw error;
      } finally {
        this.capturing = false;
      }
      return;
    }
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
      const signature = this.dedupe.candidate(result, boundaryRequested);
      if (signature === undefined) return;
      const delivery = {
        observation: buildObservation(signal, result),
        signature,
        retryAtMilliseconds: nowMilliseconds,
      };
      this.pendingDelivery = delivery;
      try {
        await this.options.onObservation(delivery.observation);
        this.dedupe.commit(signature);
        this.pendingDelivery = undefined;
      } catch (error) {
        delivery.retryAtMilliseconds = nowMilliseconds +
          this.options.config.scheduling.ordinaryCaptureGapMilliseconds;
        throw error;
      }
    } finally {
      this.capturing = false;
    }
  }
}
