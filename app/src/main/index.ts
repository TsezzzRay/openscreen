import { existsSync } from "node:fs";
import { join } from "node:path";

import { BrowserWindow, app, dialog, ipcMain } from "electron";

import type { AgentStatus, ImportedAttachment } from "@shared/ipc.ts";
import { IPC } from "@shared/ipc.ts";
import type { ApplicationCommand } from "@shared/protocol.ts";

import { AgentClient } from "./agent-client.ts";
import {
  AttachmentStore,
  handleAttachmentScheme,
  registerAttachmentSchemePrivileges,
} from "./attachments.ts";
import { registerToggleHotkey, unregisterHotkeys } from "./hotkey.ts";
import {
  ensureAccessibilityAccess,
  ensureScreenRecordingAccess,
} from "./permissions.ts";
import { createMainWindow } from "./windows/main-window.ts";
import { createOverlayWindow, positionOverlay, resizeOverlay } from "./windows/overlay.ts";

// The development application runs against the current checkout. This path
// owns the built runtime, config.json, local tool working directory, and
// Session grouping key.
const projectRoot = process.cwd();

const preload = join(__dirname, "..", "preload", "index.mjs");
const dataRoot = process.env["OPENSCREEN_DATA_DIR"] ??
  join(app.getPath("home"), "Library", "Application Support", "OpenScreen");

const attachments = new AttachmentStore(join(dataRoot, "user-attachments"));
let agent: AgentClient | undefined;
let overlay: BrowserWindow | undefined;
let mainWindow: BrowserWindow | undefined;
let lastStatus: AgentStatus = { state: "starting" };

registerAttachmentSchemePrivileges();

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(channel, payload);
  }
}

function runtimeEntry(): string {
  const built = join(projectRoot, "runtime", "dist", "main.js");
  if (existsSync(built)) return built;
  throw new Error(
    "runtime/dist/main.js is missing. Run `npm run build:runtime` first.",
  );
}

function startAgent(): void {
  const client = new AgentClient({
    // Electron's own binary in Node mode keeps the runtime under the same
    // development application identity.
    command: process.execPath,
    args: [runtimeEntry()],
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    onStderr: (line) => process.stderr.write(`[runtime] ${line}\n`),
  });
  client.on("event", (envelope) => broadcast(IPC.agentEvent, envelope));
  client.on("status", (status) => {
    lastStatus = status;
    broadcast(IPC.agentStatus, status);
  });
  client.start();
  agent = client;
}

function showOverlay(): void {
  const window = overlay;
  if (window === undefined || window.isDestroyed()) return;
  positionOverlay(window);
  // showInactive keeps the user's foreground application frontmost; focus then
  // makes the panel key so it receives keystrokes without activating this app.
  window.showInactive();
  window.focus();
  window.webContents.focus();
  window.webContents.send(IPC.overlayFocusRequested);
}

function toggleOverlay(): void {
  const window = overlay;
  if (window === undefined || window.isDestroyed()) return;
  if (window.isVisible()) window.hide();
  else showOverlay();
}

function openMainWindow(): void {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    app.focus({ steal: true });
    return;
  }
  mainWindow = createMainWindow(preload);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  // Opening the full interface is an explicit request for the app itself, so
  // this is the one place activation is wanted.
  void app.dock?.show();
  app.focus({ steal: true });
}

function registerIpc(): void {
  ipcMain.handle(IPC.agentSend, (_event, command: ApplicationCommand) => {
    if (agent === undefined || !agent.running) {
      throw new Error(
        lastStatus.state === "stopped"
          ? lastStatus.message
          : "The agent is not running.",
      );
    }
    agent.send(command);
  });

  ipcMain.handle(IPC.attachmentsPick, async (): Promise<ImportedAttachment[]> => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return attachments.importFiles(result.filePaths);
  });

  ipcMain.handle(
    IPC.attachmentsImport,
    (_event, buffers: Uint8Array[]): Promise<ImportedAttachment[]> =>
      attachments.importBuffers(buffers),
  );

  ipcMain.handle(IPC.attachmentsRemove, (_event, path: string) =>
    attachments.remove(path),
  );

  ipcMain.on(IPC.overlayResize, (_event, contentHeight: number) => {
    if (overlay !== undefined && !overlay.isDestroyed()) {
      resizeOverlay(overlay, contentHeight);
    }
  });

  ipcMain.on(IPC.overlayHide, () => overlay?.hide());
  ipcMain.on(IPC.windowOpenMain, () => openMainWindow());
}

app.whenReady().then(async () => {
  // Accessory policy: no Dock icon until the full interface is opened, matching
  // an assistant that lives in the overlay.
  app.dock?.hide();
  handleAttachmentScheme(attachments);
  registerIpc();

  // Both prompts are shown once by macOS and then remembered against this
  // application's identity. Screen Recording gates the frame stream;
  // Accessibility gates the window, focus, and visible-text signals.
  void ensureScreenRecordingAccess();
  ensureAccessibilityAccess();

  try {
    startAgent();
  } catch (error) {
    lastStatus = {
      state: "stopped",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  overlay = createOverlayWindow(preload);
  overlay.on("blur", () => {
    // The panel is only ever key while the app is inactive, so losing key
    // status means the user moved on.
    if (overlay?.isVisible() === true) overlay.hide();
  });

  if (!registerToggleHotkey(toggleOverlay)) {
    process.stderr.write("OpenScreen could not register the Option+Space shortcut\n");
  }

  app.on("activate", () => openMainWindow());
}).catch((error: unknown) => {
  process.stderr.write(`OpenScreen: ${String(error)}\n`);
});

app.on("window-all-closed", () => {
  // The overlay outlives every visible window; quitting is an explicit action.
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  unregisterHotkeys();
  await agent?.stop();
}

app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  void shutdown().then(() => app.quit());
});

// Ctrl+C in the launching terminal delivers the signal straight to this
// process, bypassing before-quit, which would orphan the runtime child.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown().then(() => app.exit(0));
  });
}
