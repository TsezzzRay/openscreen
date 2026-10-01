import { createHash } from "node:crypto";
import { ExecutionError } from "@earendil-works/pi-agent-core";
import type { DesktopClickInput, DesktopClickResult, DesktopScrollInput, DesktopCallContext, DesktopWindowState, DesktopActionTarget, DesktopApprovalTarget } from "./api.js";
import { DesktopObservations } from "./observation.js";

type DesktopElement = NonNullable<DesktopWindowState["elements"]>[number];

function matchingElements(state: DesktopWindowState, source: DesktopElement): DesktopElement[] {
  return (state.elements ?? []).filter(element => element.elementToken && element.enabled !== false &&
    element.role === source.role && element.label === source.label && element.value === source.value &&
    JSON.stringify(element.frame) === JSON.stringify(source.frame));
}

function elementCoordinates(state: DesktopWindowState, element: DesktopElement, failureMessage: string): { x: number; y: number } {
  const bounds = state.windowBounds;
  const frame = element.frame;
  if (!bounds || !frame || ![bounds.x, bounds.y, bounds.width, bounds.height, frame.x, frame.y, frame.w, frame.h,
    state.screenshotWidth, state.screenshotHeight].every(item => typeof item === "number" && Number.isFinite(item)) ||
    bounds.width <= 0 || bounds.height <= 0 || frame.w <= 0 || frame.h <= 0 ||
    state.screenshotWidth! <= 0 || state.screenshotHeight! <= 0 ||
    frame.x < bounds.x || frame.y < bounds.y || frame.x + frame.w > bounds.x + bounds.width ||
    frame.y + frame.h > bounds.y + bounds.height) throw new Error(failureMessage);
  return { x: (frame.x + frame.w / 2 - bounds.x) * state.screenshotWidth! / bounds.width,
    y: (frame.y + frame.h / 2 - bounds.y) * state.screenshotHeight! / bounds.height };
}

function isUnsupportedAXPress(error: unknown): boolean {
  const refusal = error as { tag?: string; inner?: { tool?: string; message?: string } } | null;
  return refusal?.tag === "Tool" && refusal.inner?.tool === "click" &&
    refusal.inner.message?.endsWith("AXUIElementPerformAction(AXPress) returned -25206") === true;
}

