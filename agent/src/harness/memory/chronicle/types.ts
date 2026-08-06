export type ChronicleObservationProjection = {
  type: "screen_observation";
  sourceId: string;
  occurredAt: string;
  capturedAt: string;
  application: {
    name: string;
    bundleIdentifier?: string;
  };
  windowTitle?: string;
  url?: string;
  focusedElement?: {
    role: string;
    subrole?: string;
    title?: string;
    value?: string;
    identifier?: string;
    description?: string;
    focused?: boolean;
    enabled?: boolean;
    selected?: boolean;
  };
  visibleText: string;
};

export type ChronicleWindowInput = {
  type: "chronicle_window";
  observations: ChronicleObservationProjection[];
};

export type ChronicleActivity = {
  summary: string;
  sourceIds: string[];
  application?: string;
  windowTitle?: string;
};

export type ChronicleSummary = {
  activities: ChronicleActivity[];
  sourceSummary: string;
};
