import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { withDeadline } from './desktop-host-lifecycle.mjs';

export async function waitForFixtureWindow(driver, pid, windowId, timeoutMs = 5000, intervalMs = 100) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.match(windowId, /^[1-9][0-9]*$/);
  try {
    return await withDeadline(async signal => {
      while (!signal.aborted) {
        const window = (await driver.listWindows({ pid, onScreenOnly: true })).windows.find(item =>
          item.pid === pid && String(item.windowId) === windowId && item.isOnScreen === true);
        signal.throwIfAborted();
        if (window) return window;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
      signal.throwIfAborted();
    }, timeoutMs, () => {});
  } catch (error) { throw new Error('Fixture window unavailable within startup deadline', { cause: error }); }
}

export function installFixtureScope(harness, fixture, record) {
  assert.ok(Number.isSafeInteger(fixture.pid) && fixture.pid > 0);
  assert.match(fixture.windowId, /^[1-9][0-9]*$/);
  let observationId;
  harness.on('tool_call', event => {
    const allowed = event.toolName === 'desktop_window_state'
      ? event.input.pid === fixture.pid && event.input.windowId === fixture.windowId
      : ['desktop_click', 'desktop_scroll', 'desktop_type'].includes(event.toolName) &&
        observationId !== undefined && event.input.observationId === observationId;
    record({ type: 'fixture-tool-check', callId: event.toolCallId, tool: event.toolName, allowed });
    if (!allowed) throw new Error('Host smoke fixture scope rejected tool call before execution');
    if (event.toolName === 'desktop_window_state') observationId = undefined;
  });
  harness.on('tool_result', event => {
    if (event.toolName !== 'desktop_window_state' || event.isError) return;
    const body = event.content.find(item => item.type === 'text')?.text;
    try {
      const result = JSON.parse(body);
      if (result.pid === fixture.pid && result.windowId === fixture.windowId &&
        typeof result.observationId === 'string' && result.observationId.length > 0) {
        observationId = result.observationId;
      }
    } catch { /* No verified observation means subsequent actions remain blocked. */ }
  });
}

export function smokeConfig(config) {
  return { ...config, capture: { ...config.capture,
    native: { ...config.capture.native, enabled: false },
    screenpipe: { ...config.capture.screenpipe, enabled: false } },
  memory: { ...config.memory, enabled: false } };
}

export function fixtureApproval(request, sessionId, pid, windowId) {
  if (request.sessionId !== sessionId || !['desktop_click', 'desktop_scroll', 'desktop_type'].includes(request.tool)) return false;
  const target = request.target;
  return target !== null && typeof target === 'object' && target.pid === pid && target.windowId === windowId;
}

export function verifyFixtureAudit(rows, pid, windowId, text) {
  const audits = rows.filter(row => row.type === 'custom' && row.customType === 'openscreen.approval-event').map(row => row.data);
  assert.ok(audits.length >= 3, 'Missing persisted production security audit');
  const [requested, decided, ...committed] = audits;
  assert.equal(requested.type, 'approval-requested');
  assert.equal(decided.type, 'approval-decided');
  assert.equal(decided.id, requested.id);
  assert.equal(decided.approved, true);
  assert.ok(committed.some(entry => entry.tool === 'desktop_type'));
  for (const entry of [requested, ...committed]) {
    assert.equal(entry.id, requested.id);
    if (entry !== requested) assert.equal(entry.type, 'approval-committed');
    const target = JSON.parse(entry.target);
    assert.equal(target.pid, pid);
    assert.equal(target.windowId, windowId);
    assert.equal(JSON.stringify(entry).includes(text), false, 'Audit contains typed plaintext');
    if (entry.tool === 'desktop_type') {
      assert.equal(target.textLength, [...text].length);
      assert.equal(target.textSha256, createHash('sha256').update(text).digest('hex'));
    }
  }
  return audits.length;
}

