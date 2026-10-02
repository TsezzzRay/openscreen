import { BrowserWindow, shell } from "electron";

import { rendererEntry } from "../renderer-entry.ts";

/**
 * The full application window: sessions, history, transcript, and settings.
 * The window carries the sidebar material so the chat list reads as a macOS
 * source list; the renderer paints the conversation pane opaque on top of it.
 */
export function createMainWindow(preload: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "OpenScreen",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 18 },
    vibrancy: "sidebar",
    backgroundColor: "#00000000",
    webPreferences: { preload, sandbox: false },
  });

  // Deliberately not content-protected. Unlike the overlay, this is an ordinary
  // window the user may want to screenshot; it stays out of the recorder through
  // the `capture.screenpipe.ignoredWindows` title filter in config.json instead.

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void window.loadURL(rendererEntry("main"));
  return window;
}
