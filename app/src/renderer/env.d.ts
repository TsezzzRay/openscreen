/// <reference types="vite/client" />

import type { OpenScreenBridge } from "../preload/index.ts";

declare global {
  interface Window {
    openscreen: OpenScreenBridge;
  }
}

export {};
