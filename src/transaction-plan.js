'use strict';

const crypto = require('node:crypto');
const { fingerprint } = require('./payment-core');

const PLAN_VERSION = 'intentlock.plan.v2';
const PLAN_STATES = Object.freeze(['understanding', 'awaiting_clarification', 'validating', 'ready_for_approval', 'authorization_pending', 'executing', 'completed', 'blocked', 'cancelled']);

function moneyCents(value) { return Math.round(Number(value) * 100); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function norm(value) { return String(value || '').trim().toLowerCase(); }

function parseMoneyTokens(text) {
  const words = String(text || '').toLowerCase().replace(/\ba grand\b/g, '1000');
  return [...words.matchAll(/(?:s\$|\$|sgd\s*)\s*([0-9]+(?:\.[0-9]{1,2})?)|\b([0-9]+(?:\.[0-9]{1,2})?)\s*(?:dollars?|sgd)\b/g)].map((m) => moneyCents(m[1] || m[2]));
}

function parseMinimum(text) {
  const match = String(text || '').match(/(?:keep|leave|remaining|at least)\s*(?:s\$|\$|sgd\s*)?([0-9]+(?:\.[0-9]{1,2})?)/i);
  return match ? moneyCents(match[1]) : 0;
}

function aliasCandidates(alias, recipients) {
  const query = norm(alias);
  return recipients.filter((r) => r.aliases.some((a) => norm(a) === query || norm(a).includes(query) || query.includes(norm(a))));
}

function parseTransfer(text, recipients) {
  const out = [];
  const pattern = /\b(?:send|transfer|pay)\s+(?:s\$|\$|sgd\s*)?([0-9]+(?:\.[0-9]{1,2})?)?\s*(?:to|for)?\s*([a-z][a-z0-9 &'-]*?)(?=\s+(?:s\$|\$|sgd\s*)?[0-9]|\s+and\s+|\s*,|\s+but\s+|\s+while\s+|\s*$)/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const amount = match[1] ? moneyCents(match[1]) : null;
    const alias = match[2].trim();
    if (amount && alias && !/electricity|bill|shares?|stock/i.test(alias)) out.push({ type: 'transfer', recipientAlias: alias, amountCents: amount, sourceAccountId: /from\s+savings|savings/i.test(text) ? 'savings' : 'spending', currency: 'SGD' });
  }
  const aliasFirst = /\b(?:send|transfer|pay)\s+([^0-9,]+?)\s+(?:s\$|\$|sgd\s*)?([0-9]+(?:\.[0-9]{1,2})?)(?=\s|,|$)/gi;
  while ((match = aliasFirst.exec(text))) {
    const alias = match[1].trim(); if (/electricity|bill|utility|power|shares?|stock/i.test(alias)) continue;
    const amount = moneyCents(match[2]); if (amount) out.push({ type: 'transfer', recipientAlias: alias, amountCents: amount, sourceAccountId: 'spending', currency: 'SGD' });
  }
  return out;
}

function parsePlan(text, bank) {
  text = String(text || '').replace(/\bfive hundred\b/gi, '500').replace(/\btwo thousand\b/gi, '2000').replace(/\bone thousand\b/gi, '1000').replace(/\ba grand\b/gi, '1000');
  const sourceAccountId = /\b(?:from|out of|using)\s+(?:my\s+)?savings\b/i.test(text) ? 'savings' : 'spending';
  const minimumRemainingCents = parseMinimum(text);
  const amounts = parseMoneyTokens(text);
  const actions = [];
  const transfers = parseTransfer(text, bank.recipients);
  transfers.forEach((item) => { item.sourceAccountId = sourceAccountId; item.minimumRemainingCents = minimumRemainingCents; item.requiresVerifiedRecipient = true; item.id = `action-${actions.length + 1}`; actions.push(item); });

  if (/electricity|utility|utilities|power|bill/i.test(text)) {
    const bill = bank.bills.find((b) => /electricity|utility|power/i.test(`${b.payee} ${b.alias}`));
    if (!bill) return { ok: false, code: 'BILL_NOT_FOUND', message: 'I could not find an outstanding electricity bill.' };
    const billAmount = bill.amountCents;
    actions.push({ id: `action-${actions.length + 1}`, type: 'bill_payment', billId: bill.id, payee: bill.payee, amountCents: billAmount, sourceAccountId, currency: 'SGD', minimumRemainingCents });
  }

  const stockMatch = text.match(/(?:buy|purchase|invest(?:\s+in)?)\s+(?:(\d+)\s+)?(?:shares?\s+of\s+)?(DBS|Apple|AAPL)\s+shares?/i) || text.match(/(?:buy|purchase|invest(?:\s+in)?)\s+(DBS|Apple|AAPL)/i);
  if (stockMatch) {
    const symbol = String(stockMatch[2] || stockMatch[1]).toUpperCase() === 'APPLE' ? 'AAPL' : String(stockMatch[2] || stockMatch[1]).toUpperCase();
    const quote = bank.quotes[symbol];
    if (!quote) return { ok: false, code: 'QUOTE_NOT_FOUND', message: `I cannot price ${symbol} in the mock market.` };
    const explicitShares = Number(stockMatch[1]);
    const halfRemaining = /half\s+of\s+what\s+remains|half\s+of\s+the\s+remaining/i.test(text);
    actions.push({ id: `action-${actions.length + 1}`, type: 'stock_purchase', symbol, displayName: quote.displayName, quoteCents: quote.priceCents, quantity: explicitShares || null, budgetFraction: halfRemaining ? 0.5 : null, sourceAccountId, currency: 'SGD', minimumRemainingCents });
  }

  if (!actions.length) return { ok: false, code: 'NO_ACTIONS', message: 'Tell me what to transfer, pay, or buy.' };
  const unresolved = [];
  for (const action of actions) {
    if (action.type === 'transfer') {
      const candidates = aliasCandidates(action.recipientAlias, bank.recipients);
      if (candidates.length !== 1) unresolved.push({ slot: 'recipient', actionId: action.id, input: action.recipientAlias, candidates: candidates.map((c) => ({ id: c.id, displayName: c.displayName, masked: c.masked })) });
      else { action.recipientId = candidates[0].id; action.recipientDisplayName = candidates[0].displayName; }
    }
  }
  return { ok: true, state: unresolved.length ? 'awaiting_clarification' : 'ready_for_approval', actions, unresolved, sourceAccountId, minimumRemainingCents, rawText: text };
}

function resolvePlan(plan, answer, bank) {
  const next = clone(plan);
  const target = next.unresolved?.[0];
  if (!target) return next;
  const candidates = target.candidates || [];
  const chosen = candidates.find((c) => norm(answer).includes(norm(c.displayName)) || norm(answer).includes(norm(c.masked || '')) || norm(answer) === norm(c.id));
  if (!chosen) return { ...next, clarification: `Please choose one of: ${candidates.map((c) => `${c.displayName} ${c.masked || ''}`).join(' or ')}.` };
  const action = next.actions.find((a) => a.id === target.actionId);
  action.recipientId = chosen.id; action.recipientDisplayName = chosen.displayName; next.unresolved = next.unresolved.slice(1); next.state = next.unresolved.length ? 'awaiting_clarification' : 'ready_for_approval';
  return next;
}

function calculatePlan(plan, bank) {
  const next = clone(plan); let available = bank.accounts[plan.sourceAccountId]?.balanceCents || 0; const findings = [];
  for (const action of next.actions) {
    if (action.type === 'stock_purchase') {
      if (!action.quantity) action.quantity = Math.floor((available * (action.budgetFraction || 1)) / action.quoteCents);
      action.amountCents = action.quantity * action.quoteCents;
    }
    available -= action.amountCents;
    if (action.amountCents <= 0) findings.push({ code: 'INVALID_AMOUNT', message: `${action.id} has no positive amount.` });
  }
  next.projectedBalanceCents = available; next.totalCents = next.actions.reduce((sum, a) => sum + a.amountCents, 0);
  if (available < next.minimumRemainingCents) findings.push({ code: 'MINIMUM_BALANCE', message: `This plan leaves ${available} cents, below the requested ${next.minimumRemainingCents} cents.` });
  for (const action of next.actions) if (action.type === 'transfer') { const recipient = bank.recipients.find((r) => r.id === action.recipientId); if (!recipient?.verified) findings.push({ code: 'RECIPIENT_UNVERIFIED', message: `${action.recipientDisplayName || action.recipientAlias} is not a verified payee.` }); }
  next.findings = findings; next.state = findings.length ? 'blocked' : 'ready_for_approval'; next.planHash = fingerprint({ version: PLAN_VERSION, actions: next.actions, projectedBalanceCents: next.projectedBalanceCents, minimumRemainingCents: next.minimumRemainingCents }); return next;
}

module.exports = { PLAN_VERSION, PLAN_STATES, parsePlan, resolvePlan, calculatePlan, clone };
