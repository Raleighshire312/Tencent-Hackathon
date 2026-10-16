'use strict';

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

// Per-account FIFO lock so two concurrent /execute calls targeting the same
// source account cannot race past the balance + minimum-balance checks. The
// existing synchronous methods (preparePayment / approvePayment /
// executeApproval) are kept untouched so the current test suite is green;
// executeApprovalSafe uses the lock under the hood.
class PerAccountLocker {
  constructor() { this._chains = new Map(); }
  async run(accountId, fn) {
    const prev = this._chains.get(accountId) || Promise.resolve();
    // `task` is the value we store on `_chains`; we compare identities in
    // finally to decide whether we are still the head (no one called run
    // again while we were waiting) so we know whether to clean up.
    const task = prev.then(() => fn(), () => fn());
    this._chains.set(accountId, task);
    try {
      return await task;
    } finally {
      if (this._chains.get(accountId) === task) this._chains.delete(accountId);
    }
  }
  pendingFor(accountId) { return Boolean(this._chains.get(accountId)); }
}

function resolveRecipient(alias, recipients) {
  const normalized = String(alias || '').trim().toLowerCase();
  const matches = recipients.filter((recipient) => recipient.aliases.some((candidate) => candidate.toLowerCase() === normalized));
  if (matches.length === 0) return fail('RECIPIENT_NOT_FOUND', 'Recipient is not trusted or could not be resolved.');
  if (matches.length > 1) return fail('RECIPIENT_AMBIGUOUS', 'Recipient alias matches more than one trusted recipient.');
  return { ok: true, recipient: matches[0] };
}

class MockBank {
  constructor({ accounts, recipients, bills = [], quotes = {}, now = Date.now } = {}) {
    this.accounts = clone(accounts); this.recipients = clone(recipients); this.bills = clone(bills); this.quotes = clone(quotes);
    this.ledger = []; this.nextApprovalId = 1; this.createdAt = now;
    this._locker = new PerAccountLocker();
    // Snapshot of recipient verified state captured at prepare-time, so the
    // execute-time recheck can refuse a downgrade that happened in between.
    this._verifiedAtPrepare = new Map();
    // Monotonic counter so two identical proposals in the same millisecond
    // still produce distinct fingerprints; without this, concurrent prepares
    // for the same transfer would alias each other in the pipeline.
    this._proposalSeq = 0;
  }

