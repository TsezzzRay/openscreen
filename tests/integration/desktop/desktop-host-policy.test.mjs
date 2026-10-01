import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('host smoke requires a complete content-free Turn matching its Session audit', async () => {
  const policy = await import('./desktop-host-policy.mjs');
  assert.equal(typeof policy.verifyTurnDiagnostics, 'function');
  const { TurnTrace } = await import('../../../runtime/dist/application/diagnostics/turn-trace.js');
  const records = [];
  const payloads = {};
  let ordinal = 0;
  const trace = new TurnTrace({ turnId: 'turn', threadId: 'session', requestId: 'request' }, (turnId, payload, attachment) => {
    if (attachment) {
      const id = `raw_payload:${++ordinal}`;
      payload = { ...payload, [attachment.field]: { raw_payload_id: id, kind: { type: attachment.kind }, path: `payloads/${ordinal}.json` } };
      payloads[id] = attachment.value;
    }
    records.push({ schema_version: 1, seq: records.length + 1, wall_time_unix_ms: Date.now(), rollout_id: 'session',
      thread_id: 'session', codex_turn_id: turnId, payload });
  });
  const model = { invocationId: 'model-1', provider: 'test', model: 'test' };
  trace.agentDiagnostic({ type: 'model-start', ...model });
  trace.agentDiagnostic({ type: 'model-end', invocationId: model.invocationId, stopReason: 'toolUse', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
  trace.agentEvent({ type: 'tool-start', name: 'desktop_type', callId: 'call', input: { text: 'fixture text' } });
  const target = { scope: 'application', action: 'type', pid: 123, windowId: '42', appName: 'Fixture', bundleId: 'fixture',
    observationId: 'observed', screenshotSha256: 'hash', elementToken: 'field', role: 'AXTextField',
    frame: { x: 10, y: 20, w: 200, h: 40 }, textLength: 12, textSha256: createHash('sha256').update('fixture text').digest('hex') };
  trace.agentEvent({ type: 'approval-requested', request: { id: 'grant', sessionId: 'session', callId: 'call', tool: 'desktop_type', target } });
  trace.agentDiagnostic({ type: 'approval-outcome', approvalId: 'grant', reason: 'approved' });
  trace.agentEvent({ type: 'approval-committed', id: 'grant', callId: 'call', tool: 'desktop_type', target });
  trace.agentEvent({ type: 'tool-end', callId: 'call', name: 'desktop_type', text: 'fixture text', isError: false });
  trace.finish('completed');
  const audits = [
    { type: 'approval-requested', id: 'grant', callId: 'call', tool: 'desktop_type', target: JSON.stringify(target) },
    { type: 'approval-decided', id: 'grant', approved: true },
    { type: 'approval-committed', id: 'grant', callId: 'call', tool: 'desktop_type', target: JSON.stringify(target) },
  ];
  const turn = { turnId: 'turn', threadId: 'session', requestId: 'request', complete: true, records, payloads };
  const verify = rows => policy.verifyTurnDiagnostics({ ...turn, records: rows }, 'session', 'request', audits, 'fixture text');
  assert.deepEqual(verify(records), { turnId: 'turn', models: 1, tools: 1, approvals: 1 });
  for (const changed of [
    records.slice(0, -1),
    records.map(row => ({ ...row, thread_id: 'other' })),
    records.map(row => row.payload.type === 'tool_call_ended' ? { ...row, payload: { ...row.payload, tool_call_id: 'other' } } : row),
    records.map(row => row.payload.type === 'inference_completed' ? { ...row, payload: { ...row.payload, inference_call_id: 'other' } } : row),
    records.map(row => row.payload.type === 'tool_call_started' ? { ...row, payload: { ...row.payload, text: 'fixture text' } } : row),
  ]) assert.throws(() => verify(changed));
  const decision = Object.values(payloads).find(value => value.type === 'approval_decision');
  const original = decision.decision;
  decision.decision = 'denied';
  assert.throws(() => verify(records));
  decision.decision = original;
  assert.throws(() => policy.verifyTurnDiagnostics(turn, 'session', 'request', [...audits, audits[2]], 'fixture text'));
});

test('host smoke requires successful model observation after successful typing', async () => {
  const policy = await import('./desktop-host-policy.mjs');
  assert.equal(typeof policy.verifyModelReadback, 'function');
  const text = 'fixture text';
  const call = (id, name, args) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] } });
  const result = (id, name, body, isError = false) => ({ type: 'message', message: {
    role: 'toolResult', toolCallId: id, toolName: name, isError, content: [{ type: 'text', text: JSON.stringify(body) }] } });
  const observation = { pid: 123, windowId: '42', observationId: 'before', elements: [{ label: 'Isolated test input', value: '' }] };
  const rows = [
    call('before', 'desktop_window_state', { pid: 123, windowId: '42' }), result('before', 'desktop_window_state', observation),
    call('type', 'desktop_type', { observationId: 'before', elementToken: 'field', text }), result('type', 'desktop_type', { ok: true }),
    call('after', 'desktop_window_state', { pid: 123, windowId: '42' }),
    result('after', 'desktop_window_state', { ...observation, observationId: 'after', elements: [{ label: 'Isolated test input', value: text }] }),
  ];
  assert.equal(policy.verifyModelReadback(rows, 123, '42', text), 'after');
  assert.throws(() => policy.verifyModelReadback(rows.slice(0, 4), 123, '42', text), /model.*readback/i);
  for (const altered of [
    [...rows.slice(0, 5), result('after', 'desktop_window_state', observation)],
    [...rows.slice(0, 5), result('after', 'desktop_window_state', { ...observation, elements: [{ label: 'Isolated test input', value: text }] }, true)],
    [...rows.slice(0, 3), result('type', 'desktop_type', {}, true), ...rows.slice(4)],
    [...rows.slice(0, 4), call('after', 'desktop_window_state', { pid: 124, windowId: '42' }), rows[5]],
    [...rows.slice(0, 5), { ...rows[5], message: { ...rows[5].message, toolCallId: 'unmatched' } }],
  ]) assert.throws(() => policy.verifyModelReadback(altered, 123, '42', text));
});

