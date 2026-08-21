import { beforeEach, vi } from "vitest";

// The store reaches for the preload bridge when it touches attachments. Tests
// that exercise attachments assert against these stubs; the rest never call in.
Object.defineProperty(window, "openscreen", {
  writable: true,
  value: {
    agent: { send: vi.fn(), onEvent: vi.fn(() => () => {}), onStatus: vi.fn(() => () => {}) },
    attachments: {
      pick: vi.fn(async () => []),
      importBuffers: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
    },
    overlay: { resize: vi.fn(), hide: vi.fn(), onFocusRequested: vi.fn(() => () => {}) },
    shell: { openMainWindow: vi.fn() },
  },
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
