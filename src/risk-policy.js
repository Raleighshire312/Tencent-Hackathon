'use strict';

function assessPlan(plan, bank, now = Date.now()) {
  const actions = plan?.actions || [];
  if (actions.some((a) => a.amountCents > 1000000)) return { ok: false, code: 'RISK_ACTION_LIMIT', message: 'An individual action exceeds the illustrative S$10,000 demo limit.' };
  const recent = (bank.ledger || []).filter((e) => now - Number(e.executedAt || 0) <= 600000);
  const attempts = (bank.ledger || []).filter((e) => now - Number(e.executedAt || 0) <= 60000).length;
  if (attempts >= 5) return { ok: false, code: 'RISK_RATE_LIMIT', message: 'The illustrative execution-attempt limit has been reached.' };
  const cumulative = recent.reduce((sum, e) => sum + Number(e.amountCents || 0), 0) + actions.reduce((sum, a) => sum + Number(a.amountCents || 0), 0);
  const secondaryRequired = actions.some((a) => a.amountCents > 200000) || cumulative > 300000;
  return { ok: true, secondaryRequired, cumulativeDebitsCents: cumulative, policy: 'illustrative-demo-policy' };
}

module.exports = { assessPlan };
