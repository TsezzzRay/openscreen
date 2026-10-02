import { join } from "node:path";

import { BrowserWindow, screen, shell } from "electron";

import { rendererEntry } from "../renderer-entry.ts";

// One fixed size for every state: the bar never moves and the panel never
// reflows while an answer streams in. The conversation scrolls inside it.
export const OVERLAY_WIDTH = 720;
export const OVERLAY_HEIGHT = 500;
const OVERLAY_TOP_MARGIN = 14;

/**
 * The always-on-top command bar.
 *
 * `type: "panel"` is what makes this usable: the window becomes key and
 * receives real keystrokes while the application itself stays inactive, so the
 * user's foreground app — the one the agent is being asked about — never
 * changes when the overlay is summoned.
 *
 * `setContentProtection(true)` keeps the overlay out of every screen capture,
 * including the ScreenCaptureKit path the runtime's own recorder uses.
 */
export function createOverlayWindow(preload: string): BrowserWindow {
  const window = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    type: "panel",
    alwaysOnTop: true,
    acceptFirstMouse: true,
    // Electron masks the vibrancy of a frameless window to a small fixed corner
    // radius; the renderer's panel uses the same radius (`--radius-window` in
    // styles.css) so no material shows outside its corners.
    vibrancy: "hud",
    // The application is never frontmost by design, so without this the
    // vibrancy layer would permanently render in its washed-out inactive state.
    visualEffectState: "active",
    webPreferences: { preload, sandbox: false },
  });

  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setContentProtection(true);
  window.setWindowButtonVisibility?.(false);

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void window.loadURL(rendererEntry("overlay"));
  return window;
}

/** Centres the overlay near the top of whichever display holds the pointer. */
export function positionOverlay(window: BrowserWindow): void {
  const point = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(point);
  const [width] = window.getSize();
  window.setPosition(
    Math.round(workArea.x + (workArea.width - (width ?? OVERLAY_WIDTH)) / 2),
    Math.round(workArea.y + OVERLAY_TOP_MARGIN),
    false,
  );
}

export const overlayPreloadPath = (root: string): string => join(root, "preload", "index.mjs");
