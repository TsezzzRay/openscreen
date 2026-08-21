import { join } from "node:path";

import { BrowserWindow, screen, shell } from "electron";

import { rendererEntry } from "../renderer-entry.ts";

export const OVERLAY_WIDTH = 720;
export const OVERLAY_COLLAPSED_HEIGHT = 60;
export const OVERLAY_MAX_HEIGHT = 640;
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
    height: OVERLAY_COLLAPSED_HEIGHT,
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

/** The window height a given content height maps to, clamped to the panel's range. */
export function overlayHeight(contentHeight: number): number {
  if (!Number.isFinite(contentHeight)) return OVERLAY_COLLAPSED_HEIGHT;
  return Math.round(
    Math.min(OVERLAY_MAX_HEIGHT, Math.max(OVERLAY_COLLAPSED_HEIGHT, contentHeight)),
  );
}

/**
 * Grows or shrinks the overlay around its own top edge so the command bar stays
 * put while the answer panel expands below it.
 */
export function resizeOverlay(window: BrowserWindow, contentHeight: number): void {
  const bounds = window.getBounds();
  const height = overlayHeight(contentHeight);
  if (height === bounds.height) return;
  window.setBounds({ ...bounds, height }, false);
}

export const overlayPreloadPath = (root: string): string => join(root, "preload", "index.mjs");