  executePlan(plan, now = Date.now(), { userId = 'demo-user', idempotencyKey } = {}) {
    if (!plan || plan.state !== 'ready_for_approval') return fail('PLAN_NOT_READY', 'Only a fully validated plan can execute.');
    if (!Array.isArray(plan.actions) || plan.actions.length === 0 || plan.actions.length > 5) return fail('PLAN_ACTION_LIMIT', 'A plan must contain between one and five actions.');
    if (!idempotencyKey) return fail('IDEMPOTENCY_KEY_REQUIRED', 'A one-use idempotency key is required.');
    if (this.ledger.some((entry) => entry.idempotencyKey === idempotencyKey)) return { ok: true, replay: true, entries: this.ledger.filter((entry) => entry.idempotencyKey === idempotencyKey) };
    const sourceIds = [...new Set(plan.actions.map((a) => a.sourceAccountId))];
    const sources = sourceIds.map((id) => this.accounts[id]);
    if (sources.some((s) => !s)) return fail('SOURCE_NOT_FOUND', 'A source account no longer exists.');
    const projected = Object.fromEntries(sourceIds.map((id) => [id, this.accounts[id].balanceCents]));
    const entries = []; const seenBills = new Set();
    for (const action of plan.actions) {
      if (!['transfer', 'bill_payment', 'stock_purchase'].includes(action.type)) return fail('UNSUPPORTED_ACTION', 'The plan contains an unsupported action.');
      if (action.currency !== 'SGD') return fail('UNSUPPORTED_CURRENCY', 'Only SGD plans are supported.');
      if (!Number.isSafeInteger(action.amountCents) || action.amountCents <= 0) return fail('INVALID_AMOUNT', 'Every plan action must have a positive integer amount.');
      const source = this.accounts[action.sourceAccountId];
      projected[action.sourceAccountId] -= action.amountCents;
      if (projected[action.sourceAccountId] < 0) return fail('INSUFFICIENT_FUNDS', 'Current balance is insufficient for the complete plan.');
      if (action.type === 'transfer') {
        const recipient = this.recipients.find((r) => r.id === action.recipientId);
        if (!recipient?.verified) return fail('RECIPIENT_VERIFICATION_LOST', 'A recipient is no longer verified.');
      }
      if (action.type === 'bill_payment') {
        if (seenBills.has(action.billId)) return fail('DUPLICATE_BILL', 'A bill may only be paid once in a batch.');
        seenBills.add(action.billId);
        const bill = this.bills.find((b) => b.id === action.billId);
        if (!bill || bill.status !== 'outstanding') return fail('BILL_NOT_PAYABLE', 'The bill is no longer outstanding.');
      }
      if (action.type === 'stock_purchase') {
        const quote = this.quotes[action.symbol];
        if (!Number.isSafeInteger(action.quantity) || action.quantity <= 0) return fail('INVALID_SHARE_QUANTITY', 'Stock purchases require a positive whole-share quantity.');
        if (!quote || quote.priceCents !== action.quoteCents) return fail('QUOTE_CHANGED', 'The stock quote changed; the plan must be reviewed again.');
        if (quote.expiresAt && now >= new Date(quote.expiresAt).getTime()) return fail('QUOTE_EXPIRED', 'The stock quote expired; the plan must be reviewed again.');
      }
      entries.push({ transactionId: `txn-${this.ledger.length + entries.length + 1}`, userId, actionId: action.id, type: action.type, amountCents: action.amountCents, sourceAccountId: source.id, recipientId: action.recipientId || null, billId: action.billId || null, symbol: action.symbol || null, quantity: action.quantity || null, status: 'executed', executedAt: now, idempotencyKey, planHash: plan.planHash });
    }
    for (const id of sourceIds) this.accounts[id].balanceCents = projected[id];
    for (const entry of entries) { if (entry.billId) { const bill = this.bills.find((b) => b.id === entry.billId); bill.status = 'paid'; } this.ledger.push(entry); }
    return { ok: true, entries, projectedBalances: projected };
  }

  preparePayment(intent, now = Date.now(), { requesterUserId = null } = {}) {
    if (!intent || intent.action !== 'transfer') return fail('UNSUPPORTED_ACTION', 'Only transfer intents are supported.');
    if (!Number.isSafeInteger(intent.amountCents) || intent.amountCents <= 0) return fail('INVALID_AMOUNT', 'Amount must be a positive integer number of cents.');
    if (intent.currency !== 'SGD') return fail('UNSUPPORTED_CURRENCY', 'Only SGD mock transfers are supported.');
    const source = this.accounts[intent.sourceAccountId];
    if (!source) return fail('SOURCE_NOT_FOUND', 'Source account does not exist.');
    const resolved = resolveRecipient(intent.recipientAlias, this.recipients);
    if (!resolved.ok) return resolved;
    const recipient = resolved.recipient;
    // This is deliberately not caller-configurable. AI output and natural
    // language may propose a recipient, but only trusted application records
    // decide whether that recipient is eligible.
    const requireVerified = true;
    if (!recipient.verified) return fail('RECIPIENT_UNVERIFIED', 'Recipient is not verified.');
    const minimumRemainingCents = intent.minimumRemainingCents ?? 0;
    if (!Number.isSafeInteger(minimumRemainingCents) || minimumRemainingCents < 0) return fail('INVALID_CONSTRAINT', 'Minimum remaining balance must be a non-negative integer number of cents.');
    const remainingCents = source.balanceCents - intent.amountCents;
    const violations = [];
    if (intent.amountCents > source.balanceCents) violations.push('INSUFFICIENT_FUNDS');
    if (remainingCents < minimumRemainingCents) violations.push('MINIMUM_BALANCE');
    const nonce = this._proposalSeq += 1;
    const proposal = {
      schemaVersion: 1, action: 'transfer', currency: 'SGD', amountCents: intent.amountCents,
      sourceAccountId: source.id, recipientId: recipient.id, recipientDisplayName: recipient.displayName,
      // Snapshot verified state so execute can detect mid-flight downgrade.
      recipientVerifiedAtPrepare: recipient.verified,
      requireVerifiedAtPrepare: requireVerified,
      constraints: { minimumRemainingCents, requireVerifiedRecipient: requireVerified },
      preparedAt: now, expiresAt: now + (intent.ttlMs ?? 5 * 60 * 1000),
      requesterUserId,
      nonce,
    };
    proposal.fingerprint = fingerprint(proposal);
    if (violations.length) return { ok: false, code: 'VALIDATION_FAILED', message: 'Payment was blocked before approval.', violations, proposal };
    return { ok: true, proposal };
  }

