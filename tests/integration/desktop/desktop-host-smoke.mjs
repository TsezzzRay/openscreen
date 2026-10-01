import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { smokeConfig } from './desktop-host-policy.mjs';
import { withDeadline, stopHostGroup, cleanupSteps, installInterruptHandlers } from './desktop-host-lifecycle.mjs';
import { watchForeground } from './desktop-host-foreground.mjs';

assert.equal(process.env.OPENSCREEN_DESKTOP_HOST_SMOKE, '1',
  'This real-model desktop test requires OPENSCREEN_DESKTOP_HOST_SMOKE=1');
const repo = process.cwd();
const interrupts = installInterruptHandlers();
let root;
let child;
let foreground;
try {
  await withDeadline(async signal => {
    await mkdir(join(repo, 'eval-results'), { recursive: true, mode: 0o700 });
    root = await mkdtemp(join(repo, 'eval-results/desktop-host-'));
    const config = JSON.parse(await readFile(join(repo, 'config.json'), 'utf8'));
    await writeFile(join(root, 'config.json'), JSON.stringify(smokeConfig(config)), { mode: 0o600 });
    await build({ entryPoints: [join(repo, 'tests/integration/desktop/desktop-host-entry.mjs')],
      outfile: join(root, 'host.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
    signal.throwIfAborted();
    execFileSync('swiftc', ['-O', '-o', join(root, 'foreground-observer'), 'tests/integration/desktop/fixtures/desktop-host-foreground.swift'], { timeout: 15_000 });
    signal.throwIfAborted();
    foreground = watchForeground(spawn(join(root, 'foreground-observer'), [], { stdio: ['ignore', 'pipe', 'pipe'] }));
    const foregroundPid = await foreground.ready;
    signal.throwIfAborted();
    foreground.assertUnchanged();
    const require = createRequire(join(repo, 'package.json'));
    const env = { ...process.env, OPENSCREEN_HOST_FOREGROUND_PID: String(foregroundPid) };
    delete env.ELECTRON_RUN_AS_NODE;
    // All test-owned descendants inherit this group; no model Bash is allowed.
    child = spawn(require('electron'), [join(root, 'host.cjs'), root], { cwd: repo, env, stdio: 'inherit', detached: true });
    const result = await Promise.race([foreground.failed, new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    })]);
    signal.throwIfAborted();
    assert.equal(result.code, 0, `Electron host smoke failed; evidence retained at ${root}`);
    const report = JSON.parse(await readFile(join(root, 'report.json'), 'utf8'));
    assert.equal(report.cleanupVerified, true, 'Host did not verify cleanup');
    assert.equal(report.foregroundPid, foregroundPid, 'Host used a different foreground baseline');
    let groupExited = false;
    try { process.kill(-child.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') groupExited = true; else throw error; }
    assert.ok(groupExited, 'Host left test-owned descendant processes running');
    await foreground.stop();
    foreground.assertUnchanged();
    await writeFile(join(root, 'launcher-report.json'), JSON.stringify({ result: 'pass', foregroundPid,
      foregroundEvents: foreground.records, cleanupVerified: true }), { mode: 0o600 });
  }, 150_000, () => cleanupSteps([
    { name: 'host process group', run: () => stopHostGroup(child) },
    { name: 'foreground observer', run: () => foreground?.stop() },
  ]), interrupts.signal);
  console.log(JSON.stringify({ result: 'pass', evidenceRoot: root }));
} catch (error) {
  let cleanupFailure;
  try { await cleanupSteps([
    { name: 'host process group', run: () => stopHostGroup(child) },
    { name: 'foreground observer', run: () => foreground?.stop() },
  ]); } catch (failure) { cleanupFailure = failure.message; }
  if (root) await writeFile(join(root, 'launcher-failure.json'), JSON.stringify({ result: 'fail', reason: error.message,
    cleanupFailure, foregroundEvents: foreground?.records }), { mode: 0o600 });
  throw error;
} finally {
  interrupts.dispose();
}
