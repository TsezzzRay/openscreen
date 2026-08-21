import { globalShortcut } from "electron";

export const TOGGLE_ACCELERATOR = "Alt+Space";

export function registerToggleHotkey(onToggle: () => void): boolean {
  if (globalShortcut.isRegistered(TOGGLE_ACCELERATOR)) return true;
  return globalShortcut.register(TOGGLE_ACCELERATOR, onToggle);
}

export function unregisterHotkeys(): void {
  globalShortcut.unregisterAll();
}
