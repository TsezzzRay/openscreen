import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRun, finishTrial } from '../../dist-evals/evals/persistence.js';
import { gradeRun } from '../../dist-evals/evals/report.js';
import { calibrationCases } from '../../dist-evals/evals/calibration.js';
import { snapshot } from '../../dist-evals/evals/workspace.js';

const calibration = calibrationCases.map(item => ({ caseId: item.id, status: item.expectedStatus, reason: 'Matches the calibration rubric.' }));
const cli = new URL('../../dist-evals/evals/cli.js', import.meta.url).pathname;

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'openscreen-evidence-'));
  try {
    const task = { id: 'screen', workload: 'screen-activity-memory', capability: 'activity-memory', criteria: [{
      id: 'facts', owner: 'agent', required: true, dimension: 'grounding',
      requiredEvidencePointers: ['/after/memory~1ACTIVITY.md'],
    }] };
    const run = await createRun(root, { runId: 'run', tasks: [task], trials: 2, instructionHash: 'frozen' });
    for (let index = 1; index <= 2; index++) await finishTrial(run, `screen-${index}`, {
      status: 'completed', modelCalls: 1,
      after: { 'memory/ACTIVITY.md': 'Screen displayed deployment succeeded; frame-2.', 'memory/rollout_summaries/x~y.md': 'Screen displayed deployment failed; frame-1.' },
      output: { answer: 'Deployment succeeded according to the screen.', verification: [
        { passed: true }, { passed: false, reason: '' },
        { passed: true, failures: [] }, { passed: false, reason: 'Verification did not match the screen.' },
        { details: {} },
      ] },
    });
    await writeFile(join(run, 'artifacts/screen-1/screen.png'), Buffer.from([137, 80, 78, 71, ...new Array(30).fill(65)]));
    const frozen = await snapshot(run);
    const output = join(root, 'evidence.json');
    execFileSync(process.execPath, [cli, 'evidence', '--run', run, '--output', output], { stdio: 'pipe' });
    const catalog = JSON.parse(await readFile(output, 'utf8'));
    const entry = catalog.entries.find(item => item.trialId === 'screen-1' && item.locator.pointer === '/after/memory~1ACTIVITY.md');
    const submission = { agent: 'test', model: 'test', instructionHash: 'frozen', calibration,
      evidenceProtocol: 'evidence-id-v1', evidenceCatalogHash: catalog.catalogHash,
      scores: [{ trialId: 'screen-1', criterionId: 'facts', status: 'pass', reason: 'Matches the recorded screen.', evidenceIds: [entry?.id] }],
    };
    await callback({ root, run, output, catalog, entry, submission, frozen });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('evidence preparation generates stable exact locators without changing frozen files', async () => fixture(async ({ root, run, output, catalog, entry, frozen }) => {
  assert.equal(catalog.protocol, 'evidence-id-v1');
  assert.equal(entry.locator.quote, 'Screen displayed deployment succeeded; frame-2.');
  assert.ok(catalog.entries.some(item => item.locator.pointer === '/after/memory~1rollout_summaries~1x~0y.md'));
  assert.ok(catalog.entries.some(item => item.locator.line === 2));
  assert.ok(catalog.entries.some(item => item.locator.pointer === '/output/verification/0'));
  const second = join(root, 'second.json');
  execFileSync(process.execPath, [cli, 'evidence', '--run', run, '--output', second]);
  assert.equal(await readFile(output, 'utf8'), await readFile(second, 'utf8'));
  assert.deepEqual(await snapshot(run), frozen);
  assert.throws(() => execFileSync(process.execPath, [cli, 'evidence', '--run', run, '--output', join(run, 'evidence.json')], { stdio: 'pipe' }), /outside.*run/i);
}));

test('evidence catalog does not present binary screenshots as textual excerpts', async () => fixture(async ({ catalog }) => {
  assert.equal(catalog.entries.some(item => item.locator.path.endsWith('.png')), false);
}));

test('short string leaves do not hide a citable structured result', async () => fixture(async ({ run, catalog, submission }) => {
  const entry = catalog.entries.find(item => item.trialId === 'screen-1' && item.locator.pointer === '/output/verification/1');
  assert.ok(entry, 'The complete structured result must receive an ID.');
  assert.equal(entry.locator.quote, '{"passed":false,"reason":""}');
  submission.scores[0].evidenceIds.push(entry.id);
  assert.equal((await gradeRun(run, submission)).report.trialResults[0].criteria[0].status, 'pass');
}));

test('verification flags remain citable with arrays, long reasons and empty nested values', async () => fixture(async ({ run, catalog, submission }) => {
  for (const [index, quote] of [
    [2, '{"passed":true,"failures":[]}'],
    [3, '{"passed":false,"reason":"Verification did not match the screen."}'],
    [4, '{"details":{}}'],
  ]) {
    const entry = catalog.entries.find(item => item.trialId === 'screen-1' && item.locator.pointer === `/output/verification/${index}`);
    assert.ok(entry, `Verification ${index} needs a complete structured citation.`);
    assert.equal(entry.locator.quote, quote);
    submission.scores[0].evidenceIds.push(entry.id);
  }
  assert.equal((await gradeRun(run, submission)).report.trialResults[0].criteria[0].status, 'pass');
}));

test('evidence preparation rejects artifact aliases and output aliases into the frozen run', async () => fixture(async ({ root, run }) => {
  const alias = join(root, 'run-alias');
  await symlink(run, alias);
  assert.throws(() => execFileSync(process.execPath, [cli, 'evidence', '--run', run, '--output', join(alias, 'evidence.json')], { stdio: 'pipe' }), /outside.*run/i);
  await symlink(join(run, 'artifacts/screen-2/result.json'), join(run, 'artifacts/screen-1/alias.json'));
  assert.throws(() => execFileSync(process.execPath, [cli, 'evidence', '--run', run, '--output', join(root, 'aliases.json')], { stdio: 'pipe' }), /symlink/i);
}));

test('ID scores materialize verified original locators and record the new protocol', async () => fixture(async ({ run, catalog, submission }) => {
  const graded = await gradeRun(run, submission);
  const score = graded.report.trialResults[0].criteria[0];
  assert.equal(score.status, 'pass');
  assert.deepEqual(score.evidence, ['artifacts/screen-1/result.json']);
  assert.equal(score.locators[0].pointer, '/after/memory~1ACTIVITY.md');
  const manifest = JSON.parse(await readFile(join(graded.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.evidenceProtocol, catalog.protocol);
  assert.equal(manifest.evidenceCatalogHash, catalog.catalogHash);
}));

test('ID scores reject invented IDs, another trial, mixed locators and omitted stage evidence', async () => fixture(async ({ run, catalog, submission }) => {
  const row = submission.scores[0];
  row.evidenceIds = ['invented'];
  await assert.rejects(gradeRun(run, submission), /unknown evidence ID/i);
  row.evidenceIds = [catalog.entries.find(item => item.trialId === 'screen-2').id];
  await assert.rejects(gradeRun(run, submission), /scored trial/i);
  row.evidenceIds = [catalog.entries.find(item => item.trialId === 'screen-1' && item.locator.pointer === '/output/answer').id];
  await assert.rejects(gradeRun(run, submission), /required stage/i);
  row.locators = [];
  await assert.rejects(gradeRun(run, submission), /mix/i);
}));

test('catalog binding rejects mutated archives and unsupported protocols', async () => fixture(async ({ run, submission }) => {
  submission.evidenceProtocol = 'unknown';
  await assert.rejects(gradeRun(run, submission), /protocol/i);
  submission.evidenceProtocol = 'evidence-id-v1';
  const path = join(run, 'artifacts/screen-1/result.json');
  const result = JSON.parse(await readFile(path, 'utf8'));
  result.after['memory/ACTIVITY.md'] = 'A different screen was displayed; frame-3.';
  await writeFile(path, JSON.stringify(result));
  await assert.rejects(gradeRun(run, submission), /catalog.*match/i);
}));
