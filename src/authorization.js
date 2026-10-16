'use strict';

const crypto = require('node:crypto');
const { fingerprint } = require('./payment-core');

class AuthorizationStore {
  constructor({ ttlMs = 120000, now = () => Date.now(), store = null } = {}) { this.ttlMs = ttlMs; this.now = now; this.store = store; this.challenges = new Map(); this.keys = new Map(); }
  registerSimulatorKey({ sessionId, publicKey }) { if (!sessionId || typeof publicKey !== 'string' || !publicKey) return { ok: false, code: 'AUTH_PUBLIC_KEY_REQUIRED' }; this.keys.set(sessionId, publicKey); this.store?.registerSimulatorKey(sessionId, publicKey); return { ok: true }; }
  issue({ planId, planHash, revision, sessionId, mode = 'SIMULATOR' }) {
    const nonce = crypto.randomBytes(24).toString('base64url');
    const challenge = { id: crypto.randomUUID(), nonce, planId, planHash, revision, sessionId, mode, createdAt: this.now(), expiresAt: this.now() + this.ttlMs, used: false };
    this.challenges.set(challenge.id, challenge); this.store?.saveChallenge(challenge, this.keys.get(sessionId) || this.store?.simulatorKey(sessionId)); return challenge;
  }
  verify({ challengeId, signature, publicKey, sessionId, revision }) {
    const challenge = this.challenges.get(challengeId) || this.store?.getChallenge(challengeId);
    if (!challenge || challenge.used) return { ok: false, code: 'AUTH_CHALLENGE_INVALID', message: 'Authorization challenge is unknown or already used.' };
    if (this.now() >= challenge.expiresAt) return { ok: false, code: 'AUTH_CHALLENGE_EXPIRED', message: 'Authorization challenge expired.' };
    if (challenge.sessionId !== sessionId || (revision != null && Number(revision) !== Number(challenge.revision))) return { ok: false, code: 'SESSION_MISMATCH', message: 'Authorization belongs to another session or revision.' };
    if (challenge.mode !== 'SIMULATOR' || typeof signature !== 'string') return { ok: false, code: 'AUTH_SIGNATURE_REQUIRED', message: 'A registered simulator signature is required for this demo.' };
    const registered = this.keys.get(sessionId) || this.store?.simulatorKey(sessionId) || (!this.store ? publicKey : null);
    if (!registered || (publicKey && publicKey !== registered)) return { ok: false, code: 'AUTH_KEY_MISMATCH', message: 'The signing key was not registered to this session.' };
    const payload = challenge.revision == null ? `${challenge.nonce}.${challenge.planHash}.${challenge.planId}` : `${challenge.nonce}.${challenge.planHash}.${challenge.planId}.${challenge.revision}`;
    const verifier = crypto.createVerify('SHA256'); verifier.update(payload); verifier.end();
    let key;
    try { key = crypto.createPublicKey({ key: Buffer.from(registered, 'base64url'), format: 'der', type: 'spki' }); } catch { return { ok: false, code: 'AUTH_PUBLIC_KEY_INVALID', message: 'The registered public key is invalid.' }; }
    try { const sig = Buffer.from(signature, 'base64url'); let valid = false; try { valid = verifier.verify({ key, dsaEncoding: 'ieee-p1363' }, sig); } catch { valid = false; } if (!valid) { const derVerifier = crypto.createVerify('SHA256'); derVerifier.update(payload); derVerifier.end(); valid = derVerifier.verify(key, sig); } if (!valid) return { ok: false, code: 'AUTH_SIGNATURE_INVALID', message: 'Authorization signature did not match this plan.' }; } catch { return { ok: false, code: 'AUTH_SIGNATURE_INVALID', message: 'Authorization signature did not match this plan.' }; }
    const consumed = this.store ? this.store.consumeChallenge(challenge.id) : !challenge.used;
    challenge.used = true;
    if (!consumed) return { ok: false, code: 'AUTH_CHALLENGE_INVALID', message: 'Authorization challenge was already consumed.' };
    return { ok: true, authorization: { id: challenge.id, planId: challenge.planId, planHash: challenge.planHash, revision: challenge.revision, sessionId, mode: challenge.mode, verifiedAt: this.now(), authorizationHash: fingerprint({ id: challenge.id, planId: challenge.planId, planHash: challenge.planHash, revision: challenge.revision, sessionId }) } };
  }
}

module.exports = { AuthorizationStore };