  approvePayment(proposal, userId, now = Date.now()) {
    if (!proposal || !proposal.fingerprint) return fail('INVALID_PROPOSAL', 'A validated proposal is required.');
    if (!userId) return fail('USER_REQUIRED', 'Explicit user identity is required for approval.');
    if (proposal.requesterUserId && proposal.requesterUserId !== userId) return fail('SESSION_MISMATCH', 'Approval must be made by the requesting user.');
    if (now >= proposal.expiresAt) return fail('PROPOSAL_EXPIRED', 'The payment proposal has expired.');
    if (fingerprint({ ...proposal, fingerprint: undefined }) !== proposal.fingerprint) return fail('PROPOSAL_TAMPERED', 'Proposal fingerprint does not match its contents.');
    const approval = {
      approvalId: `approval-${this.nextApprovalId++}`, userId, proposal: clone(proposal), proposalFingerprint: proposal.fingerprint,
      approvedAt: now, expiresAt: proposal.expiresAt, status: 'approved',
    };
    approval.approvalFingerprint = fingerprint({ approvalId: approval.approvalId, userId: approval.userId, proposalFingerprint: approval.proposalFingerprint, approvedAt: approval.approvedAt, expiresAt: approval.expiresAt });
    return { ok: true, approval };
  }

  // Synchronous. UNCHANGED to keep existing tests happy; new behaviour lives
  // behind executeApprovalSafe so the async pipeline can lock per account.
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

    // NEW: execution-time re-check of recipient verification status. If a
    // recipient was verified at prepare time but has since been downgraded,
    // refuse to execute. The existing `requireVerifiedRecipient` field is
    // preserved in the proposal so the audit trail records what was true
    // at the moment of preparation.
    const freshlyVerified = recipient.verified;
    const wantedVerification = proposal.requireVerifiedAtPrepare !== false;
    if (wantedVerification && !freshlyVerified) {
      return fail('RECIPIENT_VERIFICATION_LOST', 'Recipient was unverified after approval; refusing to execute.');
    }

    const remainingCents = source.balanceCents - proposal.amountCents;
    if (proposal.amountCents > source.balanceCents) return fail('INSUFFICIENT_FUNDS', 'Current balance is insufficient.');
    if (remainingCents < proposal.constraints.minimumRemainingCents) return fail('MINIMUM_BALANCE', 'Current balance violates the minimum-balance constraint.');
    source.balanceCents -= proposal.amountCents;
    const entry = { transactionId: `txn-${this.ledger.length + 1}`, approvalId: approval.approvalId, userId: approval.userId, amountCents: proposal.amountCents, currency: proposal.currency, sourceAccountId: source.id, recipientId: recipient.id, executedAt: now, status: 'executed', transactionFingerprint: approval.proposalFingerprint };
    this.ledger.push(entry); approval.status = 'executed'; return { ok: true, entry };
  }

  // Async, lock-protected variant. Used by the HTTP pipeline. The lock
  // serialises per source account so two callers cannot both pass the
  // balance check and then both debit.
  async executeApprovalSafe(approval, now) {
    if (!approval || !approval.proposal) return fail('INVALID_APPROVAL', 'A pending approved payment is required.');
    return this._locker.run(approval.proposal.sourceAccountId, () => this.executeApproval(approval, now));
  }

  // Same protection for prepare+approve convenience callers used by the HTTP
  // pipeline if it ever wants to prepare under a lock. Currently unused
  // (keep for symmetry / future use).
  async preparePaymentSafe(intent, now) {
    const probe = this.preparePayment(intent, now);
    if (!probe.ok || !probe.proposal) return probe;
    return this._locker.run(probe.proposal.sourceAccountId, () => probe);
  }
}

module.exports = { MockBank, PerAccountLocker, canonicalJson, fingerprint };
