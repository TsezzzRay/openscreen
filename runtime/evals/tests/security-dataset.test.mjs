import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { securityTasks } from '../../dist-evals/evals/security-dataset.js';
import { executeWorkload } from '../../dist-evals/evals/workloads/index.js';
import { loadApplicationConfig } from '../../dist-evals/src/runtime-config.js';

test('security scenarios are separate from the 30-task general baseline', () => {
  assert.deepEqual(securityTasks.map(task => task.id), [
    'security-within-boundary',
    'security-approved-write',
    'security-denied-alternative',
    'security-denied-stop',
    'security-nonpermission-error',
  ]);
  assert.ok(securityTasks.every(task => task.workload === 'agent'));
  assert.ok(securityTasks.every(task => task.capability === 'tool-security'));
});

test('each scenario freezes its authorization decision and checks a real outcome', () => {
  for (const task of securityTasks) {
    assert.ok(task.input.security?.writableRoots?.length);
    assert.ok(['none', 'approve', 'deny'].includes(task.input.security.decision));
    assert.ok(task.input.verifier || task.input.security.expectedUnchanged?.length);
    assert.ok(task.criteria.some(criterion => criterion.id === 'security-authorization'));
  }
  assert.equal(securityTasks[0].input.security.decision, 'none');
  assert.equal(securityTasks[1].input.security.decision, 'approve');
  assert.deepEqual(securityTasks.slice(2, 4).map(task => task.input.security.decision), ['deny', 'deny']);
  assert.equal(securityTasks[4].input.security.decision, 'none');
});

test('recovery task states the exact JSON shape its verifier requires', () => {
  const task = securityTasks.find(item => item.id === 'security-nonpermission-error');
  assert.deepEqual(task.input.verifier.expected, { timeoutMs: 3000 });
  assert.match(task.input.prompt, /\{\s*"timeoutMs"\s*:\s*3000\s*\}/);
  assert.match(task.input.prompt, /grep tool/i);
  assert.ok(task.criteria.some(criterion => criterion.id === 'tool-fallback' && criterion.owner === 'rule'));
  assert.match(task.criteria.find(criterion => criterion.id === 'security-outcome').passExamples[0], /timeoutMs.*3000/);
});

test('approved write separately grades whether the final answer attributes approval to the user', () => {
  const task = securityTasks.find(item => item.id === 'security-approved-write');
  const criterion = task.criteria.find(item => item.id === 'approval-reporting');
  assert.equal(criterion?.owner, 'agent');
  assert.equal(criterion?.dimension, 'safety');
  assert.equal(criterion?.safety, true);
  assert.match(criterion.instruction, /explicit.*user approval/i);
  assert.match(criterion.failExamples[0], /automatically/i);
  assert.deepEqual(criterion.passEvidencePointers, ['/output/answer/visibleAnswer']);
});

test('the security suite has its own CLI listing and run command', () => {
  const listed = execFileSync(process.execPath, ['runtime/dist-evals/evals/cli.js', 'list-security'], { encoding: 'utf8' });
  assert.deepEqual(listed.trim().split('\n').map(line => line.split('\t')[0]), securityTasks.map(task => task.id));
});

test('security Eval executes the production approval path and records authorization evidence', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscreen-security-eval-'));
  try {
    const task = securityTasks.find(item => item.id === 'security-approved-write');
    const faux = fauxProvider({ provider: 'eval-security-approval', models: [{ id: 'test' }] });
    const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
    faux.setResponses([
      call('edit', { path: 'documents/config.json', edits: [{ oldText: '3000', newText: '4500' }] }),
      call('read', { path: 'documents/config.json' }),
      fauxAssistantMessage('Verified timeoutMs 4500.'),
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const events = [];
    const result = await executeWorkload(task, root, loadApplicationConfig(), models, faux.getModel(), event => events.push(event));
    assert.equal(JSON.parse(result.after['documents/config.json']).timeoutMs, 4500);
    assert.equal(events.filter(event => event.type === 'security-approval-requested').length, 1);
    assert.ok(events.some(event => event.type === 'security-approval-decided' && event.approved === true));
    assert.ok(events.some(event => event.type === 'security-tool-committed' && event.target === 'documents/config.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
