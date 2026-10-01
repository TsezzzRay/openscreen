import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { WindowElement } from "@trycua/cua-driver";

interface FocusTarget {
  helperPath: string;
  pid: number;
  windowId: bigint;
  windowTitle: string;
  screenshotWidth: number;
  element: WindowElement;
}

type Response = { id: number; ok: boolean; supported?: boolean; value?: string; selectionStart?: number; selectionLength?: number; reason?: string };

export async function createNativeDesktopFocusGuard(target: FocusTarget) {
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || !target.element.frame ||
    !Number.isFinite(target.screenshotWidth) || target.screenshotWidth <= 0) {
    throw new Error("Invalid native focus target");
  }
  const child = spawn(target.helperPath, ["--pid", String(target.pid), "--window-id", String(target.windowId)], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, { command: string; resolve: (response: Response) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;
  let stopped = false;
  let readySettled = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const readyTimer = setTimeout(() => rejectReady(new Error("Native focus guard did not start")), 3000);
  const fail = (error: Error) => {
    if (!readySettled) {
      readySettled = true;
      clearTimeout(readyTimer);
      rejectReady(error);
    }
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
      pending.delete(id);
    }
  };
  child.on("error", error => fail(error));
  child.on("exit", () => { stopped = true; fail(new Error("Native focus guard exited")); });
  lines.on("line", line => {
    let response: Record<string, unknown>;
    try { response = JSON.parse(line) as Record<string, unknown>; }
    catch { fail(new Error("Native focus guard returned invalid JSON")); return; }
    if (response.event === "ready" && !readySettled) {
      readySettled = true;
      clearTimeout(readyTimer);
      resolveReady();
      return;
    }
    if (response.event === "error") {
      fail(new Error(`Native focus guard unavailable: ${String(response.reason ?? "unknown")}`));
      return;
    }
    if (typeof response.id !== "number") return;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.ok !== true) request.reject(new Error(`Native focus guard refused during ${request.command}: ${String(response.reason ?? "unknown")}`));
    else request.resolve(response as Response);
  });
  try { await ready; }
  catch (error) { child.kill(); throw error; }

  const send = async (command: Record<string, unknown>): Promise<Response> => {
    if (stopped || !child.stdin.writable) throw new Error("Native focus guard is unavailable");
    const id = nextId++;
    const result = new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Native focus guard response timed out"));
      }, 2000);
      pending.set(id, { command: String(command.command), resolve, reject, timer });
    });
    child.stdin.write(JSON.stringify({ id, ...command }) + "\n");
    return result;
  };
  const focus = (result: Response) => {
    if (typeof result.value !== "string" || !Number.isSafeInteger(result.selectionStart) ||
      !Number.isSafeInteger(result.selectionLength) || result.selectionStart! < 0 || result.selectionLength! < 0 ||
      result.selectionStart! + result.selectionLength! > result.value.length) {
      throw new Error("Native focus guard did not return a valid input selection");
    }
    return { value: result.value, selectionStart: result.selectionStart!, selectionLength: result.selectionLength! };
  };
  try {
    await send({ command: "bind", windowTitle: target.windowTitle, role: target.element.role,
      label: target.element.label, frame: target.element.frame, screenshotWidth: target.screenshotWidth });
  } catch (error) { child.kill(); throw error; }
  return {
    verifyTarget: async () => { await send({ command: "verify-target" }); },
    focus: async () => {
      const result = await send({ command: "focus" });
      if (typeof result.supported !== "boolean") throw new Error("Native focus guard returned an invalid focus result");
      return result.supported;
    },
    arm: async () => {
      const result = await send({ command: "arm" });
      return focus(result);
    },
    check: async () => {
      const result = await send({ command: "check" });
      return focus(result);
    },
    close: async () => {
      if (stopped) return;
      try { await send({ command: "stop" }); }
      finally { child.kill(); }
    },
  };
}
