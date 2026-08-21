import { contextBridge, ipcRenderer } from "electron";

import type { AgentEventEnvelope, AgentStatus, ImportedAttachment } from "@shared/ipc.ts";
import { IPC } from "@shared/ipc.ts";
import type { ApplicationCommand } from "@shared/protocol.ts";

type Unsubscribe = () => void;

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const bridge = {
  agent: {
    send: (command: ApplicationCommand): Promise<void> =>
      ipcRenderer.invoke(IPC.agentSend, command),
    onEvent: (listener: (envelope: AgentEventEnvelope) => void): Unsubscribe =>
      subscribe(IPC.agentEvent, listener),
    onStatus: (listener: (status: AgentStatus) => void): Unsubscribe =>
      subscribe(IPC.agentStatus, listener),
  },
  attachments: {
    pick: (): Promise<ImportedAttachment[]> => ipcRenderer.invoke(IPC.attachmentsPick),
    importBuffers: (buffers: Uint8Array[]): Promise<ImportedAttachment[]> =>
      ipcRenderer.invoke(IPC.attachmentsImport, buffers),
    remove: (path: string): Promise<void> => ipcRenderer.invoke(IPC.attachmentsRemove, path),
  },
  overlay: {
    resize: (contentHeight: number): void => ipcRenderer.send(IPC.overlayResize, contentHeight),
    hide: (): void => ipcRenderer.send(IPC.overlayHide),
    onFocusRequested: (listener: () => void): Unsubscribe =>
      subscribe(IPC.overlayFocusRequested, listener),
  },
  shell: {
    openMainWindow: (): void => ipcRenderer.send(IPC.windowOpenMain),
  },
};

export type OpenScreenBridge = typeof bridge;

contextBridge.exposeInMainWorld("openscreen", bridge);
