'use strict';

// Small synchronous persistence boundary for the local synthetic bank. Node 24's
// built-in SQLite is deliberately used here so security decisions survive a
// restart without adding a second ORM or hiding transaction boundaries.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function json(value) { return JSON.stringify(value ?? null); }
function parse(value, fallback = null) { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } }

class PersistentStore {
  constructor({ filename = path.join(process.cwd(), 'data', 'intentlock.sqlite'), now = () => Date.now() } = {}) {
    this.filename = filename;
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.now = now;
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, bank_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversations (
        plan_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
        plan_hash TEXT NOT NULL, nonce TEXT NOT NULL, mode TEXT NOT NULL, public_key TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS authorizations (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
        plan_hash TEXT NOT NULL, authorization_json TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS simulator_keys (
        session_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, registered_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_results (
        idempotency_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, plan_id TEXT NOT NULL,
        result_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, kind TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );`);
  }

  getSession(id) { return this.db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(id) || null; }
  saveSession(id, bank) {
    const exists = this.getSession(id);
    const payload = json({ accounts: bank.accounts, recipients: bank.recipients, bills: bank.bills, quotes: bank.quotes, ledger: bank.ledger });
    if (exists) this.db.prepare('UPDATE sessions SET bank_json = ? WHERE session_id = ?').run(payload, id);
    else this.db.prepare('INSERT INTO sessions(session_id,created_at,bank_json) VALUES(?,?,?)').run(id, this.now(), payload);
  }
  bankSnapshot(id) { return parse(this.getSession(id)?.bank_json, null); }
  saveConversation(id, session) {
    const state = { ...session, bank: undefined };
    const value = json(state);
    const exists = this.db.prepare('SELECT 1 FROM conversations WHERE plan_id = ?').get(id);
    if (exists) this.db.prepare('UPDATE conversations SET session_id=?, state_json=?, updated_at=? WHERE plan_id=?').run(session.sessionId, value, this.now(), id);
    else this.db.prepare('INSERT INTO conversations(plan_id,session_id,state_json,updated_at) VALUES(?,?,?,?)').run(id, session.sessionId, value, this.now());
  }
  getConversation(id) { const row = this.db.prepare('SELECT * FROM conversations WHERE plan_id = ?').get(id); return row ? parse(row.state_json, null) : null; }
  registerSimulatorKey(sessionId, publicKey) { this.db.prepare('INSERT INTO simulator_keys(session_id,public_key,registered_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET public_key=excluded.public_key,registered_at=excluded.registered_at').run(sessionId, publicKey, this.now()); }
  simulatorKey(sessionId) { return this.db.prepare('SELECT public_key FROM simulator_keys WHERE session_id=?').get(sessionId)?.public_key || null; }
  saveChallenge(challenge, publicKey = null) { this.db.prepare('INSERT INTO challenges(id,session_id,plan_id,revision,plan_hash,nonce,mode,public_key,created_at,expires_at,used) VALUES(?,?,?,?,?,?,?,?,?,?,0)').run(challenge.id, challenge.sessionId, challenge.planId, challenge.revision, challenge.planHash, challenge.nonce, challenge.mode, publicKey, challenge.createdAt, challenge.expiresAt); }
  getChallenge(id) { const row = this.db.prepare('SELECT * FROM challenges WHERE id=?').get(id); return row ? { ...row, used: Boolean(row.used) } : null; }
  consumeChallenge(id) { return this.db.prepare('UPDATE challenges SET used=1 WHERE id=? AND used=0').run(id).changes === 1; }
  saveAuthorization(auth) { this.db.prepare('INSERT OR REPLACE INTO authorizations(id,session_id,plan_id,revision,plan_hash,authorization_json,consumed) VALUES(?,?,?,?,?,?,0)').run(auth.id, auth.sessionId, auth.planId, auth.revision, auth.planHash, json(auth)); }
  getAuthorization(id) { const row = this.db.prepare('SELECT * FROM authorizations WHERE id=?').get(id); return row ? { ...parse(row.authorization_json), consumed: Boolean(row.consumed) } : null; }
  consumeAuthorization(id) { return this.db.prepare('UPDATE authorizations SET consumed=1 WHERE id=? AND consumed=0').run(id).changes === 1; }
  getExecution(key) { const row = this.db.prepare('SELECT result_json FROM execution_results WHERE idempotency_key=?').get(key); return row ? parse(row.result_json) : null; }
  saveExecution(key, sessionId, planId, result) { this.db.prepare('INSERT OR IGNORE INTO execution_results VALUES(?,?,?,?,?)').run(key, sessionId, planId, json(result), this.now()); }
  appendAudit(sessionId, kind, payload) { this.db.prepare('INSERT INTO audit_events(session_id,kind,payload_json,created_at) VALUES(?,?,?,?)').run(sessionId, kind, json(payload), this.now()); }
  audit(sessionId) { return this.db.prepare('SELECT * FROM audit_events WHERE session_id=? ORDER BY id').all(sessionId).map((r) => ({ id: r.id, sessionId: r.session_id, kind: r.kind, payload: parse(r.payload_json), at: r.created_at })); }
  close() { this.db.close(); }
}

module.exports = { PersistentStore };
