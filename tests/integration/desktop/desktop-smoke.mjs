import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { ActionTarget, ClickPosition, CuaDriver, InputDeliveryMode, ScrollBy, ScrollDirection } from '@trycua/cua-driver';

import { createNativeDesktopFocusGuard } from '../../../runtime/dist/desktop/native-focus-guard.js';
import { desktopActionResult } from '../../../runtime/dist/desktop/action-result.js';
import { SandboxedToolShell } from '../../../runtime/dist/security/sandboxed-shell.js';
import { ToolSecurity } from '../../../runtime/dist/security/tool-security.js';
import { shellQuote } from '../../../runtime/dist/agent/pi/tools/tool-support.js';
import { watchForeground } from './desktop-host-foreground.mjs';
import { cleanupSteps, stopFixture } from './desktop-host-lifecycle.mjs';

if (process.env.OPENSCREEN_DESKTOP_SMOKE !== '1') {
  throw new Error('Desktop smoke operates a temporary window on the real desktop; opt in with OPENSCREEN_DESKTOP_SMOKE=1');
}

const root = await mkdtemp(join(tmpdir(), 'openscreen-desktop-smoke-'));
const fixturePath = join(root, 'desktop-fixture');
const observerPath = join(root, 'foreground-observer');
let fixture;
let driver;
let foreground;
try {
  execFileSync('swiftc', ['-O', '-o', observerPath, 'tests/integration/desktop/fixtures/desktop-host-foreground.swift'], { stdio: 'inherit' });
  foreground = watchForeground(spawn(observerPath, [], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const foregroundPid = await foreground.ready;
  driver = CuaDriver.create(undefined);
  foreground.assertUnchanged();
  execFileSync('swiftc', ['-O', '-o', fixturePath, 'tests/integration/desktop/fixtures/desktop-fixture.swift'], { stdio: 'inherit' });
  fixture = spawn(fixturePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: fixture.stdout });
  const ready = await Promise.race([
    new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Fixture window did not start')), 5000)),
  ]);
  const readScrollValue = async () => {
    const response = new Promise((resolve, reject) => {
      const onLine = line => {
        clearTimeout(timer);
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      };
      const timer = setTimeout(() => {
        lines.off('line', onLine);
        reject(new Error('Fixture did not return scroll state'));
      }, 5000);
      lines.once('line', onLine);
    });
    fixture.stdin.write('scroll-state\n');
    const state = await response;
    assert.ok(Number.isFinite(state.scrollValue) && state.scrollValue >= 0 && state.scrollValue <= 1);
    return state.scrollValue;
  };
  const pid = ready.pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.ok(foregroundPid && foregroundPid !== pid, 'Fixture must not become the foreground application');
  const checkForeground = async () => {
    foreground.assertUnchanged();
    assert.equal((await driver.listApps({})).apps.find(app => app.active)?.pid, foregroundPid,
      'Desktop smoke must stop if foreground ownership changes');
  };
  await checkForeground();
  let window;
  for (let attempt = 0; attempt < 20 && !window; attempt += 1) {
    window = (await driver.listWindows({ onScreenOnly: true })).windows.find(item => item.pid === pid && item.title === 'OpenScreen isolated input test');
    if (!window) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(window, 'CUA did not list the isolated fixture window');
  let state;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    state = await driver.getWindowState({ pid, windowId: window.windowId, includeAccessibilityTree: true, includeScreenshot: true,
      maxElements: 100, maxDepth: 8, maxImageDimension: 1200, timeoutMs: 1000 });
    if (state.elements?.some(item => item.label === 'Isolated test input' && item.elementToken && item.frame)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(state.screenshotFrameValid, true);
  const input = state.elements?.find(item => item.label === 'Isolated test input' && item.elementToken && item.frame);
  if (!input) console.error(JSON.stringify({ stateKeys: Object.keys(state), elements: state.elements?.map(item => ({ label: item.label, role: item.role, hasToken: !!item.elementToken, frame: item.frame })) }));
  assert.ok(input, 'CUA did not expose the isolated input element');
  const originalValue = input.value;
  const shell = new SandboxedToolShell({ cwd: process.cwd(), outputRoot: root });
  try {
    const script = `
      import { ActionTarget, CuaDriver } from '@trycua/cua-driver';
      const driver = CuaDriver.create(undefined);
      try {
        const result = await driver.typeText({ text: 'UNAPPROVED DESKTOP INPUT',
          target: ActionTarget.Window.new({ pid: ${pid}, windowId: BigInt('${window.windowId}') }) });
        console.log(JSON.stringify({ isError: result.isError, text: result.text }));
      } finally { await driver.shutdown(); driver.uniffiDestroy(); }
    `;
    const nodeMode = process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
    const attempt = await shell.exec(`${nodeMode}${shellQuote(process.execPath)} --input-type=module -e ${shellQuote(script)}`, { timeout: 10_000 });
    assert.ok(attempt.ok, 'Sandbox probe did not finish normally');
    const refusedAtStartup = attempt.value.exitCode !== 0 && /unexpected NULL returned from \+\[NSPasteboard generalPasteboard\]/.test(attempt.value.stderr);
    const refusedAtAction = attempt.value.exitCode === 0 && attempt.value.stdout.trim().length > 0 && JSON.parse(attempt.value.stdout.trim()).isError === true;
    assert.ok(refusedAtStartup || refusedAtAction, `Sandboxed CUA did not explicitly refuse desktop input: ${attempt.value.stderr}`);
    const afterAttempt = await driver.getWindowState({ pid, windowId: window.windowId, includeAccessibilityTree: true,
      includeScreenshot: false, maxElements: 100, maxDepth: 8, timeoutMs: 1000 });
    assert.equal(afterAttempt.elements?.find(item => item.label === 'Isolated test input')?.value, originalValue,
      'Sandboxed Bash changed the isolated desktop input without approval');
    console.log(JSON.stringify({ sandboxedDesktopInputDenied: true, sandboxRefusal: refusedAtStartup ? 'sdk-startup' : 'action' }));
  } finally { await shell.cleanup(); }
  const events = [];
  const security = new ToolSecurity({
    cwd: process.cwd(), dataRoot: root,
    desktopWindowState: target => driver.getWindowState({ ...target, includeAccessibilityTree: true, includeScreenshot: true,
      maxElements: 100, maxDepth: 8, maxImageDimension: 1200, timeoutMs: 1000 }),
    desktopClick: async ({ pid: targetPid, windowId, position }) => {
      await checkForeground();
      try {
        const result = await driver.click({ target: ActionTarget.Window.new({ pid: targetPid, windowId }),
          position: 'elementToken' in position
            ? ClickPosition.Element.new({ elementToken: position.elementToken })
            : ClickPosition.Coordinates.new({ x: position.x, y: position.y }),
          deliveryMode: InputDeliveryMode.Background, count: 1 });
        return desktopActionResult(result);
      } finally { await checkForeground(); }
    },
    desktopType: async ({ pid: targetPid, windowId, text }) => {
      await checkForeground();
      try {
        const result = await driver.typeText({ text, target: ActionTarget.Window.new({ pid: targetPid, windowId }) });
        if (result.isError || !result.action) throw new Error(result.text || 'CUA did not confirm text dispatch');
        return desktopActionResult(result.action, result.text);
      } finally { await checkForeground(); }
    },
    desktopScroll: async ({ pid: targetPid, windowId, x, y, direction, by, amount }) => {
      await checkForeground();
      try {
        const result = await driver.scroll({ target: ActionTarget.Window.new({ pid: targetPid, windowId }), x, y,
          direction: { up: ScrollDirection.Up, down: ScrollDirection.Down, left: ScrollDirection.Left, right: ScrollDirection.Right }[direction],
          by: by === 'line' ? ScrollBy.Line : ScrollBy.Page, amount: BigInt(amount) });
        if (result.isError || !result.action) throw new Error(result.text || 'CUA did not confirm scroll dispatch');
        return desktopActionResult(result.action, result.text);
      } finally { await checkForeground(); }
    },
    createDesktopFocusGuard: target => createNativeDesktopFocusGuard({ helperPath: 'runtime/bin/openscreen-ax-focus', ...target }),
  });
  try {
    const run = await security.prepare('isolated-smoke', event => { events.push(event); });
    const observe = security.tools.find(tool => tool.name === 'desktop_window_state');
    const click = security.tools.find(tool => tool.name === 'desktop_click');
    const type = security.tools.find(tool => tool.name === 'desktop_type');
    const scroll = security.tools.find(tool => tool.name === 'desktop_scroll');
    assert.ok(observe && click && type && scroll);
    await run.execute(async () => {
      const observed = await observe.execute('observe', { pid, windowId: String(window.windowId) });
      const observedText = observed.content.find(item => item.type === 'text');
      assert.ok(observedText);
      const { observationId, elements } = JSON.parse(observedText.text);
      const observedInput = elements?.find(item => item.label === 'Isolated test input');
      assert.ok(observedInput?.elementToken, 'The tool observation did not expose the input element');
      assert.ok(observationId);
      const text = 'OpenScreen test input';
      const pending = click.execute('click', { observationId, position: { kind: 'element', elementToken: observedInput.elementToken }, deliveryMode: 'background' });
      for (let attempt = 0; attempt < 20 && security.approvals.pending().length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const approval = security.approvals.pending()[0];
      assert.ok(approval, 'desktop_click did not request approval');
      assert.equal(approval.tool, 'desktop_click');
      assert.equal(approval.proposedContent, undefined);
      assert.equal(approval.target.position.elementToken, observedInput.elementToken);
      const beforeDecision = await driver.getWindowState({ pid, windowId: window.windowId, includeAccessibilityTree: true,
        includeScreenshot: false, maxElements: 100, maxDepth: 8, timeoutMs: 1000 });
      assert.notEqual(beforeDecision.elements?.find(item => item.label === 'Isolated test input')?.value, text);
      security.approvals.decide(approval.id, true);
      await pending;
      const guard = await createNativeDesktopFocusGuard({ helperPath: 'runtime/bin/openscreen-ax-focus',
        pid, windowId: window.windowId, windowTitle: state.windowTitle ?? '', screenshotWidth: state.screenshotWidth, element: input });
      try { await guard.arm(); }
      finally { await guard.close(); }
      const observedAgain = await observe.execute('observe-after-click', { pid, windowId: String(window.windowId) });
      const observedAgainText = observedAgain.content.find(item => item.type === 'text');
      assert.ok(observedAgainText);
      const { observationId: typeObservationId, elements: typeElements } = JSON.parse(observedAgainText.text);
      const typeInput = typeElements?.find(item => item.label === 'Isolated test input');
      assert.ok(typeObservationId && typeInput?.elementToken);
      await type.execute('type', { observationId: typeObservationId, elementToken: typeInput.elementToken, text });
      assert.equal(security.approvals.pending().length, 0, 'typing should reuse the application approval');
      const after = await driver.getWindowState({ pid, windowId: window.windowId, includeAccessibilityTree: true,
        includeScreenshot: false, maxElements: 100, maxDepth: 8, timeoutMs: 1000 });
      assert.equal(after.elements?.find(item => item.label === 'Isolated test input')?.value, text);
      const scrollBefore = await observe.execute('observe-before-scroll', { pid, windowId: String(window.windowId) });
      const scrollBeforeText = scrollBefore.content.find(item => item.type === 'text');
      assert.ok(scrollBeforeText);
      const scrollState = JSON.parse(scrollBeforeText.text);
      const scrollArea = ready.scrollRect;
      assert.ok(scrollArea && [scrollArea.x, scrollArea.y, scrollArea.width, scrollArea.height].every(Number.isFinite));
      const scrollValueBefore = await readScrollValue();
      assert.ok(ready.windowWidth > 0 && ready.windowHeight > 0 && scrollState.screenshotWidth && scrollState.screenshotHeight);
      const x = (scrollArea.x + scrollArea.width / 2) * scrollState.screenshotWidth / ready.windowWidth;
      const y = (scrollArea.y + scrollArea.height / 2) * scrollState.screenshotHeight / ready.windowHeight;
      await scroll.execute('scroll', { observationId: scrollState.observationId, x, y, direction: 'down', by: 'page', amount: 1 });
      const scrollValueAfter = await readScrollValue();
      assert.ok(scrollValueAfter > scrollValueBefore, `Scroll value did not advance: ${scrollValueBefore} -> ${scrollValueAfter}`);
      assert.equal((await driver.listApps({})).apps.find(app => app.active)?.pid, foregroundPid,
        'Desktop smoke must not change the foreground application');
      const timeline = events.map(event => event.type);
      assert.ok(timeline.indexOf('security-approval-requested') < timeline.indexOf('security-approval-decided'));
      assert.ok(timeline.indexOf('security-approval-decided') < timeline.indexOf('security-tool-committed'));
      assert.equal(events.filter(event => event.type === 'security-approval-requested').length, 1);
      assert.equal(events.filter(event => event.type === 'security-tool-committed').length, 3);
      console.log(JSON.stringify({ result: 'pass', pid, windowId: String(window.windowId), approvedClickedTypedAndScrolled: true }));
    });
  } finally { security.approvals.close(); }
} finally {
  try {
    await cleanupSteps([
      { name: 'desktop fixture', run: () => stopFixture(fixture) },
      { name: 'Cua Driver', run: async () => { await driver?.shutdown(); driver?.uniffiDestroy?.(); } },
      { name: 'foreground observer', run: () => foreground?.stop() },
    ]);
    foreground?.assertUnchanged();
  } finally { await rm(root, { recursive: true, force: true }); }
}
