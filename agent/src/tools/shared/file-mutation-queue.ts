import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function mutationKey(filePath: string) {
  const resolvedPath = resolve(filePath);
  try {
    return await realpath(resolvedPath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  let ancestor = dirname(resolvedPath);
  const missingSegments = [basename(resolvedPath)];
  while (true) {
    try {
      const canonicalAncestor = await realpath(ancestor);
      return resolve(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missingSegments.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

export async function withFileMutationQueue<T>(
  filePath: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const registration = registrationQueue.then(async () => {
    const key = await mutationKey(filePath);
    const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const nextQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    const chainedQueue = currentQueue.then(() => nextQueue);
    fileMutationQueues.set(key, chainedQueue);
    return { key, currentQueue, chainedQueue, release };
  });
  registrationQueue = registration.then(
    () => undefined,
    () => undefined,
  );

  const { key, currentQueue, chainedQueue, release } = await registration;
  await currentQueue;
  try {
    return await mutate();
  } finally {
    release();
    if (fileMutationQueues.get(key) === chainedQueue) fileMutationQueues.delete(key);
  }
}
