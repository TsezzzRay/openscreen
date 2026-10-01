import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createInterface } from 'node:readline';

test('SIGINT and SIGTERM stop owned descendants before the launcher exits', async () => {
  const lifecycle = await import('./desktop-host-lifecycle.mjs');
  assert.equal(typeof lifecycle.installInterruptHandlers, 'function');
  const moduleUrl = new URL('./desktop-host-lifecycle.mjs', import.meta.url).href;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const source = `
      import {spawn} from 'node:child_process'; import {once} from 'node:events';
      import {installInterruptHandlers,withDeadline,stopHostGroup,stopFixture,cleanupSteps} from ${JSON.stringify(moduleUrl)};
      const interrupts=installInterruptHandlers();
      const host=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','pipe','pipe']});
      await once(host.stdout,'data');
      const observer=spawn(process.execPath,['-e','console.log("ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','pipe']});
      await once(observer.stdout,'data');
      console.log(JSON.stringify({hostPid:host.pid,observerPid:observer.pid}));
      try {await withDeadline(()=>new Promise(()=>{}),5000,()=>cleanupSteps([
        {name:'host',run:()=>stopHostGroup(host,100)},
        {name:'observer',run:()=>stopFixture(observer,100)}
      ]),interrupts.signal);}
      finally {interrupts.dispose();}
    `;
    const launcher = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = createInterface({ input: launcher.stdout });
    let pids;
    try {
      pids = JSON.parse((await once(lines, 'line'))[0]);
      const closed = once(launcher, 'close');
      launcher.kill(signal);
      const [code] = await closed;
      assert.equal(code, 1);
      for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
      for (const pid of Object.values(pids ?? {})) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
  }
});

test('deadline cannot pass when work settles while timeout cleanup is running', async () => {
  const lifecycle = await import('./desktop-host-lifecycle.mjs');
  await assert.rejects(lifecycle.withDeadline(
    () => new Promise(resolve => setTimeout(() => resolve('too late'), 20)), 5,
    () => new Promise(resolve => setTimeout(resolve, 40)),
  ), /deadline/i);
});

test('outer deadline aborts work and waits for owned host process-group termination', async () => {
  const lifecycle = await import('./desktop-host-lifecycle.mjs');
  assert.equal(typeof lifecycle.withDeadline, 'function');
  assert.equal(typeof lifecycle.stopHostGroup, 'function');
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    let observedSignal;
    await assert.rejects(lifecycle.withDeadline(signal => {
      observedSignal = signal;
      return new Promise(() => {});
    }, 20, () => lifecycle.stopHostGroup(child, 30)), /deadline/i);
    assert.equal(observedSignal.aborted, true);
    assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
});

test('host fixture shutdown waits for exit and escalates an ignored SIGTERM', async () => {
  const lifecycle = await import('./desktop-host-lifecycle.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof lifecycle.stopFixture, 'function');
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    await lifecycle.stopFixture(child, 30);
    assert.equal(child.signalCode, 'SIGKILL');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    await lifecycle.stopFixture(child, 30);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('cleanup continues after errors and bounds a never-settling step', async () => {
  const lifecycle = await import('./desktop-host-lifecycle.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof lifecycle.cleanupSteps, 'function');
  const completed = [];
  await assert.rejects(lifecycle.cleanupSteps([
    { name: 'failed', run: async () => { throw new Error('failure'); } },
    { name: 'hung', run: () => new Promise(() => {}) },
    { name: 'remaining', run: async () => { completed.push('remaining'); } },
  ], 20), error => {
    assert.match(error.message, /failed \(failure\)/);
    assert.match(error.message, /hung \(Cleanup timeout\)/);
    return true;
  });
  assert.deepEqual(completed, ['remaining']);
  await lifecycle.cleanupSteps([{ name: 'success', run: async () => { completed.push('success'); } }], 20);
  assert.deepEqual(completed, ['remaining', 'success']);
});
