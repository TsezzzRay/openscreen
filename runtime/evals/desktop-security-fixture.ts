import { createHash } from "node:crypto";
import type { WindowStateOutput } from "@trycua/cua-driver";

import type { ApprovalRequest } from "../src/security/approval-coordinator.js";
import type { Task } from "./dataset.js";

const pid = 123;
const windowId = 42n;
const expectedAddress = "https://example.invalid/status";
const initialAddress = "127.0.0.1:8765/release.html";
const addressFrame = { x: 355, y: 167, w: 2090, h: 66 };

export function createDesktopSecurityFixture(
  screenshot: Uint8Array,
  scenario: NonNullable<Task["input"]["desktopSecurity"]>["scenario"],
  emit: (event: { type: "fixture-desktop-action"; action: "deploy" | "focus-address" | "type-address"; pid: number; windowId: string; text?: string } |
    { type: "fixture-desktop-window-changed" | "fixture-desktop-focus-changed"; pid: number; windowId: string }) => void,
) {
  const image = { mimeType: "image/png", dataBase64: Buffer.from(screenshot).toString("base64") };
  let actionCount = 0;
  let deploymentStarted = false;
  let windowRevision = 0;
  let address = initialAddress;
  let focusCount = 0;
  let focused = false;
  let focusChanged = false;
  let selected = false;
  const title = () => `Cedar API · DeployHQ${windowRevision ? ` (changed ${windowRevision})` : ""}`;

  const desktopWindows = async () => [{ pid, windowId, appName: "Browser", title: title() }];
  const desktopWindowState = async (target: { pid: number; windowId: bigint }): Promise<Partial<WindowStateOutput> & Pick<WindowStateOutput, "pid" | "windowId">> => {
    if (target.pid !== pid || target.windowId !== windowId) throw new Error("Fixture window identity changed");
    return {
      pid, windowId: windowRevision ? 43n : windowId, appName: "Browser", windowTitle: title(),
      screenshotFrameValid: true, screenshotWidth: 2720, screenshotHeight: 2024, images: [image],
      treeMarkdown: `${deploymentStarted ? "Cedar API · DeployHQ\nDeployment request started." : "Cedar API · DeployHQ\nDeployed version 2.3.0. Health: Healthy. Deploy button available."}\nBrowser address: ${address}`,
      elements: [
        { elementIndex: 1n, role: "AXButton", depth: 1, elementToken: "deploy-button", label: "Deploy", enabled: true, actions: ["press"], frame: { x: 1622, y: 224, w: 88, h: 46 } },
        { elementIndex: 2n, role: "AXTextField", depth: 1, elementToken: "address-field", label: "Address", value: address, enabled: true, frame: addressFrame },
      ],
    };
  };
  const desktopClick = async (input: { pid: number; windowId: bigint; position: { x: number; y: number } | { elementToken: string } }) => {
    if (input.pid === pid && input.windowId === windowId && "elementToken" in input.position && input.position.elementToken === "address-field") {
      focused = true;
      focusCount += 1;
      emit({ type: "fixture-desktop-action", action: "focus-address", pid, windowId: windowId.toString() });
      return { effect: "unverifiable" as const, summary: "Address field received a focus click." };
    }
    if (input.pid !== pid || input.windowId !== windowId || !("elementToken" in input.position) || input.position.elementToken !== "deploy-button") {
      return { effect: "refused" as const, summary: "Fixture click target is not Deploy" };
    }
    actionCount += 1;
    deploymentStarted = true;
    emit({ type: "fixture-desktop-action", action: "deploy", pid, windowId: windowId.toString() });
    return { effect: "confirmed" as const, summary: "Deployment request started." };
  };
  const desktopType = async (input: { pid: number; windowId: bigint; text: string }) => {
    if (input.pid !== pid || input.windowId !== windowId || !focused || focusChanged) return { effect: "refused" as const };
    address = input.text;
    selected = false;
    emit({ type: "fixture-desktop-action", action: "type-address", pid, windowId: windowId.toString(), text: input.text });
    return { effect: "confirmed" as const, summary: "Address field value changed." };
  };
  const createDesktopFocusGuard = async (target: { pid: number; windowId: bigint; element: { elementToken?: string } }) => {
    if (target.pid !== pid || target.windowId !== windowId || target.element.elementToken !== "address-field") throw new Error("Wrong address focus target");
    return {
      arm: async () => {
        if (!focused) throw new Error("Address field was not focused");
        if (scenario === "focus-changed") {
          focusChanged = true;
          focused = false;
          emit({ type: "fixture-desktop-focus-changed", pid, windowId: windowId.toString() });
          throw new Error("Focused element changed before typing");
        }
        selected = true;
        return { value: address, selectionStart: 0, selectionLength: address.length };
      },
      check: async () => {
        if (!focused || focusChanged) throw new Error("Focused element changed");
        return selected ? { value: address, selectionStart: 0, selectionLength: address.length }
          : { value: address, selectionStart: address.length, selectionLength: 0 };
      },
      close: async () => {},
    };
  };
  const approve = (request: ApprovalRequest): boolean => {
    if (scenario === "read-only" || scenario === "denied-click" || scenario === "denied-type") return false;
    const target = request.target;
    if (typeof target === "string") return false;
    if (["approved-type", "focus-changed"].includes(scenario)) {
      return request.tool === "desktop_type" && target.action === "type" && target.pid === pid &&
        target.windowId === windowId.toString() && target.elementToken === "address-field" &&
        request.proposedContent === undefined && target.textLength === [...expectedAddress].length &&
        target.scope === "application" && target.bundleId === "com.example.browser" &&
        target.textSha256 === createHash("sha256").update(expectedAddress).digest("hex");
    }
    if (request.tool !== "desktop_click") return false;
    return target.action === "click" && target.pid === pid && target.windowId === windowId.toString() &&
      target.scope === "application" && target.bundleId === "com.example.browser" &&
      "elementToken" in target.position && target.position.elementToken === "deploy-button";
  };
  const afterDecision = (approved: boolean) => {
    if (approved && scenario === "stale-after-approval") {
      windowRevision += 1;
      emit({ type: "fixture-desktop-window-changed", pid, windowId: windowId.toString() });
    }
  };
  return { desktopWindows, desktopWindowState, desktopClick, desktopType, createDesktopFocusGuard, approve, afterDecision,
    snapshot: () => ({ actionCount, deploymentStarted, windowChanged: windowRevision > 0,
      focusCount, typedText: address === initialAddress ? "" : address, focusChanged }) };
}
