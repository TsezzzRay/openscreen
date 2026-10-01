import { createHash, randomUUID } from "node:crypto";
import { textResult } from "../agent/pi/tools/tool-support.js";
import type { DesktopDriverOptions, DesktopSecurityHooks, DesktopClickResult, DesktopWindowState } from "./api.js";

export class DesktopObservations {
  private desktopTail: Promise<void> = Promise.resolve();
  constructor(protected readonly options: DesktopDriverOptions, protected readonly hooks: DesktopSecurityHooks) {}
  async withDesktopLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.desktopTail;
    let release!: () => void;
    this.desktopTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  }

  async readWindow(params: unknown) {
    const run = this.hooks.run();
    if (!run) throw new Error("Desktop observation requires an active task");
    if (typeof params !== "object" || params === null || !("pid" in params) || !("windowId" in params) ||
      typeof params.pid !== "number" || !Number.isSafeInteger(params.pid) || params.pid <= 0 ||
      typeof params.windowId !== "string" || !/^[1-9][0-9]*$/.test(params.windowId)) {
      throw new Error("Invalid desktop window identity");
    }
    const pid = params.pid;
    const windowId = BigInt(params.windowId);
    const state = await this.withDesktopLock(() => this.options.desktopWindowState!({ pid, windowId }));
    if (state.pid !== pid || state.windowId !== windowId) throw new Error("Desktop window identity changed during observation");
    const treeMarkdown = state.treeMarkdown ?? "";
    const treeCharacters = [...treeMarkdown];
    const screenshot = state.screenshotFrameValid === true &&
      Number.isFinite(state.screenshotWidth) && state.screenshotWidth! > 0 &&
      Number.isFinite(state.screenshotHeight) && state.screenshotHeight! > 0
      ? state.images?.find(image => ["image/png", "image/jpeg"].includes(image.mimeType) && image.dataBase64.length > 0 && image.dataBase64.length <= 8_000_000)
      : undefined;
    const observationId = screenshot === undefined ? undefined : randomUUID();
    run.desktopObservation = observationId === undefined ? undefined : { id: observationId, observedAt: (this.options.now ?? Date.now)(), state };
    const result = textResult(JSON.stringify({
      observedAt: new Date().toISOString(),
      observationId,
      pid: state.pid,
      windowId: state.windowId.toString(),
      snapshotId: state.snapshotId,
      appName: state.appName,
      windowTitle: state.windowTitle,
      treeMarkdown: treeCharacters.slice(0, 20_000).join(""),
      textTruncated: treeCharacters.length > 20_000,
      truncated: state.truncated ?? false,
      degraded: state.degraded ?? false,
      degradedReason: state.degradedReason,
      screenshotAvailable: screenshot !== undefined,
      screenshotWidth: state.screenshotWidth,
      screenshotHeight: state.screenshotHeight,
      elements: (state.elements ?? []).slice(0, 100).map(element => ({
        elementIndex: element.elementIndex.toString(),
        role: element.role,
        depth: element.depth,
        elementToken: element.elementToken,
        label: element.label === undefined ? undefined : [...element.label].slice(0, 500).join(""),
        value: element.value === undefined ? undefined : [...element.value].slice(0, 500).join(""),
        enabled: element.enabled,
        actions: element.actions,
      })),
      elementsTruncated: (state.elements?.length ?? 0) > 100,
    }));
    return screenshot === undefined ? result : {
      ...result,
      content: [...result.content, { type: "image" as const, mimeType: screenshot.mimeType, data: screenshot.dataBase64 }],
    };
  }
  takeDesktopActionObservation(name: "click" | "scroll" | "type", observationId: string) {
    const run = this.hooks.run();
    const call = this.hooks.call();
    const observe = this.options.desktopWindowState;
    if (!run || !call || !observe) throw new Error(`Desktop ${name} lacks a valid task context`);
    const original = run.desktopObservation;
    if (!original || original.id !== observationId) throw new Error("Desktop observation is missing or superseded; observe the window again");
    run.desktopObservation = undefined;
    if ((this.options.now ?? Date.now)() - original.observedAt > 30_000) {
      throw new Error("Desktop observation is stale; observe the window again");
    }
    const first = original.state;
    const screenshot = first.screenshotFrameValid === true
      ? first.images?.find(image => ["image/png", "image/jpeg"].includes(image.mimeType) && image.dataBase64.length > 0 && image.dataBase64.length <= 8_000_000)
      : undefined;
    if (!screenshot) throw new Error(`Desktop ${name} requires a valid window screenshot`);
    const targetSource = {
      pid: first.pid,
      windowId: first.windowId.toString(),
      appName: first.appName,
      windowTitle: first.windowTitle,
      observationId: original.id,
      screenshotSha256: createHash("sha256").update(Buffer.from(screenshot.dataBase64, "base64")).digest("hex"),
    };
    return { call, observe, first, screenshot, targetSource };
  }

  async desktopPostObservation(
    observe: NonNullable<DesktopDriverOptions["desktopWindowState"]>,
    first: DesktopWindowState,
    result: DesktopClickResult,
  ) {
    let after: Awaited<ReturnType<typeof observe>> | undefined;
    let observationError: string | undefined;
    try { after = await observe({ pid: first.pid, windowId: first.windowId }); }
    catch (error) { observationError = error instanceof Error ? error.message : String(error); }
    const output = textResult(JSON.stringify({ effect: result.effect, summary: result.summary, postObservation: after === undefined ? undefined : {
      pid: after.pid, windowId: after.windowId.toString(), appName: after.appName, windowTitle: after.windowTitle,
      degraded: after.degraded ?? false, screenshotAvailable: after.screenshotFrameValid === true && (after.images?.length ?? 0) > 0,
    }, observationError }));
    const image = after?.screenshotFrameValid === true ? after.images?.find(item => ["image/png", "image/jpeg"].includes(item.mimeType) && item.dataBase64.length <= 8_000_000) : undefined;
    return image === undefined ? output : { ...output, content: [...output.content, { type: "image" as const, mimeType: image.mimeType, data: image.dataBase64 }] };
  }

}
