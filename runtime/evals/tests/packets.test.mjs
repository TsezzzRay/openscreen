import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as evidence from '../../dist-evals/evals/evidence.js';
import * as calibrationModule from '../../dist-evals/evals/calibration.js';
import { appendEvent, createRun, finishTrial } from '../../dist-evals/evals/persistence.js';
import { gradeRun } from '../../dist-evals/evals/report.js';
import { snapshot } from '../../dist-evals/evals/workspace.js';

const cli = new URL('../../dist-evals/evals/cli.js', import.meta.url).pathname;
const answers = cases => cases.map(c => ({ caseId: c.id, status: c.expectedStatus, reason: 'Matches the original evidence.' }));

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'openscreen-packets-'));
  try {
    const summary = 'The repair was pending at compaction. '.repeat(1600) + 'Preserve the unfinished repair.';
    const session = [
      { type: 'message', message: { role: 'user', content: 'Repair the date parser without changing schema.sql.' } },
      { type: 'message', message: { role: 'toolResult', content: 'Tests ran after the repair: all passed.' } },
      { type: 'message', message: { role: 'assistant', content: 'The repair is now complete and verified.' } },
    ].map(x => JSON.stringify(x)).join('\n{}\n') + '\n{}';
    const task = { id: 'repair', workload: 'compaction', capability: 'compaction', input: { prompt: 'Repair the date parser.' }, criteria: [{
      id: 'facts', owner: 'agent', required: true, dimension: 'grounding',
      requiredEvidencePointers: ['/output/compression/summary', '/after/report.md'],
    }] };
    const run = await createRun(root, { runId: 'run', tasks: [task], trials: 1, instructionHash: 'frozen' });
    await appendEvent(run, 'repair-1', { type: 'model-tool-draft', text: 'Two frames were observed before publication.' });
    await finishTrial(run, 'repair-1', { status: 'completed', modelCalls: 1,
      before: { 'report.md': 'The date parser repair is unfinished.' },
      after: { 'report.md': 'The date parser repair is complete and verified.' },
      output: { compression: { summary }, sessions: { 'nested/session.jsonl': session },
        answer: { visibleAnswer: 'The date parser repair is complete and verified.' },
        followUps: [{ visibleAnswer: 'I resumed the pending repair and ran its tests.' }],
      },
    });
    await callback({ root, run, summary, session });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('stage packets retain exact bounded excerpts, pages and original source order', async () => fixture(async ({ run, summary, session }) => {
  const frozen = await snapshot(run);
  const packet = await evidence.buildStagePackets(run);
  assert.equal(packet.protocol, 'staged-evidence-id-v2');
  assert.equal(packet.catalogHash, (await evidence.buildStagePackets(run)).catalogHash);
  assert.deepEqual(await snapshot(run), frozen);
  const chunks = packet.entries.filter(e => e.locator.pointer === '/output/compression/summary');
  assert.ok(chunks.length > 10);
  assert.equal(chunks.map(e => e.locator.quote).join(''), summary);
  assert.ok(chunks.every(e => e.stage === 'summary' && e.locator.quote.length <= 1600));
  assert.equal(packet.entries.filter(e => e.locator.pointer === '/output/sessions/nested~1session.jsonl').map(e => e.locator.quote).join(''), session);
  assert.deepEqual(chunks.map(e => e.part), chunks.map((_, i) => i + 1));
  assert.ok(packet.packets.every(p => JSON.stringify(p).length <= 12000));
  for (const page of packet.packets) {
    const view = evidence.stagePacketView(packet, page.trialId, page.stage, page.page);
    assert.ok(JSON.stringify(view).length <= 12000);
    assert.deepEqual(view.entries.map(e => e.id), page.evidenceIds);
  }
  assert.throws(() => evidence.stagePacketView(packet, 'missing', 'summary', 1), /unknown.*page/i);
  assert.deepEqual(packet.packets.flatMap(p => p.evidenceIds).sort(), packet.entries.map(e => e.id).sort());
  assert.ok(packet.entries.some(e => e.stage === 'continuation' && e.locator.pointer === '/output/followUps/0/visibleAnswer'));
  assert.ok(packet.entries.some(e => e.stage === 'artifact' && e.locator.pointer === '/after/report.md'));
  assert.ok(packet.entries.some(e => e.stage === 'input' && e.locator.quote.includes('Repair the date parser without')));
  assert.ok(packet.entries.some(e => e.stage === 'execution' && e.locator.quote.includes('Tests ran after')));
  assert.ok(packet.entries.some(e => e.stage === 'answer' && e.locator.quote.includes('now complete')));
}));

test('readable pages distinguish raw trace drafts from persisted artifacts', async () => fixture(async ({ run }) => {
  const catalog = await evidence.buildReadableStagePackets(run);
  assert.ok(catalog.entries.some(entry => entry.locator.path.startsWith('traces/') && entry.recordKind === 'raw-trace'));
  assert.ok(catalog.entries.some(entry => entry.locator.pointer === '/after/report.md' && entry.recordKind === 'persisted-artifact'));
  const artifactPage = catalog.packets.find(packet => packet.stage === 'artifact');
  assert.match(evidence.readableStagePacketView(catalog, artifactPage.trialId, artifactPage.stage, artifactPage.page).sourceInterpretation, /raw.*draft.*persisted/i);
}));

test('readable listing identifies each frozen screenshot by trial, path, size and digest without exposing its bytes as text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscreen-media-'));
  try {
    const run = await createRun(root, { runId: 'screens', tasks: [
      { id: 'screen', workload: 'screen', capability: 'screen', input: {}, criteria: [] },
    ], trials: 2, instructionHash: 'frozen' });
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(64).fill(87)]);
    await writeFile(join(run, 'artifacts/screen-1/screen.png'), image);
    await finishTrial(run, 'screen-1', { status: 'completed', output: { answer: 'Screen one.' } });
    await finishTrial(run, 'screen-2', { status: 'completed', output: { answer: 'Screen two.' } });
    const frozen = await snapshot(run);
    const readable = await evidence.buildReadableStagePackets(run);
    const expected = { trialId: 'screen-1', path: 'artifacts/screen-1/screen.png',
      length: image.length, sha256: createHash('sha256').update(image).digest('hex') };
    assert.deepEqual(readable.mediaSources, [expected]);
    const listing = JSON.parse(execFileSync(process.execPath, [cli, 'readable-packet-list', '--run', run, '--trial', 'screen-1'], { encoding: 'utf8' }));
    assert.deepEqual(listing.mediaSources, [expected]);
    assert.ok(!JSON.stringify(listing).includes(image.toString('base64')));
    assert.deepEqual(await snapshot(run), frozen);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stage protocol imports original locators and requires its separate calibration', async () => fixture(async ({ run }) => {
  const packet = await evidence.buildStagePackets(run);
  const submission = { agent: 'test', model: 'test', instructionHash: 'frozen',
    calibration: answers(calibrationModule.calibrationCases),
    packetCalibration: answers(calibrationModule.packetCalibrationCases),
    evidenceProtocol: packet.protocol, evidenceCatalogHash: packet.catalogHash,
    scores: [{ trialId: 'repair-1', criterionId: 'facts', status: 'pass', reason: 'Pending work was subsequently completed.',
      evidenceIds: packet.entries.filter(e => ['/output/compression/summary', '/after/report.md'].includes(e.locator.pointer)).map(e => e.id) }],
  };
  const graded = await gradeRun(run, submission);
  assert.equal(graded.report.overall.passed, 1);
  const manifest = JSON.parse(await readFile(join(graded.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.evidenceProtocol, packet.protocol);
  assert.equal(manifest.packetCalibration.correct, 4);
  delete submission.packetCalibration;
  await assert.rejects(gradeRun(run, submission), /packet calibration/i);
  submission.packetCalibration = answers(calibrationModule.packetCalibrationCases);
  submission.packetCalibration[0].status = 'fail';
  await assert.rejects(gradeRun(run, submission), /calibration failed/i);
  submission.packetCalibration = answers(calibrationModule.packetCalibrationCases);
  submission.scores[0].evidenceIds = ['invented'];
  await assert.rejects(gradeRun(run, submission), /unknown evidence ID/i);
}));