test('runtime preload scopes a harness created by the production Session factory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscreen-host-scope-'));
  const keys = ['OPENSCREEN_DESKTOP_HOST_SMOKE', 'OPENSCREEN_HOST_FIXTURE_SCOPE', 'OPENSCREEN_HOST_SCOPE_AUDIT'];
  const before = keys.map(key => process.env[key]);
  process.env.OPENSCREEN_DESKTOP_HOST_SMOKE = '1';
  process.env.OPENSCREEN_HOST_FIXTURE_SCOPE = JSON.stringify({ pid: 123, windowId: '42' });
  process.env.OPENSCREEN_HOST_SCOPE_AUDIT = join(root, 'scope.jsonl');
  try {
    const preload = await import('./desktop-host-preload.mjs').catch(error => {
      if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
      throw error;
    });
    assert.equal(preload.fixtureScopeInstalled, true);
    const { PiSessionRuntime } = await import('../../../runtime/dist/agent/pi/session-runtime.js');
    const { InMemorySessionRepo } = await import('@earendil-works/pi-agent-core');
    const { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } = await import('@earendil-works/pi-ai');
    const { Type } = await import('typebox');
    const faux = fauxProvider({ provider: `preload-${crypto.randomUUID()}` });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(fauxToolCall('read', { path: 'private.txt' })), fauxAssistantMessage('done')]);
    let executions = 0;
    const runtime = new PiSessionRuntime({ cwd: root, sessionsRoot: join(root, 'sessions'), models, model: faux.getModel(),
      tools: [{ name: 'read', label: 'read', description: 'read', parameters: Type.Object({ path: Type.String() }),
        execute: async () => { executions++; return { content: [{ type: 'text', text: 'private' }], details: {} }; } }] });
    const harness = runtime.createHarnessFromState(await new InMemorySessionRepo().create(), { thinkingLevel: 'off' });
    await harness.prompt('attempt a file read');
    assert.equal(executions, 0);
    const rows = (await readFile(join(root, 'scope.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].type, 'fixture-scope-installed');
    assert.equal(rows[1].allowed, false);
    assert.equal(rows[1].tool, 'read');
    assert.equal(JSON.stringify(rows).includes('private.txt'), false);
  } finally {
    keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
  }
});

