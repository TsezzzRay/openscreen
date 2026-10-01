import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('desktop smoke fixture never activates its app or takes the key window', () => {
  const source = readFileSync('tests/integration/desktop/fixtures/desktop-fixture.swift', 'utf8');
  assert.doesNotMatch(source, /\.activate\(|makeKeyAndOrderFront|makeKey\(/);
  assert.match(source, /app\.setActivationPolicy\(\.prohibited\)/,
    'AppKit launch must begin with activation prohibited');
  assert.match(source, /func applicationDidFinishLaunching/,
    'Create the accessory fixture window only after the activation-prohibited launch');
});

test('desktop smoke requires explicit permission before opening its test window', () => {
  const env = { ...process.env };
  delete env.OPENSCREEN_DESKTOP_SMOKE;
  const result = spawnSync(process.execPath, ['tests/integration/desktop/desktop-smoke.mjs'], {
    env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OPENSCREEN_DESKTOP_SMOKE=1/);
});

test('desktop smoke explicitly runs the sandbox probe in Electron Node mode', () => {
  const source = readFileSync('tests/integration/desktop/desktop-smoke.mjs', 'utf8');
  assert.match(source, /process\.versions\.electron \? 'ELECTRON_RUN_AS_NODE=1 ' : ''/);
});

test('desktop smoke checks foreground ownership around all input dispatches, including errors', () => {
  const source = readFileSync('tests/integration/desktop/desktop-smoke.mjs', 'utf8');
  for (const name of ['desktopClick', 'desktopType', 'desktopScroll']) {
    const adapter = source.slice(source.indexOf(`${name}: async`), source.indexOf('\n    },', source.indexOf(`${name}: async`)));
    assert.match(adapter, /await checkForeground\(\);/);
    assert.match(adapter, /finally \{ await checkForeground\(\); \}/);
  }
});

test('desktop smoke records foreground ownership before launching the fixture', () => {
  const source = readFileSync('tests/integration/desktop/desktop-smoke.mjs', 'utf8');
  assert.ok(source.indexOf('const foregroundPid =') < source.indexOf('fixture = spawn('));
});

test('desktop smoke continuously observes foreground changes until the fixture exits', () => {
  const source = readFileSync('tests/integration/desktop/desktop-smoke.mjs', 'utf8');
  assert.match(source, /watchForeground\(spawn\(/);
  assert.ok(source.indexOf('await foreground.ready') < source.indexOf('fixture = spawn('));
  assert.match(source, /foreground\.assertUnchanged\(\)/);
  assert.match(source, /run: \(\) => stopFixture\(fixture\)/);
  assert.match(source, /run: \(\) => foreground\?\.stop\(\)/);
  assert.ok(source.indexOf('stopFixture(fixture)') < source.indexOf('foreground?.stop()'));
});

test('desktop smoke verifies a background click and reuses one app approval for typing', () => {
  const source = readFileSync('tests/integration/desktop/desktop-smoke.mjs', 'utf8');
  assert.match(source, /security\.tools\.find\(tool => tool\.name === 'desktop_click'\)/);
  assert.match(source, /const pending = click\.execute\(/);
  assert.match(source, /await pending;/);
  assert.match(source, /await guard\.arm\(\)/);
  assert.match(source, /events\.filter\(event => event\.type === 'security-approval-requested'\)\.length, 1/);
  assert.match(source, /events\.filter\(event => event\.type === 'security-tool-committed'\)\.length, 3/);
});

test('desktop smoke scrolls an isolated fixture under the same grant without taking the foreground', () => {
  const fixture = readFileSync('tests/integration/desktop/fixtures/desktop-fixture.swift', 'utf8');
  const source = readFileSync('tests/integration/desktop/desktop-smoke.mjs', 'utf8');
  assert.match(fixture, /NSScrollView\(/);
  assert.match(source, /security\.tools\.find\(tool => tool\.name === 'desktop_scroll'\)/);
  const adapter = source.slice(source.indexOf('desktopScroll: async'), source.indexOf('\n    },', source.indexOf('desktopScroll: async')));
  assert.match(adapter, /await checkForeground\(\);/);
  assert.match(adapter, /finally \{ await checkForeground\(\); \}/);
  assert.match(source, /await scroll\.execute\(/);
  assert.match(source, /scrollValueAfter > scrollValueBefore/);
  assert.match(source, /events\.filter\(event => event\.type === 'security-approval-requested'\)\.length, 1/);
  assert.match(source, /events\.filter\(event => event\.type === 'security-tool-committed'\)\.length, 3/);
});
