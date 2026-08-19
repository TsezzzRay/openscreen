// Must be the very first import in main.ts, ahead of anything that
// transitively imports @mastra/*. ES module imports are hoisted and evaluated
// in declaration order before a file's own top-level statements run, so a
// plain `process.env.X = ...` line inside main.ts's body would execute too
// late — after all of main.ts's own imports (including this project's
// @mastra/* dependency chain) have already been evaluated. This file has no
// imports of its own, so listing it first guarantees it finishes before the
// next import in main.ts's list even begins resolving.
process.env.MASTRA_TELEMETRY_DISABLED ??= "1";
