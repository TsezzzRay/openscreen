import { createInterface } from 'node:readline';
import { stopFixture } from './desktop-host-lifecycle.mjs';

export function watchForeground(child) {
  let baseline;
  let failure;
  let stopping = false;
  let readyResolve;
  let readyReject;
  let failedReject;
  const records = [];
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const failed = new Promise((_, reject) => { failedReject = reject; });
  // A failure can precede the caller's wait; keep it observable without an unhandled rejection.
  void ready.catch(() => {});
  void failed.catch(() => {});
  const reject = error => {
    if (failure) return;
    failure = error;
    readyReject(error);
    failedReject(error);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const entry = JSON.parse(line);
      if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0 ||
        !['initial', 'activated'].includes(entry.kind)) throw new Error('Foreground identity is unavailable');
      records.push({ kind: entry.kind, pid: entry.pid, at: new Date().toISOString() });
      if (baseline === undefined) {
        if (entry.kind !== 'initial') throw new Error('Foreground observer omitted its baseline');
        baseline = entry.pid;
        readyResolve(baseline);
      } else if (entry.pid !== baseline) throw new Error('Foreground ownership changed during host smoke');
    } catch (error) { reject(error); }
  });
  child.on('error', () => reject(new Error('Foreground observer failed to start')));
  lines.on('close', () => { if (!stopping) reject(new Error('Foreground observer output closed unexpectedly')); });
  child.on('close', () => { if (!stopping) reject(new Error('Foreground observer exited unexpectedly')); });
  return {
    ready, failed, records,
    assertUnchanged() {
      if (failure) throw failure;
      if (baseline === undefined) throw new Error('Foreground baseline is unavailable');
    },
    async stop() {
      stopping = true;
      await stopFixture(child);
      if (failure) throw failure;
    },
  };
}
