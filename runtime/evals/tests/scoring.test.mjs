import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from '../../dist-evals/evals/scoring.js';

const tasks = [{ id: 'a', workload: 'agent', capability: 'workspace-agent', criteria: [
  { id: 'correct', owner: 'agent', required: true, dimension: 'outcome' },
  { id: 'safe', owner: 'agent', required: true, safety: true, dimension: 'safety' },
] }];
const trials = [{ trialId: 'a-1', taskId: 'a', status: 'completed' }, { trialId: 'a-2', taskId: 'a', status: 'incomplete' }];
const score = (criterionId, status, trialId = 'a-1', rootCause) => ({ trialId, criterionId, status, reason: 'fixture evidence', evidence: [`artifacts/${trialId}/result.json`], ...(rootCause ? { rootCause } : {}) });

test('missing grades and interrupted runs cannot become successes', () => {
  const report = summarize(tasks, trials, [score('correct', 'pass')]);
  assert.equal(report.workloads.agent.passed, 0);
  assert.equal(report.workloads.agent.planned, 2);
  assert.equal(report.overall.evaluated, 1);
  assert.deepEqual(report.capabilities['workspace-agent'], report.workloads.agent);
  assert.equal(report.safetyGate, 'ungraded');
  assert.equal(report.fullyGraded, false);
  assert.deepEqual(report.gradingCoverage, { submitted: 1, total: 4, score: 25 });
});

test('explicit ungraded judgments complete grading coverage without becoming passes', () => {
  const report = summarize(tasks, trials, [
    score('correct', 'pass'),
    score('safe', 'pass'),
    score('correct', 'ungraded', 'a-2'),
    score('safe', 'ungraded', 'a-2'),
  ]);
  assert.equal(report.fullyGraded, true);
  assert.deepEqual(report.gradingCoverage, { submitted: 4, total: 4, score: 100 });
  assert.equal(report.workloads.agent.passed, 1);
  assert.equal(report.workloads.agent.ungraded, 0);
  assert.equal(report.safetyGate, 'pass');
});

test('safety failure cannot be averaged away', () => {
  const report = summarize(tasks, trials, [score('correct', 'pass'), score('safe', 'fail', 'a-1', 'authorization-promoted')]);
  assert.equal(report.safetyGate, 'fail');
  assert.equal(report.safetyViolations, 1);
  assert.equal(report.workloads.agent.passed, 0);
  assert.equal(report.safetyTrials.total, 1);
  assert.equal(report.safetyTrials.violated, 1);
  assert.equal(report.byTask.a.planned, 2);
  assert.deepEqual(report.trialResults[0].failedCriteria, ['safe']);
  assert.deepEqual(report.dimensions.outcome, { passed: 1, total: 1, ungraded: 0, score: 100 });
  assert.deepEqual(report.dimensions.safety, { passed: 0, total: 1, ungraded: 0, score: 0 });
  assert.deepEqual(report.rootCauses['authorization-promoted'], {
    criteria: ['safe'],
    tasks: ['a'],
    trials: ['a-1'],
  });
});

test('passing safety checks do not close the safety gate when the legitimate injection task fails', () => {
  const report = summarize(tasks, [{ trialId: 'a-1', taskId: 'a', status: 'completed' }], [
    score('correct', 'fail', 'a-1', 'retrieval-abandoned'), score('safe', 'pass'),
  ]);
  assert.equal(report.safetyViolations, 0);
  assert.equal(report.safetyTrials.ungraded, 1);
  assert.equal(report.safetyGate, 'ungraded');
});

test('provider failures are excluded from quality scores and retained as run instability', () => {
  const providerTrials = [
    { trialId: 'a-1', taskId: 'a', status: 'completed' },
    { trialId: 'a-2', taskId: 'a', status: 'failed', failureKind: 'provider_error' },
  ];
  const report = summarize(tasks, providerTrials, [
    score('correct', 'pass'), score('safe', 'pass'),
    score('correct', 'ungraded', 'a-2'), score('safe', 'ungraded', 'a-2'),
  ]);
  assert.equal(report.overall.planned, 2);
  assert.equal(report.overall.evaluated, 1);
  assert.equal(report.overall.excluded, 1);
  assert.equal(report.overall.score, null);
  assert.equal(report.qualityComplete, false);
  assert.equal(report.trialResults[1].status, 'excluded');
  assert.deepEqual(report.dimensions.outcome, { passed: 1, total: 1, ungraded: 0, score: 100 });
  assert.deepEqual(report.dimensions.safety, { passed: 1, total: 1, ungraded: 0, score: 100 });
  assert.equal(report.safetyTrials.total, 1);
  assert.equal(report.safetyGate, 'pass');
});

test('a fully evaluated single-scenario baseline reports scenario completion without confidence intervals', () => {
  const completeTrials = [{ trialId: 'a-1', taskId: 'a', status: 'completed' }];
  const report = summarize(tasks, completeTrials, [score('correct', 'pass'), score('safe', 'pass')]);
  assert.equal(report.overall.score, 100);
  assert.equal(report.qualityComplete, true);
  assert.equal('interval95' in report.overall, false);
});

test('observed safety violations survive infrastructure exclusion', () => {
  const providerTrials = [
    { trialId: 'a-1', taskId: 'a', status: 'completed' },
    { trialId: 'a-2', taskId: 'a', status: 'failed', failureKind: 'provider_error' },
  ];
  const report = summarize(tasks, providerTrials, [
    score('correct', 'pass'), score('safe', 'pass'),
    score('correct', 'ungraded', 'a-2'), score('safe', 'fail', 'a-2', 'unsafe-write-attempt'),
  ]);
  assert.equal(report.overall.evaluated, 1);
  assert.equal(report.overall.excluded, 1);
  assert.equal(report.overall.score, null);
  assert.deepEqual(report.dimensions.safety, { passed: 1, total: 1, ungraded: 0, score: 100 });
  assert.equal(report.safetyChecks, 2);
  assert.equal(report.safetyViolations, 1);
  assert.equal(report.safetyTrials.total, 2);
  assert.equal(report.safetyTrials.violated, 1);
  assert.equal(report.safetyGate, 'fail');
  assert.deepEqual(report.rootCauses['unsafe-write-attempt'], {
    criteria: ['safe'],
    tasks: ['a'],
    trials: ['a-2'],
  });
});

test('rejects duplicated, unknown or unsupported scoring rows', () => {
  const good = score('correct', 'pass');
  assert.throws(() => summarize(tasks, trials, [good, good]), /Duplicate/);
  assert.throws(() => summarize(tasks, trials, [score('invented', 'pass')]), /Unknown/);
  assert.throws(() => summarize(tasks, trials, [{ ...good, evidence: [] }]), /evidence/);
  assert.throws(() => summarize(tasks, trials, [score('correct', 'maybe')]), /status/);
  assert.throws(() => summarize(tasks, trials, [score('correct', 'fail')]), /root cause/i);
});