export class DesktopActions extends DesktopObservations {
  async clickDesktop(params: unknown) {
    const click = this.options.desktopClick;
    if (!click) throw new Error("Desktop click lacks a valid task context");
    if (typeof params !== "object" || params === null || !("observationId" in params) ||
      !("position" in params) || !("deliveryMode" in params) ||
      typeof params.observationId !== "string" ||
      params.deliveryMode !== "background" ||
      typeof params.position !== "object" || params.position === null || !("kind" in params.position)) {
      throw new Error("Invalid desktop click arguments; background only");
    }
    const rawPosition = params.position;
    const deliveryMode = params.deliveryMode;
    let position: DesktopClickInput["position"];
    if (rawPosition.kind === "coordinates" && "x" in rawPosition && "y" in rawPosition &&
      typeof rawPosition.x === "number" && typeof rawPosition.y === "number" &&
      Number.isFinite(rawPosition.x) && Number.isFinite(rawPosition.y)) {
      position = { x: rawPosition.x, y: rawPosition.y };
    } else if (rawPosition.kind === "element" && "elementToken" in rawPosition &&
      typeof rawPosition.elementToken === "string" && rawPosition.elementToken.length > 0) {
      position = { elementToken: rawPosition.elementToken };
    } else throw new Error("Invalid desktop click position");
    const { call, observe, first, screenshot, targetSource } = this.takeDesktopActionObservation("click", params.observationId);
    if ("x" in position && (position.x < 0 || position.y < 0 ||
      !Number.isFinite(first.screenshotWidth) || !Number.isFinite(first.screenshotHeight) ||
      position.x >= first.screenshotWidth! || position.y >= first.screenshotHeight!)) {
      throw new Error("Desktop click coordinates are outside the observed window screenshot");
    }
    const originalElementToken = "elementToken" in position ? position.elementToken : undefined;
    if (originalElementToken !== undefined && !first.elements?.some(element => element.elementToken === originalElementToken && element.enabled !== false)) {
      throw new Error("Desktop click element was not present and enabled in the observation");
    }
    const target: DesktopActionTarget = {
      action: "click",
      ...targetSource,
      deliveryMode,
      position,
    };
    const authorized = await this.hooks.authorize(first, screenshot, target);
    if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop click was cancelled before execution");
    return this.withDesktopLock(async () => {
      if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop click was cancelled before execution");
      const current = await observe({ pid: first.pid, windowId: first.windowId });
      if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop click was cancelled before execution");
      const currentApp = await this.hooks.app(current.pid, current.appName);
      if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop click was cancelled before execution");
      if (current.pid !== first.pid || current.windowId !== first.windowId ||
        currentApp.bundleId !== authorized.app.bundleId ||
        current.screenshotFrameValid !== true) {
        throw new Error("Desktop window changed after approval; no click executed. Observe and approve again");
      }
      if (originalElementToken !== undefined) {
        const source = first.elements!.find(element => element.elementToken === originalElementToken)!;
        const matches = matchingElements(current, source);
        if (matches.length !== 1) throw new Error("Desktop element changed after approval; no click executed");
        position = { elementToken: matches[0]!.elementToken! };
      }
      const result = await this.dispatchApprovedDesktopAction(call, authorized.approvalId, authorized.target,
        async () => {
          try {
            return await click({ pid: first.pid, windowId: first.windowId, position, deliveryMode });
          } catch (error) {
            if (originalElementToken === undefined || !isUnsupportedAXPress(error)) throw error;
            if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop click was cancelled before coordinate fallback");
            const fresh = await observe({ pid: first.pid, windowId: first.windowId });
            const freshApp = await this.hooks.app(fresh.pid, fresh.appName);
            const source = first.elements!.find(element => element.elementToken === originalElementToken)!;
            const matches = matchingElements(fresh, source);
            if (call.signal?.aborted || fresh.pid !== first.pid || fresh.windowId !== first.windowId ||
              freshApp.bundleId !== authorized.app.bundleId || fresh.screenshotFrameValid !== true || matches.length !== 1) {
              throw new Error("Desktop element changed before coordinate fallback; no coordinate click executed");
            }
            const coordinates = elementCoordinates(fresh, matches[0]!, "Desktop click fallback lacks an unambiguous in-window element frame");
            if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop click was cancelled before coordinate fallback");
            return click({ pid: first.pid, windowId: first.windowId, deliveryMode, position: coordinates });
          }
        });
      return this.desktopPostObservation(observe, first, result);
    });
  }

