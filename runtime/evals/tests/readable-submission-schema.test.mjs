import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('readable scorer output schema allows only short evidence ID rows', async () => {
  const schema = JSON.parse(await readFile(new URL('../readable-submission.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  const row = schema.properties.scores.items;
  assert.equal(row.additionalProperties, false);
  assert.ok(row.required.includes('evidenceIds'));
  assert.ok(!Object.hasOwn(row.properties, 'evidence'));
  assert.ok(!Object.hasOwn(row.properties, 'locators'));
  assert.deepEqual(row.properties.evidenceIds.items, { type: 'string', pattern: '^e[1-9][0-9]*$' });
});

test('readable scorer output schema does not permit empty calibration groups', async () => {
  const schema = JSON.parse(await readFile(new URL('../readable-submission.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.calibration.minItems, 1);
  assert.equal(schema.properties.packetCalibration.minItems, 1);
});