test('packet CLI keeps old catalog transport and frozen files untouched', async () => fixture(async ({ root, run }) => {
  const frozen = await snapshot(run);
  const output = join(root, 'packet.json');
  execFileSync(process.execPath, [cli, 'packet', '--run', run, '--output', output], { stdio: 'pipe' });
  const packet = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(packet.protocol, 'staged-evidence-id-v2');
  assert.equal(packet.packetCalibration.length, 4);
  assert.ok(packet.packetCalibration.every(c => !Object.hasOwn(c, 'expectedStatus')));
  assert.equal((await evidence.buildEvidenceCatalog(run)).protocol, 'evidence-id-v1');
  const page = packet.packets[0];
  const view = JSON.parse(execFileSync(process.execPath, [cli, 'packet-view', '--run', run, '--trial', page.trialId, '--stage', page.stage, '--page', String(page.page)], { encoding: 'utf8' }));
  assert.deepEqual(view.entries.map(e => e.id), page.evidenceIds);
  assert.ok(JSON.stringify(view).length <= 12000);
  assert.deepEqual(await snapshot(run), frozen);
  assert.throws(() => execFileSync(process.execPath, [cli, 'packet', '--run', run, '--output', join(run, 'packet.json')], { stdio: 'pipe' }), /outside.*run/i);
}));

