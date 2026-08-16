interface WorkspaceState {
  tail: Promise<void>;
  frozenBy?: string;
  unfrozen?: Promise<void>;
  releaseUnfrozen?: () => void;
}

const states = new Map<string, WorkspaceState>();

function state(root: string): WorkspaceState {
  let current = states.get(root);
  if (current === undefined) {
    current = { tail: Promise.resolve() };
    states.set(root, current);
  }
  return current;
}

async function enqueue<T>(
  current: WorkspaceState,
  operation: () => Promise<T>,
): Promise<T> {
  const result = current.tail.then(operation);
  current.tail = result.then(() => undefined, () => undefined);
  return result;
}

export async function withMemoryWorkspaceWriter<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const current = state(root);
  while (current.unfrozen !== undefined) await current.unfrozen;
  return enqueue(current, operation);
}

export interface FrozenMemoryWorkspace {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  release(): Promise<void>;
}

export async function freezeMemoryWorkspace(
  root: string,
  ownershipToken: string,
): Promise<FrozenMemoryWorkspace> {
  if (!ownershipToken) throw new Error("Memory workspace freeze requires ownership");
  const current = state(root);
  await enqueue(current, async () => {
    if (current.frozenBy !== undefined) {
      throw new Error("Memory workspace is already frozen");
    }
    current.frozenBy = ownershipToken;
    current.unfrozen = new Promise<void>((resolve) => {
      current.releaseUnfrozen = resolve;
    });
  });
  let released = false;
  return {
    runExclusive: (operation) => enqueue(current, async () => {
      if (released || current.frozenBy !== ownershipToken) {
        throw new Error("Memory workspace freeze ownership lost");
      }
      return operation();
    }),
    release: () => enqueue(current, async () => {
      if (released) return;
      if (current.frozenBy !== ownershipToken) {
        throw new Error("Memory workspace freeze ownership lost");
      }
      released = true;
      current.frozenBy = undefined;
      const release = current.releaseUnfrozen;
      current.releaseUnfrozen = undefined;
      current.unfrozen = undefined;
      release?.();
    }),
  };
}
