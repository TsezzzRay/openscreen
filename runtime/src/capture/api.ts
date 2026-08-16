import type { ScreenFrameSource } from "./screenpipe/frame-source.js";

export type CapturedFrameImage = {
  sourceId: string;
  data: Uint8Array;
  mimeType: "image/jpeg";
};

export type CapturedFrameContext = {
  type: "frames";
  frames: ScreenFrameSource[];
  images: CapturedFrameImage[];
};

export type CapturedContext = CapturedFrameContext;

export interface CaptureService {
  start(): Promise<void>;
  stop(): Promise<void>;
  capture(requestId: string, signal?: AbortSignal): Promise<CapturedContext>;
}
