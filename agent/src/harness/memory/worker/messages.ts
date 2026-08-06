import type { ScreenObservation } from "../../../extensions/screen-observation/types.js";
import type { MemoryPipelineConfig } from "../types.js";

export type MemoryWorkerData = {
  memoryRoot: string;
  sessionsDirectory: string;
  apiKey: string;
  baseURL: string;
  model: string;
  contextWindowTokens: number;
  memory: MemoryPipelineConfig;
};

export type MemoryWorkerCommand =
  | { type: "observation"; observation: ScreenObservation }
  | { type: "session"; sessionId: string }
  | { type: "tick" }
  | { type: "shutdown" };

export type MemoryWorkerRequest = { requestId: string } & MemoryWorkerCommand;

export type MemoryWorkerResponse =
  | { type: "ready" }
  | { type: "result"; requestId: string }
  | { type: "error"; requestId?: string; message: string };
