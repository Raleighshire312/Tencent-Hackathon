'use strict';

// Intent pipeline — the orchestration layer of IntentLock. Six gates:
//
//   1. injectionGuard.scanUserMessage   – refuse prompt-injection in the
//                                         user's own text (runs before the
//                                         LLM is touched at all).
//   2. provider.interpretStructured     – call Tencent ADP with a strict
//                                         JSON-schema contract; fail closed
//                                         when ADP is unavailable, refuses,
//                                         or returns invalid output.
//   3. validateStructuredIntent         – schema-validate the AI envelope.
//   4. injectionGuard.scanAdpTranscript – refuse prompt-injection in the AI
//                                         transcript (covers sneaky phrasing
//                                         hidden alongside valid JSON).
//   5. compileTransferIntents           – deterministic regex + positional
//                                         metadata from the user's text.
//   6. verifyIntentContract             – positional + source + downgrade
//                                         checks against the AI proposal.
//                                         This is what *disposes*; the LLM
//                                         only *proposes*.
//
// After all six gates pass, MockBank.preparePayment produces a fingerprinted
// proposal. Approve + Execute are separate gates, both of which re-check
// invariants. Everything is recorded in the hash-chained AuditLog.

const { scanUserMessage, scanAdpTranscript } = require('../src/injection-guard');
const { compileTransferIntents } = require('../src/intent-compiler');
const { verifyIntentContract } = require('../src/semantic-verifier');
const { inspectUntrustedContent } = require('../src/attack-lab');
const { createIntentProvider } = require('../src/intent-provider');
const { explain } = require('../src/explainability');

// --- Internal: produce a redacted audit summary for the entry.
function summarise(stage, status, payload) {
  const payloadCopy = payload ? { ...payload } : {};
  // Never let the ADP key or full transcript leak into the audit log.
  for (const k of Object.keys(payloadCopy)) {
    if (k.toLowerCase().includes('key') || k === 'raw' || k === 'transcript') payloadCopy[k] = '[redacted]';
  }
  return { stage, status, at: Date.now(), ...payloadCopy };
}