test('fixture scope rejects unapproved tools and foreign windows before execution', async () => {
  const policy = await import('./desktop-host-policy.mjs');
  assert.equal(typeof policy.installFixtureScope, 'function');
  const { AgentHarness, InMemorySessionRepo } = await import('@earendil-works/pi-agent-core');
  const { NodeExecutionEnv } = await import('@earendil-works/pi-agent-core/node');
  const { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } = await import('@earendil-works/pi-ai');
  const { Type } = await import('typebox');
  for (const [name, input, allowed] of [
    ['desktop_window_state', { pid: 123, windowId: '42' }, true],
    ['desktop_type', { observationId: 'observed-fixture' }, true],
    ['desktop_window_state', { pid: 124, windowId: '42' }, false],
    ['desktop_click', { observationId: 'foreign-observation' }, false],
    ['desktop_type', { pid: 123, windowId: '42' }, false],
    ...['bash', 'read', 'write', 'edit', 'ls', 'find', 'grep', 'desktop_windows', 'unknown'].map(name => [name, {}, false]),
  ]) {
    const faux = fauxProvider({ provider: `scope-${crypto.randomUUID()}` });
    const models = createModels();
    models.setProvider(faux.provider);
    const needsObservation = name !== 'desktop_window_state';
    faux.setResponses([
      ...(needsObservation ? [fauxAssistantMessage(fauxToolCall('desktop_window_state', { pid: 123, windowId: '42' }))] : []),
      fauxAssistantMessage(fauxToolCall(name, input)), fauxAssistantMessage('done')]);
    let executions = 0;
    const harness = new AgentHarness({ env: new NodeExecutionEnv({ cwd: process.cwd() }),
      session: await new InMemorySessionRepo().create(), models, model: faux.getModel(),
      tools: [
        ...(needsObservation ? [{ name: 'desktop_window_state', label: 'observe', description: 'observe',
          parameters: Type.Object({}, { additionalProperties: true }), execute: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ pid: 123, windowId: '42', observationId: 'observed-fixture' }) }], details: {} }) }] : []),
        { name, label: name, description: name, parameters: Type.Object({}, { additionalProperties: true }),
          execute: async () => { executions++; return { content: [{ type: 'text', text: 'ok' }], details: {} }; } }] });
    const records = [];
    policy.installFixtureScope(harness, { pid: 123, windowId: '42' }, record => records.push(record));
    await harness.prompt('test scope');
    assert.equal(executions, allowed ? 1 : 0, name);
    assert.equal(records.at(-1)?.allowed, allowed, name);
    assert.equal(JSON.stringify(records).includes('"input"'), false, 'Scope audit must not copy tool arguments');
  }
});

test('host smoke disables capture and memory without changing the configured model', async () => {
  const modulePath = './desktop-host-policy.mjs';
  const policy = await import(modulePath).catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof policy.smokeConfig, 'function');
  const config = { agent: { provider: 'fixture', model: 'fixture-model' },
    capture: { native: { enabled: true }, screenpipe: { enabled: true, retained: 1 } }, memory: { enabled: true } };
  const derived = policy.smokeConfig(config);
  assert.deepEqual(derived.agent, config.agent);
  assert.equal(derived.capture.native.enabled, false);
  assert.equal(derived.capture.screenpipe.enabled, false);
  assert.equal(derived.capture.screenpipe.retained, 1);
  assert.equal(derived.memory.enabled, false);
  assert.equal(config.capture.native.enabled, true);
});

test('host smoke validates audit order, exact target, and text digest without plaintext', async () => {
  const modulePath = './desktop-host-policy.mjs';
  const policy = await import(modulePath);
  assert.equal(typeof policy.verifyFixtureAudit, 'function');
  const text = 'fixture text';
  const target = JSON.stringify({ pid: 123, windowId: '42', textLength: [...text].length,
    textSha256: createHash('sha256').update(text).digest('hex') });
  const data = [
    { type: 'approval-requested', id: 'grant', callId: 'call', tool: 'desktop_type', target },
    { type: 'approval-decided', id: 'grant', approved: true },
    { type: 'approval-committed', id: 'grant', callId: 'call', tool: 'desktop_type', target },
  ];
  const rows = data.map(data => ({ type: 'custom', customType: 'openscreen.approval-event', data }));
  assert.equal(policy.verifyFixtureAudit(rows, 123, '42', text), 3);
  assert.throws(() => policy.verifyFixtureAudit([...rows].reverse(), 123, '42', text));
  assert.throws(() => policy.verifyFixtureAudit(rows, 124, '42', text));
  assert.throws(() => policy.verifyFixtureAudit(rows, 123, '42', 'different'));
});

test('host smoke approves only desktop input in the exact temporary fixture', async () => {
  const modulePath = './desktop-host-policy.mjs';
  const policy = await import(modulePath).catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw error;
  });
  assert.equal(typeof policy.fixtureApproval, 'function');
  const request = { sessionId: 'session', tool: 'desktop_type', target: { pid: 123, windowId: '42' } };
  assert.equal(policy.fixtureApproval(request, 'session', 123, '42'), true);
  for (const changed of [{ tool: 'bash' }, { sessionId: 'other' }, { target: '{}' },
    { target: { pid: 124, windowId: '42' } }, { target: { pid: 123, windowId: '43' } },
    { target: 'not-json' }, { target: null }]) {
    assert.equal(policy.fixtureApproval({ ...request, ...changed }, 'session', 123, '42'), false);
  }
});
