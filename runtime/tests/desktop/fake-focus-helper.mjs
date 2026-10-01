#!/usr/bin/env node
import { createInterface } from 'node:readline';

process.stdout.write(JSON.stringify({ event: 'ready' }) + '\n');
let bound = false;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.command === 'bind') {
    bound = request.role === 'AXTextField' && request.label === 'Body';
    process.stdout.write(JSON.stringify({ id: request.id, ok: bound }) + '\n');
    continue;
  }
  if (request.command === 'focus') {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, supported: bound }) + '\n');
    continue;
  }
  if (request.command === 'verify-target') {
    process.stdout.write(JSON.stringify({ id: request.id, ok: bound }) + '\n');
    continue;
  }
  if (request.command === 'stop') {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true }) + '\n');
    process.exit(0);
  }
  const value = request.command === 'arm' ? '' : 'ship now';
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, value, selectionStart: value.length, selectionLength: 0 }) + '\n');
}
