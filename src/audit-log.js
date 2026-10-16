'use strict';

const crypto = require('node:crypto');

// In-memory append-only audit log. Each entry's `hash` field chains the
// previous entry's hash, so any tampering retroactively breaks the chain.
// In a real deployment this would also be mirrored to an append-only store
// (S3 Object Lock, QLDB, etc.); we keep it in-process so the demo is
// self-contained.
//
// The chain works like:
//   hash_n = sha256(JSON.stringify({ index, at, kind, payload, prevHash }))
// so any mutation to any earlier entry invalidates all subsequent hashes.

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function hashEntry({ index, at, kind, payload, prevHash }) {
  return crypto.createHash('sha256').update(canonicalJson({ index, at, kind, payload, prevHash })).digest('hex');
}

const REDACT_KEYS = /key/i;
const REDACT_NAME = new Set(['raw', 'transcript', 'authorization', 'bearer', 'secret', 'password']);

function redactPayload(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactPayload);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_KEYS.test(k) || REDACT_NAME.has(k)) out[k] = '[redacted]';
    else out[k] = redactPayload(v);
  }
  return out;
}

class AuditLog {
  constructor({ now = Date.now, salt = '' } = {}) {
    this._entries = [];
    this._now = now;
    this._salt = salt;
    this._lastHash = 'genesis';
  }

  // Append a decision. `kind` is one of: 'interpret', 'prepare', 'approve',
  // 'execute', 'block'. `payload` is an arbitrary JSON-serialisable object
  // describing the decision. Anything whose key contains "key" (case
  // insensitive) or is named `raw` / `transcript` is redacted before
  // hashing so an ADP key, raw AI transcript, or any other secret can
  // never leak into the hash-chain.
  append(kind, payload) {
    const safePayload = redactPayload(payload || {});
    const entry = {
      index: this._entries.length,
      at: this._now(),
      kind,
      payload: safePayload,
      prevHash: this._lastHash,
    };
    entry.hash = hashEntry(entry);
    this._entries.push(entry);
    this._lastHash = entry.hash;
    return entry;
  }

  entries() { return this._entries.slice(); }

  // Verify the entire chain. Returns { ok, brokenAt }.
  verify() {
    let last = 'genesis';
    for (let i = 0; i < this._entries.length; i += 1) {
      const e = this._entries[i];
      if (e.prevHash !== last) return { ok: false, brokenAt: i, reason: 'prevHash mismatch' };
      const expected = hashEntry({ index: e.index, at: e.at, kind: e.kind, payload: e.payload, prevHash: e.prevHash });
      if (expected !== e.hash) return { ok: false, brokenAt: i, reason: 'hash mismatch' };
      last = e.hash;
    }
    return { ok: true, total: this._entries.length, lastHash: this._lastHash };
  }
}

module.exports = { AuditLog, canonicalJson, hashEntry };
