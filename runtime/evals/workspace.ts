import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = Object.create(null);
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Eval artifact contains a symlink");
      if (entry.isDirectory()) await visit(path);
      else files[relative(root, path)] = await readFile(path, "utf8");
    }
  }
  await visit(root);
  return files;
}

export async function confinedPath(root: string, input: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const target = resolve(root, input);
  const within = (base: string, path: string) => { const rel = relative(base, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"); };
  if (!within(root, target) && !within(canonicalRoot, target)) throw new Error("Eval execution boundary: path outside workspace");
  let parent = target;
  while (true) {
    try { if (!within(canonicalRoot, await realpath(parent))) throw new Error("Eval execution boundary: symlink escape"); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; parent = dirname(parent); }
  }
  return target;
}

export function screenFixturePath(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*\.png$/u.test(name)) throw new Error("Invalid screen fixture name");
  return resolve("runtime/evals/fixtures/screens", name);
}
