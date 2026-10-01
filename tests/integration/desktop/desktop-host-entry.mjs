import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { app } from 'electron';
import { AgentClient } from '../../../app/src/main/agent-client.ts';
import { fixtureApproval, verifyFixtureAudit, verifyModelReadback, verifyTurnDiagnostics, waitForFixtureWindow } from './desktop-host-policy.mjs';
import { stopFixture, cleanupSteps } from './desktop-host-lifecycle.mjs';

// No BrowserWindow, Dock icon, activation, hotkeys, Capture, or permission prompts.
app.setActivationPolicy('prohibited');
app.on('window-all-closed', event => event.preventDefault());
const root = process.argv[2];
const repo = process.cwd();
let fixture;
let driver;
let client;
let deadline;
let sessionId;
let promptId;
const events = [];
const pending = new Map();
const requests = [];
const commits = [];

async function request(command) {
  const requestId = `host-${crypto.randomUUID()}`;
  if (command.type === 'prompt') promptId = requestId;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, events: [] });
    client.send({ ...command, requestId });
  });
}

async function run() {
  await app.whenReady();
  assert.equal(process.env.OPENSCREEN_DESKTOP_HOST_SMOKE, '1');
  const { CuaDriver } = await import(pathToFileURL(join(repo, 'node_modules/@trycua/cua-driver/dist/index.js')).href);
  driver = CuaDriver.create(undefined);
  const foreground = Number(process.env.OPENSCREEN_HOST_FOREGROUND_PID);
  assert.ok(Number.isSafeInteger(foreground) && foreground > 0, 'Launcher foreground baseline is required');
  // The launcher observes native activation events from before Electron starts
  // through cleanup and terminates this isolated process group on any change.
  execFileSync('swiftc', ['-O', '-o', join(root, 'desktop-fixture'), 'tests/integration/desktop/fixtures/desktop-fixture.swift'], { timeout: 15_000 });
  fixture = spawn(join(root, 'desktop-fixture'), [], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = createInterface({ input: fixture.stdout });
  let readyTimer;
  const ready = await Promise.race([
    new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
    new Promise((_, reject) => { readyTimer = setTimeout(() => reject(new Error('Fixture startup timeout')), 5000); }),
  ]).finally(() => clearTimeout(readyTimer));
  let window;
  try { window = await waitForFixtureWindow(driver, ready.pid, ready.windowId); }
  catch (error) {
    const candidates = (await driver.listWindows({ onScreenOnly: false })).windows.filter(item => item.pid === ready.pid);
    await writeFile(join(root, 'fixture-window-diagnostic.json'), JSON.stringify({
      pid: ready.pid, nativeWindowId: ready.windowId, nativeVisible: ready.visible,
      fixtureExitCode: fixture.exitCode, fixtureSignal: fixture.signalCode,
      sdkFixtureWindowIds: candidates.map(item => String(item.windowId)),
    }), { mode: 0o600 });
    throw error;
  }
  assert.ok(window, 'Fixture window unavailable');
  const snapshot = () => driver.getWindowState({ pid: ready.pid, windowId: window.windowId,
    includeAccessibilityTree: true, includeScreenshot: false, maxElements: 100, maxDepth: 8, timeoutMs: 1000 });
  const inputValue = async () => (await snapshot()).elements?.find(item => item.label === 'Isolated test input')?.value;
  const original = await inputValue();
  if (typeof original !== 'string') {
    const samples = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const state = await snapshot();
      const input = state.elements?.find(item => item.label === 'Isolated test input');
      samples.push({ elementCount: state.elements?.length ?? 0, inputFound: !!input,
        inputValueType: typeof input?.value, treeAvailable: typeof state.treeMarkdown === 'string',
        degraded: state.degraded, degradedReason: state.degradedReason,
        elementsComplete: state.elementsComplete, treeMarkdown: state.treeMarkdown });
    }
    await writeFile(join(root, 'fixture-input-diagnostic.json'), JSON.stringify({
      pid: ready.pid, windowId: String(window.windowId), samples,
    }), { mode: 0o600 });
  }
  assert.equal(typeof original, 'string', 'Fixture input readback unavailable');
  client = new AgentClient({ command: process.execPath,
    args: ['--import', join(repo, 'tests/integration/desktop/desktop-host-preload.mjs'), join(repo, 'runtime/dist/main.js')], cwd: repo,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENSCREEN_APP_PID: String(process.pid),
      OPENSCREEN_HOST_FIXTURE_SCOPE: JSON.stringify({ pid: ready.pid, windowId: String(window.windowId) }),
      OPENSCREEN_HOST_SCOPE_AUDIT: join(root, 'fixture-scope.jsonl'),
      OPENSCREEN_CONFIG_PATH: join(root, 'config.json'), OPENSCREEN_DATA_DIR: join(root, 'data') },
    onStderr: () => { /* Never copy provider output or credentials into diagnostic logs. */ },
  });
  client.on('status', status => {
    if (status.state === 'stopped') for (const item of pending.values()) item.reject(new Error('Production runtime stopped'));
  });
  client.on('event', ({ requestId, event }) => {
    events.push({ requestId, type: event.type });
    const current = pending.get(requestId);
    current?.events.push(event);
    if (event.type === 'approval_requested') {
      requests.push(event.request);
      void (async () => {
        const approved = fixtureApproval(event.request, sessionId, ready.pid, String(window.windowId));
        if (approved) assert.equal(await inputValue(), original, 'Input changed before app approval');
        await request({ type: 'decide_approval', sessionId: event.sessionId, approvalId: event.request.id, approved });
        if (!approved) throw new Error('Model requested an action outside the temporary fixture');
      })().catch(error => {
        for (const item of pending.values()) item.reject(error);
        if (sessionId && promptId) client.send({ requestId: 'host-abort', type: 'abort', sessionId, targetRequestId: promptId });
      });
    }
    if (event.type === 'approval_committed') commits.push(event);
    if (event.type === 'completed' || event.type === 'failed') {
      pending.delete(requestId);
      if (event.type === 'failed') current?.reject(new Error(`Runtime failed: ${event.error?.code ?? 'unknown'}`));
      else current?.resolve(current.events);
    }
  });
  client.start();
  const created = await request({ type: 'create_session' });
  sessionId = created.find(event => event.type === 'session_view')?.view.session.id;
  assert.ok(sessionId, 'Production runtime did not create a Session');
  const text = 'OpenScreen host test';
  await request({ type: 'prompt', sessionId, input: { text:
    `This is an authorized isolated desktop test. Only operate PID ${ready.pid}, window ID ${window.windowId}, titled OpenScreen isolated input test. Use desktop_window_state for that exact window, then desktop_type to enter exactly "${text}" into the input labeled Isolated test input. Do not use Bash, file tools, desktop_windows, other apps, or the Protected test input. Do not request foreground input. The test harness will approve only this fixture app. After typing, inspect that same window to verify the value. If blocked, report the failure without alternatives.` } });
  assert.equal(await inputValue(), text, 'Production runtime did not enter the expected fixture value');
  assert.equal(requests.length, 1, 'Expected one application approval');
  assert.ok(commits.some(event => event.tool === 'desktop_type'), 'Missing input commit event');
  assert.ok(events.findIndex(event => event.type === 'approval_decided') < events.findIndex(event => event.type === 'approval_committed'));
  await client.stop();
  const sessionFiles = await readdir(join(root, 'data/sessions'), { recursive: true });
  const jsonl = sessionFiles.filter(file => file.endsWith('.jsonl'));
  assert.equal(jsonl.length, 1, 'Expected one private production Session');
  const rows = (await readFile(join(root, 'data/sessions', jsonl[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const auditEntries = verifyFixtureAudit(rows, ready.pid, String(window.windowId), text);
  const modelReadbackCallId = verifyModelReadback(rows, ready.pid, String(window.windowId), text);
  const { readDiagnosticTurns } = await import(pathToFileURL(join(repo, 'runtime/dist/application/diagnostics/store.js')).href);
  const diagnosticTurns = await readDiagnosticTurns(join(root, 'data/diagnostics/traces'), { sessionId });
  assert.equal(diagnosticTurns.length, 1, 'Expected one production prompt Turn');
  assert.equal(diagnosticTurns[0].incompleteTail, false);
  const audits = rows.filter(row => row.type === 'custom' && row.customType === 'openscreen.approval-event').map(row => row.data);
  const diagnostics = verifyTurnDiagnostics(diagnosticTurns[0], sessionId, promptId, audits, text);
  const scope = (await readFile(join(root, 'fixture-scope.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(scope.some(entry => entry.type === 'fixture-scope-installed'), 'Missing runtime fixture scope');
  const checks = scope.filter(entry => entry.type === 'fixture-tool-check');
  assert.ok(checks.length > 0, 'Missing execution-time fixture checks');
  assert.ok(checks.every(entry => entry.allowed === true), 'Model attempted a tool outside the fixture scope');
  return { result: 'pass', hostPid: process.pid,
    targetPid: ready.pid, windowId: String(window.windowId), foregroundPid: foreground,
    approvals: requests.length, inputCommits: commits.filter(event => event.tool === 'desktop_type').length,
    auditEntries, modelReadbackCallId, diagnostics, events };
}

async function main() {
  const failures = [];
  let report;
  try {
    report = await Promise.race([
      run(),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Host smoke deadline exceeded')), 120_000); }),
    ]);
  } catch (error) { failures.push(error instanceof Error ? error.message : 'Host smoke failed'); }
  try {
    await cleanupSteps([
      { name: 'runtime', run: async () => { await client?.stop(); assert.ok(!client?.running, 'Runtime still running'); } },
      { name: 'fixture', run: () => stopFixture(fixture) },
      { name: 'driver shutdown', run: () => driver?.shutdown() },
      { name: 'driver destroy', run: () => driver?.uniffiDestroy() },
    ]);
  } catch (error) { failures.push(error.message); }
  clearTimeout(deadline);
  try {
    if (failures.length > 0) {
      await writeFile(join(root, 'failure.json'), JSON.stringify({ result: 'fail', reasons: failures, events }), { mode: 0o600 });
      console.error(failures.join('; '));
    } else {
      await writeFile(join(root, 'report.json'), JSON.stringify({ ...report, cleanupVerified: true }, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ result: 'pass', hostSpawnedProductionRuntime: true, report: join(root, 'report.json') }));
    }
  } catch { failures.push('Failed to persist final host report'); }
  finally {
    app.exit(failures.length > 0 ? 1 : 0);
  }
}
void main();
