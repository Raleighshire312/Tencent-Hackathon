const crypto = require('node:crypto');

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}
function canonicalJson(value) { return JSON.stringify(stableValue(value)); }
function fingerprint(value) { return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function fail(code, message, details = {}) { return { ok: false, code, message, details }; }

function resolveRecipient(alias, recipients) {
  const normalized = String(alias || '').trim().toLowerCase();
  const matches = recipients.filter((recipient) => recipient.aliases.some((candidate) => candidate.toLowerCase() === normalized));
  if (matches.length === 0) return fail('RECIPIENT_NOT_FOUND', 'Recipient is not trusted or could not be resolved.');
  if (matches.length > 1) return fail('RECIPIENT_AMBIGUOUS', 'Recipient alias matches more than one trusted recipient.');
  return { ok: true, recipient: matches[0] };
}

class MockBank {
  constructor({ accounts, recipients, now = Date.now() }) {
    this.accounts = clone(accounts); this.recipients = clone(recipients);
    this.ledger = []; this.nextApprovalId = 1; this.createdAt = now;
  }
  preparePayment(intent, now = Date.now()) {
    if (!intent || intent.action !== 'transfer') return fail('UNSUPPORTED_ACTION', 'Only transfer intents are supported.');
    if (!Number.isSafeInteger(intent.amountCents) || intent.amountCents <= 0) return fail('INVALID_AMOUNT', 'Amount must be a positive integer number of cents.');
    if (intent.currency !== 'SGD') return fail('UNSUPPORTED_CURRENCY', 'Only SGD mock transfers are supported.');
    const source = this.accounts[intent.sourceAccountId];
    if (!source) return fail('SOURCE_NOT_FOUND', 'Source account does not exist.');
    const resolved = resolveRecipient(intent.recipientAlias, this.recipients);
    if (!resolved.ok) return resolved;
    const recipient = resolved.recipient;
    if (intent.requireVerifiedRecipient !== false && !recipient.verified) return fail('RECIPIENT_UNVERIFIED', 'Recipient is not verified.');
    const minimumRemainingCents = intent.minimumRemainingCents ?? 0;
    if (!Number.isSafeInteger(minimumRemainingCents) || minimumRemainingCents < 0) return fail('INVALID_CONSTRAINT', 'Minimum remaining balance must be a non-negative integer number of cents.');
    const remainingCents = source.balanceCents - intent.amountCents;
    const violations = [];
    if (intent.amountCents > source.balanceCents) violations.push('INSUFFICIENT_FUNDS');
    if (remainingCents < minimumRemainingCents) violations.push('MINIMUM_BALANCE');
    const proposal = {
      schemaVersion: 1, action: 'transfer', currency: 'SGD', amountCents: intent.amountCents,
      sourceAccountId: source.id, recipientId: recipient.id, recipientDisplayName: recipient.displayName,
      constraints: { minimumRemainingCents, requireVerifiedRecipient: intent.requireVerifiedRecipient !== false },
      preparedAt: now, expiresAt: now + (intent.ttlMs ?? 5 * 60 * 1000),
    };
    proposal.fingerprint = fingerprint(proposal);
    if (violations.length) return { ok: false, code: 'VALIDATION_FAILED', message: 'Payment was blocked before approval.', violations, proposal };
    return { ok: true, proposal };
  }
  approvePayment(proposal, userId, now = Date.now()) {
    if (!proposal || !proposal.fingerprint) return fail('INVALID_PROPOSAL', 'A validated proposal is required.');
    if (!userId) return fail('USER_REQUIRED', 'Explicit user identity is required for approval.');
    if (now >= proposal.expiresAt) return fail('PROPOSAL_EXPIRED', 'The payment proposal has expired.');
    if (fingerprint({ ...proposal, fingerprint: undefined }) !== proposal.fingerprint) return fail('PROPOSAL_TAMPERED', 'Proposal fingerprint does not match its contents.');
    const approval = {
      approvalId: `approval-${this.nextApprovalId++}`, userId, proposal: clone(proposal), proposalFingerprint: proposal.fingerprint,
      approvedAt: now, expiresAt: proposal.expiresAt, status: 'approved',
    };
    approval.approvalFingerprint = fingerprint({ approvalId: approval.approvalId, userId: approval.userId, proposalFingerprint: approval.proposalFingerprint, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt });
    return { ok: true, approval };
  }
  executeApproval(approval, now = Date.now()) {
    if (!approval || approval.status !== 'approved') return fail('INVALID_APPROVAL', 'A pending approved payment is required.');
    if (now >= approval.expiresAt) return fail('APPROVAL_EXPIRED', 'Approval has expired.');
    const expectedApprovalFingerprint = fingerprint({ approvalId: approval.approvalId, userId: approval.userId, proposalFingerprint: approval.proposalFingerprint, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt });
    if (expectedApprovalFingerprint !== approval.approvalFingerprint) return fail('APPROVAL_TAMPERED', 'Approval metadata no longer matches the approved authorization.');
    if (fingerprint({ ...approval.proposal, fingerprint: undefined }) !== approval.proposalFingerprint || approval.proposal.fingerprint !== approval.proposalFingerprint) return fail('APPROVAL_TAMPERED', 'Approval is no longer bound to the approved transaction.');
    const proposal = approval.proposal;
    const source = this.accounts[proposal.sourceAccountId];
    if (!source) return fail('SOURCE_NOT_FOUND', 'Source account no longer exists.');
    const recipient = this.recipients.find((candidate) => candidate.id === proposal.recipientId);
    if (!recipient) return fail('RECIPIENT_NOT_FOUND', 'Recipient no longer exists.');
    const remainingCents = source.balanceCents - proposal.amountCents;
    if (proposal.amountCents > source.balanceCents) return fail('INSUFFICIENT_FUNDS', 'Current balance is insufficient.');
    if (remainingCents < proposal.constraints.minimumRemainingCents) return fail('MINIMUM_BALANCE', 'Current balance violates the minimum-balance constraint.');
    source.balanceCents -= proposal.amountCents;
    const entry = { transactionId: `txn-${this.ledger.length + 1}`, approvalId: approval.approvalId, userId: approval.userId, amountCents: proposal.amountCents, currency: proposal.currency, sourceAccountId: source.id, recipientId: recipient.id, executedAt: now, status: 'executed', transactionFingerprint: approval.proposalFingerprint };
    this.ledger.push(entry); approval.status = 'executed'; return { ok: true, entry };
  }
}

module.exports = { MockBank, canonicalJson, fingerprint };
