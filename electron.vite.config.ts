import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const renderer = resolve("app/src/renderer");
const shared = resolve("app/src/shared");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
    build: {
      outDir: "app/out/main",
      rollupOptions: { input: { index: resolve("app/src/main/index.ts") } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { "@shared": shared } },
    build: {
      outDir: "app/out/preload",
      rollupOptions: { input: { index: resolve("app/src/preload/index.ts") } },
    },
  },
  renderer: {
    root: renderer,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": renderer, "@shared": shared } },
    build: {
      outDir: "app/out/renderer",
      rollupOptions: {
        input: {
          main: resolve(renderer, "main.html"),
          overlay: resolve(renderer, "overlay.html"),
        },
      },
    },
  },
});
