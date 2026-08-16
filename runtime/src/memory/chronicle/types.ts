export interface ChronicleFrameInput {
  sourceId: string;
  generationId: string;
  frameId: string;
  monitorKey: string;
  deviceName: string;
  capturedAt: string;
  trigger: string;
  application?: string;
  windowTitle?: string;
  url?: string;
  visibleText?: string;
}

export interface ChronicleFrameProjection extends ChronicleFrameInput {
  type: "screenpipe_frame";
}

export interface ChronicleWindowInput {
  type: "chronicle_window";
  frames: ChronicleFrameProjection[];
}

export interface ChronicleActivity {
  summary: string;
  sourceFrameIds: string[];
  application?: string;
  windowTitle?: string;
}

export interface ChronicleSummary {
  activities: ChronicleActivity[];
  sourceSummary: string;
}
