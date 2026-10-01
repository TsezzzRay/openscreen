import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('foreground monitor remembers a transient activation even after the baseline returns', async () => {
  const module = await import('./desktop-host-foreground.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.watchForeground, 'function');
  const child = spawn(process.execPath, ['-e', `
    console.log(JSON.stringify({kind:'initial',pid:123}));
    setTimeout(() => {console.log(JSON.stringify({kind:'activated',pid:456}));
      console.log(JSON.stringify({kind:'activated',pid:123}));}, 30);
    setInterval(() => {},1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const watch = module.watchForeground(child);
  try {
    assert.equal(await watch.ready, 123);
    await assert.rejects(watch.failed, /foreground.*changed/i);
    await assert.rejects(watch.stop(), /foreground.*changed/i);
    assert.throws(() => watch.assertUnchanged(), /foreground.*changed/i);
    assert.equal(child.signalCode, 'SIGTERM');
  } finally { if (child.signalCode === null && child.exitCode === null) child.kill('SIGKILL'); }
});

test('foreground monitor rejects missing identity and unexpected observer exit', async () => {
  const module = await import('./desktop-host-foreground.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof module.watchForeground, 'function');
  for (const source of ['console.log("not-json")', 'console.log(JSON.stringify({kind:"initial",pid:null}))', 'process.exit(2)']) {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    const watch = module.watchForeground(child);
    await assert.rejects(watch.ready);
    await assert.rejects(watch.failed);
    await assert.rejects(watch.stop());
  }
});

test('foreground observer losing its output stream cannot silently stop monitoring', async () => {
  const { watchForeground } = await import('./desktop-host-foreground.mjs');
  const child = spawn(process.execPath, ['-e', `
    console.log(JSON.stringify({kind:'initial',pid:123}));
    setTimeout(() => process.stdout.end(), 20); setInterval(() => {},1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const watch = watchForeground(child);
  try {
    assert.equal(await watch.ready, 123);
    const outcome = await Promise.race([watch.failed.then(() => 'unexpected', () => 'failed'),
      new Promise(resolve => setTimeout(() => resolve('still waiting'), 80))]);
    assert.equal(outcome, 'failed');
    await assert.rejects(watch.stop());
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('native foreground observer uses activation notifications without requesting UI input', async () => {
  const source = await readFile(new URL('./fixtures/desktop-host-foreground.swift', import.meta.url), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  assert.match(source, /didActivateApplicationNotification/);
  assert.match(source, /frontmostApplication/);
  assert.doesNotMatch(source, /NSApplication\.shared|\.activate\(|makeKey|orderFront|CGEvent|AXUIElement|NSWorkspace\.shared\.open/);
});

test('host launcher waits for the foreground baseline before starting Electron', async () => {
  const source = await readFile(new URL('./desktop-host-smoke.mjs', import.meta.url), 'utf8');
  assert.match(source, /await foreground\.ready/);
  assert.ok(source.indexOf('await foreground.ready') < source.indexOf("child = spawn(require('electron')"));
  assert.match(source, /foreground\.failed/);
  assert.match(source, /await foreground\.stop\(\)/);
  assert.ok(source.indexOf("assert.ok(groupExited,") < source.indexOf('await foreground.stop()'),
    'Foreground observation must remain active until the owned host group has exited');
});
