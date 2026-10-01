import type { WindowStateOutput } from "@trycua/cua-driver";

export interface DesktopWindow {
  windowId: bigint;
  pid?: number;
  appName: string;
  title: string;
}

export interface DesktopClickInput {
  pid: number;
  windowId: bigint;
  position: { x: number; y: number } | { elementToken: string };
  deliveryMode: "background";
}

export interface DesktopClickResult {
  effect: "confirmed" | "partial" | "unverifiable" | "suspected-noop" | "refused";
  summary?: string;
}

export interface DesktopScrollInput {
  pid: number;
  windowId: bigint;
  x: number;
  y: number;
  direction: "up" | "down" | "left" | "right";
  by: "line" | "page";
  amount: number;
}

export interface DesktopFocusGuard {
  focus?(): Promise<boolean>;
  verifyTarget?(): Promise<void>;
  arm(): Promise<{ value: string; selectionStart: number; selectionLength: number }>;
  check(): Promise<{ value: string; selectionStart: number; selectionLength: number }>;
  close(): Promise<void>;
}


export type DesktopWindowState = Partial<WindowStateOutput> & Pick<WindowStateOutput, "pid" | "windowId">;
export interface DesktopAppIdentity { pid: number; appName: string; bundleId?: string }
interface DesktopActionSource {
  pid: number;
  windowId: string;
  appName?: string;
  windowTitle?: string;
  observationId: string;
  screenshotSha256: string;
}
export type DesktopActionTarget = DesktopActionSource & (
  | { action: "click"; deliveryMode: "background"; position: DesktopClickInput["position"] }
  | { action: "scroll"; x: number; y: number; direction: DesktopScrollInput["direction"]; by: DesktopScrollInput["by"]; amount: number }
  | { action: "type"; elementToken: string; role: string; label?: string; frame: NonNullable<NonNullable<DesktopWindowState["elements"]>[number]["frame"]>; textSha256: string; textLength: number }
);
export type DesktopApprovalTarget = DesktopActionTarget & { scope: "application"; appName: string; bundleId: string | null };
export interface DesktopDriverOptions {
  desktopWindows?: () => Promise<DesktopWindow[]>;
  desktopWindowState?: (target: { pid: number; windowId: bigint }) => Promise<DesktopWindowState>;
  desktopClick?: (input: DesktopClickInput) => Promise<DesktopClickResult>;
  desktopScroll?: (input: DesktopScrollInput) => Promise<DesktopClickResult>;
  desktopType?: (input: { pid: number; windowId: bigint; text: string }) => Promise<DesktopClickResult>;
  createDesktopFocusGuard?: (target: { pid: number; windowId: bigint; windowTitle: string; screenshotWidth: number; element: NonNullable<WindowStateOutput["elements"]>[number] }) => Promise<DesktopFocusGuard>;
  now?: () => number;
}
export interface DesktopRunContext {
  desktopObservation?: { id: string; observedAt: number; state: DesktopWindowState };
}
export interface DesktopCallContext {
  id: string;
  signal?: AbortSignal;
}
export type DesktopAuditEvent =
  | { type: "security-tool-committed"; id: string; callId: string; tool: "desktop_click" | "desktop_scroll" | "desktop_type"; target: DesktopApprovalTarget }
  | { type: "security-desktop-execution-uncertain"; id: string; callId: string; tool: "desktop_click" | "desktop_scroll" | "desktop_type"; target: DesktopApprovalTarget; reason: string };
export interface DesktopSecurityHooks {
  run(): DesktopRunContext | undefined;
  call(): DesktopCallContext | undefined;
  app(pid: number, fallbackName?: string): Promise<DesktopAppIdentity>;
  authorize(state: DesktopWindowState, screenshot: { mimeType: string; dataBase64: string }, target: DesktopActionTarget): Promise<{ approvalId: string; target: DesktopApprovalTarget; app: DesktopAppIdentity }>;
  recordOutcome(event: DesktopAuditEvent): Promise<void>;
}