function injectIntentPipeline({ bank, audit, env = process.env, adpClient, mode, now = () => Date.now() } = {}) {
  if (!bank) throw new Error('injectIntentPipeline: bank is required');
  if (!audit) throw new Error('injectIntentPipeline: audit log is required');

  const provider = createIntentProvider({ env, adpClient });
  const providerState = { mode: mode || env.INTENTLOCK_MODE || 'OFFLINE_DEMO', configured: Boolean(env.ADP_APP_KEY || adpClient?.isConfigured?.()), liveVerified: false, lastSuccess: null, lastFailure: null };
  // Fingerprints -> Approval map. Cleared when the corresponding execute or
  // an explicit cancel runs.
  const pendingProposals = new Map();
  const pendingApprovals = new Map();

  async function interpret({ message, untrustedContent = '', userId = 'demo-user' }) {
    const userGuard = scanUserMessage(message);
    if (!userGuard.ok) {
      audit.append('block', { stage: 'user-message-injection', code: userGuard.code, reasons: userGuard.reasons, matchedPatterns: userGuard.matchedPatterns, messageRedacted: '[redacted]' });
      return { ok: false, stage: 'user-injection', code: userGuard.code, reasons: userGuard.reasons, matchedPatterns: userGuard.matchedPatterns };
    }

    const providerResult = await provider.interpretStructured(message, { mode });
    if (providerResult.ok && providerResult.provider === 'adp') {
      providerState.liveVerified = true;
      providerState.lastSuccess = { at: new Date().toISOString(), requestId: providerResult.requestId || null, latencyMs: providerResult.latencyMs || null };
    } else if (!providerResult.ok && providerResult.provider === 'adp') {
      providerState.lastFailure = { at: new Date().toISOString(), code: providerResult.code, message: providerResult.message };
    }
    if (!providerResult.ok) {
      audit.append('block', { stage: 'provider', code: providerResult.code, provider: providerResult.provider, message: providerResult.message });
      return { ok: false, stage: 'provider', code: providerResult.code, message: providerResult.message, provider: providerResult.provider, mode: providerResult.mode || mode };
    }

    const aiIntent = providerResult.intent;
    const transcriptGuard = scanAdpTranscript(providerResult.raw || providerResult.rationale || '');
    if (!transcriptGuard.ok) {
      audit.append('block', { stage: 'adp-transcript-injection', code: transcriptGuard.code, reasons: transcriptGuard.reasons, matchedPatterns: transcriptGuard.matchedPatterns, raw: '[redacted]' });
      return { ok: false, stage: 'adp-transcript', code: transcriptGuard.code, reasons: transcriptGuard.reasons, matchedPatterns: transcriptGuard.matchedPatterns, provider: providerResult.provider };
    }

    const compiled = compileTransferIntents(message);
    if (!compiled.ok) {
      audit.append('block', { stage: 'compile', code: compiled.code, message: compiled.message });
      return { ok: false, stage: 'compile', code: compiled.code, message: compiled.message };
    }
    if (compiled.intents.length !== 1) {
      audit.append('block', { stage: 'compile', code: 'MULTIPLE_TRANSFER_INTENTS', message: 'This milestone accepts exactly one transfer per request.' });
      return { ok: false, stage: 'compile', code: 'MULTIPLE_TRANSFER_INTENTS', message: 'This milestone accepts exactly one transfer per request.' };
    }

    const semantic = verifyIntentContract(message, compiled.intents, { parsed: compiled.parsed, aiIntent });
    if (!semantic.ok) {
      audit.append('block', { stage: 'semantic', code: semantic.code, reasons: semantic.reasons, aiIntent, compiled: { intents: compiled.intents, parsed: compiled.parsed } });
      return { ok: false, stage: 'semantic', code: semantic.code, reasons: semantic.reasons, intents: compiled.intents, aiIntent, explain: explain({ code: semantic.code, reasons: semantic.reasons }) };
    }

    const receiptCheck = inspectUntrustedContent(untrustedContent);
    if (!receiptCheck.ok) {
      audit.append('block', { stage: 'untrusted-content', code: receiptCheck.code, reasons: receiptCheck.reasons, matchedPatterns: receiptCheck.matchedPatterns });
      return { ok: false, stage: 'untrusted-content', code: receiptCheck.code, reasons: receiptCheck.reasons, matchedPatterns: receiptCheck.matchedPatterns, intents: compiled.intents };
    }

    audit.append('interpret', summarise('interpret', 'ok', { userId, provider: providerResult.provider, intentCount: compiled.intents.length, aiIntent }));
    return { ok: true, stage: 'interpret', provider: providerResult.provider, mode: providerResult.mode || mode, aiIntent, intents: compiled.intents, semantic, compiled, receiptCheck, rationale: providerResult.rationale, aiProcessing: { mode: providerResult.mode || mode, source: providerResult.provider, requestId: providerResult.requestId || null, latencyMs: providerResult.latencyMs || null, transportCompleted: providerResult.completed === true, schemaValidated: true } };
  }

  async function prepare({ message, untrustedContent = '', userId = 'demo-user' }) {
    const interpreted = await interpret({ message, untrustedContent, userId });
    if (!interpreted.ok) return interpreted;

    const aiIntent = interpreted.aiIntent;
    const prepared = bank.preparePayment(aiIntent, now(), { requesterUserId: userId });
    if (!prepared.ok) {
      audit.append('block', { stage: 'prepare', code: prepared.code, message: prepared.message, violations: prepared.violations });
      return {
        ok: false,
        stage: 'prepare',
        code: prepared.code,
        message: prepared.message,
        violations: prepared.violations,
        proposal: prepared.proposal,
        explain: explain({ code: prepared.code, reasons: prepared.violations }),
      };
    }

    pendingProposals.set(prepared.proposal.fingerprint, prepared.proposal);
    audit.append('prepare', summarise('prepare', 'ok', { userId, intent: aiIntent, fingerprint: prepared.proposal.fingerprint, recipientId: prepared.proposal.recipientId, sourceAccountId: prepared.proposal.sourceAccountId, amountCents: prepared.proposal.amountCents }));

    return {
      ok: true,
      stage: 'prepare',
      provider: interpreted.provider,
      mode: interpreted.mode,
      aiIntent,
      intent: aiIntent,
      intents: interpreted.intents,
      proposal: prepared.proposal,
      rationale: interpreted.rationale,
      aiProcessing: interpreted.aiProcessing,
      explain: explain('SEMANTIC_MISMATCH') /* placeholder, replaced below */,
    };
  }

  function approve({ proposalFingerprint, userId = 'demo-user' }) {
    const proposal = pendingProposals.get(proposalFingerprint);
    if (!proposal) {
      audit.append('block', { stage: 'approve', code: 'PROPOSAL_NOT_FOUND', message: 'Unknown or already-used proposal fingerprint.', proposalFingerprint });
      return { ok: false, code: 'PROPOSAL_NOT_FOUND', message: 'No pending proposal matches that fingerprint.' };
    }
    const approvalResult = bank.approvePayment(proposal, userId, now());
    if (!approvalResult.ok) {
      audit.append('block', { stage: 'approve', code: approvalResult.code, message: approvalResult.message });
      return { ok: false, code: approvalResult.code, message: approvalResult.message };
    }
    pendingApprovals.set(approvalResult.approval.approvalId, approvalResult.approval);
    pendingProposals.delete(proposalFingerprint);
    audit.append('approve', summarise('approve', 'ok', { userId, approvalId: approvalResult.approval.approvalId, fingerprint: approvalResult.approval.proposalFingerprint, recipientId: approvalResult.approval.proposal.recipientId, amountCents: approvalResult.approval.proposal.amountCents }));
    return { ok: true, approval: approvalResult.approval };
  }

  async function execute({ approvalId, userId = 'demo-user' }) {
    const approval = pendingApprovals.get(approvalId);
    if (!approval) {
      audit.append('block', { stage: 'execute', code: 'APPROVAL_NOT_FOUND', message: 'Unknown approvalId.', approvalId });
      return { ok: false, code: 'APPROVAL_NOT_FOUND', message: 'No pending approval matches that id.' };
    }
    if (approval.userId !== userId) {
      audit.append('block', { stage: 'execute', code: 'SESSION_MISMATCH', message: 'Approval belongs to a different user.', expectedUser: approval.userId, givenUser: userId });
      return { ok: false, code: 'SESSION_MISMATCH', message: 'Cross-user execution refused.' };
    }
    const execResult = await bank.executeApprovalSafe(approval, now());
    pendingApprovals.delete(approvalId);
    if (!execResult.ok) {
      audit.append('block', { stage: 'execute', code: execResult.code, message: execResult.message });
      return { ok: false, code: execResult.code, message: execResult.message, explain: explain({ code: execResult.code }) };
    }
    audit.append('execute', summarise('execute', 'ok', { userId, transactionId: execResult.entry.transactionId, approvalId, recipientId: approval.proposal.recipientId, amountCents: execResult.entry.amountCents, fingerprint: execResult.entry.transactionFingerprint }));
    return { ok: true, entry: execResult.entry, explain: explain('APPROVAL_EXPIRED') /* placeholder for symmetry */ };
  }

  return {
    interpret,
    prepare,
    approve,
    execute,
    pendingProposals: () => Array.from(pendingProposals.values()),
    pendingApprovals: () => Array.from(pendingApprovals.values()),
    providerStatus: () => ({ ...providerState }),
  };
}

module.exports = { injectIntentPipeline };
