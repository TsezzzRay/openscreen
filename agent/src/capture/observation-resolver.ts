import { randomUUID } from "node:crypto";

import type { CaptureArtifact } from "./artifact.js";
import {
  compareObservationContent,
  contentSignature,
  type ObservationContentComparison,
  type ObservationContentSignature,
} from "./dedupe.js";
import {
  buildObservation,
  type ScreenObservation,
} from "./observation.js";
import { isBoundaryKind } from "./scheduler.js";
import type { CaptureDiagnosticsSink } from "./diagnostics.js";

export type ObservationResolution = {
  decision: "created" | "reused";
  observationId: string;
};

type ObservationResolverOptions = {
  persist: (observation: ScreenObservation) => void | Promise<void>;
  makeObservationId?: () => string;
  diagnostics?: CaptureDiagnosticsSink;
  now?: () => number;
  visualChangeThreshold?: number;
};

type Candidate = {
  observation: ScreenObservation;
  signature: ObservationContentSignature;
};

export class ObservationResolver {
  private previous?: {
    observationId: string;
    signature: ObservationContentSignature;
  };
  private readonly candidates = new Map<string, Candidate>();
  private readonly observationByRevision = new Map<number, string>();
  private readonly pendingByCapture = new Map<
    string,
    Promise<ObservationResolution>
  >();
  private readonly pendingByRevision = new Map<
    number,
    Promise<ObservationResolution>
  >();
  private readonly makeObservationId: () => string;
  private readonly now: () => number;

  constructor(private readonly options: ObservationResolverOptions) {
    this.makeObservationId = options.makeObservationId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  resolve(artifact: CaptureArtifact): Promise<ObservationResolution> {
    const existingObservationId = this.observationByRevision.get(
      artifact.activityRevision,
    );
    if (existingObservationId !== undefined) {
      const resolution = {
        decision: "reused",
        observationId: existingObservationId,
      } as const;
      this.emitResolved(artifact, resolution);
      return Promise.resolve(resolution);
    }

    const sameCapture = this.pendingByCapture.get(artifact.captureId);
    if (sameCapture !== undefined) return this.reuse(artifact, sameCapture);
    const sameRevision = this.pendingByRevision.get(artifact.activityRevision);
    if (sameRevision !== undefined) return this.reuse(artifact, sameRevision);

    const candidate = this.candidate(artifact);
    const previous = this.previous;
    const comparison = compareObservationContent(
      previous?.signature,
      candidate.signature,
      isBoundaryKind(artifact.signal.kind),
      this.options.visualChangeThreshold,
    );
    if (
      previous !== undefined &&
      !comparison.shouldEmit
    ) {
      this.candidates.delete(artifact.captureId);
      this.rememberRevision(
        artifact.activityRevision,
        previous.observationId,
      );
      const resolution = {
        decision: "reused",
        observationId: previous.observationId,
      } as const;
      this.emitResolved(artifact, resolution, undefined, comparison);
      return Promise.resolve(resolution);
    }

    const persistenceStartedAt = this.now();
    const pending = Promise.resolve(this.options.persist(candidate.observation))
      .then(() => {
        this.candidates.delete(artifact.captureId);
        this.previous = {
          observationId: candidate.observation.id,
          signature: candidate.signature,
        };
        this.rememberRevision(
          artifact.activityRevision,
          candidate.observation.id,
        );
        const resolution = {
          decision: "created" as const,
          observationId: candidate.observation.id,
        };
        this.emitResolved(
          artifact,
          resolution,
          Math.max(0, this.now() - persistenceStartedAt),
          comparison,
        );
        return resolution;
      })
      .catch((error) => {
        this.options.diagnostics?.emit({
          event: "observation.resolved",
          captureId: artifact.captureId,
          observationId: candidate.observation.id,
          activityRevision: artifact.activityRevision,
          result: "unavailable",
          reason: "persistence_failed",
          persistenceMs: Math.max(0, this.now() - persistenceStartedAt),
        });
        throw error;
      });
    this.pendingByCapture.set(artifact.captureId, pending);
    this.pendingByRevision.set(artifact.activityRevision, pending);
    const clear = () => {
      if (this.pendingByCapture.get(artifact.captureId) === pending) {
        this.pendingByCapture.delete(artifact.captureId);
      }
      if (this.pendingByRevision.get(artifact.activityRevision) === pending) {
        this.pendingByRevision.delete(artifact.activityRevision);
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  private candidate(artifact: CaptureArtifact) {
    const existing = this.candidates.get(artifact.captureId);
    if (existing !== undefined) return existing;
    const candidate = {
      observation: buildObservation(
        artifact.signal,
        artifact.result,
        {
          id: this.makeObservationId(),
          captureId: artifact.captureId,
          activityRevision: artifact.activityRevision,
        },
      ),
      signature: contentSignature(artifact.result),
    };
    this.candidates.set(artifact.captureId, candidate);
    return candidate;
  }

  private rememberRevision(activityRevision: number, observationId: string) {
    this.observationByRevision.set(activityRevision, observationId);
    while (this.observationByRevision.size > 64) {
      const oldest = this.observationByRevision.keys().next().value;
      if (oldest === undefined) break;
      this.observationByRevision.delete(oldest);
    }
  }

  private async reuse(
    artifact: CaptureArtifact,
    pending: Promise<ObservationResolution>,
  ): Promise<ObservationResolution> {
    const result = await pending;
    const resolution = {
      decision: "reused" as const,
      observationId: result.observationId,
    };
    this.emitResolved(artifact, resolution);
    return resolution;
  }

  private emitResolved(
    artifact: CaptureArtifact,
    resolution: ObservationResolution,
    persistenceMs?: number,
    comparison?: ObservationContentComparison,
  ) {
    this.options.diagnostics?.emit({
      event: "observation.resolved",
      captureId: artifact.captureId,
      observationId: resolution.observationId,
      activityRevision: artifact.activityRevision,
      activityKind: artifact.signal.kind,
      result: resolution.decision,
      ...(persistenceMs === undefined ? {} : { persistenceMs }),
      ...(comparison === undefined
        ? {}
        : {
          semanticChanged: comparison.semanticChanged,
          visualChanged: comparison.visualChanged,
          ...(comparison.visualDistance === undefined
            ? {}
            : { visualDistance: comparison.visualDistance }),
        }),
    });
  }
}
