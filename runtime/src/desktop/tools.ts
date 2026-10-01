import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { textResult } from "../agent/pi/tools/tool-support.js";
import type { DesktopDriverOptions } from "./api.js";
import type { DesktopActions } from "./actions.js";

export function createDesktopTools(options: DesktopDriverOptions, actions: DesktopActions): AgentTool[] {
  const desktopWindows = options.desktopWindows;
  const baseTools: AgentTool[] = [];
  if (desktopWindows !== undefined) {
    const parameters = Type.Object({}, { additionalProperties: false });
    baseTools.push({
      name: "desktop_windows",
      label: "Desktop windows",
      description: "List visible desktop windows without changing the desktop. Window IDs are exact strings.",
      parameters,
      executionMode: "sequential",
      execute: async () => {
        const windows = await actions.withDesktopLock(desktopWindows);
        return textResult(JSON.stringify({
          observedAt: new Date().toISOString(),
          windows: windows.slice(0, 100).map(window => ({
            windowId: window.windowId.toString(),
            ...(window.pid === undefined ? {} : { pid: window.pid }),
            appName: [...window.appName].slice(0, 200).join(""),
            title: [...window.title].slice(0, 200).join(""),
          })),
          truncated: windows.length > 100,
        }));
      },
    });
  }
  const desktopWindowState = options.desktopWindowState;
  if (desktopWindowState !== undefined) {
    baseTools.push({
      name: "desktop_window_state",
      label: "Desktop window state",
      description: "Read the accessibility state and screenshot of an exact desktop window without changing it. Use pid and windowId from desktop_windows.",
      parameters: Type.Object({
        pid: Type.Integer({ minimum: 1 }),
        windowId: Type.String({ pattern: "^[1-9][0-9]*$" }),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: async (_callId, params: unknown) => {
        return actions.readWindow(params);
      },
    });
  }
  if (desktopWindowState !== undefined && options.desktopClick !== undefined) {
    baseTools.push({
      name: "desktop_click",
      label: "Desktop click",
      description: "Click in the most recently observed exact window using background delivery only. The first action in an app requires conversation-scoped approval. Coordinates are pixels in that window's screenshot; no foreground retry.",
      parameters: Type.Object({
        observationId: Type.String({ minLength: 1 }),
        position: Type.Union([
          Type.Object({ kind: Type.Literal("coordinates"), x: Type.Number({ minimum: 0 }), y: Type.Number({ minimum: 0 }) }, { additionalProperties: false }),
          Type.Object({ kind: Type.Literal("element"), elementToken: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        ]),
        deliveryMode: Type.Literal("background"),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: (_callId, params) => actions.clickDesktop(params),
    });
  }
  if (desktopWindowState !== undefined && options.desktopScroll !== undefined) {
    baseTools.push({
      name: "desktop_scroll",
      label: "Desktop scroll",
      description: "Scroll once in the most recently observed exact window using background window input. Requires its observationId. The first action in an app requires conversation-scoped approval. Coordinates are window-local screenshot pixels; no foreground retry.",
      parameters: Type.Object({
        observationId: Type.String({ minLength: 1 }),
        x: Type.Number({ minimum: 0 }),
        y: Type.Number({ minimum: 0 }),
        direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
        by: Type.Union([Type.Literal("line"), Type.Literal("page")]),
        amount: Type.Integer({ minimum: 1, maximum: 20 }),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: (_callId, params) => actions.scrollDesktop(params),
    });
  }
  if (desktopWindowState !== undefined && options.desktopClick !== undefined && options.desktopType !== undefined && options.createDesktopFocusGuard !== undefined) {
    baseTools.push({
      name: "desktop_type",
      label: "Desktop type",
      description: "Type into one observed text element after conversation-scoped app approval. Uses only background window input; native focus and field value are checked during segmented input. If background focus fails, no foreground retry occurs.",
      parameters: Type.Object({
        observationId: Type.String({ minLength: 1 }),
        elementToken: Type.String({ minLength: 1 }),
        text: Type.String({ minLength: 1, maxLength: 4000 }),
      }, { additionalProperties: false }),
      executionMode: "sequential",
      execute: (_callId, params) => actions.typeDesktop(params),
    });
  }

  return baseTools;
}
