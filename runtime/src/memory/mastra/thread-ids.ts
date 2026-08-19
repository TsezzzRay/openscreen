// Split out of write-path.ts so write-path.ts and projector.ts can both
// depend on these constants without an import cycle between them.
export const MEMORY_THREAD_IDS = {
  interactive: "interactive",
  screenActivity: "screen-activity",
  resourceId: "openscreen",
} as const;
