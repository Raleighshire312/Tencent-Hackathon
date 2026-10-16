'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuditLog, canonicalJson, hashEntry } = require('../src/audit-log');

test('AuditLog starts with a genesis prevHash', () => {
  const log = new AuditLog({ now: () => 1000 });
  assert.deepEqual(log.entries(), []);
  log.append('interpret', { foo: 'bar' });
  const e = log.entries()[0];
  assert.equal(e.index, 0);
  assert.equal(e.prevHash, 'genesis');
  assert.match(e.hash, /^[0-9a-f]{64}$/);
  assert.equal(e.payload.foo, 'bar');
});

test('AuditLog chain is verifiable end-to-end', () => {
  let t = 1000;
  const log = new AuditLog({ now: () => (t += 10) });
  log.append('interpret', { stage: 'interpret' });
  log.append('prepare',   { stage: 'prepare' });
  log.append('approve',   { stage: 'approve' });
  log.append('execute',   { stage: 'execute' });
  const v = log.verify();
  assert.equal(v.ok, true);
  assert.equal(v.total, 4);
});

test('AuditLog detects tampering of an older entry', () => {
  const log = new AuditLog({ now: () => 2000 });
  log.append('prepare', { fingerprint: 'A' });
  log.append('approve', { fingerprint: 'B' });
  const entries = log.entries();
  entries[0].payload.fingerprint = 'A-tampered';
  const v = log.verify();
  assert.equal(v.ok, false);
  // Tampered index is itself the first break point because its own hash no
  // longer matches its contents.
  assert.equal(v.brokenAt, 0);
});

test('AuditLog detects tampering of payload fields', () => {
  const log = new AuditLog({ now: () => 2000 });
  log.append('prepare', { fingerprint: 'A' });
  log.append('approve', { fingerprint: 'B' });
  // Attempt to retroactively change a nested value via mutation.
  const entries = log.entries();
  entries[0].payload.fingerprint = 'X';
  const v = log.verify();
  assert.equal(v.ok, false);
  assert.ok(v.brokenAt >= 0);
});

test('AuditLog detects deletion when verified against a hand-built chain', () => {
  const log = new AuditLog({ now: () => 2000 });
  log.append('prepare', { fingerprint: 'A' });
  log.append('approve', { fingerprint: 'B' });
  log.append('execute', { fingerprint: 'C' });
  // Simulate a malicious caller tampering with the internal array.
  log._entries.splice(1, 1);
  const v = log.verify();
  assert.equal(v.ok, false);
});

test('AuditLog ignores ADP secrets and raw transcripts at append time', () => {
  const log = new AuditLog();
  log.append('interpret', { adpKey: 'should-not-appear-anywhere', fingerprint: 'sha256:x' });
  const dump = JSON.stringify(log.entries());
  assert.equal(dump.includes('should-not-appear-anywhere'), false);
  assert.equal(dump.includes('sha256:x'), true);
});

test('canonicalJson is key-order independent', () => {
  const a = canonicalJson({ b: 1, a: 2 });
  const b = canonicalJson({ a: 2, b: 1 });
  assert.equal(a, b);
});

test('hashEntry is deterministic and order-sensitive', () => {
  const h1 = hashEntry({ index: 0, at: 1, kind: 'a', payload: { x: 1 }, prevHash: 'genesis' });
  const h2 = hashEntry({ index: 0, at: 1, kind: 'a', payload: { x: 1 }, prevHash: 'genesis' });
  const h3 = hashEntry({ index: 0, at: 1, kind: 'a', payload: { x: 2 }, prevHash: 'genesis' });
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});
