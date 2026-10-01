import assert from 'node:assert/strict';
import test from 'node:test';

test('fixture discovery waits for the exact on-screen native window, never a sibling', async () => {
  const policy = await import('./desktop-host-policy.mjs');
  assert.equal(typeof policy.waitForFixtureWindow, 'function');
  const target = { pid: 123, windowId: 42n, appName: 'fixture', title: 'fixture',
    bounds: { x: 0, y: 0, width: 100, height: 100 }, isOnScreen: true };
  let calls = 0;
  const driver = { listWindows: async input => {
    assert.deepEqual(input, { pid: 123, onScreenOnly: true });
    calls++;
    return { windows: calls === 1 ? [{ ...target, windowId: 43n }] : [target] };
  } };
  assert.equal(await policy.waitForFixtureWindow(driver, 123, '42', 50, 1), target);
  assert.equal(calls, 2);
});

test('fixture discovery times out without accepting an invisible or foreign window', async () => {
  const policy = await import('./desktop-host-policy.mjs');
  assert.equal(typeof policy.waitForFixtureWindow, 'function');
  const driver = { listWindows: async () => ({ windows: [
    { pid: 123, windowId: 42n, isOnScreen: false }, { pid: 124, windowId: 42n, isOnScreen: true },
  ] }) };
  await assert.rejects(policy.waitForFixtureWindow(driver, 123, '42', 5, 1), /unavailable/i);
});
