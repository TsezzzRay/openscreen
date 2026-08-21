import { desktopCapturer, systemPreferences } from "electron";

/**
 * Screen Recording cannot be requested through an Electron API. Asking
 * `desktopCapturer` for a source is what triggers the system prompt the first
 * time; afterwards the status query is enough.
 */
export async function ensureScreenRecordingAccess(): Promise<boolean> {
  if (systemPreferences.getMediaAccessStatus("screen") === "granted") return true;
  try {
    await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
    });
  } catch {
    // The prompt has been shown; the user decides out of band.
  }
  return systemPreferences.getMediaAccessStatus("screen") === "granted";
}

/**
 * Prompts for Accessibility on first launch. This gates the window, focus, and
 * visible-text signals the recorder attaches to each frame.
 *
 * Input Monitoring, which gates click and scroll events, has no Electron API to
 * request it. macOS raises that prompt on its own when the recorder installs its
 * event tap, and attributes it to this application.
 */
export function ensureAccessibilityAccess(): boolean {
  return systemPreferences.isTrustedAccessibilityClient(true);
}

/** Whether Accessibility is already granted, without raising a prompt. */
export function hasAccessibilityAccess(): boolean {
  return systemPreferences.isTrustedAccessibilityClient(false);
}
