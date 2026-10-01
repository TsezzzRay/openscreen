import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('native focus policy distinguishes unsupported, uncertain, and changed input states', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal(existsSync('runtime/src/desktop/native/focus-policy.swift'), true, 'Native focus decision contract is missing');
  const root = await mkdtemp(join(tmpdir(), 'openscreen-focus-policy-'));
  try {
    const executable = join(root, 'focus-policy-tests');
    execFileSync('swiftc', ['-o', executable, 'runtime/src/desktop/native/focus-policy.swift', 'runtime/tests/desktop/native/focus-policy/main.swift']);
    const cases = JSON.parse(execFileSync(executable, [], { encoding: 'utf8' }));
    assert.deepEqual(cases, {
      settable: 'supported', unsettable: 'unsupported', missingAttribute: 'unsupported', notImplemented: 'unsupported',
      queryFailure: 'focus-unverifiable [step=query-settable, axStatus=-25204]', assignmentUnsupported: 'unsupported',
      assignmentFailure: 'focus-unverifiable [step=set-focused, axStatus=-25204]',
      noActualFocus: 'unsupported', foregroundChanged: 'foreground-changed', assigned: 'supported',
      foregroundMissing: 'focus-unverifiable', foregroundZero: 'focus-unverifiable', foregroundKnown: 'supported',
      nativeValueChanged: 'focus-value-changed', nativeValueUnavailable: 'focus-value-changed', nativeValueUnchanged: 'supported',
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
