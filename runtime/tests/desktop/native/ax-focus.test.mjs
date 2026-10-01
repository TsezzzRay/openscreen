import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('AX focus helper rejects an invalid target PID without starting observation', { skip: process.platform !== 'darwin' }, () => {
  const result = spawnSync('runtime/bin/openscreen-ax-focus', ['--pid', '0', '--window-id', '42'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { event: 'error', reason: 'invalid-pid' });
});

test('AX focus helper rejects an invalid window ID before starting observation', { skip: process.platform !== 'darwin' }, () => {
  const result = spawnSync('runtime/bin/openscreen-ax-focus', ['--pid', '123', '--window-id', '0'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { event: 'error', reason: 'invalid-window-id' });
});

test('AX focus helper does not reject a field solely for its secure subrole', () => {
  const source = readFileSync('runtime/src/desktop/native/main.swift', 'utf8');
  assert.doesNotMatch(source, /kAXSecureTextFieldSubrole|protected-field/);
  assert.match(source, /kAXValueAttribute/);
});

test('AX focus fallback distinguishes a false focused value from an unreadable value', () => {
  const source = readFileSync('runtime/src/desktop/native/main.swift', 'utf8');
  const setFocused = source.slice(source.indexOf('    func setFocused('), source.indexOf('    func handle('));
  assert.match(setFocused, /AXUIElementCopyAttributeValue\(target, kAXFocusedAttribute/);
  assert.match(setFocused, /focusedStatus == \.success/);
  assert.match(setFocused, /CFBooleanGetTypeID\(\)/);
  assert.match(setFocused, /FocusDiagnostic\(step: "read-focused"/);
});

test('foreground identity is read without system-wide AX and checked before and after focus', () => {
  const source = readFileSync('runtime/src/desktop/native/main.swift', 'utf8');
  const setFocused = source.slice(source.indexOf('    func setFocused('), source.indexOf('    func handle('));
  assert.doesNotMatch(setFocused, /AXUIElementCreateSystemWide/);
  assert.equal(setFocused.match(/NSWorkspace\.shared\.frontmostApplication\?\.processIdentifier/g)?.length, 2);
  assert.equal(setFocused.match(/verifiedForegroundPid/g)?.length, 2);
});
