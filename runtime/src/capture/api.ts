/**
 * One screen, as some backend saw it. Neutral by construction: the prompt path
 * reads the screen live through the native helper, while the background
 * activity history comes from the recorder's stored frames, and neither shape
 * may leak into the other's consumers.
 *
 * Backend-specific provenance is carried in the optional fields; a backend
 * fills what it can prove and omits the rest.
 */
export type CapturedFrame = {
  sourceId: string;
  generationId: string;
  frameId: string;
  monitorKey: string;
  deviceName: string;
  capturedAt: string;
  trigger: string;
  imagePath: string;
  application?: string;
  windowTitle?: string;
  url?: string;
  focused?: boolean;
  visibleText?: string;
};

export type CapturedFrameImage = {
  sourceId: string;
  data: Uint8Array;
  mimeType: "image/jpeg";
};

export type CapturedFrameContext = {
  type: "frames";
  frames: CapturedFrame[];
  images: CapturedFrameImage[];
};

export type CapturedContext = CapturedFrameContext;

export interface CaptureService {
  start(): Promise<void>;
  stop(): Promise<void>;
  capture(requestId: string, signal?: AbortSignal): Promise<CapturedContext>;
}
