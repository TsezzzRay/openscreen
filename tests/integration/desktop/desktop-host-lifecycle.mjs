export function installInterruptHandlers() {
  const controller = new AbortController();
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => controller.abort(signal)]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  return { signal: controller.signal,
    dispose() { for (const [signal, handler] of handlers) process.removeListener(signal, handler); } };
}

export async function withDeadline(operation, timeoutMs, onCancel, interruptionSignal) {
  const controller = new AbortController();
  let timer;
  let cleanup;
  let cancellationReason;
  let rejectCancellation;
  const cancelled = new Promise((_, reject) => { rejectCancellation = reject; });
  const cancel = reason => {
    if (cancellationReason !== undefined) return;
    cancellationReason = reason;
    controller.abort();
    cleanup = Promise.resolve().then(onCancel);
    cleanup.then(
      () => rejectCancellation(new Error(reason)),
      () => rejectCancellation(new Error(`${reason}; cleanup failed`)),
    );
  };
  const interrupt = () => cancel(`Host smoke interrupted by ${interruptionSignal.reason}`);
  interruptionSignal?.addEventListener('abort', interrupt, { once: true });
  if (interruptionSignal?.aborted) interrupt();
  timer = setTimeout(() => cancel('Host smoke outer deadline exceeded'), timeoutMs);
  try {
    let result;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal); }),
        cancelled,
      ]);
    } catch (error) { if (cancellationReason === undefined) throw error; }
    if (cancellationReason !== undefined) {
      try { await cleanup; }
      catch { throw new Error(`${cancellationReason}; cleanup failed`); }
      throw new Error(cancellationReason);
    }
    return result;
  } finally {
    clearTimeout(timer);
    interruptionSignal?.removeEventListener('abort', interrupt);
  }
}

export async function stopHostGroup(child, graceMs = 1000) {
  if (!child?.pid) return;
  const signal = name => {
    try { process.kill(-child.pid, name); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const wait = async () => {
    const end = Date.now() + graceMs;
    do {
      if (!signal(0)) return true;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < end);
    return !signal(0);
  };
  if (!signal('SIGTERM') || await wait()) return;
  signal('SIGKILL');
  if (!await wait()) throw new Error('Owned host process group did not exit after SIGKILL');
}

export async function stopFixture(child, graceMs = 1000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const wait = () => new Promise(resolve => {
    let timer;
    const closed = () => { clearTimeout(timer); resolve(true); };
    child.once('close', closed);
    timer = setTimeout(() => { child.removeListener('close', closed); resolve(false); }, graceMs);
  });
  let exited = wait();
  child.kill('SIGTERM');
  if (await exited) return;
  exited = wait();
  child.kill('SIGKILL');
  if (!await exited) throw new Error('Fixture did not exit after SIGKILL');
}

export async function cleanupSteps(steps, timeoutMs = 2500) {
  const failed = [];
  for (const step of steps) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(step.run),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cleanup timeout')), timeoutMs); }),
      ]);
    } catch (error) { failed.push(`${step.name} (${error instanceof Error ? error.message : String(error)})`); }
    finally { clearTimeout(timer); }
  }
  if (failed.length > 0) throw new Error(`Cleanup failed: ${failed.join(', ')}`);
}
