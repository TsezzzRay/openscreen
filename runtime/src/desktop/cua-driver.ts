import { ActionTarget, ClickPosition, CuaDriver, InputDeliveryMode, ScrollBy, ScrollDirection } from "@trycua/cua-driver";
import { createNativeDesktopFocusGuard } from "./native-focus-guard.js";
import { desktopActionResult } from "./action-result.js";
import type { DesktopDriverOptions, DesktopAppIdentity } from "./api.js";

export function createCuaDesktopDriver(helperPath: string): DesktopDriverOptions & {
  desktopAppForPid: (pid: number, observedAppName?: string) => Promise<DesktopAppIdentity>;
  close(): Promise<void>;
} {
  let desktopDriver: ReturnType<typeof CuaDriver.create> | undefined;
  return {
    desktopAppForPid: async (pid, observedAppName) => {
      desktopDriver ??= CuaDriver.create(undefined);
      const app = (await desktopDriver.listApps({})).apps.find(item => item.pid === pid);
      return {
        pid,
        appName: app?.name || observedAppName || "Unknown application",
        ...(app?.bundleId ? { bundleId: app.bundleId } : {}),
      };
    },
    desktopWindows: async () => {
      desktopDriver ??= CuaDriver.create(undefined);
      return (await desktopDriver.listWindows({ onScreenOnly: true })).windows;
    },
    desktopWindowState: async ({ pid, windowId }) => {
      desktopDriver ??= CuaDriver.create(undefined);
      return desktopDriver.getWindowState({
        pid,
        windowId,
        includeAccessibilityTree: true,
        includeScreenshot: true,
        maxElements: 100,
        maxDepth: 8,
        maxImageDimension: 1_200,
        timeoutMs: 1_000,
      });
    },
    desktopClick: async ({ pid, windowId, position }) => {
      desktopDriver ??= CuaDriver.create(undefined);
      const result = await desktopDriver.click({
        target: ActionTarget.Window.new({ pid, windowId }),
        position: "elementToken" in position
          ? ClickPosition.Element.new({ elementToken: position.elementToken })
          : ClickPosition.Coordinates.new({ x: position.x, y: position.y }),
        deliveryMode: InputDeliveryMode.Background,
        count: 1,
      });
      return desktopActionResult(result);
    },
    createDesktopFocusGuard: async target => createNativeDesktopFocusGuard({ helperPath, ...target }),
    desktopType: async ({ pid, windowId, text }) => {
      desktopDriver ??= CuaDriver.create(undefined);
      const result = await desktopDriver.typeText({ text, target: ActionTarget.Window.new({ pid, windowId }) });
      if (result.isError || result.action === undefined) {
        throw new Error(result.text || "Desktop driver did not confirm text dispatch");
      }
      return desktopActionResult(result.action, result.text);
    },
    desktopScroll: async ({ pid, windowId, x, y, direction, by, amount }) => {
      desktopDriver ??= CuaDriver.create(undefined);
      const result = await desktopDriver.scroll({
        target: ActionTarget.Window.new({ pid, windowId }),
        x,
        y,
        direction: {
          up: ScrollDirection.Up,
          down: ScrollDirection.Down,
          left: ScrollDirection.Left,
          right: ScrollDirection.Right,
        }[direction],
        by: by === "line" ? ScrollBy.Line : ScrollBy.Page,
        amount: BigInt(amount),
      });
      if (result.isError || result.action === undefined) {
        throw new Error(result.text || "Desktop driver did not confirm scroll dispatch");
      }
      return desktopActionResult(result.action, result.text);
    },
    close: async () => {
      try { await desktopDriver?.shutdown(); }
      finally {
        if (desktopDriver && "uniffiDestroy" in desktopDriver && typeof desktopDriver.uniffiDestroy === "function") desktopDriver.uniffiDestroy();
      }
    },
  };
}
