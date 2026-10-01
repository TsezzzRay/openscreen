import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { PiSessionRuntime } from '../../../runtime/dist/agent/pi/session-runtime.js';
import { installFixtureScope } from './desktop-host-policy.mjs';

// Test-only preload: production entry point, tools, and protocol remain unchanged.
assert.equal(process.env.OPENSCREEN_DESKTOP_HOST_SMOKE, '1');
const fixture = JSON.parse(process.env.OPENSCREEN_HOST_FIXTURE_SCOPE ?? 'null');
assert.ok(fixture && Number.isSafeInteger(fixture.pid) && fixture.pid > 0);
assert.equal(typeof fixture.windowId, 'string');
assert.match(fixture.windowId, /^[1-9][0-9]*$/);
const auditPath = process.env.OPENSCREEN_HOST_SCOPE_AUDIT;
assert.ok(auditPath, 'Fixture scope audit path is required');
const record = entry => appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
const createHarness = PiSessionRuntime.prototype.createHarnessFromState;
PiSessionRuntime.prototype.createHarnessFromState = function (...args) {
  const harness = Reflect.apply(createHarness, this, args);
  installFixtureScope(harness, fixture, record);
  record({ type: 'fixture-scope-installed', pid: fixture.pid, windowId: fixture.windowId });
  return harness;
};
export const fixtureScopeInstalled = true;