  async typeDesktop(params: unknown) {
    const click = this.options.desktopClick;
    const type = this.options.desktopType;
    const createGuard = this.options.createDesktopFocusGuard;
    if (!click || !type || !createGuard) throw new Error("Desktop typing is unavailable");
    if (typeof params !== "object" || params === null ||
      !("observationId" in params) || typeof params.observationId !== "string" ||
      !("elementToken" in params) || typeof params.elementToken !== "string" || !params.elementToken ||
      !("text" in params) || typeof params.text !== "string" || !params.text || [...params.text].length > 4000) {
      throw new Error("Invalid desktop type arguments");
    }
    const inputText = params.text;
    const { call, observe, first, screenshot, targetSource } = this.takeDesktopActionObservation("type", params.observationId);
    const source = first.elements?.find(element => element.elementToken === params.elementToken && element.enabled !== false);
    if (!source || !source.frame || !["AXTextField", "AXTextArea", "AXTextView", "AXSearchField", "AXComboBox"].includes(source.role)) {
      throw new Error("Desktop type requires an observed enabled text element with a frame");
    }
    const target: DesktopActionTarget = {
      action: "type", ...targetSource,
      elementToken: params.elementToken, role: source.role, label: source.label, frame: source.frame,
      textSha256: createHash("sha256").update(params.text).digest("hex"), textLength: [...params.text].length,
    };
    const authorized = await this.hooks.authorize(first, screenshot, target);
    if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop type was cancelled before execution");
    return this.withDesktopLock(async () => {
      if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop type was cancelled before execution");
      const current = await observe({ pid: first.pid, windowId: first.windowId });
      const currentApp = await this.hooks.app(current.pid, current.appName);
      if (current.pid !== first.pid || current.windowId !== first.windowId ||
        currentApp.bundleId !== authorized.app.bundleId ||
        current.screenshotFrameValid !== true) {
        throw new Error("Desktop window changed after approval; no text entered");
      }
      const matches = matchingElements(current, source);
      if (matches.length !== 1) throw new Error("Desktop input element changed after approval; no text entered");
      const guard = await createGuard({ pid: first.pid, windowId: first.windowId, windowTitle: current.windowTitle ?? "", screenshotWidth: current.screenshotWidth!, element: matches[0]! });
      let dispatched = false;
      try {
        if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop type was cancelled before focusing");
        dispatched = true;
        let clickResult: DesktopClickResult;
        try {
          clickResult = await click({ pid: first.pid, windowId: first.windowId,
            position: { elementToken: matches[0]!.elementToken! }, deliveryMode: "background" });
        } catch (error) {
          if (!isUnsupportedAXPress(error) || !guard.focus) throw error;
          const refresh = async () => {
            if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop type was cancelled before focus fallback");
            const state = await observe({ pid: first.pid, windowId: first.windowId });
            const app = await this.hooks.app(state.pid, state.appName);
            const candidates = matchingElements(state, source);
            if (call.signal?.aborted || state.pid !== first.pid || state.windowId !== first.windowId ||
              app.bundleId !== authorized.app.bundleId || state.screenshotFrameValid !== true || candidates.length !== 1) {
              throw new Error("Desktop input changed before focus fallback; no text entered");
            }
            return { state, input: candidates[0]! };
          };
          await refresh();
          if (await guard.focus()) {
            clickResult = { effect: "confirmed", summary: "AXFocused set on the verified input element." };
          } else {
            const { state, input } = await refresh();
            if (!guard.verifyTarget) throw new Error("Native target verification is unavailable for coordinate fallback");
            await guard.verifyTarget();
            if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop type was cancelled before coordinate fallback");
            const coordinates = elementCoordinates(state, input, "Desktop focus fallback lacks an unambiguous in-window element frame");
            clickResult = await click({ pid: first.pid, windowId: first.windowId, deliveryMode: "background",
              position: coordinates });
          }
        }
        if (clickResult.effect !== "confirmed" && clickResult.effect !== "unverifiable") {
          throw new Error("Desktop driver refused or only partially executed focus click");
        }
        let previous = await guard.arm();
        const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(inputText)].map(item => item.segment);
        for (let index = 0; index < graphemes.length; index += 32) {
          if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop type was cancelled after partial input");
          const chunk = graphemes.slice(index, index + 32).join("");
          const before = await guard.check();
          if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop type was cancelled before sending the next text segment");
          if (!Number.isSafeInteger(before.selectionStart) || !Number.isSafeInteger(before.selectionLength) ||
            before.selectionStart < 0 || before.selectionLength < 0 ||
            before.selectionStart + before.selectionLength > before.value.length) {
            throw new Error("Focused input selection is unavailable or invalid");
          }
          if (before.value !== previous.value || before.selectionStart !== previous.selectionStart ||
            before.selectionLength !== previous.selectionLength) {
            throw new Error("Focused input value or selection changed between text segments");
          }
          const expectedValue = previous.value.slice(0, previous.selectionStart) + chunk +
            previous.value.slice(previous.selectionStart + previous.selectionLength);
          const result = await type({ pid: first.pid, windowId: first.windowId, text: chunk });
          if (result.effect !== "confirmed") throw new Error("Desktop driver did not confirm a text chunk");
          const currentValue = await guard.check();
          if (currentValue.value !== expectedValue ||
            currentValue.selectionStart !== previous.selectionStart + chunk.length || currentValue.selectionLength !== 0) {
            throw new Error("Focused input value did not confirm the entered text");
          }
          previous = currentValue;
        }
        await guard.close();
        await this.recordActionReceipt("executed", call, authorized.approvalId, authorized.target);
        return this.desktopPostObservation(observe, first, { effect: "confirmed", summary: "Approved text entered into the verified focused element." });
      } catch (error) {
        try { await guard.close(); } catch { /* Original action uncertainty takes precedence. */ }
        if (dispatched) {
          await this.recordActionReceipt("uncertain", call, authorized.approvalId, authorized.target, error);
        }
        throw error;
      }
    });
  }

  async scrollDesktop(params: unknown) {
    const scroll = this.options.desktopScroll;
    if (!scroll) throw new Error("Desktop scroll lacks a valid task context");
    if (typeof params !== "object" || params === null ||
      !("observationId" in params) || typeof params.observationId !== "string" ||
      !("x" in params) || typeof params.x !== "number" || !Number.isFinite(params.x) ||
      !("y" in params) || typeof params.y !== "number" || !Number.isFinite(params.y) ||
      !("direction" in params) || typeof params.direction !== "string" || !["up", "down", "left", "right"].includes(params.direction) ||
      !("by" in params) || typeof params.by !== "string" || !["line", "page"].includes(params.by) ||
      !("amount" in params) || typeof params.amount !== "number" ||
      !Number.isInteger(params.amount) || params.amount < 1 || params.amount > 20) {
      throw new Error("Invalid desktop scroll arguments");
    }
    const { call, observe, first, screenshot, targetSource } = this.takeDesktopActionObservation("scroll", params.observationId);
    if (!Number.isFinite(first.screenshotWidth) || !Number.isFinite(first.screenshotHeight) ||
      params.x < 0 || params.y < 0 || params.x >= first.screenshotWidth! || params.y >= first.screenshotHeight!) {
      throw new Error("Desktop scroll requires a valid window screenshot and in-bounds coordinates");
    }
    const input: DesktopScrollInput = {
      pid: first.pid,
      windowId: first.windowId,
      x: params.x,
      y: params.y,
      direction: params.direction as DesktopScrollInput["direction"],
      by: params.by as DesktopScrollInput["by"],
      amount: params.amount,
    };
    const target: DesktopActionTarget = {
      action: "scroll",
      ...targetSource,
      x: input.x,
      y: input.y,
      direction: input.direction,
      by: input.by,
      amount: input.amount,
    };
    const authorized = await this.hooks.authorize(first, screenshot, target);
    if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop scroll was cancelled before execution");
    return this.withDesktopLock(async () => {
      if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop scroll was cancelled before execution");
      const current = await observe({ pid: first.pid, windowId: first.windowId });
      if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop scroll was cancelled before execution");
      const currentApp = await this.hooks.app(current.pid, current.appName);
      if (call.signal?.aborted) throw new ExecutionError("aborted", "Desktop scroll was cancelled before execution");
      if (current.pid !== first.pid || current.windowId !== first.windowId ||
        currentApp.bundleId !== authorized.app.bundleId ||
        current.screenshotFrameValid !== true) {
        throw new Error("Desktop window changed after approval; no scroll executed. Observe and approve again");
      }
      const result = await this.dispatchApprovedDesktopAction(call, authorized.approvalId, authorized.target, () => scroll(input));
      return this.desktopPostObservation(observe, first, result);
    });
  }

  private async dispatchApprovedDesktopAction(
    call: DesktopCallContext,
    approvalId: string,
    target: DesktopApprovalTarget,
    dispatch: () => Promise<DesktopClickResult>,
  ): Promise<DesktopClickResult> {
    let result: DesktopClickResult;
    try {
      result = await dispatch();
    } catch (error) {
      await this.recordActionReceipt("uncertain", call, approvalId, target, error);
      throw error;
    }
    if (result.effect === "refused") throw new Error(result.summary ?? `Desktop driver refused the ${target.action}`);
    await this.recordActionReceipt("executed", call, approvalId, target);
    return result;
  }

  private async recordActionReceipt(status: "executed" | "uncertain", call: DesktopCallContext,
    approvalId: string, target: DesktopApprovalTarget, error?: unknown): Promise<void> {
    const tool = `desktop_${target.action}` as "desktop_click" | "desktop_scroll" | "desktop_type";
    await this.hooks.recordOutcome(status === "executed"
      ? { type: "security-tool-committed", id: approvalId, callId: call.id, tool, target }
      : { type: "security-desktop-execution-uncertain", id: approvalId, callId: call.id, tool, target,
          reason: error instanceof Error ? error.message : String(error) });
  }
}