test('readable packets collapse embedded image data, preserve source locations, and import exact aliases', async () => fixture(async ({ run }) => {
  const frozen = await snapshot(run);
  const image = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(120000, 19)]).toString('base64');
  // The fixture helper owns this run. Use a second frozen trial instead of mutating it after completion.
  const root = await mkdtemp(join(tmpdir(), 'openscreen-readable-'));
  try {
    const task = { id: 'screen', workload: 'screen', capability: 'screen', input: {}, criteria: [{
      id: 'grounding', owner: 'agent', required: true, dimension: 'grounding',
      requiredEvidencePointers: ['/output/answer/visibleAnswer'],
    }] };
    const imageRun = await createRun(root, { runId: 'images', tasks: [task], trials: 1, instructionHash: 'frozen' });
    await finishTrial(imageRun, 'screen-1', { status: 'completed', modelCalls: 1,
      output: { answer: { visibleAnswer: 'The screen displayed a verified result.' },
        screenshot: { type: 'image', data: image, mimeType: 'image/png' },
        sessions: { 'screen.jsonl': JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'image', data: image, mimeType: 'image/png' }] } }) },
      },
    });
    const original = await snapshot(imageRun);
    const readable = await evidence.buildReadableStagePackets(imageRun);
    assert.equal(readable.protocol, 'readable-evidence-id-v3');
    assert.ok(JSON.stringify(readable).length < 20000);
    assert.ok(!JSON.stringify(readable).includes(image.slice(0, 100)));
    assert.ok(readable.omittedSources.some(source => source.locator.pointer === '/output/screenshot/data' && source.length === image.length && /^[a-f0-9]{64}$/.test(source.sha256)));
    assert.ok(readable.omittedSources.some(source => source.locator.pointer === '/output/sessions/screen.jsonl'));
    assert.ok(readable.entries.some(entry => entry.locator.pointer === '/output/answer/visibleAnswer'));
    const compactPath = join(root, 'readable.json');
    execFileSync(process.execPath, [cli, 'readable-packet', '--run', imageRun, '--output', compactPath], { stdio: 'pipe' });
    assert.equal(JSON.parse(await readFile(compactPath, 'utf8')).catalogHash, readable.catalogHash);
    const mediaPage = readable.packets.find(page => page.omittedSourceIds.length);
    const listing = JSON.parse(execFileSync(process.execPath, [cli, 'readable-packet-list', '--run', imageRun], { encoding: 'utf8' }));
    assert.equal(listing.catalogHash, readable.catalogHash);
    assert.ok(listing.packets.length);
    assert.ok(!Object.hasOwn(listing, 'entries'));
    assert.ok(!Object.hasOwn(listing, 'omittedSources'));
    assert.ok(JSON.stringify(listing).length < 12000);
    const cliView = JSON.parse(execFileSync(process.execPath, [cli, 'readable-packet-view', '--run', imageRun, '--trial', mediaPage.trialId, '--stage', mediaPage.stage, '--page', String(mediaPage.page)], { encoding: 'utf8' }));
    assert.ok(cliView.omittedSources.length);
    assert.ok(!JSON.stringify(cliView).includes(image.slice(0, 100)));
    assert.equal(new Set(readable.entries.map(entry => entry.shortId)).size, readable.entries.length);
    for (const page of readable.packets) {
      const view = evidence.readableStagePacketView(readable, page.trialId, page.stage, page.page);
      assert.ok(JSON.stringify(view).length <= 12000);
    }
    const answer = readable.entries.find(entry => entry.locator.pointer === '/output/answer/visibleAnswer');
    const rows = [{ trialId: 'screen-1', criterionId: 'grounding', status: 'pass', reason: 'Visible answer is grounded.', evidenceIds: [answer.shortId] }];
    const resolved = await evidence.resolveEvidenceScores(imageRun, readable.catalogHash, rows, readable.protocol);
    assert.equal(resolved[0].locators[0].quote, 'The screen displayed a verified result.');
    const nullable = await evidence.resolveEvidenceScores(imageRun, readable.catalogHash, [{ ...rows[0], rootCause: null }], readable.protocol);
    assert.equal(Object.hasOwn(nullable[0], 'rootCause'), false);
    assert.deepEqual(await snapshot(imageRun), original);
    const submission = { agent: 'test', model: 'test', instructionHash: 'frozen',
      calibration: answers(calibrationModule.calibrationCases),
      packetCalibration: answers(calibrationModule.packetCalibrationCases),
      evidenceProtocol: readable.protocol, evidenceCatalogHash: readable.catalogHash, scores: rows };
    const graded = await gradeRun(imageRun, submission);
    assert.equal(graded.report.overall.passed, 1);
    assert.equal(JSON.parse(await readFile(join(graded.directory, 'manifest.json'), 'utf8')).evidenceProtocol, readable.protocol);
    await assert.rejects(evidence.resolveEvidenceScores(imageRun, readable.catalogHash, [{ ...rows[0], evidenceIds: ['e999999'] }], readable.protocol), /unknown evidence ID/i);
    await assert.rejects(evidence.resolveEvidenceScores(imageRun, readable.catalogHash, [{ ...rows[0], trialId: 'different-1' }], readable.protocol), /belong to the scored trial/i);
    await assert.rejects(evidence.resolveEvidenceScores(imageRun, readable.catalogHash, [{ ...rows[0], evidenceIds: undefined }], readable.protocol), /requires evidence IDs/i);
    await assert.rejects(evidence.resolveEvidenceScores(imageRun, readable.catalogHash, [{ ...rows[0], evidence: ['e1'] }], readable.protocol), /cannot mix evidence IDs/i);
    await assert.rejects(evidence.resolveEvidenceScores(imageRun, readable.catalogHash, [{ ...rows[0], locators: [] }], readable.protocol), /cannot mix evidence IDs/i);
    await assert.rejects(evidence.resolveEvidenceScores(imageRun, 'wrong-hash', rows, readable.protocol), /catalog hash/i);
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.deepEqual(await snapshot(run), frozen);
}));