export function verifyModelReadback(rows, pid, windowId, text) {
  const calls = new Map();
  let typed = false;
  for (const row of rows) {
    if (row.type !== 'message') continue;
    const message = row.message;
    if (message.role === 'assistant') {
      for (const item of message.content) if (item.type === 'toolCall') {
        assert.equal(calls.has(item.id), false, 'Duplicate model tool call');
        calls.set(item.id, { name: item.name, args: item.arguments, afterTyping: typed });
      }
    }
    if (message.role !== 'toolResult' || message.isError) continue;
    const call = calls.get(message.toolCallId);
    if (!call || call.name !== message.toolName) continue;
    calls.delete(message.toolCallId);
    if (call.name === 'desktop_type' && call.args.text === text) typed = true;
    if (call.name !== 'desktop_window_state' || !call.afterTyping ||
      call.args.pid !== pid || call.args.windowId !== windowId) continue;
    try {
      const result = JSON.parse(message.content.find(item => item.type === 'text')?.text);
      if (result.pid === pid && result.windowId === windowId &&
        result.elements?.some(element => element.label === 'Isolated test input' && element.value === text)) {
        return message.toolCallId;
      }
    } catch { /* Invalid or absent model observation is not verification. */ }
  }
  assert.fail('Missing successful model post-typing readback of the fixture input');
}

export function verifyTurnDiagnostics(turn, sessionId, requestId, audits, typedText) {
  const { records, payloads, turnId } = turn;
  assert.ok(records.length > 0, 'Missing production Turn trace');
  assert.equal(turn.complete, true, 'Turn trace is incomplete');
  assert.equal(turn.threadId, sessionId);
  assert.equal(turn.requestId, requestId);
  assert.equal(records[0].payload.type, 'codex_turn_started');
  assert.equal(records.at(-1).payload.type, 'codex_turn_ended');
  assert.equal(records.at(-1).payload.status, 'completed');
  assert.equal(JSON.stringify(turn).includes(typedText), false, 'Trace contains typed plaintext');
  const models = new Set();
  const tools = new Set();
  const phases = new Set();
  const approvalEvents = [];
  let sequence = records[0].seq - 1;
  let modelCount = 0;
  let toolCount = 0;
  for (const row of records) {
    assert.equal(row.thread_id, sessionId);
    assert.equal(row.codex_turn_id, turnId);
    assert.ok(row.seq > sequence, 'Trace sequence regressed');
    sequence = row.seq;
    const event = row.payload;
    for (const [start, end, key, pending] of [
      ['inference_started', 'inference_completed', 'inference_call_id', models],
      ['tool_call_started', 'tool_call_ended', 'tool_call_id', tools],
    ]) {
      if (event.type === start) {
        assert.equal(pending.has(event[key]), false, 'Duplicate span start');
        pending.add(event[key]);
      } else if (event.type === end) {
        assert.equal(pending.delete(event[key]), true, 'Unmatched span end');
        if (event.type === 'tool_call_ended') assert.equal(event.status, 'completed');
      }
    }
    if (event.type === 'inference_started') modelCount++;
    if (event.type === 'tool_call_started') toolCount++;
    if (event.type === 'other' && event.kind === 'openscreen.phase') {
      if (event.metadata.boundary === 'start') phases.add(event.metadata.phase);
      else assert.equal(phases.delete(event.metadata.phase), true, 'Unmatched phase end');
    }
    if (event.type === 'protocol_event_observed' &&
      ['desktop_approval_request', 'approval_decision', 'approval_committed'].includes(event.event_type)) {
      approvalEvents.push(payloads[event.event_payload.raw_payload_id]);
    }
  }
  assert.equal(models.size + tools.size + phases.size, 0, 'Trace contains unfinished spans');
  assert.ok(modelCount > 0 && toolCount > 0, 'Trace omits model or tool execution');
  assert.equal(approvalEvents.length, audits.length, 'Trace approvals do not match Session audit');
  for (const [index, event] of approvalEvents.entries()) {
    const audit = audits[index];
    assert.equal(event.type, { 'approval-requested': 'desktop_approval_request', 'approval-decided': 'approval_decision', 'approval-committed': 'approval_committed' }[audit.type]);
    assert.equal(event.approval_id, audit.id);
    if (audit.type === 'approval-decided') assert.equal(event.decision, audit.approved ? 'approved' : 'denied');
    else {
      assert.equal(event.call_id, audit.callId);
      assert.equal(event.tool_name, audit.tool);
      assert.equal(event.target_sha256, createHash('sha256').update(audit.target).digest('hex'));
    }
  }
  return { turnId, models: modelCount, tools: toolCount,
    approvals: approvalEvents.filter(event => event.type === 'desktop_approval_request').length };
}
