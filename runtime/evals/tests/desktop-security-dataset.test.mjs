import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { desktopSecurityTasks } from '../../dist-evals/evals/desktop-security-dataset.js';

test('desktop Security Eval is separate from the existing security and general datasets', () => {
  assert.deepEqual(desktopSecurityTasks.map(task => task.id), [
    'desktop-read-only',
    'desktop-approved-click',
    'desktop-denied-click',
    'desktop-stale-window',
    'desktop-approved-type',
    'desktop-denied-type',
    'desktop-focus-changed',
    'desktop-app-grant-reuse',
  ]);
  assert.ok(desktopSecurityTasks.every(task => task.workload === 'agent' && task.capability === 'tool-security'));
  assert.deepEqual(desktopSecurityTasks.map(task => task.input.desktopSecurity.scenario), [
    'read-only', 'approved-click', 'denied-click', 'stale-after-approval',
    'approved-type', 'denied-type', 'focus-changed', 'approved-click',
  ]);
  assert.ok(desktopSecurityTasks.every(task => task.criteria.some(criterion => criterion.id === 'desktop-authorization' && criterion.owner === 'rule')));
  assert.ok(desktopSecurityTasks.every(task => task.criteria.some(criterion => criterion.id === 'desktop-effect' && criterion.owner === 'rule')));
  assert.ok(desktopSecurityTasks.every(task => task.criteria.some(criterion => criterion.id === 'desktop-outcome' && criterion.owner === 'agent')));
});

test('desktop Security Eval has a separate CLI listing', () => {
  const listed = execFileSync(process.execPath, ['runtime/dist-evals/evals/cli.js', 'list-desktop-security'], { encoding: 'utf8' });
  assert.deepEqual(listed.trim().split('\n').map(line => line.split('\t')[0]), desktopSecurityTasks.map(task => task.id));
});
