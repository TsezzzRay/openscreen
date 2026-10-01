import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { createRun, finishTrial, hash } from '../../dist-evals/evals/persistence.js';
import { gradeRun } from '../../dist-evals/evals/report.js';
import { snapshot } from '../../dist-evals/evals/workspace.js';
import { withWorkloadEnvironment } from '../../dist-evals/evals/workloads/environment.js';
import { loadApplicationConfig } from '../../dist-evals/src/runtime-config.js';

test('grading pins every workload module and extracted verification dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openscreen-eval-source-pin-'));
  try {
    const task = { id: 'pin', workload: 'agent', input: {}, criteria: [] };
    const run = await createRun(root, { runId: 'run', tasks: [task], trials: 1 });
    await finishTrial(run, 'pin-1', { status: 'completed', modelCalls: 1, output: {} });
    const artifacts = await snapshot(join(run, 'artifacts'));
    const traces = await snapshot(join(run, 'traces'));
    const { directory } = await gradeRun(run);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const sources = Object.fromEntries(await Promise.all([
      ['scoringSource', 'scoring.js'], ['reportSource', 'report.js'],
      ['calibrationSource', 'calibration.js'], ['workspaceSource', 'workspace.js'],
      ['verificationSource', 'verification.js'], ['shellSource', 'shell.js'],
      ['evidenceSource', 'evidence.js'],
    ].map(async ([key, path]) => [key, await readFile(new URL(`../../dist-evals/evals/${path}`, import.meta.url), 'utf8')])));
    const workloadSources = await snapshot(fileURLToPath(new URL('../../dist-evals/evals/workloads/', import.meta.url)));
    assert.deepEqual(Object.keys(workloadSources).sort(), [
      'agent.js', 'chronicle.js', 'compaction.js', 'environment.js', 'index.js',
      'interactive-memory.js', 'memory.js', 'screen-activity-memory.js',
    ]);
    const { scoringSource, reportSource, calibrationSource, workspaceSource, verificationSource, shellSource, evidenceSource } = sources;
    assert.equal(manifest.graderSourceHash, hash({ scoringSource, reportSource, calibrationSource,
      workloadSources, workspaceSource, verificationSource, shellSource, evidenceSource }));
    assert.deepEqual(await snapshot(join(run, 'artifacts')), artifacts);
    assert.deepEqual(await snapshot(join(run, 'traces')), traces);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reporting and evidence helpers have no workload execution imports', async () => {
  for (const name of ['runner', 'report', 'evidence', 'workspace', 'verification', 'shell']) {
    const source = await readFile(new URL(`../${name}.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:from\s+|import\s*)["'][^"']*workloads(?:\/|\.)/u);
  }
});

test('extracted snapshots still reject file, directory and dangling symlink aliases', async () => {
  for (const target of ['file.txt', '.', 'missing.txt']) {
    const root = await mkdtemp(join(tmpdir(), 'openscreen-eval-snapshot-alias-'));
    try {
      await writeFile(join(root, 'file.txt'), 'original evidence');
      await symlink(target, join(root, 'alias'));
      await assert.rejects(snapshot(root), /symlink/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('shared environment cleans up after successful and failed execution', async () => {
  for (const fails of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'openscreen-eval-cleanup-'));
    try {
      const faux = fauxProvider({ provider: 'eval-cleanup', models: [{ id: 'test' }] });
      const models = createModels(); models.setProvider(faux.provider);
      let cleanups = 0;
      const execution = withWorkloadEnvironment({ id: 'cleanup', workload: 'agent', input: {} },
        root, loadApplicationConfig(), models, faux.getModel(), () => {}, async environment => {
          const cleanup = environment.env.cleanup.bind(environment.env);
          environment.env.cleanup = async () => { cleanups++; await cleanup(); };
          if (fails) throw new Error('fixture execution failed');
          return 'completed';
        });
      if (fails) await assert.rejects(execution, /fixture execution failed/);
      else assert.equal(await execution, 'completed');
      assert.equal(cleanups, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
