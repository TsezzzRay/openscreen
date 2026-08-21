/** Resolves one of the renderer documents served by `electron-vite dev`. */
export function rendererEntry(name: "main" | "overlay"): string {
  const devServer = process.env["ELECTRON_RENDERER_URL"];
  if (devServer === undefined || devServer.length === 0) {
    throw new Error("ELECTRON_RENDERER_URL is missing. Run `npm run dev`.");
  }
  return `${devServer}/${name}.html`;
}
